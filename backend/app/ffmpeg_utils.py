"""
All ffmpeg/ffprobe interaction lives here. Every clip operation from the
planning doc maps to a piece of a filter graph built in `build_filters_for_clip`.

Fixed pipeline order (matches planning discussion):
  1. trim (handled by -ss/-to on the source, done by caller before filters)
  2. reverse
  3. speed (+ optional pitch correction on audio)
  4. freeze frame
  5. transform (crop/rotate/flip)
  6. fade in/out
  (audio mute/replace/volume is layered in alongside, on the audio stream)
"""
from __future__ import annotations

import json
import subprocess
import hashlib
import shlex
from pathlib import Path
from typing import Optional

from .models import Clip, SourceInfo

# Bump this any time render_clip's filter-building logic changes in a way that
# would produce different output for the same clip inputs. Cache keys include
# this, so old cached renders from before the change are automatically treated
# as stale instead of silently being reused (this is how the -ss/-t ordering
# fix for `reverse` could otherwise still show the old broken behavior even
# after the code was corrected -- the cache didn't know anything had changed).
#
# v3: audio.mode gained "inherit" and "metronome". clip_cache_key now takes
# the caller-resolved audio fingerprint (see metronome.resolve_clip_audio)
# instead of hashing clip.operations.audio directly, since an "inherit"
# clip's effective audio can change without clip.operations itself changing
# at all (its group's setting changed, or -- for a group-scoped metronome --
# a sibling clip's duration shifted the beat schedule).
# v4: a metronome's audio no longer gets re-stretched by the clip's speed
# factor (see ResolvedAudio.sync_to_speed / render_clip's sync_audio_to_speed)
# -- same clip inputs as before now render differently for a metronome clip
# that also has a non-1.0 speed factor.
# v5: MetronomeOp gained start_frame/end_frame windowing. Same clip inputs
# can now render differently in one specific case: a clip combining
# freeze_frame with a default (unset start/end) metronome no longer gets
# beats extending into the freeze-frame padding -- a beat window is
# inherently frame-based, and freeze padding isn't a real source frame
# range, so the default end now lands exactly at the clip's actual last
# frame instead of implicitly including that padding.
RENDER_LOGIC_VERSION = 9


class FFmpegError(RuntimeError):
    pass


# Every image-derived source is generated at this fixed frame rate. Two
# clips with mismatched frame rates sitting in the same export isn't
# something concat_clips currently guards against (it only probes and
# reconciles *dimensions*, via _probe_dims, not fps) -- standardizing here
# sidesteps that rather than requiring a separate fps-reconciliation pass.
IMAGE_CLIP_FPS = 30.0

def _proxy_dimensions(source: SourceInfo, max_height: int = 480) -> tuple[int, int]:
    if not source.width or not source.height:
        return 0, 0

    proxy_height = min(max_height, source.height)
    scale = proxy_height / source.height
    proxy_width = max(1, int(round((source.width * scale) / 2.0) * 2))
    return proxy_width, proxy_height

def _scale_crop_for_proxy(crop: dict[str, int], source: SourceInfo) -> dict[str, int]:
    proxy_width, proxy_height = _proxy_dimensions(source)
    if not proxy_width or not proxy_height or not source.width or not source.height:
        return crop

    scale_x = proxy_width / source.width
    scale_y = proxy_height / source.height

    width = max(1, min(int(round(crop["width"] * scale_x)), proxy_width))
    height = max(1, min(int(round(crop["height"] * scale_y)), proxy_height))
    x = max(0, min(int(round(crop["x"] * scale_x)), proxy_width - width))
    y = max(0, min(int(round(crop["y"] * scale_y)), proxy_height - height))
    return {"x": x, "y": y, "width": width, "height": height}

def _rect_to_dict(rect) -> dict[str, int]:
    if rect is None:
        return {"x": 0, "y": 0, "width": 0, "height": 0}
    if hasattr(rect, "model_dump"):
        rect = rect.model_dump()
    return {
        "x": int(rect.get("x", 0)),
        "y": int(rect.get("y", 0)),
        "width": int(rect.get("width", 0)),
        "height": int(rect.get("height", 0)),
    }

def _clamp_crop_rect(crop: dict[str, int], source: SourceInfo) -> dict[str, int]:
    if not source.width or not source.height:
        return crop

    width = max(1, min(int(crop["width"]), source.width))
    height = max(1, min(int(crop["height"]), source.height))
    x = max(0, min(int(crop["x"]), source.width - width))
    y = max(0, min(int(crop["y"]), source.height - height))

    return {"x": x, "y": y, "width": width, "height": height}

def _active_dimensions(source: SourceInfo, quality: str) -> tuple[int, str]:
    if quality == "proxy":
        return _proxy_dimensions(source)
    return (source.width or 0, source.height or 0)

def _linear_expr(start: int, end: int, duration: float) -> str:
    if duration <= 0:
        return str(end)

    return f"({start} + ({end} - {start}) * min(max(t/{duration:.6f},0),1))"

def _crop_transition_filters(
    start_crop: dict[str, int],
    end_crop: dict[str, int],
    output_w: int,
    output_h: int,
    duration: float,
) -> list[str]:
    
    crop_x = _linear_expr(start_crop["x"], end_crop["x"], duration)
    crop_y = _linear_expr(start_crop["y"], end_crop["y"], duration)
    crop_width = _linear_expr(start_crop["width"], end_crop["width"], duration)
    crop_height = _linear_expr(start_crop["height"], end_crop["height"], duration)    

    even_crop_width = (
        f"max(2,2*floor(({crop_width})/2))"
    )
    even_crop_height = (
        f"max(2,2*floor(({crop_height})/2))"
    )

    return [
        (
            "crop="
            f"w='{even_crop_width}':"
            f"h='{even_crop_height}':"
            f"x='min(max(0,{crop_x}),iw-ow)':"
            f"y='min(max(0,{crop_y}),ih-oh)':"
            "exact=1:"
            "eval=frame"
        ),
        (
            f"scale="
            f"w={output_w}:"
            f"h={output_h}:"
            "force_original_aspect_ratio=decrease:"
            "force_divisible_by=2:"
            "eval=frame"
        ),
        (
            f"pad="
            f"w={output_w}:"
            f"h={output_h}:"
            "x='(ow-iw)/2':"
            "y='(oh-ih)/2':"
            "color=black:"
            "eval=frame"
        ),
        "setsar=1",
    ]


def generate_video_from_image(image_path: str, output_path: str, duration_sec: float, fps: float = IMAGE_CLIP_FPS) -> None:
    """Turn a still image into a silent .mp4 of exactly `duration_sec`,
    displaying the image the whole time. The result is then ingested exactly
    like any uploaded video (probe_source, generate_proxy, ...) -- nothing
    downstream needs to know it didn't start out as a video file."""
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-loop", "1", "-i", image_path,
        "-t", f"{duration_sec:.6f}",
        "-r", str(fps),
        # scale ensures even width/height -- yuv420p requires both dimensions
        # divisible by 2, which an arbitrary source image has no reason to satisfy
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-pix_fmt", "yuv420p",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-movflags", "+faststart",
        output_path,
    ]
    run(cmd)


def run(cmd: list[str]) -> str:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    # --- TEMPORARY DIAGNOSTIC (safe to remove once the freeze-frame issue is found) ---
    if "ffmpeg" in cmd[0]:
        print("=" * 60)
        print("FFMPEG CMD:", " ".join(shlex.quote(c) for c in cmd))
        print("--- stderr (last 3000 chars) ---")
        print(proc.stderr[-3000:])
        print("=" * 60)
    # --- end temporary diagnostic ---
    if proc.returncode != 0:
        raise FFmpegError(f"Command failed: {' '.join(shlex.quote(c) for c in cmd)}\n{proc.stderr[-4000:]}")
    return proc.stdout


def probe_source(path: str) -> dict:
    """Run ffprobe and extract fps, frame count, duration, dimensions, audio presence."""
    cmd = [
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", path,
    ]
    out = run(cmd)
    data = json.loads(out)

    video_stream = next((s for s in data["streams"] if s["codec_type"] == "video"), None)
    audio_stream = next((s for s in data["streams"] if s["codec_type"] == "audio"), None)
    if video_stream is None:
        raise FFmpegError("No video stream found")

    # r_frame_rate is like "30000/1001"
    num, den = video_stream["r_frame_rate"].split("/")
    fps = float(num) / float(den)

    duration = float(data["format"].get("duration", video_stream.get("duration", 0)))
    total_frames = video_stream.get("nb_frames")
    if total_frames is not None:
        total_frames = int(total_frames)
    else:
        # Some containers don't report nb_frames; estimate from duration * fps
        total_frames = int(round(duration * fps))

    return {
        "fps": fps,
        "total_frames": total_frames,
        "duration_sec": duration,
        "width": video_stream.get("width"),
        "height": video_stream.get("height"),
        "has_audio": audio_stream is not None,
    }


def generate_proxy(original_path: str, proxy_path: str, max_height: int = 480) -> None:
    """Downscale to a low-res, fast-seeking proxy. Same fps/duration as source
    so frame numbers map 1:1 between proxy and original."""
    Path(proxy_path).parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-i", original_path,
        "-vf", f"scale=-2:'min({max_height},ih)'",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
        "-c:a", "aac", "-b:a", "96k",
        "-movflags", "+faststart",
        proxy_path,
    ]
    run(cmd)


def clip_cache_key(source: SourceInfo, clip: Clip, quality: str, resolved_audio: dict) -> str:
    """Deterministic hash used to skip re-rendering unchanged clips.

    `resolved_audio` is the fingerprint from metronome.resolve_clip_audio,
    not clip.operations.audio.model_dump() -- see RENDER_LOGIC_VERSION v3
    note above for why hashing the raw (possibly "inherit") value would miss
    real changes to what actually gets rendered.
    """
    ops_payload = clip.operations.model_dump()
    ops_payload["audio"] = resolved_audio
    payload = json.dumps({
        "render_logic_version": RENDER_LOGIC_VERSION,
        "source_id": source.id,
        "source_mtime": Path(source.original_path).stat().st_mtime if quality == "final" else None,
        "start_frame": clip.start_frame,
        "end_frame": clip.end_frame,
        "operations": ops_payload,
        "quality": quality,
    }, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode()).hexdigest()[:24]


def probe_duration(path: str) -> float:
    """Just the duration of a rendered file, in seconds. Used to build exact
    clip_id -> [start_sec, end_sec] boundaries for a concatenated preview, so
    the timeline can highlight whichever clip is currently playing without
    drifting out of sync from small per-clip encoding overhead."""
    out = run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", path,
    ])
    return float(out.strip())


def _build_video_filters(clip: Clip, fps: float) -> list[str]:
    filters = []
    ops = clip.operations

    if ops.reverse:
        filters.append("reverse")

    speed = ops.speed
    if speed.factor != 1.0:
        # setpts: new_pts = old_pts / factor (factor > 1 = faster)
        filters.append(f"setpts=(1/{speed.factor})*PTS")

    if ops.freeze_frame and ops.freeze_frame.duration_sec > 0:
        ff = ops.freeze_frame
        if ff.position == "start":
            filters.append(f"tpad=start_mode=clone:start_duration={ff.duration_sec}")
        else:
            filters.append(f"tpad=stop_mode=clone:stop_duration={ff.duration_sec}")

    t = ops.transform
    if t.crop_transition:
        filters.append("__CROP_TRANSITION_PLACEHOLDER__")
    elif t.crop:
        crop = _rect_to_dict(t.crop)
        filters.append(f"crop={crop['width']}:{crop['height']}:{crop['x']}:{crop['y']}")
    if t.rotate == 90:
        filters.append("transpose=1")
    elif t.rotate == 180:
        filters.append("transpose=1,transpose=1")
    elif t.rotate == 270:
        filters.append("transpose=2")
    if t.flip == "horizontal":
        filters.append("hflip")
    elif t.flip == "vertical":
        filters.append("vflip")

    fade = ops.fade
    if fade.fade_in.duration_sec > 0:
        filters.append(f"fade=t=in:st=0:d={fade.fade_in.duration_sec}")
    if fade.fade_out.duration_sec > 0:
        # Applied relative to clip end; caller supplies duration via -t already,
        # so we approximate using a large st and let ffmpeg clip it -- safer to
        # compute exact clip duration and pass it in. See render_clip.
        filters.append(f"__FADE_OUT_PLACEHOLDER__={fade.fade_out.duration_sec}")

    return filters


def _build_audio_filters(clip: Clip, speed_factor: float, sync_to_speed: bool = True) -> list[str]:
    filters = []
    ops = clip.operations

    if ops.audio.mode == "muted":
        return ["volume=0"]

    if ops.reverse:
        filters.append("areverse")

    # sync_to_speed=False means this audio's timing has already been
    # computed against the clip's final (post-speed) output duration -- a
    # synthesized metronome track, specifically -- so re-stretching it here
    # via atempo/asetrate would double-apply the speed change (a 220bpm
    # metronome on a 0.5x clip would otherwise come out at 110bpm). The
    # caller (main.py, via ResolvedAudio.sync_to_speed) decides this per
    # clip based on where the audio actually came from; ordinary "original"
    # or "replaced" audio keeps the old speed-synced behavior.
    if sync_to_speed and speed_factor != 1.0 and ops.speed.pitch_correction:
        # atempo only supports 0.5-2.0 per instance; chain multiple stages
        remaining = speed_factor
        stages = []
        while remaining > 2.0:
            stages.append(2.0)
            remaining /= 2.0
        while remaining < 0.5:
            stages.append(0.5)
            remaining /= 0.5
        stages.append(remaining)
        for s in stages:
            filters.append(f"atempo={s:.6f}")
    elif sync_to_speed and speed_factor != 1.0 and not ops.speed.pitch_correction:
        # Let speed change pitch naturally: resample instead of atempo.
        # asetrate scales sample rate then aresample restores standard rate label.
        filters.append(f"asetrate=48000*{speed_factor},aresample=48000")

    if ops.audio.volume != 1.0:
        filters.append(f"volume={ops.audio.volume}")

    fade = ops.fade
    if fade.fade_in.duration_sec > 0:
        filters.append(f"afade=t=in:st=0:d={fade.fade_in.duration_sec}")
    if fade.fade_out.duration_sec > 0:
        filters.append(f"__AFADE_OUT_PLACEHOLDER__={fade.fade_out.duration_sec}")

    return filters


def render_clip(
    source: SourceInfo,
    clip: Clip,
    output_path: str,
    quality: str = "proxy",
    audio_asset_path: Optional[str] = None,
    sync_audio_to_speed: bool = True,
) -> None:
    """Render a single EDL clip entry to a standalone mp4 file.

    quality: "proxy" uses source.proxy_path, "final" uses source.original_path.
    sync_audio_to_speed: False for a synthesized metronome track (see
    ResolvedAudio.sync_to_speed in metronome.py) -- its timing is already
    computed against the clip's final post-speed duration, so it should play
    at its own native rate rather than being stretched again by the clip's
    speed factor.
    """
    src_path = source.proxy_path if quality == "proxy" else source.original_path
    fps = source.fps or 30.0

    start_sec = clip.start_frame / fps
    end_sec = clip.end_frame / fps
    trim_duration = max(end_sec - start_sec, 1 / fps)

    speed_factor = clip.operations.speed.factor
    freeze_extra = clip.operations.freeze_frame.duration_sec if clip.operations.freeze_frame else 0.0
    # Approximate output duration after speed + freeze, used to place fade-out correctly
    output_duration = (trim_duration / speed_factor) + freeze_extra

    output_width, output_height = _active_dimensions(source, quality)

    effective_clip = clip
    if quality == "proxy" and clip.operations.transform.crop:
        scaled_crop = _scale_crop_for_proxy(_rect_to_dict(clip.operations.transform.crop), source)
        effective_clip = clip.model_copy(
            update={
                "operations": clip.operations.model_copy(
                    update={
                        "transform": clip.operations.transform.model_copy(
                            update={"crop": scaled_crop}
                        )
                    }
                )
            }
        )
    elif quality == "proxy" and clip.operations.transform.crop_transition:
        transition = clip.operations.transform.crop_transition
        effective_clip = clip.model_copy(
            update={
                "operations": clip.operations.model_copy(
                    update={
                        "transform": clip.operations.transform.model_copy(
                            update={
                                "crop_transition": {
                                    "start": _scale_crop_for_proxy(_rect_to_dict(transition.start), source),
                                    "end": _scale_crop_for_proxy(_rect_to_dict(transition.end), source),
                                }
                            }
                        )
                    }
                )
            }
        )
    elif clip.operations.transform.crop_transition:
        transition = clip.operations.transform.crop_transition
        effective_clip = clip.model_copy(
            update={
                "operations": clip.operations.model_copy(
                    update={
                        "transform": clip.operations.transform.model_copy(
                            update={
                                "crop_transition": {
                                    "start": _clamp_crop_rect(_rect_to_dict(transition.start), source),
                                    "end": _clamp_crop_rect(_rect_to_dict(transition.end), source),
                                }
                            }
                        )
                    }
                )
            }
        )

    video_filters = _build_video_filters(effective_clip, fps)

    if effective_clip.operations.transform.crop_transition:
        transition = effective_clip.operations.transform.crop_transition
        if isinstance(transition, dict):
            start_crop = _rect_to_dict(transition["start"])
            end_crop = _rect_to_dict(transition["end"])
        else:
            start_crop = _rect_to_dict(transition.start)
            end_crop = _rect_to_dict(transition.end)
        crop_filters = _crop_transition_filters(
            start_crop, 
            end_crop,
            output_width or 1,
            output_height or 1,
            max(output_duration, 1/fps)
        )
        expanded_filters = []
        for f in video_filters:
            if f == "__CROP_TRANSITION_PLACEHOLDER__":
                expanded_filters.extend(crop_filters)
            else:
                expanded_filters.append(f)
        video_filters = expanded_filters

    audio_filters = _build_audio_filters(effective_clip, speed_factor, sync_to_speed=sync_audio_to_speed)

    # Resolve fade-out placeholders now that we know output_duration
    fade_out_d = effective_clip.operations.fade.fade_out.duration_sec
    if fade_out_d > 0:
        st = max(output_duration - fade_out_d, 0)
        video_filters = [
            f"fade=t=out:st={st:.3f}:d={fade_out_d}" if f.startswith("__FADE_OUT_PLACEHOLDER__") else f
            for f in video_filters
        ]
        audio_filters = [
            f"afade=t=out:st={st:.3f}:d={fade_out_d}" if f.startswith("__AFADE_OUT_PLACEHOLDER__") else f
            for f in audio_filters
        ]

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    cmd = ["ffmpeg", "-y"]
    # -ss AND -t must both be placed BEFORE -i to act as input options that
    # actually bound what gets read from the source. Putting -t after -i
    # silently makes it an output option instead -- it would then do nothing
    # to limit what feeds into filters like `reverse`, which need the whole
    # (unbounded) stream to have already ended before they can do anything,
    # causing them to operate on the entire remainder of the source file
    # rather than just the trimmed range.
    cmd += ["-ss", f"{start_sec:.6f}", "-t", f"{trim_duration:.6f}", "-i", src_path]

    has_replacement_audio = (
        clip.operations.audio.mode == "replaced" and audio_asset_path is not None
    )
    if has_replacement_audio:
        cmd += ["-ss", f"{clip.operations.audio.replacement_start_sec:.6f}", "-i", audio_asset_path]

    # Check if the crop transition needs a black background stream (moving
    # crop window case -- pad can't handle animated x/y safely when position
    # changes, because x + iw > canvas_w can occur mid-animation).
    black_canvas_sentinel = next((f for f in video_filters if f.startswith("__NEEDS_BLACK_CANVAS__")), None)

    filter_complex_parts = []
    if black_canvas_sentinel:
        # Split at the sentinel: filters before it run on [0:v], then crop,
        # then overlay onto the black canvas.
        canvas_size = black_canvas_sentinel.split("=")[1]  # e.g. "854x480"
        sentinel_idx = video_filters.index(black_canvas_sentinel)
        pre_filters = [f for f in video_filters[:sentinel_idx] if not f.startswith("__")]
        # After sentinel: [crop_filter, overlay_filter]
        post = [f for f in video_filters[sentinel_idx + 1:] if not f.startswith("__")]
        crop_f = post[0]
        overlay_f = post[1] if len(post) > 1 else "overlay=0:0"
        pre_chain = ",".join(pre_filters) if pre_filters else "null"
        filter_complex_parts.append(f"color=black:{canvas_size}:r={fps}[bg]")
        filter_complex_parts.append(f"[0:v]{pre_chain},{crop_f}[cropped]")
        filter_complex_parts.append(f"[bg][cropped]{overlay_f}[vout]")
    else:
        clean = [f for f in video_filters if not f.startswith("__")]
        filter_complex_parts.append(f"[0:v]{','.join(clean)}[vout]" if clean else "[0:v]null[vout]")

    if has_replacement_audio:
        a_chain = ",".join(audio_filters) if audio_filters else "anull"
        filter_complex_parts.append(f"[1:a]{a_chain}[aout]")
    elif source.has_audio and clip.operations.audio.mode != "muted":
        a_chain = ",".join(audio_filters) if audio_filters else "anull"
        filter_complex_parts.append(f"[0:a]{a_chain}[aout]")
    else:
        filter_complex_parts.append(f"anullsrc=r=48000:cl=stereo[aout]")

    cmd += ["-filter_complex", ";".join(filter_complex_parts)]
    cmd += ["-map", "[vout]", "-map", "[aout]"]
    cmd += ["-t", f"{output_duration:.6f}"]

    if quality == "proxy":
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26"]
    else:
        cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "18"]
    cmd += ["-c:a", "aac", "-b:a", "128k"]
    cmd += ["-movflags", "+faststart", output_path]

    run(cmd)


def _probe_dims(path: str) -> tuple[int, int]:
    out = run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "csv=p=0", path,
    ])
    w, h = out.strip().split(",")
    return int(w), int(h)


def _probe_fps(path: str) -> float:
    out = run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=r_frame_rate", "-of", "default=noprint_wrappers=1:nokey=1", path,
    ])
    value = out.strip()
    if "/" in value:
        num, den = value.split("/", 1)
        return float(num) / float(den)
    return float(value)

def compose_clips(
    rendered_paths: list[str],
    output_path: str,
    split_x: float,
    split_y: float,
    quadrants: list[str],
    duration: float,
    quality: str,
) -> None:
    """Compose two clips through a movable 2D split.

    `split_x` and `split_y` define a vertical and horizontal boundary on one
    shared output canvas. `quadrants` is ordered as:

        [top-left, top-right, bottom-left, bottom-right]

    with each value being "a" for rendered_paths[0] or "b" for
    rendered_paths[1].

    IMPORTANT: each source is first scaled to the FULL output canvas and then
    cropped into its assigned quadrant. This means a quadrant shows the
    corresponding part of the source frame rather than restarting the source
    at (0, 0) independently inside every quadrant. For example, with A/B/B/A:

        A's top-left      B's top-right
        B's bottom-left   A's bottom-right

    all four regions are windows into the original full frames.
    """
    if len(rendered_paths) != 2:
        raise FFmpegError("compose_clips requires exactly two rendered paths")
    if len(quadrants) != 4 or any(value not in ("a", "b") for value in quadrants):
        raise FFmpegError("compose_clips quadrants must contain exactly four 'a'/'b' values")

    dims = [_probe_dims(path) for path in rendered_paths]
    output_fps = _probe_fps(rendered_paths[0])
    target_w = max(w for w, _h in dims)
    target_h = max(h for _w, h in dims)
    # yuv420p requires even dimensions.
    target_w = max(4, target_w + target_w % 2)
    target_h = max(4, target_h + target_h % 2)

    split_x = max(0.1, min(float(split_x), 0.9))
    split_y = max(0.1, min(float(split_y), 0.9))

    left_w = max(2, min(int(round(target_w * split_x)), target_w - 2))
    left_w -= left_w % 2
    right_w = target_w - left_w

    top_h = max(2, min(int(round(target_h * split_y)), target_h - 2))
    top_h -= top_h % 2
    bottom_h = target_h - top_h

    cells = [
        (0, 0, left_w, top_h),
        (left_w, 0, right_w, top_h),
        (0, top_h, left_w, bottom_h),
        (left_w, top_h, right_w, bottom_h),
    ]

    cmd = ["ffmpeg", "-y", "-i", rendered_paths[0], "-i", rendered_paths[1]]
    filter_complex = [
        f"color=c=black:s={target_w}x{target_h}:r={output_fps:.6f}:d={duration:.6f}[base]",
        # Each source is prepared ONCE at the full output-canvas size. The
        # branches below then crop windows out of that same full frame.
        f"[0:v]scale={target_w}:{target_h}:force_original_aspect_ratio=increase,"
        f"crop={target_w}:{target_h}:(iw-{target_w})/2:(ih-{target_h})/2,split=4[a0][a1][a2][a3]",
        f"[1:v]scale={target_w}:{target_h}:force_original_aspect_ratio=increase,"
        f"crop={target_w}:{target_h}:(iw-{target_w})/2:(ih-{target_h})/2,split=4[b0][b1][b2][b3]",
    ]

    cell_labels = []
    used_branches = {"a": set(), "b": set()}
    for index, (x, y, width, height) in enumerate(cells):
        source = quadrants[index]
        used_branches[source].add(index)
        source_label = f"[{source}{index}]"
        cell_label = f"[cell{index}]"
        filter_complex.append(
            f"{source_label}crop={width}:{height}:{x}:{y}{cell_label}"
        )
        cell_labels.append(cell_label)

    # Every output of split=4 must be consumed. A source may occupy one to
    # four quadrants, so send unused branches to nullsink.
    for source in ("a", "b"):
        for index in range(4):
            if index not in used_branches[source]:
                filter_complex.append(f"[{source}{index}]nullsink")

    current = "[base]"
    for index, (x, y, _width, _height) in enumerate(cells):
        next_label = "[vout]" if index == len(cells) - 1 else f"[comp{index}]"
        filter_complex.append(
            f"{current}{cell_labels[index]}overlay={x}:{y}:shortest=1{next_label}"
        )
        current = next_label

    filter_complex.append("[0:a][1:a]amix=inputs=2:duration=shortest:normalize=0[aout]")

    cmd += [
        "-filter_complex", ";".join(filter_complex),
        "-map", "[vout]",
        "-map", "[aout]",
        "-t", f"{duration:.6f}",
    ]
    if quality == "proxy":
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26"]
    else:
        cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "18"]

    cmd += ["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", output_path]
    run(cmd)

def concat_clips(rendered_paths: list[str], output_path: str) -> None:
    """Concatenate already-rendered clip files.

    Individual clips can have different frame sizes (e.g. one was rotated
    90deg, changing its aspect ratio). The concat demuxer's fast `-c copy`
    path does NOT validate this -- it will happily "succeed" while producing
    a corrupted output where mismatched segments render incorrectly. So we
    always probe dimensions first: if they all match, use the fast copy path;
    otherwise, normalize every clip to a common canvas (scale-to-fit + letterbox
    pad) via filter_complex before concatenating, and re-encode.
    """
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    dims = [_probe_dims(p) for p in rendered_paths]
    all_same = len(set(dims)) == 1

    if all_same:
        list_file = output_path + ".concat_list.txt"
        with open(list_file, "w") as f:
            for p in rendered_paths:
                f.write(f"file '{Path(p).resolve()}'\n")
        try:
            cmd = ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", list_file, "-c", "copy", output_path]
            run(cmd)
            return
        except FFmpegError:
            pass  # fall through to the normalized re-encode path below
        finally:
            Path(list_file).unlink(missing_ok=True)

    # Normalize to the largest width/height seen, preserving each clip's aspect
    # ratio via scale-to-fit + black-bar padding, then concat + re-encode.
    target_w = max(w for w, h in dims)
    target_h = max(h for w, h in dims)
    # Ensure even dimensions (required by yuv420p)
    target_w = max(4, target_w + target_w % 2)
    target_h = max(4, target_h + target_h % 2)

    inputs = []
    filter_parts = []
    concat_refs = []
    for i, p in enumerate(rendered_paths):
        inputs += ["-i", p]
        filter_parts.append(
            f"[{i}:v:0]scale={target_w}:{target_h}:force_original_aspect_ratio=decrease,"
            f"pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v{i}]"
        )
        concat_refs.append(f"[v{i}][{i}:a:0]")

    filter_str = ";".join(filter_parts) + ";" + "".join(concat_refs) + f"concat=n={len(rendered_paths)}:v=1:a=1[v][a]"
    cmd = ["ffmpeg", "-y", *inputs, "-filter_complex", filter_str,
           "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast",
           "-c:a", "aac", output_path]
    run(cmd)