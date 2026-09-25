"""
Audio-mode resolution (the "inherit" walk-up through groups) and metronome
beat timing / click-track synthesis.

Design notes (matches what was worked out on the frontend side):

- A clip's audio.mode of "inherit" defers to the nearest ancestor group whose
  own audio.mode isn't "inherit"; falls back to "original" if none is found.
  Any other explicit clip.audio.mode wins outright and is used as-is -- the
  frontend already resets a clip back to "inherit" whenever the enclosing
  group's own mode changes, so an explicit clip override and a just-changed
  group setting shouldn't normally coexist, but this walk is the correct
  behavior to fall back on regardless of how that invariant is kept on the
  frontend.

- "metronome" (whether it's the clip's own or inherited from a group) is
  resolved down to a concrete synthesized WAV file and from that point on is
  treated exactly like the existing "replaced" mode -- ffmpeg_utils and
  render_clip never need to know metronome exists as a concept at all.

- Beat spacing uses N beats = N intervals, not N-1 (i.e. beat i sits at
  i * duration/N, so the last beat lands just *before* the end rather than
  exactly on it). That's what keeps two adjacent clips in a group from both
  placing a beat on the exact same instant at their shared boundary --
  placing beats at both "start and end" of each clip is what causes that
  collision in the first place. `include_end_beat` is the deliberate,
  opt-in exception, and only ever applies at the outer edge of the whole
  scope (this clip, or the last clip of the group) -- never at an internal
  clip boundary within a group, which would reintroduce the exact collision
  this scheme exists to avoid.
"""
from __future__ import annotations

import hashlib
import json
import math
import subprocess
import wave
from array import array
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from . import storage
from .ffmpeg_utils import FFmpegError
from .groups_util import group_ancestor_chain, clips_in_group
from .models import Clip, MetronomeOp, Project, SourceInfo

SAMPLE_RATE = 48000
CHANNELS = 2


class AudioAssetNotFound(Exception):
    pass


# ---------------------------------------------------------------------------
# Beat timing
# ---------------------------------------------------------------------------

def _ramp_beat_times(bpm0: float, ramp, count: Optional[int] = None, duration: Optional[float] = None) -> list[float]:
    """Generate beat times (starting at 0) under a stepped tempo ramp. Stops
    once `count` beats exist, or once the next beat would reach/exceed
    `duration` -- callers pass exactly one of the two."""
    times = [0.0]
    i = 0
    while True:
        if count is not None and len(times) >= count:
            break
        segment = i // max(ramp.every_n_beats, 1)
        sign = 1 if ramp.direction == "accelerate" else -1
        if ramp.change_unit == "bpm":
            bpm_i = bpm0 + sign * segment * ramp.change_amount
        else:  # "percent" -- compounds relative to the starting bpm, not the previous step
            factor = 1 + sign * segment * (ramp.change_amount / 100.0)
            bpm_i = bpm0 * factor
        bpm_i = max(ramp.min_bpm, min(ramp.max_bpm, bpm_i))
        gap = 60.0 / bpm_i
        next_t = times[-1] + gap
        if duration is not None and next_t >= duration:
            break
        times.append(next_t)
        i += 1
    return times


def _solve_ramp_bpm0_for_beat_count(ramp, count: int, duration: float) -> float:
    """beat_count + ramp mode: the user fixes total beats AND total duration,
    so the *starting* bpm isn't free -- solve for it by bisection. Elapsed
    time for a fixed beat count decreases monotonically as bpm0 increases
    (faster start -> everything shrinks), which is exactly what bisection
    needs. Bounded to the ramp's own min/max -- if the target genuinely can't
    be hit inside that range, this returns the closest edge rather than
    raising: a slightly-off tempo beats a hard failure for what is
    fundamentally a creative tool, not a place that needs strict validation.
    """
    lo, hi = ramp.min_bpm, ramp.max_bpm
    if lo >= hi:
        return lo

    def elapsed(bpm0: float) -> float:
        times = _ramp_beat_times(bpm0, ramp, count=count)
        return times[-1] if len(times) > 1 else 0.0

    elapsed_lo, elapsed_hi = elapsed(lo), elapsed(hi)
    if duration >= elapsed_lo:
        return lo
    if duration <= elapsed_hi:
        return hi

    for _ in range(40):
        mid = (lo + hi) / 2
        if elapsed(mid) > duration:
            lo = mid  # too much elapsed time -> speed up -> raise the floor
        else:
            hi = mid
    return (lo + hi) / 2


def compute_beat_times(duration: float, op: MetronomeOp) -> list[float]:
    """Full list of beat timestamps in seconds, relative to the start of
    whatever `duration` represents -- a single clip's own span, or a whole
    group's span."""
    if duration <= 0:
        return []

    if op.ramp is not None:
        if op.tempo_mode == "beat_count":
            bpm0 = _solve_ramp_bpm0_for_beat_count(op.ramp, max(op.beat_count, 1), duration)
            times = _ramp_beat_times(bpm0, op.ramp, count=max(op.beat_count, 1))
        else:
            times = _ramp_beat_times(op.bpm, op.ramp, duration=duration)
    else:
        if op.tempo_mode == "beat_count":
            n = max(op.beat_count, 1)
            interval = duration / n
            times = [i * interval for i in range(n)]
        else:
            interval = 60.0 / max(op.bpm, 0.01)
            times = []
            t = 0.0
            while t < duration:
                times.append(t)
                t += interval

    if op.include_end_beat and (not times or duration - times[-1] > 1e-6):
        times.append(duration)

    return times


# ---------------------------------------------------------------------------
# Effective (post speed/freeze) clip duration -- must match render_clip's own
# `output_duration` math exactly, since beats need to be placed against the
# length ffmpeg will actually produce, not the raw trim length.
# ---------------------------------------------------------------------------

def effective_clip_duration(clip: Clip, source: SourceInfo) -> float:
    fps = source.fps or 30.0
    start_sec = clip.start_frame / fps
    end_sec = clip.end_frame / fps
    trim_duration = max(end_sec - start_sec, 1 / fps)
    speed_factor = clip.operations.speed.factor
    freeze_extra = clip.operations.freeze_frame.duration_sec if clip.operations.freeze_frame else 0.0
    return (trim_duration / speed_factor) + freeze_extra


def _clip_local_output_time(clip: Clip, source: SourceInfo, frame: int) -> float:
    """Convert an absolute source frame number into this clip's own
    output-relative time in seconds (0 = this clip's own first frame,
    the same timeline effective_clip_duration measures) -- i.e. post-speed,
    matching the timeline the synthesized click track is actually built
    against. Out-of-range frame values are clamped to the clip's own
    [start_frame, end_frame] rather than raising, since a metronome
    start/end frame can go stale if the clip's trim is changed after the
    fact -- better to clamp into range than break the render."""
    fps = source.fps or 30.0
    speed_factor = clip.operations.speed.factor
    clamped = max(clip.start_frame, min(clip.end_frame, frame))
    return (clamped - clip.start_frame) / fps / speed_factor


def _group_member_offsets(project: Project, group_id: str) -> list[tuple[Clip, SourceInfo, float, float]]:
    """Every member of group_id, in order, as (clip, source, offset,
    duration) -- offset is that clip's own start time on the group's shared
    timeline (0 = the first member's start)."""
    members = clips_in_group(project, group_id)
    entries = []
    offset = 0.0
    for c in members:
        source = project.sources[c.source_id]
        duration = effective_clip_duration(c, source)
        entries.append((c, source, offset, duration))
        offset += duration
    return entries


def _group_scoped_beats_for_clip(project: Project, group_id: str, clip: Clip, met: MetronomeOp) -> tuple[list[float], float]:
    """Compute one continuous beat timeline across the group's window (which
    member clip to start/end on, and which frame within each -- defaulting
    to the group's actual first and last member), then return the slice of
    it that falls within this particular clip, shifted to clip-local time.
    Computing one schedule for the whole window (rather than each clip
    re-deriving its own) is what keeps a ramp's momentum carrying across a
    clip boundary, and what keeps the N-beats=N-intervals spacing
    collision-free between clips whose durations differ.
    """
    entries = _group_member_offsets(project, group_id)
    by_id = {c.id: (c, source, offset, duration) for c, source, offset, duration in entries}

    # start_clip_id/end_clip_id reference a specific member clip by id
    # (rather than assuming "the first/last member"), so this stays correct
    # even if the group gets reordered later. A reference to a clip that's
    # no longer actually in the group (moved out, or a stale id) falls back
    # to the group's real first/last member rather than raising mid-render.
    start_entry = by_id.get(met.start_clip_id) or entries[0]
    end_entry = by_id.get(met.end_clip_id) or entries[-1]
    start_clip, start_source, start_offset, _ = start_entry
    end_clip, end_source, end_offset, _ = end_entry

    start_frame = met.start_frame if met.start_frame is not None else start_clip.start_frame
    end_frame = met.end_frame if met.end_frame is not None else end_clip.end_frame

    window_start = start_offset + _clip_local_output_time(start_clip, start_source, start_frame)
    window_end = end_offset + _clip_local_output_time(end_clip, end_source, end_frame)
    window_end = max(window_end, window_start)  # guards a start clip picked after the end clip
    window_duration = window_end - window_start

    # Shift the window-relative beat times back onto the group's absolute
    # (0 = first clip's own start) shared timeline, same coordinate space
    # the offset/clip_duration slicing below already works in.
    group_beats = [window_start + t for t in compute_beat_times(window_duration, met)]

    if clip.id not in by_id:
        # Shouldn't happen -- resolution only reaches here via this clip's
        # own ancestor chain, so it must be a member. Fail safe with silence
        # rather than raising mid-render.
        return [], effective_clip_duration(clip, project.sources[clip.source_id])
    _, _, offset, clip_duration = by_id[clip.id]

    is_last_member = entries[-1][0].id == clip.id
    local_beats = []
    for t in group_beats:
        if is_last_member:
            in_range = offset - 1e-9 <= t <= offset + clip_duration + 1e-9
        else:
            in_range = offset - 1e-9 <= t < offset + clip_duration
        if in_range:
            local_beats.append(max(t - offset, 0.0))
    return local_beats, clip_duration


# ---------------------------------------------------------------------------
# Click track synthesis
# ---------------------------------------------------------------------------

def _synth_click(sample_rate: int = SAMPLE_RATE, channels: int = CHANNELS,
                  freq: float = 1800.0, duration_sec: float = 0.045) -> array:
    """A short percussive click: an exponentially-decaying sine burst.
    Returns interleaved 16-bit PCM samples."""
    n = int(sample_rate * duration_sec)
    samples = array("h")
    for i in range(n):
        t = i / sample_rate
        envelope = math.exp(-t * 60)
        value = int(envelope * 0.9 * 32767 * math.sin(2 * math.pi * freq * t))
        for _ in range(channels):
            samples.append(value)
    return samples


def _decode_sample_to_pcm(sample_path: str, sample_rate: int = SAMPLE_RATE, channels: int = CHANNELS) -> array:
    """Decode a user-uploaded click sample (whatever format ffmpeg can read)
    to raw interleaved 16-bit PCM at our working sample rate, via ffmpeg
    itself -- keeps this module free of extra audio-decoding dependencies."""
    cmd = [
        "ffmpeg", "-y", "-i", sample_path,
        "-ar", str(sample_rate), "-ac", str(channels),
        "-f", "s16le", "-acodec", "pcm_s16le", "-",
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise FFmpegError(f"Failed to decode click sample {sample_path}: {proc.stderr[-2000:].decode(errors='replace')}")
    samples = array("h")
    samples.frombytes(proc.stdout)
    return samples


def _mix_in(buffer: array, click: array, start_sample: int, channels: int = CHANNELS) -> None:
    """Add `click`'s samples into `buffer` starting at `start_sample` frames
    in, clipping to int16 range. Silently truncates if the click would run
    past the end of the buffer -- only matters for a beat placed right at the
    very end of a clip/group (e.g. include_end_beat)."""
    start_idx = start_sample * channels
    for i, v in enumerate(click):
        idx = start_idx + i
        if idx >= len(buffer):
            break
        buffer[idx] = max(-32768, min(32767, buffer[idx] + v))


def synthesize_metronome_wav(beat_times: list[float], duration_sec: float, output_path: str,
                              sound_asset_path: Optional[str] = None,
                              sample_rate: int = SAMPLE_RATE, channels: int = CHANNELS) -> None:
    """Render a metronome click track to a WAV file: silence for the full
    `duration_sec`, with a click (synthesized, or the user's uploaded sound)
    mixed in at each of `beat_times`."""
    total_frames = max(int(round(duration_sec * sample_rate)), 1)
    buffer = array("h", [0]) * (total_frames * channels)

    click = _decode_sample_to_pcm(sound_asset_path, sample_rate, channels) if sound_asset_path else _synth_click(sample_rate, channels)

    for t in beat_times:
        start_sample = int(round(t * sample_rate))
        if 0 <= start_sample < total_frames:
            _mix_in(buffer, click, start_sample, channels)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with wave.open(output_path, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(buffer.tobytes())


def _resolve_audio_asset_path(asset_id: str) -> str:
    matches = list(storage.AUDIO_ASSETS_DIR.glob(f"{asset_id}.*"))
    if not matches:
        raise AudioAssetNotFound(f"Audio asset {asset_id} not found")
    return str(matches[0])


def _metronome_cache_path(fingerprint: dict) -> str:
    payload = json.dumps(fingerprint, sort_keys=True)
    digest = hashlib.sha256(payload.encode()).hexdigest()[:24]
    return str(storage.CACHE_DIR / f"metronome_{digest}.wav")


# ---------------------------------------------------------------------------
# Resolution: clip.operations.audio (possibly "inherit") -> a concrete,
# ffmpeg_utils-ready audio operation.
# ---------------------------------------------------------------------------

@dataclass
class ResolvedAudio:
    mode: str  # "original" | "muted" | "replaced" -- collapsed; ffmpeg_utils never sees "inherit" or "metronome"
    volume: float
    asset_path: Optional[str]  # concrete file path, used when mode == "replaced"
    replacement_start_sec: float
    fingerprint: dict  # everything that actually determined the above -- see clip_cache_key
    sync_to_speed: bool = True  # False only for a metronome: its beat timing
    # is already computed against the clip's final post-speed duration (see
    # effective_clip_duration), so ffmpeg must play it at its own native rate
    # rather than re-stretching it with atempo/asetrate -- that would
    # literally halve a 220bpm click to 110bpm on a 0.5x-speed clip.


def _find_audio_source(project: Project, clip: Clip):
    """Walk clip -> ancestor groups, nearest first, to find whichever
    explicit (non-"inherit") audio setting applies. Returns (owner, audio_op)
    where owner is "clip", a group id, or None (everything was "inherit",
    all the way up -- falls back to plain "original")."""
    if clip.operations.audio.mode != "inherit":
        return "clip", clip.operations.audio

    chain = group_ancestor_chain(clip.group_id, project.groups)  # outermost first
    for group_id in reversed(chain):  # nearest ancestor first
        group = project.groups[group_id]
        if group.operations.audio.mode != "inherit":
            return group_id, group.operations.audio

    return None, None


def resolve_clip_audio(project: Project, clip: Clip) -> ResolvedAudio:
    source = project.sources.get(clip.source_id)
    owner, audio_op = _find_audio_source(project, clip)

    if audio_op is None or audio_op.mode == "original":
        volume = audio_op.volume if audio_op is not None else 1.0
        return ResolvedAudio(mode="original", volume=volume, asset_path=None,
                              replacement_start_sec=0.0,
                              fingerprint={"mode": "original", "volume": volume})

    if audio_op.mode == "muted":
        return ResolvedAudio(mode="muted", volume=1.0, asset_path=None,
                              replacement_start_sec=0.0, fingerprint={"mode": "muted"})

    if audio_op.mode == "replaced":
        # Clip-only mode -- groups don't offer "replaced" (one file standing
        # in for every clip in a group isn't a supported concept yet).
        asset_path = _resolve_audio_asset_path(audio_op.replacement_asset_id)
        return ResolvedAudio(
            mode="replaced", volume=audio_op.volume, asset_path=asset_path,
            replacement_start_sec=audio_op.replacement_start_sec,
            fingerprint={
                "mode": "replaced",
                "asset_id": audio_op.replacement_asset_id,
                "start_sec": audio_op.replacement_start_sec,
                "volume": audio_op.volume,
            },
        )

    if audio_op.mode == "metronome":
        met = audio_op.metronome
        if met is None:
            # Defensive: a "metronome" mode with no config shouldn't happen
            # (the frontend always seeds one), but fall back to silence-free
            # original audio rather than producing an empty click track.
            return ResolvedAudio(mode="original", volume=1.0, asset_path=None,
                                  replacement_start_sec=0.0, fingerprint={"mode": "original"})

        if owner == "clip":
            duration = effective_clip_duration(clip, source)
            # start_clip_id/end_clip_id are meaningless at clip scope --
            # there's only ever this one clip -- so only start_frame/end_frame matter here.
            start_frame = met.start_frame if met.start_frame is not None else clip.start_frame
            end_frame = met.end_frame if met.end_frame is not None else clip.end_frame
            window_start = _clip_local_output_time(clip, source, start_frame)
            window_end = max(_clip_local_output_time(clip, source, end_frame), window_start)
            beats = [window_start + t for t in compute_beat_times(window_end - window_start, met)]
        else:
            beats, duration = _group_scoped_beats_for_clip(project, owner, clip, met)

        sound_path = _resolve_audio_asset_path(met.sound_asset_id) if met.sound_asset_id else None
        fingerprint = {
            "mode": "metronome",
            "owner": owner,
            "beats": [round(b, 4) for b in beats],
            "duration": round(duration, 4),
            "sound_asset_id": met.sound_asset_id,
        }
        wav_path = _metronome_cache_path(fingerprint)
        if not Path(wav_path).exists():
            synthesize_metronome_wav(beats, duration, wav_path, sound_asset_path=sound_path)
        return ResolvedAudio(mode="replaced", volume=1.0, asset_path=wav_path,
                              replacement_start_sec=0.0, fingerprint=fingerprint,
                              sync_to_speed=False)

    # Unreachable given the Literal types on AudioOp/GroupAudioOp, but fail
    # safe rather than let an unrecognized mode crash a render.
    return ResolvedAudio(mode="original", volume=1.0, asset_path=None,
                          replacement_start_sec=0.0, fingerprint={"mode": "original"})