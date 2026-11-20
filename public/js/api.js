async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });

  let data = null;
  try { data = await response.json(); } catch { /* empty body */ }

  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status}).`);
  return data;
}

export const api = {
  config: () => request("/api/config"),
  inputs: () => request("/api/inputs"),
  jobs: () => request("/api/jobs"),
  job: id => request(`/api/jobs/${id}`),
  review: id => request(`/api/jobs/${id}/review`),
  createJob: body => request("/api/jobs", { method: "POST", body }),
  patchJob: (id, body) => request(`/api/jobs/${id}`, { method: "PATCH", body }),
  deleteJob: id => request(`/api/jobs/${id}`, { method: "DELETE" }),
  cancel: id => request(`/api/jobs/${id}/cancel`, { method: "POST", body: {} }),
  skip: id => request(`/api/jobs/${id}/skip`, { method: "POST", body: {} }),
  run: (id, body = {}) => request(`/api/jobs/${id}/run`, { method: "POST", body }),
  saveEdits: (id, ranges, keepalive = false) =>
    fetch(`/api/jobs/${id}/edits`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ranges }),
      keepalive
    }).then(async r => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Could not save.");
    }),
  saveCaptions: (id, captions, keepalive = false) =>
    fetch(`/api/jobs/${id}/captions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(captions),
      keepalive
    }).then(async r => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Could not save the captions.");
    }),

  // Fonts are shared by every project.
  fonts: () => request("/api/fonts"),
  removeFont: id => request(`/api/fonts/${id}`, { method: "DELETE" }),
  searchGoogleFonts: q => request(`/api/google-fonts?q=${encodeURIComponent(q)}`),
  addGoogleFont: family => request("/api/google-fonts", { method: "POST", body: { family } }),
  async uploadFont(file) {
    const response = await fetch(`/api/fonts?filename=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || `Upload failed (${response.status}).`);
    return data;
  },

  // `extra` carries the B-roll choice: { broll: true|false, brollFit: "cover"|"contain" }.
  exportJob: (id, pad, extra = {}) => request(`/api/jobs/${id}/export`, { method: "POST", body: { pad, ...extra } }),

  // B-roll: the plan of one project, and the global parts (Chrome, usage, API keys, image jobs).
  broll: id => request(`/api/jobs/${id}/broll`),
  brollPost: (id, sub, body = {}) => request(`/api/jobs/${id}/broll/${sub}`, { method: "POST", body }),
  brollGlobal: sub => request(`/api/broll/${sub}`),
  brollGlobalPost: (sub, body = {}) => request(`/api/broll/${sub}`, { method: "POST", body }),

  // Upload with progress (fetch cannot report upload progress yet).
  upload(id, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/api/jobs/${id}/source?filename=${encodeURIComponent(file.name)}`);
      xhr.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        let message = `Upload failed (${xhr.status}).`;
        try { message = JSON.parse(xhr.responseText).error || message; } catch { /* keep default */ }
        reject(new Error(message));
      };
      xhr.onerror = () => reject(new Error("Upload failed. Is the server still running?"));
      xhr.send(file);
    });
  },

  // Adobe Podcast enhanced audio: swap it in (with upload progress) or go back to the original audio.
  enhanceUpload(id, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/api/jobs/${id}/enhance/upload?filename=${encodeURIComponent(file.name)}`);
      xhr.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        let body = null;
        try { body = JSON.parse(xhr.responseText); } catch { /* empty */ }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(body);
        reject(new Error(body?.error || `Upload failed (${xhr.status}).`));
      };
      xhr.onerror = () => reject(new Error("Upload failed. Is the server still running?"));
      xhr.send(file);
    });
  },
  enhanceRevert: id => request(`/api/jobs/${id}/enhance`, { method: "DELETE" }),

  // Live project updates (progress, state changes).
  watch(id, onJob) {
    const source = new EventSource(`/api/jobs/${id}/events`);
    source.onmessage = e => onJob(JSON.parse(e.data));
    return () => source.close();
  }
};
