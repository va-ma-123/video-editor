import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "./api";
import { defaultOperations, newClipId } from "./edl";
import UploadPanel from "./components/UploadPanel";
import FramePreview from "./components/FramePreview";
import Timeline from "./components/Timeline";
import ClipEditor from "./components/ClipEditor";
import WipPlayer from "./components/WipPlayer";
import ExportPanel from "./components/ExportPanel";
import "./app.css";

export default function App() {
  const [project, setProject] = useState(null);
  const [projectList, setProjectList] = useState([]);
  const [selectedSourceId, setSelectedSourceId] = useState(null);
  const [selectedClipId, setSelectedClipId] = useState(null);
  const [selectedGroupId, setSelectedGroupId] = useState(null);
  const [playingClipId, setPlayingClipId] = useState(null);
  const [error, setError] = useState(null);
  const pollingSources = useRef(new Set());

  useEffect(() => {
    api.listProjects().then(setProjectList).catch((e) => setError(e.message));
  }, []);

  const pendingSaveRef = useRef(Promise.resolve());

  const saveProject = useCallback((updated) => {
    setProject(updated);
    const promise = api.saveProject(updated).catch((e) => setError(e.message));
    pendingSaveRef.current = promise;
    return promise;
  }, []);

  // Any "render a preview" action should wait for the most recent edit to
  // actually finish saving first -- otherwise a quick edit-then-play can
  // race the backend, which renders from whatever was last persisted, not
  // whatever the UI is currently showing.
  const ensureSaved = useCallback(() => pendingSaveRef.current, []);

  const createProject = async () => {
    const name = window.prompt("Project name?", "My Project") || "Untitled Project";
    const p = await api.createProject(name);
    setProject(p);
    setSelectedSourceId(null);
    setSelectedClipId(null);
    setSelectedGroupId(null);
    api.listProjects().then(setProjectList);
  };

  const loadProject = async (id) => {
    const p = await api.getProject(id);
    setProject(p);
    setSelectedSourceId(Object.keys(p.sources)[0] || null);
    setSelectedClipId(null);
    setSelectedGroupId(null);
  };

  // Poll any source still generating its proxy until it's ready or failed.
  const pollSourceUntilReady = useCallback((projectId, sourceId) => {
    if (pollingSources.current.has(sourceId)) return;
    pollingSources.current.add(sourceId);

    const interval = setInterval(async () => {
      try {
        const source = await api.getSource(projectId, sourceId);
        setProject((prev) => {
          if (!prev || prev.id !== projectId) return prev;
          return { ...prev, sources: { ...prev.sources, [sourceId]: source } };
        });
        if (source.proxy_status === "ready" || source.proxy_status === "failed") {
          clearInterval(interval);
          pollingSources.current.delete(sourceId);
        }
      } catch (e) {
        clearInterval(interval);
        pollingSources.current.delete(sourceId);
      }
    }, 1000);
  }, []);

  const handleSourceAdded = (source) => {
    setProject((prev) => ({ ...prev, sources: { ...prev.sources, [source.id]: source } }));
    setSelectedSourceId(source.id);
    pollSourceUntilReady(project.id, source.id);
  };

  const handleSourceDeleted = (updatedProject, deletedSourceId) => {
    setProject(updatedProject);
    if (selectedSourceId === deletedSourceId) {
      setSelectedSourceId(Object.keys(updatedProject.sources)[0] || null);
    }
    // If the selected clip was removed as part of the cascade, clear the selection too.
    if (selectedClipId && !updatedProject.clips.find((c) => c.id === selectedClipId)) {
      setSelectedClipId(null);
    }
    // Same idea for a selected group that lost all its clips in the cascade.
    if (selectedGroupId && !updatedProject.clips.some((c) => c.group_id === selectedGroupId)) {
      setSelectedGroupId(null);
    }
  };

  const selectedSource = project && selectedSourceId ? project.sources[selectedSourceId] : null;
  const sourceWithProxyUrl = selectedSource
    ? { ...selectedSource, _proxyUrl: api.mediaUrl(`/media/proxies/${selectedSource.id}.mp4`) }
    : null;

  const handleMarkRange = (startFrame, endFrame) => {
    const clip = {
      id: newClipId(),
      source_id: selectedSourceId,
      start_frame: startFrame,
      end_frame: endFrame,
      operations: defaultOperations(),
      group_id: null,
    };
    const updated = { ...project, clips: [...project.clips, clip] };
    saveProject(updated);
    setSelectedClipId(clip.id);
  };

  const handleTimelineChange = (updated) => {
    // Any timeline mutation (split, delete, drag, group actions, etc.) can
    // remove or replace the clip/group that's currently selected -- e.g.
    // splitting the selected clip replaces it with two new ids. Since this
    // is the one place all such mutations flow through, this is the right
    // spot to catch a selection that no longer points at anything real,
    // rather than patching every individual Timeline action separately.
    if (selectedClipId && !updated.clips.find((c) => c.id === selectedClipId)) {
      setSelectedClipId(null);
    }
    if (selectedGroupId && !updated.groups?.[selectedGroupId]) {
      setSelectedGroupId(null);
    }
    saveProject(updated);
  };

  const handleSelectClip = (clipId) => {
    setSelectedClipId(clipId);
    setSelectedGroupId(null);
  };

  const handleSelectGroup = (groupId) => {
    setSelectedGroupId(groupId);
    setSelectedClipId(null);
  };

  const selectedClip = project ? project.clips.find((c) => c.id === selectedClipId) : null;

  const handleClipEdit = (updatedClip) => {
    const clips = project.clips.map((c) => (c.id === updatedClip.id ? updatedClip : c));
    saveProject({ ...project, clips });
  };

  if (!project) {
    return (
      <div className="landing">
        <h1>Clip Editor</h1>
        <p className="dim">Frame-accurate trimming, stitching, and effects for your videos.</p>
        <button className="primary" onClick={createProject}>+ New project</button>
        {projectList.length > 0 && (
          <div className="project-list">
            <h3>Existing projects</h3>
            {projectList.map((p) => (
              <button key={p.id} className="project-item" onClick={() => loadProject(p.id)}>
                {p.name} <span className="dim">({p.clip_count} clips)</span>
              </button>
            ))}
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <button className="link-button" onClick={() => setProject(null)}>← Projects</button>
        <h2>{project.name}</h2>
      </header>

      <div className="app-grid">
        <div className="col col-left">
          <UploadPanel
            project={project}
            onSourceAdded={handleSourceAdded}
            selectedSourceId={selectedSourceId}
            onSelectSource={setSelectedSourceId}
            onSourceDeleted={handleSourceDeleted}
          />
          <h3>Timeline</h3>
          <Timeline
            project={project}
            selectedClipId={selectedClipId}
            selectedGroupId={selectedGroupId}
            playingClipId={playingClipId}
            onSelect={handleSelectClip}
            onSelectGroup={handleSelectGroup}
            onChange={handleTimelineChange}
          />
        </div>

        <div className="col col-center">
          <FramePreview source={sourceWithProxyUrl} onMarkRange={handleMarkRange} />
          <WipPlayer
            project={project}
            selectedClipId={selectedClipId}
            selectedGroupId={selectedGroupId}
            ensureSaved={ensureSaved}
            onPlayingClipChange={setPlayingClipId}
          />
          <ExportPanel project={project} />
        </div>

        <div className="col col-right">
          <ClipEditor
            clip={selectedClip}
            source={selectedClip ? project.sources[selectedClip.source_id] : null}
            onChange={handleClipEdit}
          />
        </div>
      </div>

      {error && <div className="error toast">{error}</div>}
    </div>
  );
}