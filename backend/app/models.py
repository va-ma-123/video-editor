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
    every_n_beats: int = 4
    change_amount: int = 5
    change_unit: Literal["bpm", "percent"] = "bpm"
    min_bpm: float = 20.0
    max_bpm: float = 300.0


class MetronomeOp(BaseModel):
    tempo_mode: Literal["bpm", "beat_count"] = "bpm"
    bpm: float = 120.0
    beat_count: int = 8
    include_end_beat: bool = False
    ramp: Optional[RampOp] = None
    sound_asset_id: Optional[str] = None



class AudioOp(BaseModel):
    mode: Literal["inherit", "original", "muted", "replaced", "metronome"] = "inherit"
    volume: float = 1.0  # multiplier, applied when mode == "original"
    replacement_asset_id: Optional[str] = None  # references an uploaded audio file
    replacement_start_sec: float = 0.0  # offset into replacement audio to start from
    metronome: Optional[MetronomeOp] = None


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