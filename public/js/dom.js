// Tiny DOM helpers: h("div", { class: "x", onclick: fn }, child, "text")

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;

    if (key === "class") el.className = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "value" || key === "checked") el[key] = value;
    else el.setAttribute(key, value === true ? "" : value);
  }

  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const ICONS = {
  play: '<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4.5" width="4.2" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1" fill="currentColor" stroke="none"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
  redo: '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  film: '<rect x="2.5" y="2.5" width="19" height="19" rx="2"/><path d="M7 2.5v19M17 2.5v19M2.5 12h19M2.5 7h4.5M2.5 17h4.5M17 17h4.5M17 7h4.5"/>',
  trash: '<path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<circle cx="12" cy="12" r="9.5"/><path d="M12 7.5v5M12 16.2h.01"/>',
  next: '<path d="M5 4.5 15 12 5 19.5z" fill="currentColor" stroke="none"/><path d="M19 5v14"/>',
  prev: '<path d="M19 4.5 9 12l10 7.5z" fill="currentColor" stroke="none"/><path d="M5 5v14"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  keys: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h.01M10.5 10h.01M14.5 10h.01M18 10h.01M7 14h10"/>'
};

export function icon(name, size = 16) {
  const span = document.createElement("span");
  span.className = "icon";
  span.innerHTML =
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  return span;
}

export function toast(message, kind = "info", ms = 4200) {
  const box = document.getElementById("toasts");
  const el = h("div", { class: `toast ${kind}`, role: "status" }, message);
  box.append(el);
  setTimeout(() => el.remove(), ms);
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return "";
  if (n > 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

export function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ", " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
