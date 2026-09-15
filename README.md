# Clip Editor — Phase 1

A local, frame-accurate video editor: trim, reverse, speed-change, freeze-frame,
crop/rotate/flip, fade, and re-score/mute audio on clips, then stitch them
together and export.

## Architecture

- **Backend**: Python + FastAPI, using `ffmpeg`/`ffprobe` for all video work.
  Projects are stored as plain JSON files (no database) in `backend/storage/projects/`.
- **Frontend**: React + Vite. Talks to the backend over HTTP.
- **Storage layout** (`backend/storage/`):
  - `originals/` — uploaded source videos (full quality)
  - `proxies/` — low-res versions used for scrubbing/preview (fast to seek)
  - `cache/` — rendered individual clips, keyed by a hash of their trim range +
    operations, so re-rendering the timeline after a small tweak only
    re-processes what changed
  - `exports/` — final stitched outputs (and the WIP preview file)
  - `projects/` — one JSON file per project (the EDL)
  - `audio_assets/` — uploaded replacement audio files

See `EDL_NOTES.md` for the data model this is all built around.

## Requirements

- Python 3.10+
- Node.js 18+
- `ffmpeg` and `ffprobe` on your `PATH` (check with `ffmpeg -version`).
  - macOS: `brew install ffmpeg`
  - Ubuntu/Debian: `sudo apt install ffmpeg`
  - Windows: https://ffmpeg.org/download.html (add the `bin` folder to PATH)

## Running it

**1. Backend**

```bash
cd backend
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000
```

Leave this running. It serves the API and the generated media files at `http://localhost:8000`.

**2. Frontend** (in a second terminal)

```bash
cd frontend
npm install
npm run dev
```

Open the URL it prints (typically `http://localhost:5173`).

## Using it

1. **New project** → give it a name.
2. **Upload a source video.** It uploads immediately; a low-res proxy generates
   in the background (you'll see the status change from "processing" to "ready").
   Scrubbing and frame-stepping happen against this proxy, not the full file,
   so it stays fast even with huge source videos.
3. **Scrub to find your range.** Use the frame-step buttons (◀ Frame / Frame ▶) for
   exact frame accuracy, or the ⏪10 / 10⏩ buttons to move faster. Set an In point
   and an Out point, then **+ Add Clip to Timeline**.
4. **Select a clip** in the timeline (left panel) to edit its operations in the
   right panel: reverse, speed (0.1x–5x, with a pitch-correction toggle), freeze
   frame, fade in/out, volume/mute/replace audio, crop, rotate, flip.
5. Reorder clips with the ↑/↓ buttons, **split** a clip at its midpoint, or
   delete it, all from the timeline.
6. **▶ Play work-in-progress** renders your current timeline at low-res and
   plays it back, so you can check your progress at any point. Unchanged clips
   are served from cache, so this is fast after the first render.
7. **Export final video** starts a background render at full quality. A
   progress bar tracks clips as they finish, and a small preview player plays
   through completed clips while the rest are still rendering. When done,
   download the final file.

## Known phase-1 simplifications (documented, not bugs)

- **Progressive export preview** plays finished clips back-to-back by swapping
  the `<video>` element's source, rather than using true MSE segment-appending.
  It looks and feels continuous in normal use, but there can be a very brief
  re-buffer at each clip boundary. If that bothers you, this is the one part
  of the system designed to be swapped for real MSE later without touching
  anything else.
- **Reordering** uses ↑/↓ buttons rather than drag-and-drop. Functionally
  equivalent, just less slick — an easy upgrade later.
- **Frame stepping** relies on `<video>` seeking + the browser's frame
  timing; it's been reliable in testing, but if you ever hit a source/codec
  where it visibly drifts, the fallback discussed during planning (extracting
  every frame as a JPEG for the scrubber) is a bounded, known fix.
- No authentication/multi-user support — this is a single-user local tool, as
  scoped.

## Extending later

Everything (transitions, text overlays, cross-fades between clips, a real job
queue, a database) was deliberately deferred, not architecturally blocked.
The EDL's operations block is a fixed-shape object per clip specifically so
that adding a new key there, plus a corresponding filter in
`backend/app/ffmpeg_utils.py`, is the entire integration surface for a new
per-clip effect.
