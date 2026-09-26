import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "./api";
import { defaultOperations, newClipId } from "./edl";
import { groupSpan, descendantGroupIds } from "./groups";
import UploadPanel from "./components/UploadPanel";
import FramePreview from "./components/FramePreview";
import Timeline from "./components/Timeline";
import ClipEditor from "./components/ClipEditor";
import GroupEditor from "./components/GroupEditor";
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
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const nameInputRef = useRef(null);
  const pollingSources = useRef(new Set());

  useEffect(() => {
    api.listProjects().then(setProjectList).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (editingName) nameInputRef.current?.focus();
  }, [editingName]);

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

  const startEditingName = () => {
    setNameDraft(project.name);
    setEditingName(true);
  };

  const commitNameEdit = () => {
    const trimmed = nameDraft.trim();
    setEditingName(false);
    if (!trimmed || trimmed === project.name) return;
    saveProject({ ...project, name: trimmed });
    // Keep the landing page's list in sync too, so the new name is there
    // if the person goes back to it without a full reload.
    api.listProjects().then(setProjectList).catch(() => {});
  };

  const cancelNameEdit = () => setEditingName(false);

  const handleDeleteProjectFromList = async (e, id, name) => {
    e.stopPropagation(); // don't trigger loadProject on the row underneath
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try {
      await api.deleteProject(id);
      setProjectList((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDeleteCurrentProject = async () => {
    if (!window.confirm(`Delete "${project.name}"? This cannot be undone.`)) return;
    try {
      await api.deleteProject(project.id);
      setProject(null);
      api.listProjects().then(setProjectList).catch(() => {});
    } catch (err) {
      setError(err.message);
    }
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
    const clip = project?.clips.find((c) => c.id === clipId) || null;
    setSelectedClipId(clipId);
    setSelectedGroupId(null);
    if (clip?.source_id) {
      setSelectedSourceId(clip.source_id);
    }
  };

  const handleSelectGroup = (groupId) => {
    setSelectedGroupId(groupId);
    setSelectedClipId(null);
  };

  const selectedClip = project ? project.clips.find((c) => c.id === selectedClipId) : null;
  const previewClip = selectedClip && selectedClip.source_id === selectedSourceId ? selectedClip : null;
  const selectedGroup = project && selectedGroupId ? project.groups?.[selectedGroupId] || null : null;
  const selectedGroupMembers = (() => {
    if (!project || !selectedGroupId) return null;
    const span = groupSpan(project.clips, project.groups, selectedGroupId);
    if (!span) return null;
    const [start, end] = span;
    // Full ordered member list (not just first/last) so the metronome
    // window can start or end on ANY clip in the group, not only its
    // actual first/last member -- see GroupEditor's clip-picker fields.
    return project.clips.slice(start, end + 1).map((c, i) => ({
      id: c.id,
      index: i,
      startFrame: c.start_frame,
      endFrame: c.end_frame,
    }));
  })();

  const handleClipEdit = (updatedClip) => {
    const clips = project.clips.map((c) => (c.id === updatedClip.id ? updatedClip : c));
    saveProject({ ...project, clips });
  };

  const handleGroupEdit = (updatedGroup) => {
    const prevGroup = project.groups[updatedGroup.id];
    const modeChanged = prevGroup?.operations?.audio?.mode !== updatedGroup.operations?.audio?.mode;

    let clips = project.clips;
    let groups = { ...project.groups, [updatedGroup.id]: updatedGroup };

    if (modeChanged) {
      // "Group always wins": the moment this group's own audio mode
      // changes, reset every member clip -- and any nested subgroup's own
      // audio override -- back to "inherit". Without this, a clip (or
      // subgroup) that already has an explicit setting keeps winning over
      // the group per the normal inherit-resolution rule, and the new
      // group setting silently never takes effect for it. A clip/subgroup
      // can still be given its own override afterward for a deliberate
      // exception; only *changing* the group's mode re-triggers this reset,
      // so that later exception won't get clobbered by e.g. just tweaking
      // the group's BPM.
      const span = groupSpan(project.clips, project.groups, updatedGroup.id);
      if (span) {
        const [start, end] = span;
        clips = clips.map((c, i) =>
          i >= start && i <= end
            ? { ...c, operations: { ...c.operations, audio: { ...c.operations.audio, mode: "inherit" } } }
            : c
        );
      }
      descendantGroupIds(project.groups, updatedGroup.id).forEach((id) => {
        const g = groups[id];
        groups[id] = { ...g, operations: { ...g.operations, audio: { ...g.operations.audio, mode: "inherit" } } };
      });
    }

    saveProject({ ...project, clips, groups });
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
              <div key={p.id} className="project-item-row">
                <button className="project-item" onClick={() => loadProject(p.id)}>
                  {p.name} <span className="dim">({p.clip_count} clips)</span>
                </button>
                <button
                  className="danger source-delete"
                  onClick={(e) => handleDeleteProjectFromList(e, p.id, p.name)}
                  title="Delete project"
                >
                  ×
                </button>
              </div>
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
        {editingName ? (
          <input
            ref={nameInputRef}
            className="project-name-input"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitNameEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitNameEdit();
              if (e.key === "Escape") cancelNameEdit();
            }}
          />
        ) : (
          <h2 onClick={startEditingName} title="Click to rename">{project.name}</h2>
        )}
        <button className="link-button danger header-delete-btn" onClick={handleDeleteCurrentProject}>
          Delete project
        </button>
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
          <FramePreview 
            source={sourceWithProxyUrl} 
            clip={previewClip} 
            onMarkRange={handleMarkRange}
            onCropChange={handleClipEdit} 
          />
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
          {selectedGroupId ? (
            <GroupEditor group={selectedGroup} memberClips={selectedGroupMembers} onChange={handleGroupEdit} />
          ) : (
            <ClipEditor
              clip={selectedClip}
              source={selectedClip ? project.sources[selectedClip.source_id] : null}
              onChange={handleClipEdit}
            />
          )}
        </div>
      </div>

      {error && <div className="error toast">{error}</div>}
    </div>
  );
}