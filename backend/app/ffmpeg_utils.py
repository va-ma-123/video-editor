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
RENDER_LOGIC_VERSION = 2


class FFmpegError(RuntimeError):
    pass


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


def clip_cache_key(source: SourceInfo, clip: Clip, quality: str) -> str:
    """Deterministic hash used to skip re-rendering unchanged clips."""
    payload = json.dumps({
        "render_logic_version": RENDER_LOGIC_VERSION,
        "source_id": source.id,
        "source_mtime": Path(source.original_path).stat().st_mtime if quality == "final" else None,
        "start_frame": clip.start_frame,
        "end_frame": clip.end_frame,
        "operations": clip.operations.model_dump(),
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
        extra_frames = int(round(ff.duration_sec * fps))
        if ff.position == "start":
            filters.append(f"tpad=start_mode=clone:start_duration={ff.duration_sec}")
        else:
            filters.append(f"tpad=stop_mode=clone:stop_duration={ff.duration_sec}")

    t = ops.transform
    if t.crop:
        filters.append(f"crop={t.crop['width']}:{t.crop['height']}:{t.crop['x']}:{t.crop['y']}")
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


def _build_audio_filters(clip: Clip, speed_factor: float) -> list[str]:
    filters = []
    ops = clip.operations

    if ops.audio.mode == "muted":
        return ["volume=0"]

    if ops.reverse:
        filters.append("areverse")

    if speed_factor != 1.0 and ops.speed.pitch_correction:
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
    elif speed_factor != 1.0 and not ops.speed.pitch_correction:
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
) -> None:
    """Render a single EDL clip entry to a standalone mp4 file.

    quality: "proxy" uses source.proxy_path, "final" uses source.original_path.
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

    video_filters = _build_video_filters(clip, fps)
    audio_filters = _build_audio_filters(clip, speed_factor)

    # Resolve fade-out placeholders now that we know output_duration
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

    filter_complex_parts = []
    filter_complex_parts.append(f"[0:v]{','.join(video_filters)}[vout]" if video_filters else "[0:v]null[vout]")

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
    target_w += target_w % 2
    target_h += target_h % 2

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