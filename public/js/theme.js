// Theme: "dark" (the soft default) or "retro" (old computer). Kept in localStorage and applied on <html data-theme>.
export const DESKS = [
  ["ink", "Ink", "#23262e"],
  ["mint", "Mint", "#78cc67"],
  ["moss", "Moss", "#3f4c41"]
];

const read = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* storage may be blocked */ } };

export const getTheme = () => (read("theme", "dark") === "retro" ? "retro" : "dark");
export const getDesk = () => { const d = read("retroDesk", "ink"); return DESKS.some(x => x[0] === d) ? d : "ink"; };

export function applyTheme() {
  const root = document.documentElement;
  const retro = getTheme() === "retro";
  if (retro) { root.dataset.theme = "retro"; root.dataset.desk = getDesk(); }
  else { delete root.dataset.theme; delete root.dataset.desk; }
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", retro ? "light" : "dark");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", retro ? "#ece5ca" : "#15131f");
}

export function setTheme(theme) { write("theme", theme === "retro" ? "retro" : "dark"); applyTheme(); }
export function setDesk(desk) { write("retroDesk", desk); applyTheme(); }

applyTheme();
