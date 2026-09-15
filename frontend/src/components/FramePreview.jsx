import { useRef, useState, useEffect, useCallback } from "react";
import { timeToFrame } from "../edl";

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
export default function FramePreview({ source, onMarkRange }) {
  const videoRef = useRef(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [inFrame, setInFrame] = useState(null);
  const [outFrame, setOutFrame] = useState(null);
  const [ready, setReady] = useState(false);

  const fps = source?.fps || 30;
  const totalFrames = source?.total_frames || 0;

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
  }, [source?.id]);

  const handleLoadedMetadata = () => setReady(true);

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

  return (
    <div className="frame-preview">
      <video
        ref={videoRef}
        src={source._proxyUrl}
        onLoadedMetadata={handleLoadedMetadata}
        onTimeUpdate={handleTimeUpdate}
        onSeeked={handleSeeked}
        className="preview-video"
        playsInline
      />

      {!ready && <div className="dim">Loading video...</div>}

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
            onMarkRange(inFrame, outFrame + 1); // end_frame is exclusive
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