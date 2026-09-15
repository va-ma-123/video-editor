import { useState, useRef, useEffect, useCallback } from "react";
import { api } from "../api";

/**
 * Final export with:
 *  - background job started via POST /export, polled for progress
 *  - a progress bar driven by completed_clips / total_clips
 *  - a small "preview while it builds" player: as each clip finishes,
 *    its URL is appended to a queue. The <video> element plays through
 *    the queue continuously, advancing to the next ready clip on `ended`,
 *    so it looks like one continuous video assembling itself.
 *
 * Note: this is a simplified stand-in for true MSE segment-appending --
 * it swaps `src` between separately-encoded clip files rather than
 * appending to one continuous buffer. It's simpler and reliable, at the
 * cost of a very brief re-buffer at each clip boundary rather than a
 * byte-perfect seamless splice. Good enough for a WIP feel; can be
 * upgraded to real MSE later if the boundary blip bothers you.
 */
export default function ExportPanel({ project }) {
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [queue, setQueue] = useState([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const videoRef = useRef(null);
  const seenPaths = useRef(new Set());
  const pollRef = useRef(null);

  const reset = () => {
    setJob(null);
    setError(null);
    setQueue([]);
    setQueueIndex(0);
    seenPaths.current = new Set();
  };

  const startExport = async () => {
    reset();
    try {
      const { job_id } = await api.startExport(project.id);
      setJob({ id: job_id, status: "queued", total_clips: project.clips.length, completed_clips: 0 });
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    if (!job || job.status === "done" || job.status === "failed") return;

    pollRef.current = setInterval(async () => {
      try {
        const updated = await api.getExportJob(job.id);
        setJob(updated);

        // Enqueue any newly-ready clip previews for the progressive player
        const newPaths = updated.ready_clip_paths.filter((p) => !seenPaths.current.has(p));
        if (newPaths.length > 0) {
          newPaths.forEach((p) => seenPaths.current.add(p));
          setQueue((q) => [...q, ...newPaths.map((p) => api.mediaUrl(p))]);
        }

        if (updated.status === "done" || updated.status === "failed") {
          clearInterval(pollRef.current);
        }
      } catch (err) {
        setError(err.message);
        clearInterval(pollRef.current);
      }
    }, 700);

    return () => clearInterval(pollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status]);

  // Auto-play the queue: start once the first clip is ready
  useEffect(() => {
    const video = videoRef.current;
    if (!video || queue.length === 0) return;
    if (video.src !== queue[queueIndex] && queue[queueIndex]) {
      video.src = queue[queueIndex];
      video.play().catch(() => {});
    }
  }, [queue, queueIndex]);

  const handleEnded = useCallback(() => {
    setQueueIndex((i) => (i + 1 < queue.length ? i + 1 : i)); // hold on last frame if nothing new yet
  }, [queue.length]);

  const progressPct = job && job.total_clips > 0 ? Math.round((job.completed_clips / job.total_clips) * 100) : 0;
  const isRendering = job && job.status !== "done" && job.status !== "failed";

  return (
    <div className="export-panel">
      <div className="row">
        <button className="primary" onClick={startExport} disabled={isRendering || project.clips.length === 0}>
          {isRendering ? "Exporting..." : "Export final video"}
        </button>
      </div>

      {job && (
        <div className="export-status">
          <div className="progress-bar-track">
            <div className="progress-bar-fill" style={{ width: `${job.status === "done" ? 100 : progressPct}%` }} />
          </div>
          <div className="dim mono">
            {job.status} — {job.completed_clips}/{job.total_clips} clips
          </div>
        </div>
      )}

      {error && <div className="error">Export error: {error}</div>}
      {job?.status === "failed" && <div className="error">Render failed: {job.error}</div>}

      {queue.length > 0 && (
        <div className="export-preview">
          <div className="dim">Preview (builds as clips finish rendering):</div>
          <video ref={videoRef} className="wip-video" onEnded={handleEnded} playsInline />
        </div>
      )}

      {job?.status === "done" && (
        <a className="download-link" href={api.mediaUrl(job.output_path)} download>
          ⬇ Download final export
        </a>
      )}
    </div>
  );
}
