"""
Pydantic models describing the EDL (Edit Decision List) data structure.

This mirrors the JSON shape we designed in planning:
- A Project contains a list of Clips (in playback order) and a dict of Sources.
- Each Clip references a Source by id, a frame range within that source,
  and a fixed set of operations (all keys always present, inactive ones
  left at their "off" default) so caching/hashing is predictable.
"""
from __future__ import annotations

from typing import Optional, Literal, Dict, List
from pydantic import BaseModel, Field
import uuid


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------

class SourceInfo(BaseModel):
    id: str
    filename: str
    original_path: str
    proxy_path: Optional[str] = None
    proxy_status: Literal["pending", "processing", "ready", "failed"] = "pending"
    fps: Optional[float] = None
    total_frames: Optional[int] = None
    duration_sec: Optional[float] = None
    width: Optional[int] = None
    height: Optional[int] = None
    has_audio: bool = False
    error: Optional[str] = None
    # "image" means this source was generated from an uploaded still image
    # (see ffmpeg_utils.generate_video_from_image) rather than an uploaded
    # video file -- purely informational for the UI (a badge in the source
    # list / timeline). Once generated, an image-derived source is a real
    # .mp4 with real fps/total_frames like any other -- nothing in the
    # rendering pipeline (render_clip, concat_clips, metronome, ...) treats
    # the two differently, or needs to.
    source_kind: Literal["video", "image"] = "video"


# ---------------------------------------------------------------------------
# Clip operations (fixed shape; see planning notes on ordering)
# ---------------------------------------------------------------------------

class SpeedOp(BaseModel):
    factor: float = 1.0  # 0.1 - 5.0
    pitch_correction: bool = True  # only meaningful when factor != 1.0


class FreezeFrameOp(BaseModel):
    # Which end of the (already reversed, if applicable) clip to freeze
    position: Literal["start", "end"] = "end"
    duration_sec: float = 1.0


class FadeSpec(BaseModel):
    duration_sec: float = 0.0  # 0 = disabled


class FadeOp(BaseModel):
    fade_in: FadeSpec = Field(default_factory=FadeSpec)
    fade_out: FadeSpec = Field(default_factory=FadeSpec)


class RampOp(BaseModel):
    direction: Literal["accelerate", "decelerate"] = "accelerate"
    every_n_beats: int = 4  # >= 1
    change_amount: float = 5.0  # interpreted per `change_unit`
    change_unit: Literal["bpm", "percent"] = "bpm"
    min_bpm: float = 20.0
    max_bpm: float = 300.0


class MetronomeOp(BaseModel):
    tempo_mode: Literal["bpm", "beat_count"] = "bpm"
    bpm: float = 120.0  # used directly when tempo_mode == "bpm"; the STARTING
    # tempo (before ramping) either way -- also itself clamped to [min_bpm, max_bpm]
    # when a ramp is present, since it's just beat 0 of the ramp sequence.
    beat_count: int = 8  # used when tempo_mode == "beat_count": total beats
    # spread evenly (or per the ramp) across the scope's full duration.
    include_end_beat: bool = False  # place one extra beat exactly on the last
    # frame of the scope (this clip, or the whole group). Never applied at an
    # internal clip boundary within a group -- see metronome.py beat-spacing
    # notes for why that would reintroduce the collision this feature exists
    # to avoid.
    ramp: Optional[RampOp] = None
    sound_asset_id: Optional[str] = None  # references an uploaded audio_assets
    # entry to use as the click sound; None means backend-synthesized click.
    #
    # Window: which clip range (and frame range within it) beats get placed
    # over. Meaningful as written for a clip-level metronome, where there's
    # only ever one clip in scope -- start_clip_id/end_clip_id are ignored
    # there. For a group-level metronome, start_clip_id/end_clip_id let the
    # window start and end on ANY member clip, not just the group's actual
    # first/last -- explicitly referencing a clip id (rather than assuming
    # "the first/last member") also means this stays correct if the group
    # gets reordered later, since it points at a specific clip rather than a
    # position.
    start_clip_id: Optional[str] = None  # None = this clip (clip scope), or
    # the group's actual first member clip (group scope)
    start_frame: Optional[int] = None  # None = that clip's own start_frame
    end_clip_id: Optional[str] = None  # None = this clip (clip scope), or
    # the group's actual last member clip (group scope)
    end_frame: Optional[int] = None  # None = that clip's own end_frame


class AudioOp(BaseModel):
    # "inherit" defers to the enclosing group's audio.mode (recursing through
    # nested groups), falling back to "original" if there's no group or every
    # ancestor is also "inherit". This is the default for newly-created clips;
    # any other explicit mode here is treated as an override that wins over
    # whatever the group says -- see metronome.resolve_clip_audio.
    mode: Literal["inherit", "original", "muted", "replaced", "metronome"] = "inherit"
    volume: float = 1.0  # multiplier, applied when mode == "original"
    replacement_asset_id: Optional[str] = None  # references an uploaded audio file
    replacement_start_sec: float = 0.0  # offset into replacement audio to start from
    metronome: Optional[MetronomeOp] = None  # used when mode == "metronome"


class TransformOp(BaseModel):
    crop: Optional[Dict[str, int]] = None  # {x, y, width, height} in source pixel space
    rotate: Literal[0, 90, 180, 270] = 0
    flip: Optional[Literal["horizontal", "vertical"]] = None


class ClipOperations(BaseModel):
    reverse: bool = False
    speed: SpeedOp = Field(default_factory=SpeedOp)
    freeze_frame: Optional[FreezeFrameOp] = None
    transform: TransformOp = Field(default_factory=TransformOp)
    fade: FadeOp = Field(default_factory=FadeOp)
    audio: AudioOp = Field(default_factory=AudioOp)


class Clip(BaseModel):
    id: str
    source_id: str
    start_frame: int
    end_frame: int  # exclusive
    operations: ClipOperations = Field(default_factory=ClipOperations)
    group_id: Optional[str] = None  # timeline organization only; never read by rendering


# ---------------------------------------------------------------------------
# Groups (organizational overlay over the flat `clips` order -- see
# EDL_NOTES.md. Groups themselves carry only an audio block: trim/speed/
# freeze/transform/fade stay clip-only. Group audio IS read by rendering now
# -- it's the fallback a clip's "inherit" audio.mode resolves to. See
# metronome.resolve_clip_audio for the actual resolution walk.)
# ---------------------------------------------------------------------------

class GroupAudioOp(BaseModel):
    mode: Literal["inherit", "original", "muted", "metronome"] = "inherit"
    metronome: Optional[MetronomeOp] = None


class GroupOperations(BaseModel):
    audio: GroupAudioOp = Field(default_factory=GroupAudioOp)


class Group(BaseModel):
    id: str
    name: str = "Group"
    collapsed: bool = False
    parent_group_id: Optional[str] = None  # supports nesting groups within groups
    operations: GroupOperations = Field(default_factory=GroupOperations)


# ---------------------------------------------------------------------------
# Project (top level EDL, persisted as one JSON file)
# ---------------------------------------------------------------------------

class Project(BaseModel):
    id: str
    name: str = "Untitled Project"
    clips: List[Clip] = Field(default_factory=list)
    sources: Dict[str, SourceInfo] = Field(default_factory=dict)
    groups: Dict[str, Group] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Job tracking for async export
# ---------------------------------------------------------------------------

class ExportJob(BaseModel):
    id: str
    project_id: str
    status: Literal["queued", "rendering", "concatenating", "done", "failed"] = "queued"
    total_clips: int = 0
    completed_clips: int = 0
    ready_clip_paths: List[str] = Field(default_factory=list)  # in order, as each finishes
    output_path: Optional[str] = None
    error: Optional[str] = None