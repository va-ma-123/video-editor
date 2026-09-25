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
from typing import Optional, Any

from .models import Clip, SourceInfo, CropOp

# Bump this any time render_clip's filter-building logic changes in a way that
# would produce different output for the same clip inputs. Cache keys include
# this, so old cached renders from before the change are automatically treated
# as stale instead of silently being reused.
#
# v3: audio.mode gained "inherit" and "metronome".
# v4: a metronome's audio no longer gets re-stretched by speed factor.
# v5: MetronomeOp gained start_frame/end_frame windowing.
# v6: Added animated moving crop support via dynamic FFmpeg expressions.
RENDER_LOGIC_VERSION = 6


class FFmpegError(RuntimeError):
    pass


IMAGE_CLIP_FPS = 30.0


def generate_video_from_image(image_path: str, output_path: str, duration_sec: float, fps: float = IMAGE_CLIP_FPS) -> None:
    """Turn a still image into a silent .mp4 of exactly `duration_sec`,
    displaying the image the whole time."""
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-loop", "1", "-i", image_path,
        "-t", f"{duration_sec:.6f}",
        "-r", str(fps),
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-pix_fmt", "yuv420p",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-movflags", "+faststart",
        output_path,
    ]
    run(cmd)


def run(cmd: list[str]) -> str:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if "ffmpeg" in cmd[0]:
        print("=" * 60)
        print("FFMPEG CMD:", " ".join(shlex.quote(c) for c in cmd))
        print("--- stderr (last 3000 chars) ---")
        print(proc.stderr[-3000:])
        print("=" * 60)
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

    num, den = video_stream["r_frame_rate"].split("/")
    fps = float(num) / float(den)

    duration = float(data["format"].get("duration", video_stream.get("duration", 0)))
    total_frames = video_stream.get("nb_frames")
    if total_frames is not None:
        total_frames = int(total_frames)
    else:
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
    """Downscale to a low-res, fast-seeking proxy."""
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
    """Deterministic hash used to skip re-rendering unchanged clips."""
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
    """Just the duration of a rendered file, in seconds."""
    out = run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", path,
    ])
    return float(out.strip())


def _build_crop_filter_string(crop_data: Any, fallback_duration: float) -> Optional[str]:
    """Generates an FFmpeg crop filter string supporting both static and animated crops."""
    if not crop_data:
        return None

    # Handle Pydantic model conversion if needed
    if isinstance(crop_data, CropOp):
        crop_dict = crop_data.model_dump()
    elif isinstance(crop_data, dict):
        crop_dict = crop_data
    else:
        return None

    is_animated = crop_dict.get("animated", False)

    if not is_animated:
        # Static crop fallback
        x = crop_dict.get("x", 0)
        y = crop_dict.get("y", 0)
        w = crop_dict.get("w") if crop_dict.get("w") is not None else crop_dict.get("width", 1920)
        h = crop_dict.get("h") if crop_dict.get("h") is not None else crop_dict.get("height", 1080)
        return f"crop={w}:{h}:{x}:{y}"

    # Extract animated parameters
    start = crop_dict.get("start_crop") or {}
    end = crop_dict.get("end_crop") or {}
    
    # Fall back to static params if start or end bounds are missing
    s_x = start.get("x", crop_dict.get("x", 0))
    s_y = start.get("y", crop_dict.get("y", 0))
    s_w = start.get("w", crop_dict.get("w") or crop_dict.get("width", 1920))
    s_h = start.get("h", crop_dict.get("h") or crop_dict.get("height", 1080))

    e_x = end.get("x", s_x)
    e_y = end.get("y", s_y)
    e_w = end.get("w", s_w)
    e_h = end.get("h", s_h)

    duration = float(crop_dict.get("duration_sec") or fallback_duration)
    if duration <= 0:
        duration = fallback_duration or 1.0

    # FFmpeg time-evaluated filter expressions
    w_expr = f"'{s_w}+({e_w}-{s_w})*min(1,t/{duration:.6f})'"
    h_expr = f"'{s_h}+({e_h}-{s_h})*min(1,t/{duration:.6f})'"
    x_expr = f"'{s_x}+({e_x}-{s_x})*min(1,t/{duration:.6f})'"
    y_expr = f"'{s_y}+({e_y}-{s_y})*min(1,t/{duration:.6f})'"

    return f"crop={w_expr}:{h_expr}:{x_expr}:{y_expr}"


def _build_video_filters(clip: Clip, fps: float, output_duration: float) -> list[str]:
    filters = []
    ops = clip.operations

    if ops.reverse:
        filters.append("reverse")

    speed = ops.speed
    if speed.factor != 1.0:
        filters.append(f"setpts=(1/{speed.factor})*PTS")

    if ops.freeze_frame and ops.freeze_frame.duration_sec > 0:
        ff = ops.freeze_frame
        if ff.position == "start":
            filters.append(f"tpad=start_mode=clone:start_duration={ff.duration_sec}")
        else:
            filters.append(f"tpad=stop_mode=clone:stop_duration={ff.duration_sec}")

    t = ops.transform
    if t.crop:
        crop_filter = _build_crop_filter_string(t.crop, fallback_duration=output_duration)
        if crop_filter:
            filters.append(crop_filter)

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
        filters.append(f"__FADE_OUT_PLACEHOLDER__={fade.fade_out.duration_sec}")

    return filters


def _build_audio_filters(clip: Clip, speed_factor: float, sync_to_speed: bool = True) -> list[str]:
    filters = []
    ops = clip.operations

    if ops.audio.mode == "muted":
        return ["volume=0"]

    if ops.reverse:
        filters.append("areverse")

    if sync_to_speed and speed_factor != 1.0 and ops.speed.pitch_correction:
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
    """Render a single EDL clip entry to a standalone mp4 file."""
    src_path = source.proxy_path if quality == "proxy" else source.original_path
    fps = source.fps or 30.0

    start_sec = clip.start_frame / fps
    end_sec = clip.end_frame / fps
    trim_duration = max(end_sec - start_sec, 1 / fps)

    speed_factor = clip.operations.speed.factor
    freeze_extra = clip.operations.freeze_frame.duration_sec if clip.operations.freeze_frame else 0.0
    output_duration = (trim_duration / speed_factor) + freeze_extra

    video_filters = _build_video_filters(clip, fps, output_duration)
    audio_filters = _build_audio_filters(clip, speed_factor, sync_to_speed=sync_audio_to_speed)

    fade_out_d = clip.operations.fade.fade_out.duration_sec
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
    cmd += ["-ss", f"{start_sec:.6f}", "-t", f"{trim_duration:.6f}", "-i", src_path]

    has_replacement_audio = (
        clip.operations.audio.mode == "replaced" and audio_asset_path is not None
    )
    if has_replacement_audio:
        cmd += ["-ss", f"{clip.operations.audio.replacement_start_sec:.6f}", "-i", audio_asset_path]

    filter_complex_parts = []
    filter_complex_parts.append(f"[0:v]{','.join(video_filters)}[vout]" if video_filters else "[0:v]null[vout]")

    if has_replacement_audio:
        a_chain = ",".join(audio_filters) if audio_filters else "anull"
        filter_complex_parts.append(f"[1:a]{a_chain}[aout]")
    elif source.has_audio and clip.operations.audio.mode != "muted":
        a_chain = ",".join(audio_filters) if audio_filters else "anull"
        filter_complex_parts.append(f"[0:a]{a_chain}[aout]")
    else:
        filter_complex_parts.append("anullsrc=r=48000:cl=stereo[aout]")

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


def concat_clips(rendered_paths: list[str], output_path: str) -> None:
    """Concatenate already-rendered clip files."""
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
            pass
        finally:
            Path(list_file).unlink(missing_ok=True)

    target_w = max(w for w, h in dims)
    target_h = max(h for w, h in dims)
    target_w += target_w % 2
    target_h += target_h % 2

    inputs = []
    filter_parts = []
    concat_refs = []
    for i, p in enumerate(rendered_paths):
        inputs += ["-i", p]
        filter_parts.append(
            f"[{i}:v:0]scale={target_w}:{target_h}:force_original_aspect_ratio=decrease,"
            f"pad={target_w}:{target_h}:(ow-ih)/2:(oh-ih)/2,setsar=1[v{i}]"
        )
        concat_refs.append(f"[v{i}][{i}:a:0]")

    filter_str = ";".join(filter_parts) + ";" + "".join(concat_refs) + f"concat=n={len(rendered_paths)}:v=1:a=1[v][a]"
    cmd = ["ffmpeg", "-y", *inputs, "-filter_complex", filter_str,
           "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast",
           "-c:a", "aac", output_path]
    run(cmd)