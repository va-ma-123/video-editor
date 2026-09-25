from __future__ import annotations

import re
import shutil
import threading
import traceback
from pathlib import Path
from typing import Dict, Optional

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse

from . import storage, ffmpeg_utils, metronome
from .groups_util import group_ancestor_chain, clips_in_group
from .models import Project, SourceInfo, Clip, ExportJob, new_id

print(">>> main.py loaded, marker: TEST12345 <<<")

app = FastAPI(title="Clip Editor API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Cache files older than this get swept on every server startup. Purely a
# disk-space measure -- see storage.clean_cache for why this is always safe.
DEFAULT_CACHE_MAX_AGE_HOURS = 72  # 3 days


@app.on_event("startup")
def _sweep_cache_on_startup():
    result = storage.clean_cache(DEFAULT_CACHE_MAX_AGE_HOURS)
    if result["deleted_count"] > 0:
        mb_freed = result["bytes_freed"] / (1024 * 1024)
        print(f"[cache sweep] removed {result['deleted_count']} old cache file(s), freed {mb_freed:.1f} MB")


# In-memory job tracking (fine for single-user local tool; not persisted across restarts)
EXPORT_JOBS: Dict[str, ExportJob] = {}

RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")
CHUNK_SIZE = 1024 * 1024  # 1MB per streamed chunk


def _serve_media_file(request: Request, directory: Path, filename: str) -> StreamingResponse | FileResponse:
    """Serve a file with proper HTTP Range support.

    Browsers require Range requests to work for <video> seeking: when you
    drag a scrub bar to an unbuffered position, the browser asks for just
    that byte range rather than re-downloading the whole file. FastAPI's
    built-in StaticFiles does NOT implement this (confirmed: its FileResponse
    has no Range handling), so it always sends the entire file regardless of
    what was asked for -- seeking silently fails for any file that hasn't
    already fully downloaded into the browser's buffer. This function
    implements Range support directly.
    """
    file_path = directory / filename
    if not file_path.is_file():
        raise HTTPException(404, "File not found")

    file_size = file_path.stat().st_size
    range_header = request.headers.get("range")

    if range_header is None:
        # No range requested -- send the whole file, but advertise that we
        # DO support ranges so the browser knows it can ask for pieces next time.
        response = FileResponse(str(file_path), media_type="video/mp4")
        response.headers["Accept-Ranges"] = "bytes"
        return response

    match = RANGE_RE.match(range_header)
    if not match:
        raise HTTPException(416, "Invalid Range header")

    start_str, end_str = match.groups()
    start = int(start_str) if start_str else 0
    end = int(end_str) if end_str else file_size - 1
    end = min(end, file_size - 1)

    if start > end or start >= file_size:
        raise HTTPException(416, f"Requested range not satisfiable (file size {file_size})")

    content_length = end - start + 1

    def stream_range():
        with open(file_path, "rb") as f:
            f.seek(start)
            remaining = content_length
            while remaining > 0:
                chunk = f.read(min(CHUNK_SIZE, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    headers = {
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(content_length),
    }
    return StreamingResponse(stream_range(), status_code=206, media_type="video/mp4", headers=headers)


@app.get("/media/proxies/{filename}")
def serve_proxy(request: Request, filename: str):
    return _serve_media_file(request, storage.PROXIES_DIR, filename)


@app.get("/media/cache/{filename}")
def serve_cache(request: Request, filename: str):
    return _serve_media_file(request, storage.CACHE_DIR, filename)


@app.get("/media/exports/{filename}")
def serve_export(request: Request, filename: str):
    return _serve_media_file(request, storage.EXPORTS_DIR, filename)


@app.get("/media/originals/{filename}")
def serve_original(request: Request, filename: str):
    return _serve_media_file(request, storage.ORIGINALS_DIR, filename)


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------

@app.post("/api/projects")
def create_project(name: str = "Untitled Project"):
    project = Project(id=new_id("proj"), name=name)
    storage.save_project(project)
    return project


@app.get("/api/projects")
def list_projects():
    return storage.list_projects()


@app.get("/api/projects/{project_id}")
def get_project(project_id: str):
    try:
        return storage.load_project(project_id)
    except FileNotFoundError:
        raise HTTPException(404, "Project not found")


@app.put("/api/projects/{project_id}")
def update_project(project_id: str, project: Project):
    if project.id != project_id:
        raise HTTPException(400, "Project id mismatch")
    storage.save_project(project)
    return project


@app.delete("/api/projects/{project_id}")
def remove_project(project_id: str):
    storage.delete_project(project_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Source upload + proxy generation
# ---------------------------------------------------------------------------

def _generate_proxy_background(project_id: str, source_id: str):
    try:
        project = storage.load_project(project_id)
        source = project.sources[source_id]
        source.proxy_status = "processing"
        storage.save_project(project)

        proxy_path = str(storage.PROXIES_DIR / f"{source_id}.mp4")
        ffmpeg_utils.generate_proxy(source.original_path, proxy_path)

        info = ffmpeg_utils.probe_source(source.original_path)
        project = storage.load_project(project_id)  # reload in case of concurrent edits
        source = project.sources[source_id]
        source.proxy_path = proxy_path
        source.proxy_status = "ready"
        source.fps = info["fps"]
        source.total_frames = info["total_frames"]
        source.duration_sec = info["duration_sec"]
        source.width = info["width"]
        source.height = info["height"]
        source.has_audio = info["has_audio"]
        storage.save_project(project)
    except Exception as e:
        traceback.print_exc()
        try:
            project = storage.load_project(project_id)
            project.sources[source_id].proxy_status = "failed"
            project.sources[source_id].error = str(e)
            storage.save_project(project)
        except Exception:
            pass


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
# .gif deliberately excluded -- an animated gif is ambiguous under this
# feature (loop just its first frame? honor its own timing instead of
# duration_sec? treat it as a tiny video instead?) and isn't handled here.


@app.post("/api/projects/{project_id}/sources")
def upload_source(project_id: str, file: UploadFile = File(...), duration_sec: Optional[float] = Form(None)):
    project = storage.load_project(project_id)

    source_id = new_id("source")
    ext = (Path(file.filename).suffix or "").lower()
    is_image = ext in IMAGE_EXTENSIONS

    if is_image:
        if not duration_sec or duration_sec <= 0:
            raise HTTPException(400, "duration_sec (a positive number of seconds) is required when uploading an image")
        # Write the raw upload to a temp path, convert it into a real silent
        # .mp4 of the requested length, then discard the temp image file --
        # from here on this source goes through the exact same ingestion
        # path (probe_source, generate_proxy) as an uploaded video, and
        # render_clip/concat_clips/metronome never need to know the
        # difference. We don't keep the original image around: there's no
        # "extend the duration later" feature built on top of this yet, and
        # keeping unused originals would just be silent storage growth.
        temp_image_path = storage.ORIGINALS_DIR / f"{source_id}_src{ext}"
        with open(temp_image_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
        original_path = storage.ORIGINALS_DIR / f"{source_id}.mp4"
        try:
            ffmpeg_utils.generate_video_from_image(str(temp_image_path), str(original_path), duration_sec)
        except ffmpeg_utils.FFmpegError as e:
            raise HTTPException(400, f"Couldn't process image: {e}")
        finally:
            temp_image_path.unlink(missing_ok=True)
    else:
        original_path = storage.ORIGINALS_DIR / f"{source_id}{ext or '.mp4'}"
        with open(original_path, "wb") as f:
            shutil.copyfileobj(file.file, f)

    source = SourceInfo(
        id=source_id,
        filename=file.filename,
        original_path=str(original_path),
        proxy_status="pending",
        source_kind="image" if is_image else "video",
    )
    project.sources[source_id] = source
    storage.save_project(project)

    thread = threading.Thread(target=_generate_proxy_background, args=(project_id, source_id), daemon=True)
    thread.start()

    return source


@app.get("/api/projects/{project_id}/sources/{source_id}")
def get_source(project_id: str, source_id: str):
    project = storage.load_project(project_id)
    if source_id not in project.sources:
        raise HTTPException(404, "Source not found")
    return project.sources[source_id]


@app.delete("/api/projects/{project_id}/sources/{source_id}")
def delete_source(project_id: str, source_id: str):
    project = storage.load_project(project_id)
    if source_id not in project.sources:
        raise HTTPException(404, "Source not found")

    source = project.sources[source_id]

    # Cascade: any clip referencing this source is removed from the timeline too,
    # since a clip pointing at a deleted source can't be rendered.
    removed_clip_ids = [c.id for c in project.clips if c.source_id == source_id]
    project.clips = [c for c in project.clips if c.source_id != source_id]
    del project.sources[source_id]
    storage.save_project(project)

    # Best-effort cleanup of the underlying files; not fatal if this fails.
    for path_str in [source.original_path, source.proxy_path]:
        if path_str:
            try:
                Path(path_str).unlink(missing_ok=True)
            except Exception:
                pass

    return {"project": project, "removed_clip_ids": removed_clip_ids}


# ---------------------------------------------------------------------------
# Audio asset upload (for "replace audio" operation)
# ---------------------------------------------------------------------------

@app.post("/api/audio-assets")
def upload_audio_asset(file: UploadFile = File(...)):
    asset_id = new_id("audio")
    ext = Path(file.filename).suffix or ".mp3"
    dest = storage.AUDIO_ASSETS_DIR / f"{asset_id}{ext}"
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)
    return {"id": asset_id, "path": str(dest), "filename": file.filename}


# NOTE: audio-asset path lookup for rendering now lives in metronome.py
# (used inside resolve_clip_audio), since it needs the same lookup for both
# a genuine "replaced" asset and a metronome's optional custom click sound.



# ---------------------------------------------------------------------------
# WIP playback: render the current EDL at proxy quality, fast, synchronous
# ---------------------------------------------------------------------------

def _ensure_clip_rendered(project: Project, clip: Clip, quality: str) -> Path:
    """Render a clip to the cache dir if not already cached, and return its path."""
    source = project.sources.get(clip.source_id)
    if source is None or source.proxy_status != "ready":
        raise HTTPException(400, f"Source {clip.source_id} proxy not ready")

    try:
        resolved_audio = metronome.resolve_clip_audio(project, clip)
    except metronome.AudioAssetNotFound as e:
        raise HTTPException(400, str(e))

    cache_key = ffmpeg_utils.clip_cache_key(source, clip, quality=quality, resolved_audio=resolved_audio.fingerprint)
    prefix = "final_" if quality == "final" else ""
    cache_path = storage.CACHE_DIR / f"{prefix}{cache_key}.mp4"
    if not cache_path.exists():
        # ffmpeg_utils/render_clip only ever see "original" / "muted" /
        # "replaced" -- "inherit" and "metronome" are fully resolved above,
        # with a metronome landing here as a synthesized WAV played back
        # through the exact same "replaced" path a user-uploaded replacement
        # audio file already uses.
        render_clip_input = clip.model_copy(deep=True)
        render_clip_input.operations.audio.mode = resolved_audio.mode
        render_clip_input.operations.audio.volume = resolved_audio.volume
        render_clip_input.operations.audio.replacement_start_sec = resolved_audio.replacement_start_sec
        ffmpeg_utils.render_clip(
            source, render_clip_input, str(cache_path), quality=quality,
            audio_asset_path=resolved_audio.asset_path,
            sync_audio_to_speed=resolved_audio.sync_to_speed,
        )
    return cache_path


def _build_clip_boundaries(clips: list[Clip], rendered_paths: list[str]) -> list[dict]:
    """Exact clip_id -> [start_sec, end_sec] ranges within a concatenated
    output, measured from each clip's actual rendered file rather than
    estimated from speed/freeze math -- avoids drift from small per-clip
    encoding overhead accumulating across a long timeline."""
    boundaries = []
    cursor = 0.0
    for clip, path in zip(clips, rendered_paths):
        duration = ffmpeg_utils.probe_duration(path)
        boundaries.append({"clip_id": clip.id, "start_sec": cursor, "end_sec": cursor + duration})
        cursor += duration
    return boundaries


@app.post("/api/projects/{project_id}/render-wip")
def render_wip(project_id: str):
    project = storage.load_project(project_id)
    if not project.clips:
        raise HTTPException(400, "No clips in project")

    rendered_paths = [str(_ensure_clip_rendered(project, clip, quality="proxy")) for clip in project.clips]

    if len(rendered_paths) == 1:
        wip_path = storage.EXPORTS_DIR / f"wip_{project_id}.mp4"
        shutil.copyfile(rendered_paths[0], wip_path)
    else:
        wip_path = storage.EXPORTS_DIR / f"wip_{project_id}.mp4"
        ffmpeg_utils.concat_clips(rendered_paths, str(wip_path))

    boundaries = _build_clip_boundaries(project.clips, rendered_paths)
    return {"url": f"/media/exports/{wip_path.name}", "cache_bust": wip_path.stat().st_mtime, "clip_boundaries": boundaries}


@app.post("/api/projects/{project_id}/clips/{clip_id}/render-preview")
def render_clip_preview(project_id: str, clip_id: str):
    project = storage.load_project(project_id)
    clip = next((c for c in project.clips if c.id == clip_id), None)
    if clip is None:
        raise HTTPException(404, "Clip not found")

    cache_path = _ensure_clip_rendered(project, clip, quality="proxy")
    boundaries = _build_clip_boundaries([clip], [str(cache_path)])
    return {"url": f"/media/cache/{cache_path.name}", "cache_bust": cache_path.stat().st_mtime, "clip_boundaries": boundaries}


def _clips_in_group(project: Project, group_id: str) -> list[Clip]:
    return clips_in_group(project, group_id)


@app.post("/api/projects/{project_id}/groups/{group_id}/render-preview")
def render_group_preview(project_id: str, group_id: str):
    project = storage.load_project(project_id)
    if group_id not in project.groups:
        raise HTTPException(404, "Group not found")

    group_clips = _clips_in_group(project, group_id)
    if not group_clips:
        raise HTTPException(400, "Group has no clips")

    rendered_paths = [str(_ensure_clip_rendered(project, clip, quality="proxy")) for clip in group_clips]

    preview_path = storage.EXPORTS_DIR / f"group_preview_{group_id}.mp4"
    if len(rendered_paths) == 1:
        shutil.copyfile(rendered_paths[0], preview_path)
    else:
        ffmpeg_utils.concat_clips(rendered_paths, str(preview_path))

    return {"url": f"/media/exports/{preview_path.name}", "cache_bust": preview_path.stat().st_mtime,
            "clip_boundaries": _build_clip_boundaries(group_clips, rendered_paths)}


def _clips_from_clip(project: Project, clip_id: str) -> list[Clip]:
    """The selected clip and every clip after it in the timeline."""
    for i, clip in enumerate(project.clips):
        if clip.id == clip_id:
            return project.clips[i:]
    raise HTTPException(404, "Clip not found")


def _clips_from_group(project: Project, group_id: str) -> list[Clip]:
    """From this group's first clip onward -- continues past the group's own
    end and through the rest of the timeline, not just the group's contents."""
    if group_id not in project.groups:
        raise HTTPException(404, "Group not found")
    group_clips = _clips_in_group(project, group_id)
    if not group_clips:
        raise HTTPException(400, "Group has no clips")
    return _clips_from_clip(project, group_clips[0].id)


def _render_continuation(project: Project, clips: list[Clip]):
    """Render a sequence of clips (already resolved by the caller) into one preview."""
    if not clips:
        raise HTTPException(404, "No clips to render")

    rendered_paths = [str(_ensure_clip_rendered(project, clip, quality="proxy")) for clip in clips]
    continuation_path = storage.EXPORTS_DIR / f"continuation_{project.id}.mp4"

    if len(rendered_paths) == 1:
        shutil.copyfile(rendered_paths[0], continuation_path)
    else:
        ffmpeg_utils.concat_clips(rendered_paths, str(continuation_path))

    return {"url": f"/media/exports/{continuation_path.name}", "cache_bust": continuation_path.stat().st_mtime,
            "clip_boundaries": _build_clip_boundaries(clips, rendered_paths)}


@app.post("/api/projects/{project_id}/clips/{clip_id}/render-cont")
def render_clip_continuation(project_id: str, clip_id: str):
    project = storage.load_project(project_id)
    clips = _clips_from_clip(project, clip_id)
    return _render_continuation(project, clips)


@app.post("/api/projects/{project_id}/groups/{group_id}/render-cont")
def render_group_continuation(project_id: str, group_id: str):
    project = storage.load_project(project_id)
    clips = _clips_from_group(project, group_id)
    return _render_continuation(project, clips)


@app.get("/debug/routes")
def debug_routes():
    return [
        {
            "path": route.path,
            "methods": list(route.methods or [])
        }
        for route in app.routes
    ]


# ---------------------------------------------------------------------------
# Final export: async background job with per-clip progress
# ---------------------------------------------------------------------------

def _run_export_job(job_id: str, project_id: str):
    job = EXPORT_JOBS[job_id]
    try:
        project = storage.load_project(project_id)
        job.status = "rendering"
        job.total_clips = len(project.clips)

        rendered_paths = []
        for clip in project.clips:
            cache_path = _ensure_clip_rendered(project, clip, quality="final")
            rendered_paths.append(str(cache_path))
            job.completed_clips += 1
            job.ready_clip_paths.append(f"/media/cache/{cache_path.name}")

        job.status = "concatenating"
        output_path = storage.EXPORTS_DIR / f"export_{job_id}.mp4"
        if len(rendered_paths) == 1:
            shutil.copyfile(rendered_paths[0], output_path)
        else:
            ffmpeg_utils.concat_clips(rendered_paths, str(output_path))

        job.output_path = f"/media/exports/{output_path.name}"
        job.status = "done"
    except Exception as e:
        traceback.print_exc()
        job.status = "failed"
        job.error = str(e)


@app.post("/api/projects/{project_id}/export")
def start_export(project_id: str):
    project = storage.load_project(project_id)
    if not project.clips:
        raise HTTPException(400, "No clips in project")

    job_id = new_id("job")
    job = ExportJob(id=job_id, project_id=project_id, total_clips=len(project.clips))
    EXPORT_JOBS[job_id] = job

    thread = threading.Thread(target=_run_export_job, args=(job_id, project_id), daemon=True)
    thread.start()

    return {"job_id": job_id}


@app.get("/api/export-jobs/{job_id}")
def get_export_job(job_id: str):
    job = EXPORT_JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    return job


@app.post("/api/cache/clean")
def clean_cache(max_age_hours: float = DEFAULT_CACHE_MAX_AGE_HOURS):
    """Manually sweep old cache files, on top of the automatic startup sweep.
    E.g. POST /api/cache/clean?max_age_hours=0 clears everything right now."""
    return storage.clean_cache(max_age_hours)


@app.get("/")
def root():
    return {"status": "ok", "service": "clip-editor-backend"}