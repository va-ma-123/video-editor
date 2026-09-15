import { useRef, useState } from "react";
import { api } from "../api";

export default function WipPlayer({ project, selectedClipId, selectedGroupId, ensureSaved, onPlayingClipChange }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [videoUrl, setVideoUrl] = useState(null);
  const [label, setLabel] = useState(null); // what's currently shown, for a small caption
  const boundariesRef = useRef([]); // [{clip_id, start_sec, end_sec}, ...] for whatever's currently loaded

  const startPreview = async (renderFn, labelText) => {
    setLoading(true);
    setError(null);
    onPlayingClipChange?.(null); // clear any stale highlight from a previous preview while this one loads
    try {
      await ensureSaved(); // don't render against a project state that's still mid-save
      const result = await renderFn();
      boundariesRef.current = result.clip_boundaries || [];
      setVideoUrl(`${api.mediaUrl(result.url)}?t=${result.cache_bust}`);
      setLabel(labelText);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handlePlayWip = () => startPreview(() => api.renderWip(project.id), "Full timeline");

  // Clip and group selection are mutually exclusive (see App.jsx), so exactly
  // one of these branches applies whenever something is selected at all.
  const handlePlaySelection = () => {
    if (!selectedClipId && !selectedGroupId) return;
    if (selectedGroupId) {
      const name = project.groups?.[selectedGroupId]?.name || selectedGroupId;
      startPreview(() => api.renderGroupPreview(project.id, selectedGroupId), `Group: ${name}`);
    } else {
      const index = project.clips.findIndex((c) => c.id === selectedClipId);
      startPreview(() => api.renderClipPreview(project.id, selectedClipId), `Clip ${index + 1}`);
    }
  };

  const handlePlayFromHere = () => {
    if (!selectedClipId && !selectedGroupId) return;
    if (selectedGroupId) {
      const name = project.groups?.[selectedGroupId]?.name || selectedGroupId;
      startPreview(() => api.renderGroupContinuation(project.id, selectedGroupId), `From group: ${name} onward`);
    } else {
      const index = project.clips.findIndex((c) => c.id === selectedClipId);
      startPreview(() => api.renderClipContinuation(project.id, selectedClipId), `From clip ${index + 1} onward`);
    }
  };

  const handleClose = () => {
    setVideoUrl(null);
    setLabel(null);
    boundariesRef.current = [];
    onPlayingClipChange?.(null);
  };

  // Maps the video's current playback position to a clip id using the exact
  // (ffprobe-measured) boundaries from the render response, and reports it
  // upward so the timeline can highlight whichever clip is currently playing.
  const handleTimeUpdate = (e) => {
    const t = e.target.currentTime;
    const hit = boundariesRef.current.find((b) => t >= b.start_sec && t < b.end_sec);
    onPlayingClipChange?.(hit ? hit.clip_id : null);
  };

  const hasSelection = Boolean(selectedClipId || selectedGroupId);
  const selectionButtonLabel = selectedGroupId ? "▶ Play selected group" : "▶ Play selected clip";
  const selectionButtonTitle = hasSelection
    ? "Preview just this selection"
    : "Select a clip or group in the timeline first";
  const continuationButtonTitle = hasSelection
    ? "Preview from this selection through the end of the timeline"
    : "Select a clip or group in the timeline first";

  return (
    <div className="wip-player">
      <div className="row">
        <button className="primary" onClick={handlePlayWip} disabled={loading || project.clips.length === 0}>
          {loading ? "Rendering..." : "▶ Play work-in-progress"}
        </button>
        <button onClick={handlePlaySelection} disabled={loading || !hasSelection} title={selectionButtonTitle}>
          {selectionButtonLabel}
        </button>
        <button onClick={handlePlayFromHere} disabled={loading || !hasSelection} title={continuationButtonTitle}>
          ▶ Play from here
        </button>
        {loading && <span className="spinner" aria-label="loading" />}
        {videoUrl && !loading && (
          <button onClick={handleClose} title="Hide preview">✕ Close preview</button>
        )}
      </div>
      {error && <div className="error">Couldn't render preview: {error}</div>}
      {videoUrl && !loading && (
        <div>
          {label && <div className="dim" style={{ marginBottom: 4 }}>{label}</div>}
          <video
            src={videoUrl}
            controls
            autoPlay
            className="wip-video"
            onTimeUpdate={handleTimeUpdate}
            onEnded={() => onPlayingClipChange?.(null)}
          />
        </div>
      )}
    </div>
  );
}