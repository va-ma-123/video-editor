import { useRef, useState } from "react";
import { api } from "../api";

export default function UploadPanel({ project, onSourceAdded, selectedSourceId, onSelectSource, onSourceDeleted }) {
  const inputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null); // { done, total } while uploading multiple files
  const [deletingId, setDeletingId] = useState(null);
  const [error, setError] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0); // dragenter/dragleave fire on every child element too; a plain counter is the
  // standard way to tell "left the panel entirely" from "moved between two children inside it"

  const uploadFiles = async (files) => {
    const videoFiles = Array.from(files).filter((f) => f.type.startsWith("video/"));
    if (videoFiles.length === 0) {
      setError(files.length > 0 ? "No video files found in what was dropped." : null);
      return;
    }
    setUploading(true);
    setError(null);
    // Sequential rather than parallel: keeps proxy-generation load on the
    // backend predictable, and lets the progress readout ("2 of 5") mean
    // something concrete rather than "some indeterminate number in flight".
    for (let i = 0; i < videoFiles.length; i++) {
      setUploadProgress(videoFiles.length > 1 ? { done: i, total: videoFiles.length } : null);
      try {
        const source = await api.uploadSource(project.id, videoFiles[i]);
        onSourceAdded(source);
      } catch (err) {
        setError(`${videoFiles[i].name}: ${err.message}`);
        // Keep going with the rest of the batch rather than abandoning it --
        // one bad file (wrong codec, too large, whatever) shouldn't block
        // the others that were dropped alongside it.
      }
    }
    setUploading(false);
    setUploadProgress(null);
  };

  const handleFile = async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    await uploadFiles(files);
    inputRef.current.value = "";
  };

  const handleDragEnter = (e) => {
    e.preventDefault();
    dragDepth.current += 1;
    if (e.dataTransfer.types.includes("Files")) setDragActive(true);
  };

  const handleDragOver = (e) => {
    // Required for onDrop to fire at all -- the browser's default is to
    // reject a drop everywhere unless dragover explicitly allows it.
    e.preventDefault();
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    dragDepth.current = Math.max(dragDepth.current - 1, 0);
    if (dragDepth.current === 0) setDragActive(false);
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    if (uploading) return; // don't let a second drop interrupt an upload already in progress
    await uploadFiles(e.dataTransfer.files);
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
    <div
      className={`upload-panel ${dragActive ? "drag-over" : ""}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <h3>Source videos</h3>
      <input ref={inputRef} type="file" accept="video/*" multiple onChange={handleFile} disabled={uploading} />
      <div className="dim small">or drag &amp; drop video files here</div>
      {uploading && (
        <span className="dim small">
          <span className="spinner" /> {uploadProgress ? `Uploading ${uploadProgress.done + 1} of ${uploadProgress.total}...` : "Uploading..."}
        </span>
      )}
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