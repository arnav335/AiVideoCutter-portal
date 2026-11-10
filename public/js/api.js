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
  exportJob: (id, pad) => request(`/api/jobs/${id}/export`, { method: "POST", body: { pad } }),

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

  // Live project updates (progress, state changes).
  watch(id, onJob) {
    const source = new EventSource(`/api/jobs/${id}/events`);
    source.onmessage = e => onJob(JSON.parse(e.data));
    return () => source.close();
  }
};
