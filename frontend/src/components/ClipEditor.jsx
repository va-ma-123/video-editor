import { useEffect, useState } from "react";
import { api } from "../api";
import { defaultMetronome, defaultRamp } from "../edl";

export default function ClipEditor({ clip, source, onChange }) {
  const [audioUploadStatus, setAudioUploadStatus] = useState("");
  const [soundUploadStatus, setSoundUploadStatus] = useState("");
  const [startDraft, setStartDraft] = useState("");
  const [endDraft, setEndDraft] = useState("");

  useEffect(() => {
    if(clip) {
      setStartDraft(String(clip.start_frame));
      setEndDraft(String(clip.end_frame));
    }
  }, [clip?.id]);

  if (!clip) {
    return <div className="clip-editor empty">Select a clip in the timeline to edit its operations.</div>;
  }

  const ops = clip.operations;
  const maxFrame = source?.total_frames || Infinity;

  const update = (patch) => onChange({ ...clip, operations: { ...ops, ...patch } });

  const updateSpeed = (patch) => update({ speed: { ...ops.speed, ...patch } });
  const updateTransform = (patch) => update({ transform: { ...ops.transform, ...patch } });
  const updateAudio = (patch) => update({ audio: { ...ops.audio, ...patch } });
  const updateFade = (patch) => update({ fade: { ...ops.fade, ...patch } });

  const metronome = ops.audio.metronome || defaultMetronome();
  const updateMetronome = (patch) => updateAudio({ metronome: { ...metronome, ...patch } });
  const updateRamp = (patch) => updateMetronome({ ramp: { ...metronome.ramp || defaultRamp(), ...patch } });
  const toggleRamp = (enabled) => updateMetronome({ ramp: enabled ? defaultRamp() : null });

  const handleAudioModeChange = (mode) => {
    if (mode === "metronome" && !ops.audio.metronome) {
      updateAudio({ mode, metronome: defaultMetronome() });
    } else {
      updateAudio({ mode });
    }
  };

  const toggleFreeze = (enabled) => {
    update({ freeze_frame: enabled ? { position: "end", duration_sec: 1.0 } : null });
  };

  const clampCrop = (crop) => {
    const maxWidth = Math.max(source?.width || 640, 1);
    const maxHeight = Math.max(source?.height || 360, 1);
    const width = Math.max(1, Math.min(parseInt(crop.width, 10) || maxWidth, maxWidth));
    const height = Math.max(1, Math.min(parseInt(crop.height, 10) || maxHeight, maxHeight));
    const x = Math.max(0, Math.min(parseInt(crop.x, 10) || 0, maxWidth - width));
    const y = Math.max(0, Math.min(parseInt(crop.y, 10) || 0, maxHeight - height));
    return { x, y, width, height };
  };

  const updateCrop = (patch) => {
    const nextCrop = clampCrop({ ...ops.transform.crop, ...patch });
    updateTransform({ crop: nextCrop });
  };

  const toggleCrop = (enabled) => {
    updateTransform({ crop: enabled ? { x: 0, y: 0, width: 640, height: 360 } : null });
  };

  const applyRange = () => {
    let rawStart = parseInt(startDraft, 10);
    let rawEnd = parseInt(endDraft, 10);
    if (isNaN(rawStart)) rawStart = clip.start_frame;
    if (isNaN(rawEnd)) rawEnd = clip.end_frame;
 
    // Clamp both together (not independently) so typing a new start doesn't
    // get fought by a stale end value, or vice versa.
    let clampedStart = Math.max(0, Math.min(rawStart, maxFrame - 1));
    let clampedEnd = Math.max(clampedStart + 1, Math.min(rawEnd, maxFrame));
    if (clampedStart >= clampedEnd) clampedStart = Math.max(0, clampedEnd - 1);
 
    onChange({ ...clip, start_frame: clampedStart, end_frame: clampedEnd });
    setStartDraft(String(clampedStart));
    setEndDraft(String(clampedEnd));
  };

  const handleRangeKeyDown = (e) => {
    if (e.key === "Enter") {
      e.target.blur(); // triggers the blur handler's applyRange below
    }
  };
 
  const isRangeDirty = startDraft !== String(clip.start_frame) || endDraft !== String(clip.end_frame);

  const handleAudioFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setAudioUploadStatus("uploading...");
    try {
      const asset = await api.uploadAudioAsset(file);
      updateAudio({ mode: "replaced", replacement_asset_id: asset.id });
      setAudioUploadStatus(`loaded: ${asset.filename}`);
    } catch (err) {
      setAudioUploadStatus(`failed: ${err.message}`);
    }
  };

  const handleMetronomeSoundUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setSoundUploadStatus("uploading...");
    try {
      const asset = await api.uploadAudioAsset(file);
      updateMetronome({ sound_asset_id: asset.id });
      setSoundUploadStatus(`loaded: ${asset.filename}`);
    } catch (err) {
      setSoundUploadStatus(`failed: ${err.message}`);
    }
  };

  return (
    <div className="clip-editor">
      <h3>Trim Range</h3>
      <section>
        <div className="crop-fields">
          <label className="field-label small">
            Start
            <input 
              type="number"
              value={startDraft}
              onChange={(e) => setStartDraft(e.target.value)}
              onBlur={applyRange}
              onKeyDown={handleRangeKeyDown}
            />
          </label>
          <label className="field-label small">
            End
            <input 
              type="number"
              value={endDraft}
              onChange={(e) => setEndDraft(e.target.value)}
              onBlur={applyRange}
              onKeyDown={handleRangeKeyDown}
            />
          </label>
          <button
            className={isRangeDirty ? "primary" : ""}
            onClick={applyRange}
            disabled={!isRangeDirty}
            title="Apply the typed range"
          >
            Apply
          </button>
        </div>
        {source && (
          <div className="dim mono">
            {clip.end_frame - clip.start_frame} frames of {source.total_frames} available
            {isRangeDirty && " · unapplied changes"}
          </div>
        )}
      </section>

      <h3>Clip operations</h3>

      <section>
        <label className="row">
          <input type="checkbox" checked={ops.reverse} onChange={(e) => update({ reverse: e.target.checked })} />
          Reverse
        </label>
      </section>

      <section>
        <label className="field-label">Speed: {ops.speed.factor.toFixed(2)}x</label>
        <input
          type="range"
          min="0.1"
          max="5"
          step="0.1"
          value={ops.speed.factor}
          onChange={(e) => updateSpeed({ factor: parseFloat(e.target.value) })}
        />
        <label className="row">
          <input
            type="checkbox"
            checked={ops.speed.pitch_correction}
            onChange={(e) => updateSpeed({ pitch_correction: e.target.checked })}
            disabled={ops.speed.factor === 1.0}
          />
          Correct pitch (off = natural pitch shift)
        </label>
      </section>

      <section>
        <label className="row">
          <input type="checkbox" checked={!!ops.freeze_frame} onChange={(e) => toggleFreeze(e.target.checked)} />
          Freeze frame
        </label>
        {ops.freeze_frame && (
          <div className="sub-fields">
            <label className="field-label">
              Position:
              <select
                value={ops.freeze_frame.position}
                onChange={(e) => update({ freeze_frame: { ...ops.freeze_frame, position: e.target.value } })}
              >
                <option value="start">Start</option>
                <option value="end">End</option>
              </select>
            </label>
            <label className="field-label">
              Hold duration (sec):
              <input
                type="number"
                min="0.1"
                step="0.1"
                value={ops.freeze_frame.duration_sec}
                onChange={(e) =>
                  update({ freeze_frame: { ...ops.freeze_frame, duration_sec: parseFloat(e.target.value) || 0 } })
                }
              />
            </label>
          </div>
        )}
      </section>

      <section>
        <label className="field-label">Fade in (sec)</label>
        <input
          type="number"
          min="0"
          step="0.1"
          value={ops.fade.fade_in.duration_sec}
          onChange={(e) => updateFade({ fade_in: { duration_sec: parseFloat(e.target.value) || 0 } })}
        />
        <label className="field-label">Fade out (sec)</label>
        <input
          type="number"
          min="0"
          step="0.1"
          value={ops.fade.fade_out.duration_sec}
          onChange={(e) => updateFade({ fade_out: { duration_sec: parseFloat(e.target.value) || 0 } })}
        />
      </section>

      <section>
        <h4>Audio</h4>
        <label className="field-label">
          Mode:
          <select value={ops.audio.mode} onChange={(e) => handleAudioModeChange(e.target.value)}>
            <option value="inherit">Inherit (from group, or original if ungrouped)</option>
            <option value="original">Original</option>
            <option value="muted">Muted</option>
            <option value="replaced">Replace with file</option>
            <option value="metronome">Metronome</option>
          </select>
        </label>

        {ops.audio.mode === "original" && (
          <label className="field-label">
            Volume: {ops.audio.volume.toFixed(2)}x
            <input
              type="range"
              min="0"
              max="3"
              step="0.05"
              value={ops.audio.volume}
              onChange={(e) => updateAudio({ volume: parseFloat(e.target.value) })}
            />
          </label>
        )}

        {ops.audio.mode === "replaced" && (
          <div className="sub-fields">
            <input type="file" accept="audio/*,video/*" onChange={handleAudioFileUpload} />
            {audioUploadStatus && <div className="dim">{audioUploadStatus}</div>}
            <label className="field-label">
              Start offset in replacement (sec):
              <input
                type="number"
                min="0"
                step="0.1"
                value={ops.audio.replacement_start_sec}
                onChange={(e) => updateAudio({ replacement_start_sec: parseFloat(e.target.value) || 0 })}
              />
            </label>
          </div>
        )}

        {ops.audio.mode === "metronome" && (
          <div className="sub-fields">
            <label className="field-label">
              Tempo:
              <select value={metronome.tempo_mode} onChange={(e) => updateMetronome({ tempo_mode: e.target.value })}>
                <option value="bpm">Fixed BPM</option>
                <option value="beat_count">Beat count (spread evenly over this clip)</option>
              </select>
            </label>

            <div className="row">
              <label className="field-label small">
                First beat at frame
                <input
                  type="number"
                  min={clip.start_frame}
                  max={clip.end_frame}
                  step="1"
                  value={metronome.start_frame ?? clip.start_frame}
                  onChange={(e) => updateMetronome({ start_frame: parseInt(e.target.value, 10) })}
                />
              </label>
              <label className="field-label small">
                Last beat at frame
                <input
                  type="number"
                  min={clip.start_frame}
                  max={clip.end_frame}
                  step="1"
                  value={metronome.end_frame ?? clip.end_frame}
                  onChange={(e) => updateMetronome({ end_frame: parseInt(e.target.value, 10) })}
                />
              </label>
            </div>
            <div className="dim">
              Defaults to this clip's own start and end frame. Narrow the range to have the metronome only play
              over part of the clip.
            </div>
 
            {metronome.tempo_mode === "bpm" ? (
              <label className="field-label">
                BPM{metronome.ramp ? " (starting)" : ""}:
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={metronome.bpm}
                  onChange={(e) => updateMetronome({ bpm: parseFloat(e.target.value) || 0 })}
                />
              </label>
            ) : (
              <label className="field-label">
                Number of beats across this clip:
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={metronome.beat_count}
                  onChange={(e) => updateMetronome({ beat_count: parseInt(e.target.value, 10) || 0 })}
                />
              </label>
            )}
 
            <label className="row">
              <input
                type="checkbox"
                checked={metronome.include_end_beat}
                onChange={(e) => updateMetronome({ include_end_beat: e.target.checked })}
              />
              Place a final beat exactly on this clip's last frame
            </label>
 
            <label className="row">
              <input type="checkbox" checked={!!metronome.ramp} onChange={(e) => toggleRamp(e.target.checked)} />
              Ramp tempo over time
            </label>
            {metronome.ramp && (
              <div className="sub-fields">
                <label className="field-label">
                  Direction:
                  <select value={metronome.ramp.direction} onChange={(e) => updateRamp({ direction: e.target.value })}>
                    <option value="accelerate">Speed up</option>
                    <option value="decelerate">Slow down</option>
                  </select>
                </label>
                <label className="field-label small">
                  Every
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={metronome.ramp.every_n_beats}
                    onChange={(e) => updateRamp({ every_n_beats: parseInt(e.target.value, 10) || 1 })}
                  />
                </label>
                <div className="dim">beats, change tempo by:</div>
                <label className="field-label small">
                  Amount
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={metronome.ramp.change_amount}
                    onChange={(e) => updateRamp({ change_amount: parseFloat(e.target.value) || 0 })}
                  />
                </label>
                <label className="field-label">
                  Unit:
                  <select value={metronome.ramp.change_unit} onChange={(e) => updateRamp({ change_unit: e.target.value })}>
                    <option value="bpm">BPM</option>
                    <option value="percent">% of current tempo</option>
                  </select>
                </label>
                <label className="field-label small">
                  Min BPM
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={metronome.ramp.min_bpm}
                    onChange={(e) => updateRamp({ min_bpm: parseFloat(e.target.value) || 1 })}
                  />
                </label>
                <label className="field-label small">
                  Max BPM
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={metronome.ramp.max_bpm}
                    onChange={(e) => updateRamp({ max_bpm: parseFloat(e.target.value) || 1 })}
                  />
                </label>
              </div>
            )}
            <label className="field-label">Click sound (optional -- leave empty for a synthesized click)</label>
            <input type="file" accept="audio/*" onChange={handleMetronomeSoundUpload} />
            {soundUploadStatus && <div className="dim">{soundUploadStatus}</div>}
          </div>
        )}
      </section>

      <section>
        <h4>Transform</h4>
        <label className="field-label">
          Rotate:
          <select
            value={ops.transform.rotate}
            onChange={(e) => updateTransform({ rotate: parseInt(e.target.value) })}
          >
            <option value={0}>0°</option>
            <option value={90}>90°</option>
            <option value={180}>180°</option>
            <option value={270}>270°</option>
          </select>
        </label>
        <label className="field-label">
          Flip:
          <select
            value={ops.transform.flip || ""}
            onChange={(e) => updateTransform({ flip: e.target.value || null })}
          >
            <option value="">None</option>
            <option value="horizontal">Horizontal</option>
            <option value="vertical">Vertical</option>
          </select>
        </label>

        <label className="row">
          <input type="checkbox" checked={!!ops.transform.crop} onChange={(e) => toggleCrop(e.target.checked)} />
          Crop
        </label>
        {ops.transform.crop && (
          <div className="sub-fields">
            <div className=" crop-fields">
              {["x", "y", "width", "height"].map((k) => (
                <label key={k} className="field-label small">
                  {k}
                  <input
                    type="number"
                    min={k === "width" || k === "height" ? "1" : "0"}
                    max={k === "x" || k === "width" ? source?.width || undefined : source?.height || undefined}
                    value={ops.transform.crop[k]}
                    onChange={(e) => updateCrop({ [k]: parseInt(e.target.value, 10) || 0 })}
                  />
                </label>
              ))}
            </div>
            <div className="crop-meta dim mono">
              Source pixels ⋅ max {source?.width ?? "-"}x{source?.height ?? "-"}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
