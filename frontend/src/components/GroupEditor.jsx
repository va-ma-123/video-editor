import { useState } from "react";
import { api } from "../api";
import { defaultGroupOperations, defaultMetronome, defaultRamp } from "../edl";

// Group-level counterpart to ClipEditor. Groups only carry an audio block --
// trim/speed/freeze/transform/fade all stay per-clip -- so this editor is
// deliberately much smaller than ClipEditor, not a re-skin of it.
function clampSplit(raw) {
  return Math.max(0.1, Math.min(Number(raw) || 0.5, 0.9));
}

const DEFAULT_QUADRANTS = ["a", "b", "a", "b"];

function getCompositeState(video) {
  const legacySplit = clampSplit(video.split ?? 0.5);
  const splitX = clampSplit(
    video.split_x ?? (video.layout === "horizontal_split" ? 0.5 : legacySplit)
  );
  const splitY = clampSplit(
    video.split_y ?? (video.layout === "horizontal_split" ? legacySplit : 0.5)
  );

  let quadrants = Array.isArray(video.quadrants) ? video.quadrants : null;
  if (!quadrants || quadrants.length !== 4 || quadrants.some((value) => value !== "a" && value !== "b")) {
    quadrants = video.layout === "horizontal_split"
      ? ["a", "a", "b", "b"]
      : DEFAULT_QUADRANTS;
  }

  return { splitX, splitY, quadrants };
}

function compositeEligibility(group, directClips, hasNestedGroups) {
  if (group.parent_group_id) {
    return { eligible: false, reason: "Composite groups can't be nested inside another group." };
  }
  if (hasNestedGroups) {
    return { eligible: false, reason: "Composite groups can't contain nested groups." };
  }
  if (directClips.length !== 2) {
    return { eligible: false, reason: "Composite groups need exactly 2 direct clips." };
  }
  return { eligible: true, reason: null };
}

export default function GroupEditor({ group, memberClips, directMemberClips, hasNestedGroups, onChange }) {
  const [soundUploadStatus, setSoundUploadStatus] = useState("");

  if (!group) {
    return <div className="clip-editor empty">Select a group in the timeline to edit its audio.</div>;
  }

  // Tolerate groups saved before group-level operations existed.
  const ops = group.operations || defaultGroupOperations();
  const metronome = ops.audio.metronome || defaultMetronome();
  const video = ops.video || defaultGroupOperations().video;
  const directClips = directMemberClips || [];
  const { eligible: compositeEligible, reason: compositeReason } = compositeEligibility(group, directClips, hasNestedGroups);

  const update = (patch) => onChange({ ...group, operations: { ...ops, ...patch } });
  const updateAudio = (patch) => update({ audio: { ...ops.audio, ...patch } });
  const updateVideo = (patch) => update({ video: { ...video, ...patch } });
  const updateMetronome = (patch) => updateAudio({ metronome: { ...metronome, ...patch } });
  const updateRamp = (patch) => updateMetronome({ ramp: { ...(metronome.ramp || defaultRamp()), ...patch } });

  const { splitX, splitY, quadrants } = getCompositeState(video);

  const handleModeChange = (mode) => {
    // Seed a fresh metronome config the first time this group switches into
    // metronome mode; once it exists, leave it in place across mode
    // switches so toggling back doesn't lose the user's settings.
    if (mode === "metronome" && !ops.audio.metronome) {
      const firstMember = memberClips?.[0];
      const lastMember = memberClips?.[memberClips.length - 1];
      updateAudio({
        mode,
        metronome: defaultMetronome({
          startClipId: firstMember?.id,
          endClipId: lastMember?.id,
          startFrame: firstMember?.startFrame,
          endFrame: lastMember?.endFrame,
        }),
      });
    } else {
      updateAudio({ mode });
    }
  };

  const toggleRamp = (enabled) => updateMetronome({ ramp: enabled ? defaultRamp() : null });

  const enableComposite = () => {
    if(!compositeEligible) return;
    updateVideo({ mode: "composite" });
  }

  const disableComposite = () => updateVideo({ mode: "sequential" });

  const startDividerDrag = (axis, event) => {
    event.preventDefault();
    const preview = event.currentTarget.parentElement;
    const rect = preview.getBoundingClientRect();

    const handlePointerMove = (moveEvent) => {
      if (axis === "x") {
        const ratio = (moveEvent.clientX - rect.left) / rect.width;
        updateVideo({ split_x: clampSplit(ratio) });
      } else if (axis === "y") {
        const ratio = (moveEvent.clientY - rect.top) / rect.height;
        updateVideo({ split_y: clampSplit(ratio) });
      } else {
        const x = (moveEvent.clientX - rect.left) / rect.width;
        const y = (moveEvent.clientY - rect.top) / rect.height;
        updateVideo({ split_x: clampSplit(x), split_y: clampSplit(y) });
      }
    };

    const stopDragging = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);
  };

  const toggleQuadrant = (index) => {
    const next = [...quadrants];
    next[index] = next[index] === "a" ? "b" : "a";
    updateVideo({ quadrants: next });
  };

  const handleSoundUpload = async (e) => {
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
      <h3>{group.name}</h3>
      <div className="dim mono">Group settings</div>
      
      <section>
        <h4>Playback</h4>
        <div className="row composite-mode-row">
          <button 
            type="button" 
            className={video.mode === "composite" ? "primary" : ""}
            onClick={enableComposite}
            disabled={!compositeEligible}
            title={compositeReason || "Render these 2 clips side-by-side"}
          >
            Play side-by-side
          </button>
          {video.mode === "composite" && (
            <button type="button" onClick={disableComposite}>Back to sequential</button>
          )}
        </div>
        {compositeReason && <div className="dim">{compositeReason}</div>}

        {video.mode === "composite" && compositeEligible && (
          <div className="composite-editor">
            <div className="composite-preview">
              {[
                { index: 0, label: "top-left", x: 0, y: 0 },
                { index: 1, label: "top-right", x: 1, y: 0 },
                { index: 2, label: "bottom-left", x: 0, y: 1 },
                { index: 3, label: "bottom-right", x: 1, y: 1 },
              ].map(({ index, label, x, y }) => {
                const isA = quadrants[index] === "a";
                const left = x === 0 ? 0 : splitX * 100;
                const top = y === 0 ? 0 : splitY * 100;
                const width = (x === 0 ? splitX : 1 - splitX) * 100;
                const height = (y === 0 ? splitY : 1 - splitY) * 100;

                return (
                  <button
                    key={label}
                    type="button"
                    className={`composite-quadrant ${isA ? "source-a" : "source-b"}`}
                    style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
                    onClick={() => toggleQuadrant(index)}
                    aria-label={`${label}: ${isA ? "Clip 1" : "Clip 2"}. Click to switch source.`}
                  >
                    <span className="composite-pane-label">
                      {isA ? (directClips[0]?.filename || "Clip 1") : (directClips[1]?.filename || "Clip 2")}
                    </span>
                  </button>
                );
              })}

              <button
                type="button"
                className="composite-divider vertical_split"
                style={{ left: `${splitX * 100}%` }}
                onPointerDown={(event) => startDividerDrag("x", event)}
                aria-label="Adjust vertical divider"
              />
              <button
                type="button"
                className="composite-divider horizontal_split"
                style={{ top: `${splitY * 100}%` }}
                onPointerDown={(event) => startDividerDrag("y", event)}
                aria-label="Adjust horizontal divider"
              />
              <button
                type="button"
                className="composite-intersection"
                style={{ left: `${splitX * 100}%`, top: `${splitY * 100}%` }}
                onPointerDown={(event) => startDividerDrag("both", event)}
                aria-label="Move both dividers"
              />
            </div>

            <div className="row composite-controls">
              <label className="field-label small">
                X
                <input
                  type="number"
                  min="10"
                  max="90"
                  step="1"
                  value={Math.round(splitX * 100)}
                  onChange={(e) => updateVideo({ split_x: clampSplit(Number(e.target.value) / 100) })}
                />
              </label>
              <label className="field-label small">
                Y
                <input
                  type="number"
                  min="10"
                  max="90"
                  step="1"
                  value={Math.round(splitY * 100)}
                  onChange={(e) => updateVideo({ split_y: clampSplit(Number(e.target.value) / 100) })}
                />
              </label>
            </div>

            <div className="dim mono">
              Click a quadrant to switch between Clip 1 and Clip 2. Drag the vertical or horizontal divider to
              reposition it, or drag the center handle to move both at once.
            </div>
          </div>
        )}
      </section>
      <section>
        <h4>Audio</h4>
        <label className="field-label">
          Mode:
          <select value={ops.audio.mode} onChange={(e) => handleModeChange(e.target.value)}>
            <option value="inherit">Inherit (from parent group, or original if none)</option>
            <option value="original">Original</option>
            <option value="muted">Muted</option>
            <option value="metronome">Metronome</option>
          </select>
        </label>
        <div className="dim">
          Applies to every clip in this group whose own audio mode is left on "inherit". A clip that sets its
          own mode overrides this.
        </div>
      </section>

      {ops.audio.mode === "metronome" && (
        <section>
          <h4>Metronome</h4>

          <label className="field-label">
            Tempo:
            <select value={metronome.tempo_mode} onChange={(e) => updateMetronome({ tempo_mode: e.target.value })}>
              <option value="bpm">Fixed BPM</option>
              <option value="beat_count">Beat count (spread evenly over the range below)</option>
            </select>
          </label>

          {memberClips && memberClips.length > 0 && (() => {
            const firstMember = memberClips[0];
            const lastMember = memberClips[memberClips.length - 1];

            const startClip = memberClips.find((c) => c.id === metronome.start_clip_id) || firstMember;
            const endClip = memberClips.find((c) => c.id === metronome.end_clip_id) || lastMember;
          
            return (
              <>
                <div className="row">
                  <label className="field-label small">
                    Start clip
                    <select
                      value={startClip.id}
                      onChange={(e) => {
                        const chosen = memberClips.find((c) => c.id === e.target.value);
                        // Reset the frame to the newly chosen clip's own
                        // start -- carrying over the old frame number could
                        // land outside this clip's actual range.
                        updateMetronome({ start_clip_id: chosen.id, start_frame: chosen.startFrame });
                      }}
                    >
                      {memberClips.map((c) => (
                        <option key={c.id} value={c.id}>
                          Clip {c.index + 1} (frames {c.startFrame}\u2013{c.endFrame})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field-label small">
                    First beat at frame
                    <input
                      type="number"
                      min={startClip.startFrame}
                      max={startClip.endFrame}
                      step="1"
                      value={metronome.start_frame ?? startClip.startFrame}
                      onChange={(e) => updateMetronome({ start_frame: parseInt(e.target.value, 10) })}
                    />
                  </label>
                </div>
                <div className="row">
                  <label className="field-label small">
                    End clip
                    <select
                      value={endClip.id}
                      onChange={(e) => {
                        const chosen = memberClips.find((c) => c.id === e.target.value);
                        updateMetronome({ end_clip_id: chosen.id, end_frame: chosen.endFrame });
                      }}
                    >
                      {memberClips.map((c) => (
                        <option key={c.id} value={c.id}>
                          Clip {c.index + 1} (frames {c.startFrame}\u2013{c.endFrame})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field-label small">
                    Last beat at frame
                    <input
                      type="number"
                      min={endClip.startFrame}
                      max={endClip.endFrame}
                      step="1"
                      value={metronome.end_frame ?? endClip.endFrame}
                      onChange={(e) => updateMetronome({ end_frame: parseInt(e.target.value, 10) })}
                    />
                  </label>
                </div>
                <div className="dim">
                  Defaults to the start of the first clip and the end of the last clip. Pick different clips and/or
                  frames to have the metronome only cover part of the group -- even just one clip in the middle.
                </div>
              </>
            );
          })()}

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
              Number of beats across that range:
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
            Place a final beat exactly on the last frame above
          </label>
          <div className="dim">
            Off by default: beats are spaced so each one marks the start of an interval, which keeps clip-to-clip
            transitions inside the group evenly spaced. Turning this on adds one extra beat right at the very end
            of the group only -- never at the internal boundary between clips.
          </div>

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

          <div className="sub-fields">
            <label className="field-label">Click sound (optional -- leave empty for a synthesized click)</label>
            <input type="file" accept="audio/*" onChange={handleSoundUpload} />
            {soundUploadStatus && <div className="dim">{soundUploadStatus}</div>}
          </div>
        </section>
      )}
    </div>
  );
}