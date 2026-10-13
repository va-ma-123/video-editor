import { useRef, useState, useEffect, useCallback } from "react";
import { timeToFrame } from "../edl";

function clampCropToSource(crop, source) {
  if(!crop || !source?.width || !source?.height) return null;

  const width = Math.max(1, Math.min(crop.width || source.width, source.width));
  const height = Math.max(1, Math.min(crop.height || source.height, source.height));
  const x = Math.max(0, Math.min(crop.x || 0, source.width - width));
  const y = Math.max(0, Math.min(crop.y || 0, source.height - height));

  return { x, y, width, height };
}

/**
 * Frame-accurate scrubber over a source's low-res proxy video.
 *
 * HTML5 <video> seeking is not inherently frame-accurate, and there's a
 * specific gotcha this component has to guard against: seeking to a
 * non-keyframe position forces the browser to decode backward to the
 * nearest keyframe and then forward to the target. While that's happening,
 * the video fires `timeupdate` with those *intermediate* positions -- for a
 * clip with sparse keyframes, that intermediate position is often frame 0.
 * If a handler blindly trusts every `timeupdate`, the displayed frame can
 * get stuck on that transient value once the video is paused (no further
 * event arrives to correct it).
 *
 * The fix: treat `timeupdate` as informational only while a seek is in
 * flight (`video.seeking === true` means "don't trust this yet"), and use
 * `requestVideoFrameCallback` -- which only fires once an actual frame has
 * been decoded and presented -- as the authoritative source of truth once
 * a seek completes. `seeked` is used as a fallback for browsers without
 * rVFC support.
 */
function clampPreviewCrop(crop, previewSize) {
  if(!crop || !previewSize?.width || !previewSize?.height) return null;

  const minSize = 8;
  const width = Math.max(minSize, Math.min(crop.width || previewSize.width, previewSize.width));
  const height = Math.max(minSize, Math.min(crop.height || previewSize.height, previewSize.height));
  const x = Math.max(0, Math.min(crop.x || 0, previewSize.width - width));
  const y = Math.max(0, Math.min(crop.y || 0, previewSize.height - height));

  return { x, y, width, height };
}

function resizeAxis(start, end, delta, edge, minSize) {
  if (!edge) return [start, end];
  if (edge === "move") return [start + delta, end + delta];
  if (edge === "start") return [Math.min(end - minSize, start + delta), end];
  return [start, Math.max(start + minSize, end + delta)];
}

function previewCropToSourceCrop(crop, source, previewSize) {
  if(!crop || !previewSize?.width || !previewSize?.height || !source?.height || !source?.width) return null;
  const scaleX = source.width / previewSize.width;
  const scaleY = source.height / previewSize.height;
  return {
    x: Math.max(0, Math.min(Math.round(crop.x * scaleX), source.width - 1)),
    y: Math.max(0, Math.min(Math.round(crop.y * scaleY), source.height - 1)),
    width: Math.max(1, Math.min(Math.round(crop.width * scaleX), source.width)),
    height: Math.max(1, Math.min(Math.round(crop.height * scaleY), source.height)),
  };
}

function sourceCropToPreviewCrop(crop, source, previewSize) {
  if(!crop || !previewSize?.width || !previewSize?.height || !source?.height || !source?.width) return null;
  const scaleX = previewSize.width / source.width;
  const scaleY = previewSize.height / source.height;
  return {
    x: crop.x * scaleX,
    y: crop.y * scaleY,
    width: crop.width * scaleX,
    height: crop.height * scaleY,
  };
}

function resizePreviewCrop(startCrop, dragMode, dx, dy, previewSize) {
  const minSize = 8;
  let horizontalEdge = null;
  let verticalEdge = null;

  if(dragMode === "move") {
    horizontalEdge = "move";
    verticalEdge = "move";
  } else {
    if(dragMode.includes("w")) horizontalEdge = "start"
    else if (dragMode.includes("e")) horizontalEdge = "end"

    if (dragMode.includes("n")) verticalEdge = "start"
    else if (dragMode.includes("s")) verticalEdge = "end"
  }

  const [l, r] = resizeAxis(startCrop.x, startCrop.x + startCrop.width, dx, horizontalEdge, minSize);
  const [t, b] = resizeAxis(startCrop.y, startCrop.y + startCrop.height, dy, verticalEdge, minSize);

  return clampPreviewCrop({ x: l, y: t, width: r-l, height: b-t }, previewSize);
}

export default function FramePreview({ 
  source, 
  clip, 
  onMarkRange, 
  onCropChange, 
  visible = true, 
  onClose,
  cropMode: propCropMode = "single",
  cropTransition = null,
  crops = null,
  onCropTransitionChange = null,
  onCropsChange = null, 
}) {
  const videoRef = useRef(null);
  const stageRef = useRef(null);
  const dragStateRef = useRef(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [inFrame, setInFrame] = useState(null);
  const [outFrame, setOutFrame] = useState(null);
  const [ready, setReady] = useState(false);
  const [previewLayout, setPreviewLayout] = useState(null);

  const fps = source?.fps || 30;
  const totalFrames = source?.total_frames || 0;
  const crop = clampCropToSource(clip?.operations?.transform?.crop, source);
  const cropPreview = sourceCropToPreviewCrop(crop, source, previewLayout);
  const hasCropOverlay = !!cropPreview && !!previewLayout;
  const transformCropMode = clip?.operations?.transform?.crop_mode || "crop";

  const shouldShowSingleCrop = propCropMode === "single" && hasCropOverlay;
  const shouldShowTransitionCrop = propCropMode === "transition" && cropTransition && previewLayout;
  const shouldShowMultipleCrops = propCropMode === "multi" && crops && crops.length > 0 && previewLayout;

  // for transitions
  const getInterpolatedTransitionCrop = () => {
    if (!cropTransition || !clip) return null;
    const clipDuration = clip.end_frame - clip.start_frame;
    const clipProgress = Math.max(0, Math.min(currentFrame - clip.start_frame, clipDuration)) / clipDuration;

    const start = cropTransition.start;
    const end = cropTransition.end;

    return {
      x: Math.round(start.x + (end.x - start.x) * clipProgress),
      y: Math.round(start.y + (end.y - start.y) * clipProgress),
      width: Math.round(start.width + (end.width - start.width) * clipProgress),
      height: Math.round(start.height + (end.height - start.height) * clipProgress),
    };
  };

  const transitionCropPreview = shouldShowTransitionCrop 
    ? sourceCropToPreviewCrop(getInterpolatedTransitionCrop(), source, previewLayout)
    : null; 
  
  const syncPreviewSize = useCallback(() => {
    const video = videoRef.current;
    const stage = stageRef.current;
    if (!video || !stage) return;

    const rect = video.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const intWidth = video.videoWidth;
    const intHeight = video.videoHeight;
    if (
      rect.width > 0 && 
      rect.height > 0 && 
      stageRect.width > 0 && 
      stageRect.height > 0 &&
      intWidth > 0 &&
      intHeight > 0
    ) {

      const boxAspect = rect.width / rect.height;
      const intAspect = intWidth / intHeight;
      let contentWidth = rect.width;
      let contentHeight = rect.height;

      if(boxAspect > intAspect) {
        contentHeight = rect.height;
        contentWidth = contentHeight * intAspect;
      } else {
        contentWidth = rect.width;
        contentHeight = contentWidth / intAspect;
      }

      const contentLeft = rect.left - stageRect.left + (rect.width - contentWidth) / 2;
      const contentTop = rect.top - stageRect.top + (rect.height - contentHeight) / 2;

      setPreviewLayout((current) => {
        const next = { 
          left: contentLeft,
          top: contentTop,
          width: contentWidth, 
          height: contentHeight, 
        };
        if (
          current?.left === next.left &&
          current?.top === next.top &&
          current?.width === next.width &&
          current?.height === next.height
        ) {
          return current;
        }
        return next;
      });
    }
  }, []);

  const commitPreviewCrop = useCallback(
    (previewCrop, metadata = {}) => {
      if (!source || !previewLayout) return;
      const clampedPreviewCrop = clampPreviewCrop(previewCrop, previewLayout);
      const nextCrop = previewCropToSourceCrop(clampedPreviewCrop, source, previewLayout);
      if (!nextCrop) return;
      
      // route to appropriate callback based on mode
      if (propCropMode === "transition" && (metadata.target === "start" || metadata.target === "end")) {
        if (onCropTransitionChange) {
          const newTransition = { ...cropTransition };
          newTransition[metadata.target] = nextCrop;
          onCropTransitionChange(newTransition);
        }
      } else if (propCropMode === "multi" && typeof metadata.index === "number") {
        if (onCropsChange) {
          const newCrops = [...crops];
          newCrops[metadata.index] = nextCrop;
          onCropsChange(newCrops);
        }
      } else if (propCropMode === "single" && onCropChange) {
        onCropChange({ ...clip, operations: { ...clip.operations, transform: { ...clip.operations.transform, crop: nextCrop } } });
      }
    },
    [clip, onCropChange, onCropTransitionChange, onCropsChange, propCropMode, previewLayout, source, cropTransition, crops]
  );

  const handlePointerMove = useCallback(
    (event) => {
      const drag = dragStateRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      const dx = event.clientX - drag.startPoint.x;
      const dy = event.clientY - drag.startPoint.y;
      const nextCrop = clampPreviewCrop(resizePreviewCrop(drag.startCrop, drag.mode, dx, dy, previewLayout), previewLayout);
      if (nextCrop) commitPreviewCrop(nextCrop, drag.metadata);
    },
    [commitPreviewCrop, previewLayout]
  );

  const stopDragging = useCallback(
    (event) => {
      const drag = dragStateRef.current;
      if (!drag || (event?.pointerId && event.pointerId !== drag.pointerId)) return;
      dragStateRef.current = null;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    },
    [handlePointerMove]
  );

  const startDragging = useCallback(
    (mode, metadata = {}) => (event) => {
      if(!previewLayout || !onCropChange && !onCropTransitionChange && !onCropsChange) return;

      let startCrop = null;
      if (propCropMode === "single") {
        if(!cropPreview) return;
        startCrop = cropPreview;
      } else if (propCropMode === "transition" && metadata.target) {
        const cropToEdit = metadata.target === "start" ? cropTransition?.start : cropTransition?.end;
        if (!cropToEdit) return;
        startCrop = sourceCropToPreviewCrop(cropToEdit, source, previewLayout);
      } else if (propCropMode === "multi" && typeof metadata.index === "number") {
        const cropToEdit = crops?.[metadata.index];
        if (!cropToEdit) return;
        startCrop = sourceCropToPreviewCrop(cropToEdit, source, previewLayout);
      }

      if (!startCrop) return;

      event.preventDefault();
      event.stopPropagation();
      dragStateRef.current = {
        mode,
        metadata,
        pointerId: event.pointerId,
        startPoint: { x: event.clientX, y: event.clientY },
        startCrop,
      };
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", stopDragging);
      window.addEventListener("pointercancel", stopDragging);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [propCropMode, cropPreview, cropTransition, crops, source, onCropTransitionChange, onCropsChange, handlePointerMove, onCropChange, previewLayout, stopDragging]
  );

  const seekToFrame = useCallback(
    (frame) => {
      const video = videoRef.current;
      if (!video || totalFrames <= 0) return;
      const clamped = Math.max(0, Math.min(frame, totalFrames - 1));
      const targetTime = clamped / fps;

      video.currentTime = targetTime;
      setCurrentFrame(clamped); // optimistic; confirmed/corrected below once the seek actually lands

      // Prefer requestVideoFrameCallback: fires once a real decoded frame has
      // been presented, so metadata.mediaTime is the true landed position --
      // not a transient mid-seek value the way `timeupdate` can be.
      if (video.requestVideoFrameCallback) {
        video.requestVideoFrameCallback((_now, metadata) => {
          setCurrentFrame(timeToFrame(metadata.mediaTime, fps));
        });
      }
      // else: the 'seeked' listener below covers browsers without rVFC support.
    },
    [fps, totalFrames]
  );

  useEffect(() => {
    // Reset when source changes
    setCurrentFrame(0);
    setInFrame(null);
    setOutFrame(null);
    setReady(false);
    setPreviewLayout(null);
  }, [source?.id]);

  useEffect(() => {
    const video = videoRef.current;
    const stage = stageRef.current;
    if (!video || !stage) return undefined;

    syncPreviewSize();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", syncPreviewSize);
      return () => window.removeEventListener("resize", syncPreviewSize);
    }

    const observer = new ResizeObserver(() => syncPreviewSize());
    observer.observe(video);
    observer.observe(stage);
    window.addEventListener("resize", syncPreviewSize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncPreviewSize);
    };
  }, [syncPreviewSize, source?.id]);

  const handleLoadedMetadata = () => {
    syncPreviewSize();
    setReady(true);
  }

  const handleSeeked = () => {
    // Fallback authoritative sync for browsers without requestVideoFrameCallback.
    const video = videoRef.current;
    if (!video || video.requestVideoFrameCallback) return; // rVFC already handled it
    setCurrentFrame(timeToFrame(video.currentTime, fps));
  };

  const stepFrame = (delta) => {
    const video = videoRef.current;
    if (!video || !ready) return;
    video.pause();
    seekToFrame(currentFrame + delta);
  };

  const handleScrub = (e) => {
    if (!ready) return;
    const frame = Number(e.target.value);
    seekToFrame(frame);
  };

  const handleTimeUpdate = () => {
    // Only trust timeupdate during actual playback progression, never mid-seek
    // (video.seeking is true while the browser is still decoding toward a
    // seek target, and currentTime during that window can be a transient
    // intermediate position rather than the real destination).
    const video = videoRef.current;
    if (!video || video.seeking) return;
    setCurrentFrame(timeToFrame(video.currentTime, fps));
  };

  const resetCrop = () => {
    if (!source?.width || !source?.height) return;
    const defaultRect = { x:0, y: 0, width: source.width, height: source.height };

    if (propCropMode === "single" && clip && onCropChange) {
      onCropChange({
        ...clip,
        operations: {
          ...clip.operations,
          transform: {
            ...clip.operations.transform,
            crop: defaultRect,
          },
        },
      });
    } else if (propCropMode === "transition" && onCropTransitionChange) {
      onCropTransitionChange({
        start: defaultRect,
        end: defaultRect,
      });
    } else if (propCropMode === "multi" && onCropsChange) {
      onCropsChange([defaultRect]);
    }
  };

  if (!source) {
    return <div className="frame-preview empty">Upload a video to start scrubbing frames.</div>;
  }

  if (source.proxy_status !== "ready") {
    return (
      <div className="frame-preview empty">
        Generating preview proxy... ({source.proxy_status})
      </div>
    );
  }

  if (!visible) return null;

  const cropColors = ["#4a90e2", "#f5a623", "#7ed321", "#e84393", "#9b9b9b"];

  const renderCropOverlay = (cropPreviewRect, label, color, metadata) => {
    if (!cropPreviewRect || !previewLayout) return null;

    return (
      <div
        key={label}
        className="crop-overlay"
        aria-hidden="true"
        style={{
          left: `${previewLayout.left}px`,
          top: `${previewLayout.top}px`,
          width: `${previewLayout.width}px`,
          height: `${previewLayout.height}px`,
          pointerEvents: "none",
        }}
      >
        <div className="crop-mask crop-mask-top" style={{ height: `${cropPreviewRect.y}px`, backgroundColor: `${color}40` }} />
        <div 
          className="crop-mask crop-mask-left"
          style={{
            top: `${cropPreviewRect.y}px`,
            width: `${cropPreviewRect.x}px`,
            height: `${cropPreviewRect.height}px`,
            backgroundColor: `${color}40`,
          }}
        />
        <div 
          className="crop-mask crop-mask-right"
          style={{
            top: `${cropPreviewRect.y}px`,
            left: `${cropPreviewRect.x + cropPreviewRect.width}px`,
            height: `${cropPreviewRect.height}px`,
            backgroundColor: `${color}40`,
          }}
        />
        <div 
          className="crop-mask crop-mask-bottom"
          style={{
            top: `${cropPreviewRect.y + cropPreviewRect.height}px`,
            backgroundColor: `${color}40`,
          }}
        />
        <div
          className="crop-box"
          style={{
            left: `${cropPreviewRect.x}px`,
            top: `${cropPreviewRect.y}px`,
            width: `${cropPreviewRect.width}px`,
            height: `${cropPreviewRect.height}px`,
            borderColor: color,
            pointerEvents: "auto",
          }}
          onPointerDown={startDragging("move", metadata)}
        >
          <div
            className="crop-label"
            style={{ backgroundColor: color, color: "white" }}
          >
            {label}
          </div>
          {[
            ["nw", "crop-handle nw"],
            ["n", "crop-handle n"],
            ["ne", "crop-handle ne"],
            ["e", "crop-handle e"],
            ["se", "crop-handle se"],
            ["s", "crop-handle s"],
            ["sw", "crop-handle sw"],
            ["w", "crop-handle w"],
          ].map(([mode, className]) => (
            <button 
              key={mode}
              type="button"
              className={className}
              style={{ borderColor: color }}
              onPointerDown={startDragging(mode, metadata)}
              aria-label={`Resize crop ${mode}`}
            />
          ))}
        </div>
      </div>
    );
  };
 
  return (
    <div className="frame-preview">
      <div className="frame-preview-header">
        <span className="frame-preview-title">Frame Preview</span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="Hide this frame preview"
          >
            ✕ Close preview
          </button>
        )}
      </div>
      <div ref={stageRef} className="preview-stage">
        <video
          ref={videoRef}
          src={source._proxyUrl}
          onLoadedMetadata={handleLoadedMetadata}
          onTimeUpdate={handleTimeUpdate}
          onSeeked={handleSeeked}
          className="preview-video"
          playsInline
        >
          <track kind="captions" label="Captions" srcLang="en" src={null} />
        </video>
        {shouldShowSingleCrop && (
          renderCropOverlay(cropPreview, "Crop", "#4a90e2", {})
        )}
        {shouldShowTransitionCrop && (
          <>
            {renderCropOverlay(
              sourceCropToPreviewCrop(cropTransition?.start, source, previewLayout),
              "Start",
              "#4a90e2",
              { target: "start" }
            )}
            {renderCropOverlay(
              sourceCropToPreviewCrop(cropTransition?.end, source, previewLayout),
              "End",
              "#f5a623",
              { target: "end" }
            )}
            {transitionCropPreview && (
              <div 
                className="crop-overlay-animated" 
                aria-hidden="true"
                style={{
                  left: `${previewLayout.left}px`,
                  top: `${previewLayout.top}px`,
                  width: `${previewLayout.width}px`,
                  height: `${previewLayout.height}px`,
                }}
              >
                <div
                  className="crop-box animated"
                  style={{
                    left: `${transitionCropPreview.x}px`,
                    top: `${transitionCropPreview.y}px`,
                    width: `${transitionCropPreview.width}px`,
                    height: `${transitionCropPreview.height}px`,
                    borderColor: "#7ed321",
                    pointerEvents: "none",
                  }}
                >
                  <div
                    className="crop-label"
                    style={{ backgroundColor: "#7ed321", color: "white" }}
                  >
                    Live
                  </div>
                </div>
              </div>
            )}
          </>
        )}
        {shouldShowMultipleCrops &&
          crops.map((cropData, idx) => {
            const cropPreviewData = sourceCropToPreviewCrop(cropData, source, previewLayout);
            return renderCropOverlay(
              cropPreviewData,
              `Crop ${idx + 1}`,
              cropColors[idx % cropColors.length],
              { index: idx }
            );
          })
        }
      </div>

      {!ready && <div className="dim">Loading video...</div>}

      {shouldShowSingleCrop && (
        <div className="crop-readout-row">
          <div className="crop-readout mono dim">
            Crop keeps {crop.width}x{crop.height} at ({crop.x}, {crop.y}) in source space
          </div>
          <button type="button" onClick={resetCrop} className="crop-reset-button">
            Reset Crop
          </button>
        </div>
      )}

      {shouldShowTransitionCrop && (
        <div className="crop-readout-row">
          <div className="crop-readout mono dim">
            Start: {cropTransition?.start?.width}x{cropTransition?.start?.height} at ({cropTransition?.start?.x}, {cropTransition?.start?.y})
            End: {cropTransition?.end?.width}x{cropTransition?.end?.height} at ({cropTransition?.end?.x}, {cropTransition?.end?.y})
          </div>
          <button type="button" onClick={resetCrop} className="crop-reset-button">
            Reset Crop
          </button>
        </div>
      )}

      {shouldShowMultipleCrops && (
        <div className="crop-readout-row">
          <div className="crop-readout mono dim">
            {crops.length} crop{crops.length !== 1 ? "s" : ""} defined
          </div>
          <button type="button" onClick={resetCrop} className="crop-reset-button">
            Reset Crop
          </button>
        </div>
      )}

      <div className="frame-readout">
        Frame <span className="mono">{currentFrame}</span> / {totalFrames - 1}
        <span className="dim"> &nbsp;({(currentFrame / fps).toFixed(3)}s)</span>
      </div>

      <input
        type="range"
        min={0}
        max={Math.max(totalFrames - 1, 0)}
        value={currentFrame}
        onChange={handleScrub}
        disabled={!ready}
        className="scrub-bar"
      />

      <div className="frame-controls">
        <button onClick={() => stepFrame(-10)} disabled={!ready} title="Back 10 frames">⏪ 10</button>
        <button onClick={() => stepFrame(-1)} disabled={!ready} title="Previous frame">◀ Frame</button>
        <button
          disabled={!ready}
          onClick={() => {
            const v = videoRef.current;
            if (v.paused) v.play();
            else v.pause();
          }}
        >
          ▶/⏸
        </button>
        <button onClick={() => stepFrame(1)} disabled={!ready} title="Next frame">Frame ▶</button>
        <button onClick={() => stepFrame(10)} disabled={!ready} title="Forward 10 frames">10 ⏩</button>
      </div>

      <div className="mark-controls">
        <button onClick={() => setInFrame(currentFrame)} disabled={!ready}>Set In [{inFrame ?? "-"}]</button>
        <button onClick={() => setOutFrame(currentFrame)} disabled={!ready}>Set Out [{outFrame ?? "-"}]</button>
        <button
          className="primary"
          disabled={inFrame === null || outFrame === null || outFrame <= inFrame}
          onClick={() => {
            onMarkRange(inFrame, outFrame - 1); // end_frame is exclusive
            setInFrame(null);
            setOutFrame(null);
          }}
        >
          + Add Clip to Timeline
        </button>
      </div>
    </div>
  );
}