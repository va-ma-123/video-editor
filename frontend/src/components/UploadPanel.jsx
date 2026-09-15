import { useRef, useState } from "react";
import { api } from "../api";

export default function UploadPanel({ project, onSourceAdded, selectedSourceId, onSelectSource, onSourceDeleted }) {
  const inputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [error, setError] = useState(null);

  const handleFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const source = await api.uploadSource(project.id, file);
      onSourceAdded(source);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      inputRef.current.value = "";
    }
  };

  const handleDelete = async (e, source) => {
    e.stopPropagation(); // don't trigger onSelectSource
    const clipCount = project.clips.filter((c) => c.source_id === source.id).length;
    const warning =
      clipCount > 0
        ? `Delete "${source.filename}"? This will also remove ${clipCount} clip${clipCount === 1 ? "" : "s"} using it from your timeline.`
        : `Delete "${source.filename}"?`;
    if (!window.confirm(warning)) return;
 
    setDeletingId(source.id);
    setError(null);
    try {
      const result = await api.deleteSource(project.id, source.id);
      onSourceDeleted(result.project, source.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingId(null);
    }
  };

  const sources = Object.values(project.sources || {});

  return (
    <div className="upload-panel">
      <h3>Source videos</h3>
      <input ref={inputRef} type="file" accept="video/*" onChange={handleFile} disabled={uploading} />
      {uploading && <span className="spinner" />}
      {error && <div className="error">{error}</div>}

      <div className="source-list">
        {sources.map((s) => (
          <div
            key={s.id}
            className={`source-item ${s.id === selectedSourceId ? "selected" : ""}`}
            onClick={() => onSelectSource(s.id)}
          >
            <div className="source-item-main">
              <div className="source-name">{s.filename}</div>
              <div className="dim mono">
                {s.proxy_status === "ready" ? `${s.total_frames}f @ ${s.fps.toFixed(2)}fps` : s.proxy_status}
              </div>
            </div>
            <button
              className="danger source-delete"
              onClick={(e) => handleDelete(e, s)}
              disabled={deletingId === s.id}
              title="Delete source"
            >
              {deletingId === s.id ? "..." : "×"}
            </button>
          </div>
        ))}
        {sources.length === 0 && <div className="dim">No sources uploaded yet.</div>}
      </div>
    </div>
  );
}
