// Mirrors backend/app/models.py ClipOperations -- keep in sync.
export function defaultOperations() {
  return {
    reverse: false,
    speed: { factor: 1.0, pitch_correction: true },
    freeze_frame: null,
    transform: { crop: null, rotate: 0, flip: null },
    fade: { fade_in: { duration_sec: 0 }, fade_out: { duration_sec: 0 } },
    audio: { mode: "inherit", volume: 1.0, replacement_asset_id: null, replacement_start_sec: 0, metronome: null },
  };
}

export function defaultMetronome({ startClipId = null, endClipId = null,  startFrame = null, endFrame = null } = {}) {
  return {
    tempo_mode: "bpm", // bpm or beat_count
    bpm: 120,
    beat_count: 8,
    // only ever do at the end of a clip or 
    include_end_beat: false,
    ramp: null, // or { direction, every_n_beats, change_amount, change_unit, min_bpm, max_bpm }
    sound_asset_id: null, // null = backend-synthesized click, can override with your own metronome
    start_clip_id: startClipId,
    end_clip_id: endClipId,
    start_frame: startFrame,
    end_frame: endFrame,
  };
}

export function defaultRamp() {
  return {
    direction: "accelerate", // or decelerate
    every_n_beats: 4,
    change_amount: 5,
    change_unit: "bpm", // or percent
    min_bpm: 20,
    max_bpm: 300,
  };
}

// Mirrors backend/app/models.py GroupOperations -- keep in sync.
// Groups only carry an audio block for now for group-wide muting and metronome
export function defaultGroupOperations() {
  return {
    audio: { mode: "inherit", metronome: null },
  };
}

export function newClipId() {
  return "clip_" + Math.random().toString(16).slice(2, 12);
}

export function frameToTime(frame, fps) {
  return frame / fps;
}

export function timeToFrame(time, fps) {
  return Math.round(time * fps);
}

// Rough estimate of a clip's output duration after speed + freeze, for display only.
export function estimateClipDuration(clip, fps) {
  const trimFrames = clip.end_frame - clip.start_frame;
  const trimSec = trimFrames / fps;
  const speed = clip.operations.speed.factor || 1.0;
  const freeze = clip.operations.freeze_frame ? clip.operations.freeze_frame.duration_sec : 0;
  return trimSec / speed + freeze;
}

export function formatSec(s) {
  if (!isFinite(s)) return "0.0s";
  return `${s.toFixed(2)}s`;
}
