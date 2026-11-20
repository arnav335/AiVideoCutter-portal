import { h, toast } from "./dom.js";
import { api } from "./api.js";
import {
  CAPTION_UNIT, DEFAULT_STYLE, PRESETS, SYSTEM_FONTS,
  sanitizeCaptions, sanitizeStyle, buildCaptions, captionIndexAt, makeTimeMap, pickFontFile
} from "/shared/captions.js";
import { rangesToMask } from "/shared/editModel.js";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// libass sizes text by the font's line height (ascent + descent), so a size of 58 means a
// 58-unit tall line and the letters are smaller than that. For added fonts the exact ratio is
// read from the file; these are the usual values of the system fonts we offer.
const SYSTEM_CELL = {
  "Arial": 1.117, "Arial Black": 1.41, "Impact": 1.22, "Verdana": 1.215, "Tahoma": 1.207,
  "Trebuchet MS": 1.161, "Georgia": 1.136, "Times New Roman": 1.107, "Courier New": 1.133,
  "Segoe UI": 1.33, "Comic Sans MS": 1.39, "Helvetica": 1.117
};
const FALLBACK_CELL = 1.15;

const SAMPLE = ["Your captions", "will look like this"];

function rgba(hex, percent) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${clamp(percent, 0, 100) / 100})`;
}

const cssName = name => String(name).replace(/["\\]/g, "");

// A round outline made of many copies of the text, like libass draws it. (-webkit-text-stroke
// gives pointed corners; stacking offset copies at a few radii gives the same round look.)
function outlineShadows(radius, color) {
  if (radius <= 0) return "none";
  const rings = radius < 2 ? 1 : 3;
  const steps = radius < 2 ? 8 : 20;
  const out = [];
  for (let k = 1; k <= rings; k++) {
    const r = (radius * k) / rings;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2 + (k % 2 ? 0 : Math.PI / steps);
      out.push(`${(Math.cos(a) * r).toFixed(2)}px ${(Math.sin(a) * r).toFixed(2)}px 0 ${color}`);
    }
  }
  return out.join(",");
}

// Paint one caption (its lines) into `target` with the given style.
//   unit  screen pixels per caption unit
//   font  { css, cell }
function paintCaption(target, lines, style, unit, font) {
  Object.assign(target.style, {
    fontFamily: font.css,
    fontWeight: style.bold ? "700" : "400",
    fontStyle: style.italic ? "italic" : "normal",
    fontSize: `${(style.size / font.cell) * unit}px`,
    lineHeight: `${style.size * unit}px`,
    letterSpacing: `${style.spacing * unit}px`
  });

  const shadow = style.shadowSize * unit;
  const spread = style.bgPadding * unit;
  const boxColor = rgba(style.bgColor, style.bgOpacity);

  target.replaceChildren(...lines.map(line => {
    const glyphs = h("span", { class: "cap-glyphs" }, line);
    Object.assign(glyphs.style, {
      color: rgba(style.color, style.textOpacity),
      textShadow: outlineShadows(style.outlineWidth * unit, style.outlineColor),
      filter: shadow > 0
        ? `drop-shadow(${shadow}px ${shadow}px 0 ${rgba(style.shadowColor, style.shadowOpacity)})`
        : "none"
    });

    // libass draws the background as one box per line, padded by the same amount on every side.
    const box = h("span", { class: "cap-box" }, glyphs);
    if (style.bgEnabled) {
      box.style.background = boxColor;
      box.style.boxShadow = `0 0 0 ${spread}px ${boxColor}`;
    }
    return box;
  }));
}

export function mountCaptions({ jobId, video, player, editor, words, initial, hasVideo, onStatus }) {
  let config = sanitizeCaptions(initial);
  let fonts = [];              // fonts added by the user (shared by every project)
  let captions = [];           // built from the kept words, on the FINAL timeline
  let map = makeTimeMap([]);   // preview time (cut-free source) -> final time
  let unit = 1;                // screen pixels per caption unit
  let active = false;          // the Captions tab is open
  let lastTime = 0;
  let shownKey = "";
  let shown = null;            // { lines, sample } currently drawn

  // ------------------------------------------------------------ overlay on the player
  const frame = h("div", { class: "cap-frame" });
  const guide = h("i", { class: "cap-guide" });
  const capEl = h("div", { class: "cap", title: "Drag to move the captions" });
  capEl.hidden = true;
  frame.append(guide, capEl);
  player.append(frame);

  const faces = new Map();
  function ensureFace(entry, file) {
    const name = `capfont-${entry.id}-${file.file.replace(/[^a-z0-9]/gi, "")}`;
    if (!faces.has(name)) {
      const face = new FontFace(name, `url(/api/fonts/${entry.id}/file/${file.file})`, {
        weight: String(file.weight),
        style: file.italic ? "italic" : "normal"
      });
      faces.set(name, face);
      document.fonts.add(face);
      face.load().then(() => { shownKey = ""; paintAt(lastTime); }).catch(() => {});
    }
    return name;
  }

  function resolveFont() {
    const s = config.style;
    const entry = s.fontId ? fonts.find(f => f.id === s.fontId) : null;
    const file = entry ? pickFontFile(entry, s) : null;
    if (file) {
      return {
        css: `"${ensureFace(entry, file)}", "${cssName(s.fontFamily)}", sans-serif`,
        cell: file.cell || FALLBACK_CELL
      };
    }
    return { css: `"${cssName(s.fontFamily)}", sans-serif`, cell: SYSTEM_CELL[s.fontFamily] || FALLBACK_CELL };
  }

  // The picture is letterboxed inside the player; captions are placed on the picture itself.
  function layout() {
    const W = player.clientWidth, H = player.clientHeight;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!hasVideo || !W || !H || !vw || !vh) { frame.style.display = "none"; return; }

    const k = Math.min(W / vw, H / vh);
    const w = vw * k, hgt = vh * k;
    Object.assign(frame.style, {
      display: "block",
      left: `${(W - w) / 2}px`, top: `${(H - hgt) / 2}px`,
      width: `${w}px`, height: `${hgt}px`
    });
    unit = Math.min(w, hgt) / CAPTION_UNIT;
    shownKey = "";
    paintAt(lastTime);
  }

  function draw() {
    if (!shown) { capEl.hidden = true; return; }
    const s = config.style;
    capEl.hidden = false;
    capEl.classList.toggle("sample", shown.sample);
    capEl.style.left = `${s.x * 100}%`;
    capEl.style.top = `${s.y * 100}%`;
    paintCaption(capEl, shown.lines, s, unit, resolveFont());
  }

  function sampleLines() {
    if (captions[0]) return captions[0].lines;
    return config.style.allCaps ? SAMPLE.map(l => l.toUpperCase()) : SAMPLE;
  }

  // Called with the player's time (the cut-free timeline) as it moves.
  function paintAt(t) {
    lastTime = t;
    if (!hasVideo || !config.enabled) {
      if (shown) { shown = null; shownKey = ""; draw(); }
      return;
    }

    const finalTime = map.toFinal(t);
    const index = finalTime === null ? -1 : captionIndexAt(captions, finalTime);
    // While the Captions tab is open and the video is paused, show a sample so the style can be seen.
    const sample = index < 0 && active && video.paused;

    const key = `${index}|${sample ? 1 : 0}`;
    if (key === shownKey) return;
    shownKey = key;

    shown = index >= 0 ? { lines: captions[index].lines, sample: false }
      : sample ? { lines: sampleLines(), sample: true }
      : null;
    draw();
  }

  function rebuild() {
    const keep = editor.keep();
    map = makeTimeMap(keep);
    captions = buildCaptions(words, rangesToMask(editor.ranges(), words.length), keep, config.style);
    countEl.textContent = `${captions.length} caption${captions.length === 1 ? "" : "s"}`;
    shownKey = "";
  }

  // Drag the captions on the video to move them.
  capEl.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const box = frame.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const start = { x: e.clientX, y: e.clientY, sx: config.style.x, sy: config.style.y };
    capEl.setPointerCapture(e.pointerId);
    capEl.classList.add("dragging");

    const move = ev => {
      let x = clamp(start.sx + (ev.clientX - start.x) / box.width, 0, 1);
      const y = clamp(start.sy + (ev.clientY - start.y) / box.height, 0, 1);
      const snapped = Math.abs(x - 0.5) < 0.012;   // sticks to the centre
      if (snapped) x = 0.5;
      guide.classList.toggle("on", snapped);

      config = { ...config, style: { ...config.style, x, y } };
      capEl.style.left = `${x * 100}%`;
      capEl.style.top = `${y * 100}%`;
      sync();
    };
    const up = () => {
      capEl.removeEventListener("pointermove", move);
      capEl.removeEventListener("pointerup", up);
      capEl.removeEventListener("pointercancel", up);
      capEl.classList.remove("dragging");
      guide.classList.remove("on");
      scheduleSave();
    };
    capEl.addEventListener("pointermove", move);
    capEl.addEventListener("pointerup", up);
    capEl.addEventListener("pointercancel", up);
  });

  const resizeObserver = new ResizeObserver(layout);
  resizeObserver.observe(player);
  video.addEventListener("loadedmetadata", layout);

  // ------------------------------------------------------------ saving
  let saveTimer = 0;
  let dirty = false;

  function scheduleSave() {
    dirty = true;
    onStatus?.("Unsaved");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNow(), 500);
  }

  async function saveNow(keepalive = false) {
    clearTimeout(saveTimer);
    if (!dirty) return;
    dirty = false;
    try {
      onStatus?.("Saving…");
      await api.saveCaptions(jobId, config, keepalive);
      if (!dirty) onStatus?.("Saved");
    } catch (error) {
      dirty = true;
      onStatus?.("Not saved", true);
      if (!keepalive) toast(error.message, "error");
    }
  }

  // Apply a change to the style (it is cleaned the same way the server cleans it).
  function commit(changes) {
    config = { ...config, style: sanitizeStyle({ ...config.style, ...changes }, config.style) };
    if ("allCaps" in changes || "maxChars" in changes || "maxLines" in changes) rebuild();
    sync();
    shownKey = "";
    paintAt(lastTime);
    scheduleSave();
  }

  // ------------------------------------------------------------ panel: building blocks
  const controls = [];                       // each one re-reads the config into its input
  const sync = () => controls.forEach(fn => fn());

  const label = (text, unitText) =>
    h("span", { class: "cap-label" }, text, unitText ? h("small", {}, ` ${unitText}`) : null);

  function slider(text, key, min, max, step, { scale = 1, unitText = "" } = {}) {
    const range = h("input", { type: "range", class: "range", min, max, step, "aria-label": text });
    const number = h("input", { type: "number", class: "field num mini", min, max, step, "aria-label": text });
    const write = v => commit({ [key]: Number(v) / scale });

    range.addEventListener("input", () => { number.value = String(Math.round(Number(range.value) * 100) / 100); write(range.value); });
    number.addEventListener("change", () => {
      if (number.value === "") { sync(); return; }
      write(clamp(Number(number.value), min, max));
    });
    controls.push(() => {
      const v = Number(config.style[key]) * scale;
      range.value = String(v);
      number.value = String(Math.round(v * 100) / 100);
    });
    return h("label", { class: "cap-row" }, label(text, unitText), range, number);
  }

  function colour(text, key) {
    const input = h("input", { type: "color", class: "swatch", "aria-label": text });
    input.addEventListener("input", () => commit({ [key]: input.value }));
    controls.push(() => { input.value = config.style[key].toLowerCase(); });
    return h("label", { class: "cap-row simple" }, label(text), input);
  }

  function toggleButton(text, key, title, extraClass = "") {
    const button = h("button", { class: `btn small tog ${extraClass}`, title, "aria-pressed": "false" }, text);
    button.addEventListener("click", () => commit({ [key]: !config.style[key] }));
    controls.push(() => button.setAttribute("aria-pressed", String(Boolean(config.style[key]))));
    return button;
  }

  const section = (title, ...children) => h("section", { class: "cap-sec" }, h("h3", {}, title), ...children);

  // ------------------------------------------------------------ panel: header
  const enableSwitch = h("input", { type: "checkbox", class: "switch", checked: config.enabled });
  enableSwitch.addEventListener("change", () => {
    config = { ...config, enabled: enableSwitch.checked };
    panel.classList.toggle("off", !config.enabled);
    shownKey = "";
    paintAt(lastTime);
    scheduleSave();
  });
  const countEl = h("span", { class: "muted num" });

  const head = h("div", { class: "cap-head" },
    h("label", { class: "switch-row" }, enableSwitch, "Burn captions into the video"),
    h("span", { class: "grow" }), countEl);

  const intro = h("p", { class: "hint" },
    "Captions are built from the transcript, and words you cut are left out. ",
    "Drag them on the video to move them.");

  const audioNote = hasVideo ? null
    : h("div", { class: "banner" }, "This project is audio only. Captions are only added to videos.");

  // ------------------------------------------------------------ panel: presets
  const presetButtons = PRESETS.map(p => {
    const sample = h("span", { class: "cap-preset-text" });
    const button = h("button", { class: "cap-preset", title: p.label }, sample, h("span", { class: "cap-preset-name" }, p.label));
    paintCaption(sample, ["Aa"], { ...DEFAULT_STYLE, ...p.style, size: 56 }, 0.42, {
      css: `"${cssName(p.style.fontFamily)}", sans-serif`,
      cell: SYSTEM_CELL[p.style.fontFamily] || FALLBACK_CELL
    });
    button.addEventListener("click", () => commit(p.style));
    return button;
  });

  // ------------------------------------------------------------ panel: font
  const fontSelect = h("select", { class: "field", "aria-label": "Font" });
  const removeFontBtn = h("button", { class: "btn small danger", title: "Remove this added font" }, "Remove");
  removeFontBtn.hidden = true;

  const usableFont = () => (config.style.fontId ? fonts.find(f => f.id === config.style.fontId) : null);

  function fillFontSelect() {
    const s = config.style;
    const groups = [];
    if (fonts.length) {
      groups.push(h("optgroup", { label: "Your fonts" }, fonts.map(f => h("option", { value: `font:${f.id}` }, f.family))));
    }
    // A removed font keeps its name as a system font, so keep that name selectable.
    const system = usableFont() || SYSTEM_FONTS.includes(s.fontFamily) ? SYSTEM_FONTS : [s.fontFamily, ...SYSTEM_FONTS];
    groups.push(h("optgroup", { label: "System fonts" }, system.map(name => h("option", { value: `sys:${name}` }, name))));
    fontSelect.replaceChildren(...groups);
    syncFont();
  }

  function syncFont() {
    const entry = usableFont();
    fontSelect.value = entry ? `font:${entry.id}` : `sys:${config.style.fontFamily}`;
    removeFontBtn.hidden = !entry;
  }
  controls.push(syncFont);

  fontSelect.addEventListener("change", () => {
    const [kind, ...rest] = fontSelect.value.split(":");
    const value = rest.join(":");
    if (kind === "font") {
      const entry = fonts.find(f => f.id === value);
      if (entry) commit({ fontId: entry.id, fontFamily: entry.family });
    } else {
      commit({ fontId: null, fontFamily: value });
    }
  });

  removeFontBtn.addEventListener("click", async () => {
    const entry = usableFont();
    if (!entry || !confirm(`Remove "${entry.family}" from your fonts? It is shared by every project.`)) return;
    try {
      await api.removeFont(entry.id);
      commit({ fontId: null, fontFamily: "Arial" });
      await loadFonts();
    } catch (error) {
      toast(error.message, "error");
    }
  });

  async function loadFonts() {
    try {
      fonts = (await api.fonts()).fonts;
    } catch (error) {
      toast(error.message, "error");
    }
    fillFontSelect();
    shownKey = "";
    paintAt(lastTime);
  }

  // Add a font: search Google Fonts, or drop in a .ttf / .otf file.
  const searchInput = h("input", { class: "field", type: "search", placeholder: "Search Google Fonts…", "aria-label": "Search Google Fonts" });
  const results = h("div", { class: "cap-results" });
  let searchTimer = 0;
  let searchToken = 0;
  let searched = false;

  function renderResults(list) {
    if (list.length === 0) {
      results.replaceChildren(h("div", { class: "muted cap-empty" }, "No font with that name."));
      return;
    }
    results.replaceChildren(...list.map(item => {
      const button = h("button", { class: "btn small", disabled: item.installed }, item.installed ? "Added" : "Add");
      button.addEventListener("click", async () => {
        button.disabled = true;
        button.textContent = "Adding…";
        try {
          const entry = await api.addGoogleFont(item.family);
          await loadFonts();
          commit({ fontId: entry.id, fontFamily: entry.family });
          button.textContent = "Added";
          toast(`${entry.family} added.`);
        } catch (error) {
          button.disabled = false;
          button.textContent = "Add";
          toast(error.message, "error", 8000);
        }
      });
      return h("div", { class: "cap-result" },
        h("span", { class: "name" }, item.family),
        h("span", { class: "muted" }, `${item.category} · ${item.styles} style${item.styles === 1 ? "" : "s"}`),
        button);
    }));
  }

  async function runSearch() {
    const token = ++searchToken;
    results.replaceChildren(h("div", { class: "muted cap-empty" }, "Searching…"));
    try {
      const list = await api.searchGoogleFonts(searchInput.value.trim());
      if (token === searchToken) renderResults(list);
    } catch (error) {
      if (token === searchToken) results.replaceChildren(h("div", { class: "error-card" }, error.message));
    }
  }
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 250);
  });

  async function uploadFiles(files) {
    let last = null;
    for (const file of files) {
      if (!/\.(ttf|otf)$/i.test(file.name)) {
        toast(`${file.name}: use a .ttf or .otf file.`, "error");
        continue;
      }
      try {
        last = await api.uploadFont(file);
      } catch (error) {
        toast(`${file.name}: ${error.message}`, "error", 8000);
      }
    }
    if (last) {
      await loadFonts();
      commit({ fontId: last.id, fontFamily: last.family });
      toast(`${last.family} added.`);
    }
  }

  const fileInput = h("input", { type: "file", accept: ".ttf,.otf", multiple: true, hidden: true });
  fileInput.addEventListener("change", () => { uploadFiles([...fileInput.files]); fileInput.value = ""; });
  const dropZone = h("label", { class: "cap-drop" },
    h("strong", {}, "Upload a font file"),
    h("span", { class: "muted" }, "Drop .ttf / .otf files here, or click to choose. Add a bold or italic file to the same family and it is used for the B and I buttons."),
    fileInput);
  dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("over"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("over"));
  dropZone.addEventListener("drop", e => {
    e.preventDefault();
    dropZone.classList.remove("over");
    uploadFiles([...e.dataTransfer.files]);
  });

  const addFont = h("details", { class: "cap-add" },
    h("summary", {}, "Add a font"),
    h("div", { class: "cap-add-body" }, searchInput, results, dropZone));
  addFont.addEventListener("toggle", () => {
    if (addFont.open && !searched) { searched = true; runSearch(); }
  });

  // ------------------------------------------------------------ panel: assembled
  const body = h("div", { class: "cap-body" },
    section("Presets", h("div", { class: "cap-presets" }, presetButtons)),

    section("Font",
      h("div", { class: "cap-fontrow" }, fontSelect, removeFontBtn),
      h("div", { class: "cap-toggles" },
        toggleButton("B", "bold", "Bold", "b"),
        toggleButton("I", "italic", "Italic", "i"),
        toggleButton("AA", "allCaps", "ALL CAPS")),
      slider("Size", "size", 20, 200, 1),
      slider("Letter spacing", "spacing", -5, 30, 0.5),
      addFont),

    section("Text",
      colour("Colour", "color"),
      slider("Opacity", "textOpacity", 0, 100, 1, { unitText: "%" })),

    section("Outline",
      slider("Width", "outlineWidth", 0, 20, 0.5),
      colour("Colour", "outlineColor")),

    section("Shadow",
      slider("Distance", "shadowSize", 0, 20, 0.5),
      colour("Colour", "shadowColor"),
      slider("Opacity", "shadowOpacity", 0, 100, 1, { unitText: "%" })),

    section("Background box",
      (() => {
        const sw = h("input", { type: "checkbox", class: "switch" });
        sw.addEventListener("change", () => commit({ bgEnabled: sw.checked }));
        controls.push(() => { sw.checked = config.style.bgEnabled; });
        return h("label", { class: "switch-row" }, sw, "Show a box behind the text");
      })(),
      colour("Colour", "bgColor"),
      slider("Opacity", "bgOpacity", 0, 100, 1, { unitText: "%" }),
      slider("Padding", "bgPadding", 0, 40, 1)),

    section("Position and wrapping",
      slider("Horizontal", "x", 0, 100, 0.5, { scale: 100, unitText: "%" }),
      slider("Vertical", "y", 0, 100, 0.5, { scale: 100, unitText: "%" }),
      h("div", {}, h("button", { class: "btn small", onclick: () => commit({ x: DEFAULT_STYLE.x, y: DEFAULT_STYLE.y }) }, "Reset position")),
      slider("Characters per line", "maxChars", 8, 60, 1),
      slider("Lines per caption", "maxLines", 1, 4, 1)));

  const panel = h("div", { class: `cap-panel${config.enabled ? "" : " off"}` }, head, audioNote, intro, body);

  // ------------------------------------------------------------ live updates
  let rebuildTimer = 0;
  const offEditor = editor.onChange(() => {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => { rebuild(); paintAt(video.currentTime); }, 60);
  });

  rebuild();
  sync();
  fillFontSelect();
  layout();
  loadFonts();

  return {
    pane: panel,

    paintAt,

    // The keep list changed (for example the padding): rebuild the captions now.
    refresh() { rebuild(); paintAt(video.currentTime); },

    setActive(value) {
      active = value;
      shownKey = "";
      paintAt(lastTime);
    },

    summary: () => ({ available: hasVideo, enabled: config.enabled, count: captions.length }),

    saveNow,

    destroy() {
      clearTimeout(saveTimer);
      clearTimeout(rebuildTimer);
      clearTimeout(searchTimer);
      offEditor();
      resizeObserver.disconnect();
      video.removeEventListener("loadedmetadata", layout);
      for (const face of faces.values()) document.fonts.delete(face);
      frame.remove();
    }
  };
}
