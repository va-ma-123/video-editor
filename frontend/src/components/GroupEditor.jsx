import { useState } from "react";
import { api } from "../api";
import { defaultGroupOperations, defaultMetronome, defaultRamp } from "../edl";

// Group-level counterpart to ClipEditor. Groups only carry an audio block --
// trim/speed/freeze/transform/fade all stay per-clip -- so this editor is
// deliberately much smaller than ClipEditor, not a re-skin of it.
export default function GroupEditor({ group, memberClips, onChange }) {
  const [soundUploadStatus, setSoundUploadStatus] = useState("");

  if (!group) {
    return <div className="clip-editor empty">Select a group in the timeline to edit its audio.</div>;
  }

  // Tolerate groups saved before group-level operations existed.
  const ops = group.operations || defaultGroupOperations();
  const metronome = ops.audio.metronome || defaultMetronome();

  const update = (patch) => onChange({ ...group, operations: { ...ops, ...patch } });
  const updateAudio = (patch) => update({ audio: { ...ops.audio, ...patch } });
  const updateMetronome = (patch) => updateAudio({ metronome: { ...metronome, ...patch } });
  const updateRamp = (patch) => updateMetronome({ ramp: { ...(metronome.ramp || defaultRamp()), ...patch } });

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
      <div className="dim mono">Group audio</div>

      <section>
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