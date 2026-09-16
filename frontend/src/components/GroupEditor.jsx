import { useState } from "react";
import { api } from "../api";
import { defaultGroupOperations, defaultMetronome, defaultRamp } from "../edl";


export default function GroupEditor({ group, onChange }) {
    const [soundUploadStatus, setSoundUploadStatus] = useState("");

    if(!group) {
        return <div className="clip-editor empty">Select a group in the timeline to edit its audio</div>;
    }

    const ops = group.operations || defaultGroupOperations();
    const metronome = ops.audio.metronome || defaultMetronome();

    const update = (patch) => onChange({ ...group, operations: { ...ops, ...patch } });
    const updateAudio = (patch) => update({ audio: { ...ops.audio, ...patch } });
    const updateMetronome = (patch) => updateAudio({ metronome: { ...metronome, ...patch } });
    const updateRamp = (patch) => updateMetronome({ ramp: { ...(metronome.ramp || defaultRamp()), ...patch } });

    const handleModeChange = (mode) => {
        if (mode === "metronome" && !ops.audio.metronome) {
            updateAudio({ mode, metronome: defaultMetronome() });
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
            <div className="dim mono">Group Audio</div>

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
                    own mode overrides this
                </div>
            </section>

            {ops.audio.mode === "metronome" && (
                <section>
                    <h4>Metronome</h4>

                    <label className="field-label">
                        Tempo:
                        <select value={metronome.tempo_mode} onChange={(e) => updateMetronome({ tempo_mode: e.target.value })}>
                            <option value="bpm">Fixed BPM</option>
                            <option value="beat_count">Beat count (spread evenly over the group)</option>
                        </select>
                    </label>

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
                        Number of beats across the whole group:
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
                        Place a final beat exactly on the group's last frame
                    </label>

                    <div className="dim">
                        Off by default: beats are spaced so each one marks the start of an interval, which keeps clip-to-clip
                        transitions inside the group evenly spaced. Turning this on adds one extra beat right at the very end
                        of the group only -- never at the internal boundary between clips.
                    </div>

                    <label className="row">
                        <input 
                            type="checkbox" 
                            checked={!!metronome.ramp}
                            onChange={(e) => toggleRamp(e.target.checked)}
                        />
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
                        <label className="field-label">
                            Click sound (optional -- leave empty for a synthesized click )
                        </label>
                        <input type="file" accept="audio/*" onChange={handleSoundUpload} />
                        {soundUploadStatus && <div className="dim">{soundUploadStatus}</div>}
                    </div>
                </section>
            )}
        </div>
    );
}