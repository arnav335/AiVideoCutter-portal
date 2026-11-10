import { h, icon, toast, fmtBytes } from "./dom.js";
import { api } from "./api.js";
import { createEditor } from "./editor.js";
import { nextPlayable, fmtClock } from "/shared/editModel.js";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const SOURCE_LABEL = { ai: "AI cut", you: "Your cut", mixed: "AI + you" };

export async function mountReview(root, jobId, { topbar }) {
  const data = await api.review(jobId);
  let job = data.job;
  const { words, segments, duration } = data;
  const n = words.length;

  const editor = createEditor({
    words, duration,
    aiRanges: data.ai?.ranges || [],
    ranges: data.edits.ranges || [],
    pad: job.export?.pad ?? 0.05
  });

  const segOfWord = new Int32Array(n);
  segments.forEach((s, si) => { for (let i = s.w0; i < s.w1; i++) segOfWord[i] = si; });

  // ---------------------------------------------------------------- player
  const video = h("video", { src: `/api/jobs/${jobId}/media/base`, preload: "auto", playsinline: true });
  const flashEl = h("div", { class: "flash" }, "Cut skipped");
  const player = h("div", { class: `player${job.source?.hasVideo === false ? " audio-only" : ""}` },
    video, h("div", { class: "audio-label" }, "Audio only"), flashEl);
  let flashTimer;
  const flash = text => {
    flashEl.textContent = text; flashEl.classList.add("on");
    clearTimeout(flashTimer); flashTimer = setTimeout(() => flashEl.classList.remove("on"), 700);
  };

  const track = h("div", {});
  const head = h("div", { class: "tl-head" });
  const tlSel = h("div", { class: "tl-sel" });
  const timeline = h("div", { class: "timeline", role: "slider", "aria-label": "Playback position" }, track, tlSel, head);

  const playBtn = h("button", { class: "btn primary square", title: "Play / pause (Space)", "aria-label": "Play or pause" }, icon("play"));
  const prevBtn = h("button", { class: "btn square", title: "Previous cut (P)", "aria-label": "Previous cut" }, icon("prev"));
  const nextBtn = h("button", { class: "btn square", title: "Next cut (N): hear it with context", "aria-label": "Next cut" }, icon("next"));
  const timeEl = h("div", { class: "time num" });
  const preview = h("input", { type: "checkbox", class: "switch", checked: true });
  const rate = h("select", { "aria-label": "Playback speed" },
    [0.75, 1, 1.25, 1.5, 2].map(r => h("option", { value: r, selected: r === 1 }, `${r}×`)));

  const transport = h("div", { class: "transport" },
    prevBtn, playBtn, nextBtn, timeEl, h("span", { class: "grow" }),
    h("label", { class: "switch-row", title: "Jump over cuts while playing" }, preview, "Skip cuts"), rate);

  const bigNum = h("div", { class: "big num" });
  const facts = h("div", { class: "facts num" });
  const caption = h("div", { class: "caption num" });
  const summary = h("div", { class: "summary" }, bigNum, facts, caption);

  const legend = h("div", { class: "legend" },
    h("span", { class: "ai" }, h("i"), "Cut by AI"),
    h("span", { class: "you" }, h("i"), "Cut by you"),
    h("span", { class: "sel" }, h("i"), "Selected"));

  const stage = h("section", { class: "stage" }, player, timeline, transport, summary, legend);

  // ------------------------------------------------------------ transcript
  const wordEls = new Array(n);
  const segEls = [];
  const segHas = new Array(segments.length).fill(false);

  const tx = h("div", { class: "transcript" });
  segments.forEach((s, si) => {
    const p = h("p", { class: "seg-text" });
    for (let i = s.w0; i < s.w1; i++) {
      const span = h("span", { class: "w", dataset: { i } }, words[i].t + " ");
      wordEls[i] = span;
      p.append(span);
    }
    const el = h("div", { class: "seg", dataset: { seg: si } },
      h("button", { class: "seg-time", title: "Jump here", onclick: () => seek(s.start) }, fmtClock(s.start)),
      p,
      h("div", { class: "seg-actions" },
        h("button", { class: "btn quiet small square", title: "Cut this sentence", "aria-label": "Cut this sentence",
          onclick: () => { editor.set(s.w0, s.w1 - 1, 1); } }, icon("scissors", 14)),
        h("button", { class: "btn quiet small square", title: "Restore this sentence", "aria-label": "Restore this sentence",
          onclick: () => { editor.set(s.w0, s.w1 - 1, 0); } }, icon("restore", 14))));
    segEls.push(el);
    tx.append(el);
  });

  const selInfo = h("div", { class: "sel-info" });
  const cutBtn = h("button", { class: "btn small", title: "Cut selection (Delete)" }, icon("scissors", 14), "Cut");
  const restoreBtn = h("button", { class: "btn small", title: "Restore selection (R)" }, icon("restore", 14), "Restore");
  const undoBtn = h("button", { class: "btn quiet small square", title: "Undo (Ctrl+Z)", "aria-label": "Undo" }, icon("undo", 15));
  const redoBtn = h("button", { class: "btn quiet small square", title: "Redo (Ctrl+Shift+Z)", "aria-label": "Redo" }, icon("redo", 15));
  const cutsOnly = h("input", { type: "checkbox", class: "switch" });
  const follow = h("input", { type: "checkbox", class: "switch", checked: true });
  const keysBtn = h("button", { class: "btn quiet small square", title: "Keyboard shortcuts (?)", "aria-label": "Keyboard shortcuts" }, icon("keys", 15));

  const toolbar = h("div", { class: "toolbar" },
    cutBtn, restoreBtn, undoBtn, redoBtn, selInfo, h("span", { class: "grow" }),
    h("label", { class: "switch-row" }, cutsOnly, "Only cuts"),
    h("label", { class: "switch-row" }, follow, "Follow playback"),
    keysBtn);

  const transcriptPane = h("div", { class: "pane", id: "pane-transcript" }, tx);
  const cutsPane = h("div", { class: "pane", id: "pane-cuts", hidden: true });
  const notesPane = h("div", { class: "pane", id: "pane-notes", hidden: true });

  const tabCuts = h("span", { class: "count num" }, "0");
  const tabs = [
    ["transcript", h("button", { class: "tab", role: "tab" }, "Transcript"), transcriptPane],
    ["cuts", h("button", { class: "tab", role: "tab" }, "Cuts", tabCuts), cutsPane],
    ["notes", h("button", { class: "tab", role: "tab" }, "AI notes"), notesPane]
  ];
  let activeTab = "transcript";
  function showTab(name) {
    activeTab = name;
    for (const [key, btn, pane] of tabs) {
      btn.setAttribute("aria-selected", String(key === name));
      pane.hidden = key !== name;
    }
    toolbar.hidden = name !== "transcript";
  }
  tabs.forEach(([key, btn]) => btn.addEventListener("click", () => showTab(key)));

  const sheet = h("section", { class: "sheet" },
    h("div", { class: "tabs", role: "tablist" }, tabs.map(t => t[1])),
    toolbar, transcriptPane, cutsPane, notesPane);

  // ------------------------------------------------------------ top bar
  const titleInput = h("input", { class: "title-input", value: job.name, "aria-label": "Project name" });
  titleInput.addEventListener("change", async () => {
    try { await api.patchJob(jobId, { name: titleInput.value }); } catch (e) { toast(e.message, "error"); }
  });
  const saveState = h("span", { class: "save-state" }, "Saved");
  const exportBtn = h("button", { class: "btn primary" }, icon("download", 15), "Export video");

  const bar = topbar(
    h("a", { class: "btn quiet small", href: "#/" }, icon("back", 15), "Projects"),
    h("div", { class: "grow" }, titleInput),
    saveState, exportBtn);

  root.replaceChildren(bar, h("div", { class: "review" }, stage, sheet));

  // ---------------------------------------------------------- selection
  let sel = null; // { anchor, focus }
  const selRange = () => sel ? [Math.min(sel.anchor, sel.focus), Math.max(sel.anchor, sel.focus)] : null;

  function setSel(anchor, focus) {
    const old = selRange();
    if (old) for (let i = old[0]; i <= old[1]; i++) wordEls[i].classList.remove("sel");
    sel = anchor === null ? null : { anchor, focus };
    const now = selRange();
    if (now) for (let i = now[0]; i <= now[1]; i++) wordEls[i].classList.add("sel");
    paintToolbar();
    paintSelOnTimeline();
  }

  function paintToolbar() {
    const r = selRange();
    if (!r) {
      selInfo.textContent = "Click a word, or drag across several.";
      cutBtn.disabled = restoreBtn.disabled = true;
    } else {
      const count = r[1] - r[0] + 1;
      selInfo.textContent = `${count} word${count === 1 ? "" : "s"} · ${fmtClock(words[r[0]].s)}–${fmtClock(words[r[1]].e)}`;
      let anyCut = false;
      for (let i = r[0]; i <= r[1]; i++) if (editor.isCut(i)) { anyCut = true; break; }
      cutBtn.disabled = editor.allCut(r[0], r[1]);
      restoreBtn.disabled = !anyCut;
    }
    undoBtn.disabled = !editor.canUndo();
    redoBtn.disabled = !editor.canRedo();
  }

  function paintSelOnTimeline() {
    const r = selRange();
    if (!r) { tlSel.style.display = "none"; return; }
    const a = words[r[0]].s, b = words[r[1]].e;
    tlSel.style.display = "block";
    tlSel.style.left = `${(a / duration) * 100}%`;
    tlSel.style.width = `${Math.max(0.4, ((b - a) / duration) * 100)}%`;
  }

  const cutSelection = () => { const r = selRange(); if (r) editor.set(r[0], r[1], 1); };
  const restoreSelection = () => { const r = selRange(); if (r) editor.set(r[0], r[1], 0); };
  cutBtn.addEventListener("click", cutSelection);
  restoreBtn.addEventListener("click", restoreSelection);
  undoBtn.addEventListener("click", () => editor.undo());
  redoBtn.addEventListener("click", () => editor.redo());

  let drag = null;
  tx.addEventListener("mousedown", e => {
    if (e.button !== 0) return;
    const w = e.target.closest(".w");
    if (!w) { if (!e.target.closest("button")) setSel(null); return; }
    const i = Number(w.dataset.i);
    if (e.shiftKey && sel) setSel(sel.anchor, i);
    else { drag = { anchor: i }; setSel(i, i); }
    e.preventDefault();
  });
  tx.addEventListener("mouseover", e => {
    if (!drag) return;
    const w = e.target.closest(".w");
    if (w) setSel(drag.anchor, Number(w.dataset.i));
  });
  const onMouseUp = () => {
    if (!drag) return;
    drag = null;
    const r = selRange();
    if (r) seek(words[r[0]].s);
  };
  window.addEventListener("mouseup", onMouseUp);
  tx.addEventListener("dblclick", e => {
    const w = e.target.closest(".w");
    if (!w) return;
    const i = Number(w.dataset.i);
    editor.set(i, i, editor.isCut(i) ? 0 : 1);
  });

  // ------------------------------------------------------------ painting
  function paintWord(i) {
    const el = wordEls[i];
    const cut = editor.isCut(i), ai = editor.isAi(i);
    el.classList.toggle("cut", cut);
    el.classList.toggle("ai", cut && ai);
    el.classList.toggle("you", cut && !ai);
    el.classList.toggle("restored", !cut && ai);
  }

  function paintSegment(si) {
    const s = segments[si];
    let count = 0;
    for (let i = s.w0; i < s.w1; i++) if (editor.isCut(i)) count++;
    segHas[si] = count > 0;
    segEls[si].classList.toggle("has-cut", count > 0);
    segEls[si].classList.toggle("all-cut", count === s.w1 - s.w0);
  }

  function paintNear() {
    for (let si = 0; si < segments.length; si++) {
      const near = (si > 0 && segHas[si - 1]) || (si < segments.length - 1 && segHas[si + 1]);
      segEls[si].classList.toggle("near-cut", near);
    }
  }

  function paintTimeline() {
    track.replaceChildren(...editor.cutRuns().map(run => h("div", {
      class: `tl-cut ${run.source}`,
      style: { left: `${(run.start / duration) * 100}%`, width: `${((run.end - run.start) / duration) * 100}%` }
    })));
  }

  function paintSummary() {
    const s = editor.stats();
    bigNum.replaceChildren(fmtClock(s.finalSeconds), h("small", {}, "final length"));
    const pct = duration > 0 ? Math.round((s.removedSeconds / duration) * 100) : 0;
    facts.replaceChildren(
      h("span", {}, `${s.removedSeconds.toFixed(1)}s cut (${pct}%)`),
      h("span", {}, `${s.cuts} cut${s.cuts === 1 ? "" : "s"}`),
      h("span", {}, `${s.cutWords} of ${n} words`));
    const src = job.source?.duration;
    caption.textContent = src && Math.abs(src - duration) > 0.5
      ? `Recording ${fmtClock(src)} · after silence removal ${fmtClock(duration)}`
      : `Recording ${fmtClock(duration)}`;
    tabCuts.textContent = String(s.cuts);
  }

  function paintCuts() {
    const runs = editor.cutRuns();
    if (runs.length === 0) {
      cutsPane.replaceChildren(h("div", { class: "empty", style: { margin: "16px" } },
        "No cuts yet. Select words in the transcript and press Delete."));
      return;
    }
    cutsPane.replaceChildren(...runs.map(run => {
      const text = run.text.length > 220 ? run.text.slice(0, 220) + "…" : run.text;
      return h("div", { class: `cut-card ${run.source}` },
        h("div", { class: "head" },
          h("span", { class: `badge ${run.source}` }, SOURCE_LABEL[run.source]),
          h("span", { class: "when num" }, `${fmtClock(run.start)} – ${fmtClock(run.end)}`),
          h("span", { class: "len num" }, `${(run.end - run.start).toFixed(1)}s`)),
        h("p", { class: "text" }, text),
        h("div", { class: "row" },
          h("button", { class: "btn small", onclick: () => playWindow(run.start - 1.5, run.end + 1.5, true) },
            icon("play", 13), "Hear the join"),
          h("button", { class: "btn small", onclick: () => playWindow(run.start - 0.2, run.end + 0.2, false) },
            "Hear what's cut"),
          h("button", { class: "btn small", onclick: () => { editor.set(run.a, run.b, 0); } },
            icon("restore", 13), "Restore"),
          h("button", { class: "btn quiet small", onclick: () => showInTranscript(run) }, "Show in transcript")));
    }));
  }

  function showInTranscript(run) {
    showTab("transcript");
    cutsOnly.checked = false; tx.classList.remove("cuts-only");
    setSel(run.a, run.b);
    wordEls[run.a].scrollIntoView({ block: "center", behavior: "smooth" });
    seek(run.start);
  }

  function paintNotes() {
    const ai = data.ai;
    const children = [];

    if (!ai) {
      children.push(h("p", { class: "muted" }, "No AI review has run for this project."));
    } else if (ai.skipped) {
      children.push(h("div", { class: "banner" }, icon("alert"), ai.message || "The AI review was skipped."));
    } else {
      children.push(h("p", { class: "muted", style: { margin: 0 } },
        `${ai.model || "AI"} marked ${ai.ranges.length} passage${ai.ranges.length === 1 ? "" : "s"}. Review each one in the Cuts tab.`));
      if (ai.analysis?.length) {
        children.push(h("div", {}, h("h3", {}, "Why the AI cut them"), h("ul", {}, ai.analysis.map(a => h("li", {}, a)))));
      }
      if (ai.warnings?.length) {
        children.push(h("div", { class: "warn" }, h("h3", {}, "Couldn't apply"), h("ul", {}, ai.warnings.map(w => h("li", {}, w)))));
      }
    }

    children.push(h("div", { class: "actions" },
      h("button", {
        class: "btn", disabled: !ai || ai.skipped,
        title: "Drop your manual edits and go back to what the AI marked",
        onclick: () => { if (!editor.resetToAi()) toast("Already matches the AI suggestions."); }
      }, icon("restore", 14), "Reset to AI suggestions"),
      h("button", {
        class: "btn",
        onclick: async () => {
          if (!confirm("Run the AI review again? This replaces your current cuts with a fresh set.")) return;
          try { await flush(); await api.run(jobId, { from: "ai" }); }
          catch (e) { toast(e.message, "error", 6000); }
        }
      }, "Run AI review again")));

    notesPane.replaceChildren(h("div", { class: "notes" }, children));
  }

  // ------------------------------------------------------------ playback
  let win = null;            // { to, skip } while playing a review window
  let raf = 0;
  let lastWord = -1;
  let lastSeg = -1;

  function wordAt(t) {
    let lo = 0, hi = n - 1, found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid].s <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  }

  function paintPlayhead(t) {
    head.style.left = `${clamp((t / duration) * 100, 0, 100)}%`;
    timeEl.replaceChildren(fmtClock(t), h("span", {}, ` / ${fmtClock(duration)}`));

    const wi = wordAt(t);
    if (wi !== lastWord) {
      if (lastWord >= 0) wordEls[lastWord].classList.remove("now");
      wordEls[wi].classList.add("now");
      lastWord = wi;
    }
    const si = segOfWord[wi];
    if (si !== lastSeg) {
      if (lastSeg >= 0) segEls[lastSeg].classList.remove("live");
      segEls[si].classList.add("live");
      lastSeg = si;
      if (follow.checked && !video.paused) segEls[si].scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  function tick() {
    const t = video.currentTime;

    if (!video.paused) {
      if (win && t >= win.to) {
        video.pause();
      } else if (win ? win.skip : preview.checked) {
        const keep = editor.keep();
        const k = nextPlayable(keep, t);
        if (k === null) {
          video.pause();
          if (keep.length) video.currentTime = keep[keep.length - 1].end;
        } else if (k > t + 0.02) {
          video.currentTime = k;
          flash("Cut skipped");
        }
      }
    }

    paintPlayhead(video.currentTime);
    if (!video.paused) raf = requestAnimationFrame(tick);
  }

  video.addEventListener("play", () => {
    playBtn.replaceChildren(icon("pause"));
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  });
  video.addEventListener("pause", () => {
    playBtn.replaceChildren(icon("play"));
    win = null;
    cancelAnimationFrame(raf);
    paintPlayhead(video.currentTime);
  });
  video.addEventListener("seeked", () => paintPlayhead(video.currentTime));
  video.addEventListener("loadedmetadata", () => paintPlayhead(video.currentTime));
  video.addEventListener("error", () => toast("The video could not be loaded.", "error"));

  function seek(t) {
    video.currentTime = clamp(t, 0, duration);
    paintPlayhead(video.currentTime);
  }

  async function togglePlay() {
    if (!video.paused) { video.pause(); return; }
    try {
      const keep = editor.keep();
      if (preview.checked && nextPlayable(keep, video.currentTime) === null && keep.length) seek(keep[0].start);
      await video.play();
    } catch { /* interrupted by another seek */ }
  }

  async function playWindow(from, to, skip) {
    win = null;
    seek(Math.max(0, from));
    win = { to: Math.min(duration, to), skip };
    try { await video.play(); } catch { win = null; }
  }

  function jumpToCut(direction) {
    const runs = editor.cutRuns();
    if (runs.length === 0) { toast("There are no cuts yet."); return; }
    const t = video.currentTime;
    const run = direction > 0
      ? runs.find(r => r.start > t + 0.05) || runs[0]
      : [...runs].reverse().find(r => r.start < t - 1) || runs[runs.length - 1];

    setSel(run.a, run.b);
    wordEls[run.a].scrollIntoView({ block: "center", behavior: "smooth" });
    playWindow(run.start - 1.5, run.end + 1.5, true);
  }

  playBtn.addEventListener("click", togglePlay);
  video.addEventListener("click", togglePlay);
  prevBtn.addEventListener("click", () => jumpToCut(-1));
  nextBtn.addEventListener("click", () => jumpToCut(1));
  rate.addEventListener("change", () => { video.playbackRate = Number(rate.value); });
  cutsOnly.addEventListener("change", () => tx.classList.toggle("cuts-only", cutsOnly.checked));

  // timeline scrubbing
  const scrub = e => {
    const rect = timeline.getBoundingClientRect();
    seek(((e.clientX - rect.left) / rect.width) * duration);
  };
  timeline.addEventListener("pointerdown", e => {
    timeline.setPointerCapture(e.pointerId); scrub(e);
    timeline.onpointermove = scrub;
  });
  timeline.addEventListener("pointerup", () => { timeline.onpointermove = null; });

  // ------------------------------------------------------------ edits
  editor.onChange(({ from, to }) => {
    for (let i = from; i <= to; i++) paintWord(i);
    for (let si = segOfWord[from]; si <= segOfWord[to]; si++) paintSegment(si);
    paintNear();
    paintTimeline();
    paintSummary();
    paintCuts();
    paintToolbar();
    renderExport();
    scheduleSave();
  });

  // autosave
  let saveTimer = 0;
  let savedKey = JSON.stringify(editor.ranges());
  const setSave = (text, err) => { saveState.textContent = text; saveState.classList.toggle("err", Boolean(err)); };

  function scheduleSave() {
    if (JSON.stringify(editor.ranges()) === savedKey) { setSave("Saved"); return; }
    setSave("Unsaved");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 600);
  }

  async function flush() {
    clearTimeout(saveTimer);
    const ranges = editor.ranges();
    const key = JSON.stringify(ranges);
    if (key === savedKey) { setSave("Saved"); return; }
    try {
      setSave("Saving…");
      await api.saveEdits(jobId, ranges);
      savedKey = key;
      if (JSON.stringify(editor.ranges()) !== key) scheduleSave(); else setSave("Saved");
    } catch (error) {
      setSave("Not saved", true);
      toast(error.message, "error");
    }
  }

  const onUnload = () => {
    const ranges = editor.ranges();
    if (JSON.stringify(ranges) !== savedKey) api.saveEdits(jobId, ranges, true).catch(() => {});
  };
  window.addEventListener("beforeunload", onUnload);

  // ------------------------------------------------------------ export dialog
  const padInput = h("input", { class: "field num", type: "number", min: "0", max: "300", step: "10", value: String(Math.round((job.export?.pad ?? 0.05) * 1000)) });
  padInput.addEventListener("change", () => {
    editor.setPad(clamp(Number(padInput.value) || 0, 0, 300) / 1000);
    paintSummary(); renderExport();
  });
  const dlgBody = h("div", { class: "dlg" });
  const dialog = h("dialog", {}, dlgBody);
  document.body.append(dialog);

  function renderExport() {
    const ex = job.export || { status: "idle" };
    const s = editor.stats();
    const pct = Math.round((ex.progress || 0) * 100);

    exportBtn.replaceChildren(
      icon("download", 15),
      ex.status === "running" ? `Rendering ${pct}%` : "Export video");

    const parts = [
      h("h2", {}, "Export video"),
      h("div", { class: "muted num" },
        `Final length ${fmtClock(s.finalSeconds)} · ${s.cuts} cut${s.cuts === 1 ? "" : "s"} · ${s.removedSeconds.toFixed(1)}s removed`)
    ];

    if (ex.status === "running") {
      parts.push(h("div", { class: "progress" }, h("i", { style: { width: `${pct}%` } })),
        h("div", { class: "muted" }, `Rendering… ${pct}%`));
    } else {
      parts.push(h("label", { class: "stack" }, "Padding around each cut (ms)", padInput),
        h("p", { class: "hint" }, "A little audio is kept next to each cut so words aren't clipped. Never more than half the gap."));

      if (ex.status === "error") parts.push(h("div", { class: "error-card" }, ex.error));
      if (ex.status === "done" && ex.stale) parts.push(h("div", { class: "banner" }, icon("alert"), "You changed the cuts after this render. Render again to update it."));
      if (ex.status === "done") {
        parts.push(h("video", { controls: true, src: `/api/jobs/${jobId}/media/final?t=${ex.finishedAt}` }),
          h("div", { class: "muted num" }, `${fmtClock(ex.duration)} · ${fmtBytes(ex.bytes)} · saved in workspace/${jobId}/${ex.file}`));
      }
    }

    const closeBtn = h("button", { class: "btn", onclick: () => dialog.close() }, "Close");
    const renderBtn = h("button", {
      class: ex.status === "done" && !ex.stale ? "btn" : "btn primary",
      disabled: ex.status === "running" || s.finalSeconds <= 0,
      onclick: startExport
    }, ex.status === "done" ? "Render again" : "Render video");
    const downloadBtn = ex.status === "done"
      ? h("a", { class: `btn ${ex.stale ? "" : "primary"}`, href: `/api/jobs/${jobId}/media/final?download=1` }, icon("download", 15), "Download")
      : null;

    parts.push(h("div", { class: "foot" }, closeBtn, renderBtn, downloadBtn));
    dlgBody.replaceChildren(...parts);
  }

  async function startExport() {
    try {
      await flush();
      await api.exportJob(jobId, clamp(Number(padInput.value) || 0, 0, 300) / 1000);
    } catch (error) {
      toast(error.message, "error", 6000);
    }
  }

  exportBtn.addEventListener("click", () => { renderExport(); dialog.showModal(); });

  // ------------------------------------------------------------ shortcuts
  const keysDialog = h("dialog", {}, h("div", { class: "dlg" },
    h("h2", {}, "Keyboard shortcuts"),
    h("dl", { class: "keys" },
      h("dt", {}, h("kbd", {}, "Space")), h("dd", {}, "Play / pause"),
      h("dt", {}, h("kbd", {}, "←"), " ", h("kbd", {}, "→")), h("dd", {}, "Move the selection by one word (Shift extends it)"),
      h("dt", {}, h("kbd", {}, "↑"), " ", h("kbd", {}, "↓")), h("dd", {}, "Previous / next sentence"),
      h("dt", {}, h("kbd", {}, "Delete"), " / ", h("kbd", {}, "X")), h("dd", {}, "Cut the selection"),
      h("dt", {}, h("kbd", {}, "R")), h("dd", {}, "Restore the selection"),
      h("dt", {}, h("kbd", {}, "N"), " / ", h("kbd", {}, "P")), h("dd", {}, "Hear the next / previous cut with context"),
      h("dt", {}, h("kbd", {}, "Ctrl"), "+", h("kbd", {}, "Z")), h("dd", {}, "Undo (add Shift to redo)"),
      h("dt", {}, "Double-click"), h("dd", {}, "Toggle a single word")),
    h("div", { class: "foot" }, h("button", { class: "btn", onclick: () => keysDialog.close() }, "Close"))));
  document.body.append(keysDialog);
  keysBtn.addEventListener("click", () => keysDialog.showModal());

  function onKey(e) {
    if (dialog.open || keysDialog.open) return;
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? editor.redo() : editor.undo(); return; }
    if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); editor.redo(); return; }
    if (mod || e.altKey) return;

    const onButton = tag === "BUTTON" || tag === "A";
    if (e.key === " " && !onButton) { e.preventDefault(); togglePlay(); return; }
    if (activeTab !== "transcript") return;

    switch (e.key) {
      case "Delete": case "Backspace": case "x": case "X": e.preventDefault(); cutSelection(); break;
      case "r": case "R": e.preventDefault(); restoreSelection(); break;
      case "n": case "N": jumpToCut(1); break;
      case "p": case "P": jumpToCut(-1); break;
      case "?": keysDialog.showModal(); break;
      case "ArrowLeft": case "ArrowRight": {
        e.preventDefault();
        moveSelection(e.key === "ArrowRight" ? 1 : -1, e.shiftKey);
        break;
      }
      case "ArrowUp": case "ArrowDown": {
        e.preventDefault();
        const from = sel ? sel.focus : Math.max(0, lastWord);
        const si = clamp(segOfWord[from] + (e.key === "ArrowDown" ? 1 : -1), 0, segments.length - 1);
        const first = segments[si].w0;
        setSel(first, first);
        wordEls[first].scrollIntoView({ block: "nearest" });
        seek(words[first].s);
        break;
      }
      default: break;
    }
  }

  function moveSelection(delta, extend) {
    const current = sel ? sel.focus : Math.max(0, lastWord);
    const next = clamp(current + delta, 0, n - 1);
    if (extend && sel) setSel(sel.anchor, next); else setSel(next, next);
    wordEls[next].scrollIntoView({ block: "nearest" });
    if (!extend) seek(words[next].s);
  }
  document.addEventListener("keydown", onKey);

  // ------------------------------------------------------------ first paint
  for (let i = 0; i < n; i++) paintWord(i);
  for (let si = 0; si < segments.length; si++) paintSegment(si);
  paintNear(); paintTimeline(); paintSummary(); paintCuts(); paintNotes(); paintToolbar();
  paintSelOnTimeline(); paintPlayhead(0); renderExport(); showTab("transcript");

  return {
    update(next) { job = next; renderExport(); },
    destroy() {
      flush();
      cancelAnimationFrame(raf);
      video.pause();
      video.removeAttribute("src");
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("beforeunload", onUnload);
      dialog.remove();
      keysDialog.remove();
    }
  };
}
