const BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

async function handle(res) {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail || JSON.stringify(body);
    } catch (_) {}
    throw new Error(detail);
  }
  return res.json();
}

export const api = {
  base: BASE,

  createProject: (name) =>
    fetch(`${BASE}/api/projects?name=${encodeURIComponent(name)}`, { method: "POST" }).then(handle),

  listProjects: () => fetch(`${BASE}/api/projects`).then(handle),

  getProject: (id) => fetch(`${BASE}/api/projects/${id}`).then(handle),

  saveProject: (project) =>
    fetch(`${BASE}/api/projects/${project.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(project),
    }).then(handle),

  deleteProject: (id) => fetch(`${BASE}/api/projects/${id}`, { method: "DELETE" }).then(handle),

  uploadSource: (projectId, file) => {
    const form = new FormData();
    form.append("file", file);
    return fetch(`${BASE}/api/projects/${projectId}/sources`, { method: "POST", body: form }).then(handle);
  },

  getSource: (projectId, sourceId) =>
    fetch(`${BASE}/api/projects/${projectId}/sources/${sourceId}`).then(handle),

  deleteSource: (projectId, sourceId) =>
    fetch(`${BASE}/api/projects/${projectId}/sources/${sourceId}`, { method: "DELETE" }).then(handle),

  uploadAudioAsset: (file) => {
    const form = new FormData();
    form.append("file", file);
    return fetch(`${BASE}/api/audio-assets`, { method: "POST", body: form }).then(handle);
  },

  renderWip: (projectId) =>
    fetch(`${BASE}/api/projects/${projectId}/render-wip`, { method: "POST" }).then(handle),

  renderClipPreview: (projectId, clipId) => 
    fetch(`${BASE}/api/projects/${projectId}/clips/${clipId}/render-preview`, { method: "POST" }).then(handle),

  renderClipContinuation: (projectId, clipId) => 
    fetch(`${BASE}/api/projects/${projectId}/clips/${clipId}/render-cont`, { method: "POST" }).then(handle),

  renderGroupPreview: (projectId, groupId) => 
    fetch(`${BASE}/api/projects/${projectId}/groups/${groupId}/render-preview`, { method: "POST" }).then(handle),

  renderGroupContinuation: (projectId, groupId) => 
    fetch(`${BASE}/api/projects/${projectId}/groups/${groupId}/render-cont`, { method: "POST" }).then(handle),

  startExport: (projectId) =>
    fetch(`${BASE}/api/projects/${projectId}/export`, { method: "POST" }).then(handle),

  getExportJob: (jobId) => fetch(`${BASE}/api/export-jobs/${jobId}`).then(handle),

  mediaUrl: (path) => `${BASE}${path}`,
};
