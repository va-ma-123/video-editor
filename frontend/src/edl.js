// Mirrors backend/app/models.py ClipOperations -- keep in sync.
export function defaultOperations() {
  return {
    reverse: false,
    speed: { factor: 1.0, pitch_correction: true },
    freeze_frame: null,
    transform: { crop: null, rotate: 0, flip: null },
    fade: { fade_in: { duration_sec: 0 }, fade_out: { duration_sec: 0 } },
    audio: { mode: "original", volume: 1.0, replacement_asset_id: null, replacement_start_sec: 0 },
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
