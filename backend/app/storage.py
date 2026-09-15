"""
Persistence layer. Per the plan: no database, just JSON files on disk.
Each project is a single JSON file in storage/projects/{id}.json
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import List

from .models import Project

BASE_DIR = Path(__file__).resolve().parent.parent / "storage"
PROJECTS_DIR = BASE_DIR / "projects"
ORIGINALS_DIR = BASE_DIR / "originals"
PROXIES_DIR = BASE_DIR / "proxies"
CACHE_DIR = BASE_DIR / "cache"
EXPORTS_DIR = BASE_DIR / "exports"
AUDIO_ASSETS_DIR = BASE_DIR / "audio_assets"

for d in [PROJECTS_DIR, ORIGINALS_DIR, PROXIES_DIR, CACHE_DIR, EXPORTS_DIR, AUDIO_ASSETS_DIR]:
    d.mkdir(parents=True, exist_ok=True)


def project_path(project_id: str) -> Path:
    return PROJECTS_DIR / f"{project_id}.json"


def save_project(project: Project) -> None:
    project_path(project.id).write_text(project.model_dump_json(indent=2))


def load_project(project_id: str) -> Project:
    p = project_path(project_id)
    if not p.exists():
        raise FileNotFoundError(f"Project {project_id} not found")
    return Project.model_validate_json(p.read_text())


def list_projects() -> List[dict]:
    out = []
    for f in PROJECTS_DIR.glob("*.json"):
        try:
            data = json.loads(f.read_text())
            out.append({"id": data["id"], "name": data.get("name", "Untitled"), "clip_count": len(data.get("clips", []))})
        except Exception:
            continue
    return out


def delete_project(project_id: str) -> None:
    project_path(project_id).unlink(missing_ok=True)


def clean_cache(max_age_hours: float) -> dict:
    """Delete cached rendered clips (backend/storage/cache/*.mp4) older than
    max_age_hours, based on last-modified time. Safe to run at any time:
    cache files are purely disposable derived output -- render_clip.py's
    _ensure_clip_rendered() already checks existence before reusing a cache
    file, so a deleted entry just gets transparently re-rendered next time
    that exact clip/operations combination is requested. Nothing else in the
    app references a cache file by any identity that would break if it's gone.
    """
    cutoff = time.time() - (max_age_hours * 3600)
    deleted_count = 0
    bytes_freed = 0
    for f in CACHE_DIR.glob("*.mp4"):
        try:
            stat = f.stat()
            if stat.st_mtime < cutoff:
                bytes_freed += stat.st_size
                f.unlink()
                deleted_count += 1
        except FileNotFoundError:
            continue  # already removed by something else; not an error
    return {"deleted_count": deleted_count, "bytes_freed": bytes_freed, "max_age_hours": max_age_hours}