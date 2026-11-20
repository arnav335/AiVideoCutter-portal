import { h, icon, toast, fmtBytes } from "./dom.js";
import { api } from "./api.js";
import { createEditor } from "./editor.js";
import { mountCaptions } from "./captions.js";
import { createBroll } from "./broll.js";
import { openKeys } from "./keys.js";
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

  // Timeline: a ruler, a lane of "speech bars" (taller = more talking), the cut passages on top, and a playhead.
  const BINS = 150;
  const barEls = Array.from({ length: BINS }, () => h("i"));
  {
    const cover = new Float32Array(BINS);
    for (const w of words) {
      const a = (w.s / duration) * BINS, b = (w.e / duration) * BINS;
      for (let k = Math.max(0, Math.floor(a)); k <= Math.min(BINS - 1, Math.floor(b)); k++) {
        cover[k] += Math.min(b, k + 1) - Math.max(a, k);
      }
    }
    barEls.forEach((el, k) => {
      const wobble = 0.65 + 0.35 * Math.abs(Math.sin(k * 12.9898) * Math.cos(k * 4.1414));
      const amp = cover[k] > 0.02 ? 0.3 + 0.7 * Math.min(1, cover[k]) * wobble : 0.07;
      el.style.height = `${Math.round(amp * 100)}%`;
    });
  }
  const bars = h("div", { class: "tl-bars" }, barEls);

  const rulerEl = h("div", { class: "tl-ruler" });
  {
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const step = steps.find(x => duration / x <= 7) || 7200;
    for (let t = 0; t <= duration + 0.001; t += step) {
      const pct = (t / duration) * 100;
      const cls = t === 0 ? " first" : pct > 94 ? " last" : "";
      rulerEl.append(h("span", { class: `tl-tick${cls}`, style: { left: `${pct}%` } }, fmtClock(t, 0)));
    }
  }

  const track = h("div", { class: "tl-cuts" });
  const head = h("div", { class: "tl-head" });
  const tlSel = h("div", { class: "tl-sel" });
  const hoverTime = h("b", {}, "0:00");
  const hoverEl = h("div", { class: "tl-hover" }, hoverTime);
  const lane = h("div", { class: "tl-lane" }, bars, track, tlSel);
  const timeline = h("div", { class: "timeline", role: "slider", "aria-label": "Playback position" }, rulerEl, lane, hoverEl, head);

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

  const tlCard = h("div", { class: "tl-card" },
    h("div", { class: "tl-title" }, "Timeline", h("span", {}, "Click or drag to jump around")),
    timeline, legend);

  const stage = h("section", { class: "stage" }, player, transport, tlCard, summary);

  // ------------------------------------------------------------ transcript
  const wordEls = new Array(n);
  const segEls = [];
  const segHas = new Array(segments.length).fill(false);
  const segToggle = [];

  const tx = h("div", { class: "transcript" });
  segments.forEach((s, si) => {
    const p = h("p", { class: "seg-text" });
    for (let i = s.w0; i < s.w1; i++) {
      const span = h("span", { class: "w", dataset: { i } }, words[i].t + " ");
      wordEls[i] = span;
      p.append(span);
    }
    // One button per sentence: it cuts the sentence, or restores it when it is already cut.
    const toggle = h("button", { class: "btn quiet small square",
      onclick: () => { editor.set(s.w0, s.w1 - 1, editor.allCut(s.w0, s.w1 - 1) ? 0 : 1); } });
    const el = h("div", { class: "seg", dataset: { seg: si } },
      h("button", { class: "seg-time", title: "Jump here", onclick: () => seek(s.start) }, fmtClock(s.start)),
      p,
      h("div", { class: "seg-actions" }, toggle));
    segToggle.push(toggle);
    segEls.push(el);
    tx.append(el);
  });

  const selInfo = h("div", { class: "sel-info" });
  // One button: "Cut" for a selection that still has words in it, "Restore" once every selected word is cut.
  const toggleBtn = h("button", { class: "btn small", title: "Cut or restore selection (X)" }, icon("scissors", 14), "Cut");
  const undoBtn = h("button", { class: "btn quiet small square", title: "Undo (Ctrl+Z)", "aria-label": "Undo" }, icon("undo", 15));
  const redoBtn = h("button", { class: "btn quiet small square", title: "Redo (Ctrl+Shift+Z)", "aria-label": "Redo" }, icon("redo", 15));
  const cutsOnly = h("input", { type: "checkbox", class: "switch" });
  const follow = h("input", { type: "checkbox", class: "switch", checked: true });
  const keysBtn = h("button", { class: "btn quiet small menu-item", title: "Keyboard shortcuts (?)" }, icon("keys", 15), "Shortcuts");

  const toolbar = h("div", { class: "toolbar" },
    toggleBtn, undoBtn, redoBtn, selInfo, h("span", { class: "grow" }),
    h("label", { class: "switch-row" }, cutsOnly, "Only cuts"),
    h("label", { class: "switch-row" }, follow, "Follow"),
    h("button", { class: "btn quiet small", title: "Download subtitles (.srt) with your cuts applied", onclick: () => downloadText("srt") }, icon("download", 14), "SRT"),
    h("button", { class: "btn quiet small", title: "Download the transcript (.txt) with your cuts applied", onclick: () => downloadText("transcript") }, icon("download", 14), "Transcript"));

  // Captions: live overlay on the player + the style panel. Needs `editor`, `video` and `player`.
  const captionsUi = mountCaptions({
    jobId, video, player, editor, words,
    initial: data.captions,
    hasVideo: job.source?.hasVideo !== false,
    onStatus: (text, err) => setSave(text, err)
  });

  // B-roll: pictures laid over the video, planned by the AI from the words that stay. Needs `video`, `player`,
  // `flush` (the plan is made from the saved cuts) and the export dialog, which are all defined below.
  const hasVideo = job.source?.hasVideo !== false;
  const brollUi = createBroll({
    jobId, video, player, hasVideo,
    beforeAction: () => flush(),
    seek,
    onChange: () => renderExport(),
    goTranscript: () => showTab("transcript"),
    openExport: () => { renderExport(); dialog.showModal(); }
  });
  brollUi.panel.id = "pane-broll";
  brollUi.panel.hidden = true;

  const transcriptPane = h("div", { class: "pane", id: "pane-transcript" }, tx);
  const cutsPane = h("div", { class: "pane", id: "pane-cuts", hidden: true });
  const notesPane = h("div", { class: "pane", id: "pane-notes", hidden: true });
  const captionsPane = h("div", { class: "pane", id: "pane-captions", hidden: true }, captionsUi.pane);

  const tabCuts = h("span", { class: "count num" }, "0");
  const tabs = [
    ["transcript", h("button", { class: "tab", role: "tab" }, "Transcript"), transcriptPane],
    ["captions", h("button", { class: "tab", role: "tab" }, "Captions"), captionsPane],
    ["broll", h("button", { class: "tab", role: "tab" }, "B-roll"), brollUi.panel]
  ];
  let activeTab = "transcript";
  function showTab(name) {
    activeTab = name;
    for (const [key, btn, pane] of tabs) {
      btn.setAttribute("aria-selected", String(key === name));
      pane.hidden = key !== name;
    }
    toolbar.hidden = name !== "transcript";
    captionsUi.setActive(name === "captions");
    brollUi.setActive(name === "broll");
  }
  tabs.forEach(([key, btn]) => btn.addEventListener("click", () => showTab(key)));

  const sheet = h("section", { class: "sheet" },
    h("div", { class: "tabs", role: "tablist" }, tabs.map(t => t[1])),
    toolbar, transcriptPane, captionsPane, brollUi.panel);

  // ------------------------------------------------------------ top bar
  const titleInput = h("input", { class: "title-input", value: job.name, "aria-label": "Project name" });
  titleInput.addEventListener("change", async () => {
    try { await api.patchJob(jobId, { name: titleInput.value }); } catch (e) { toast(e.message, "error"); }
  });
  const saveState = h("span", { class: "save-state" }, "Saved");
  const exportBtn = h("button", { class: "btn primary" }, icon("download", 16), "Export video");
  const enhanceBtn = h("button", { class: "btn quiet small menu-item", title: "Clean up the voice with Adobe Podcast, then swap the audio" },
    icon("mic", 15), "Enhance audio");
  const apiKeysBtn = h("button", {
    class: "btn quiet small menu-item", title: "API keys (Gemini, Groq, Speechmatics)",
    onclick: () => openKeys({ onSaved: () => brollUi.refresh() })
  }, icon("key", 15), "API keys");
  // Quiet actions live in one "More" menu so Export is the only strong button in the top bar.
  const moreMenu = h("details", { class: "more-menu" },
    h("summary", { class: "btn quiet small", title: "More actions", "aria-label": "More actions" }, icon("sliders", 15), "More"),
    h("div", { class: "menu-body" }, enhanceBtn, keysBtn, apiKeysBtn));
  moreMenu.addEventListener("click", e => { if (e.target.closest(".menu-item")) moreMenu.open = false; });
  const closeMore = e => { if (moreMenu.open && !moreMenu.contains(e.target)) moreMenu.open = false; };
  const closeMoreKey = e => { if (e.key === "Escape" && moreMenu.open) { moreMenu.open = false; moreMenu.querySelector("summary").focus(); } };
  document.addEventListener("pointerdown", closeMore);
  document.addEventListener("keydown", closeMoreKey);

  const bar = topbar(
    h("a", { class: "btn quiet small", href: "#/", title: "Back to all projects" }, icon("back", 15), "Projects"),
    h("div", { class: "grow" }, titleInput),
    saveState, moreMenu, exportBtn);

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
      toggleBtn.disabled = true;
    } else {
      const count = r[1] - r[0] + 1;
      selInfo.textContent = `${count} word${count === 1 ? "" : "s"} · ${fmtClock(words[r[0]].s)}–${fmtClock(words[r[1]].e)}`;
      const restoring = editor.allCut(r[0], r[1]);
      toggleBtn.disabled = false;
      toggleBtn.title = restoring ? "Restore selection (X)" : "Cut selection (X)";
      toggleBtn.replaceChildren(icon(restoring ? "restore" : "scissors", 14), restoring ? "Restore" : "Cut");
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

  // One shortcut for both: cuts the selection, or restores it when every selected word is already cut.
  const toggleSelection = () => { const r = selRange(); if (r) editor.set(r[0], r[1], editor.allCut(r[0], r[1]) ? 0 : 1); };
  toggleBtn.addEventListener("click", () => {
    const r = selRange();
    if (r) editor.set(r[0], r[1], editor.allCut(r[0], r[1]) ? 0 : 1);
  });
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
    const all = count === s.w1 - s.w0;
    segEls[si].classList.toggle("all-cut", all);
    const label = all ? "Restore this sentence" : "Cut this sentence";
    segToggle[si].title = label;
    segToggle[si].setAttribute("aria-label", label);
    segToggle[si].replaceChildren(icon(all ? "restore" : "scissors", 14));
  }

  function paintNear() {
    for (let si = 0; si < segments.length; si++) {
      const near = (si > 0 && segHas[si - 1]) || (si < segments.length - 1 && segHas[si + 1]);
      segEls[si].classList.toggle("near-cut", near);
    }
  }

  function paintTimeline() {
    const runs = editor.cutRuns();
    track.replaceChildren(...runs.map(run => h("div", {
      class: `tl-cut ${run.source}`,
      title: `${SOURCE_LABEL[run.source]}: ${fmtClock(run.start)} – ${fmtClock(run.end)}`,
      style: { left: `${(run.start / duration) * 100}%`, width: `${((run.end - run.start) / duration) * 100}%` }
    })));
    let r = 0;
    barEls.forEach((el, k) => {
      const t = ((k + 0.5) / BINS) * duration;
      while (r < runs.length && runs[r].end < t) r++;
      const run = runs[r] && runs[r].start <= t ? runs[r] : null;
      el.className = run ? `cut ${run.source === "you" ? "you" : "ai"}` : "";
    });
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
        "No cuts yet. Select words in the transcript and press Delete to cut them."));
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
    captionsUi.paintAt(t);
    brollUi.paint(t);
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
  timeline.addEventListener("pointermove", e => {
    const rect = timeline.getBoundingClientRect();
    const f = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    hoverEl.style.left = `${f * 100}%`;
    hoverTime.textContent = fmtClock(f * duration);
  });

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
    captionsUi.saveNow(true);
  };
  window.addEventListener("beforeunload", onUnload);

  // ------------------------------------------------------------ export dialog
  const padInput = h("input", { class: "field num", type: "number", min: "0", max: "300", step: "10", value: String(Math.round((job.export?.pad ?? 0.05) * 1000)) });
  padInput.addEventListener("change", () => {
    editor.setPad(clamp(Number(padInput.value) || 0, 0, 300) / 1000);
    captionsUi.refresh();
    paintSummary(); renderExport();
  });
  // Less common export options live in one fold that keeps its open state between renders.
  const padWrap = h("div", { class: "export-pad" },
    h("label", { class: "stack" }, "Padding around each cut (ms)", padInput),
    h("p", { class: "hint" }, "A little audio is kept next to each cut so words aren't clipped."));
  const exportMore = h("details", { class: "export-more" },
    h("summary", {}, "More options"),
    h("div", { class: "export-more-body" },
      h("div", { class: "row", style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } },
        h("span", { class: "muted" }, "Updated with your cuts:"),
        h("button", { class: "btn small", onclick: () => downloadText("srt"), title: "Subtitles, cut words left out" }, icon("download", 14), "SRT"),
        h("button", { class: "btn small", onclick: () => downloadText("transcript"), title: "Transcript, cut words left out" }, icon("download", 14), "Transcript")),
      padWrap));
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

    const cap = captionsUi.summary();
    const picks = brollUi.chosenCount();
    const wantBroll = hasVideo && brollUi.include() && picks > 0;
    const line = (name, text, state) => h("li", { class: state }, h("b", {}, name), h("span", {}, text));
    const summaryList = h("ul", { class: "export-sum" },
      line("Cuts", `${fmtClock(s.finalSeconds)} final length · ${s.cuts} cut${s.cuts === 1 ? "" : "s"} · ${s.removedSeconds.toFixed(1)}s removed`, "on"),
      line("Captions",
        cap.available
          ? (cap.enabled ? `On, ${cap.count} caption${cap.count === 1 ? "" : "s"} burned into the video.` : "Off. Turn them on in the Captions tab.")
          : "Only added to videos, not audio files.",
        cap.available && cap.enabled ? "on" : "off"),
      line("B-roll",
        !hasVideo ? "Only added to videos, not audio files."
          : picks === 0 ? "No pictures chosen yet. Pick them in the B-roll tab."
          : brollUi.include()
            ? `${picks} picture${picks === 1 ? "" : "s"} over the video (${brollUi.fit() === "cover" ? "filling the frame" : "fitted inside the frame"}).`
            : "Off for this export. Switch it on in the B-roll tab.",
        wantBroll ? "on" : "off"));
    const parts = [h("h2", {}, "Export video"), summaryList];
    padWrap.hidden = ex.status === "running";
    parts.push(exportMore);

    if (ex.status === "running") {
      parts.push(h("div", { class: "progress" }, h("i", { style: { width: `${pct}%` } })),
        h("div", { class: "muted" }, `Rendering… ${pct}%`));
    } else {

      if (ex.status === "error") parts.push(h("div", { class: "error-card" }, ex.error));
      if (ex.lastError) parts.push(h("div", { class: "error-card" }, `The last render failed (${ex.lastError}). Your previous video is still below. Press Render again to retry.`));
      if (ex.status === "done" && ex.stale) parts.push(h("div", { class: "banner" }, icon("alert"), "You changed the cuts or B-roll after this render. Render again to update it."));
      else if (ex.status === "done" && ex.broll && (ex.broll.enabled !== wantBroll || (wantBroll && ex.broll.fit !== brollUi.fit()))) {
        parts.push(h("div", { class: "banner" }, icon("alert"), "The B-roll setting changed after this render. Render again to update it."));
      }
      if (ex.status === "done") {
        parts.push(h("video", { controls: true, src: `/api/jobs/${jobId}/media/final?t=${ex.finishedAt}` }),
          h("div", { class: "muted num" }, `${fmtClock(ex.duration)} · ${fmtBytes(ex.bytes)}${ex.broll?.count ? ` · ${ex.broll.count} B-roll` : ""} · saved in workspace/${jobId}/${ex.file}`));
      }
    }

    const closeBtn = h("button", { class: "btn", onclick: () => dialog.close() }, "Close");
    const renderBtn = h("button", {
      class: ex.status === "done" && !ex.stale ? "btn" : "btn primary",
      disabled: ex.status === "running" || s.finalSeconds <= 0,
      onclick: startExport
    }, ex.status === "done" ? "Render again" : "Render video");
    // An out-of-date render (old cuts, old captions) is not offered for download: render again first.
    const downloadBtn = ex.status === "done" && !ex.stale
      ? h("a", { class: "btn primary", href: `/api/jobs/${jobId}/media/final?download=1` }, icon("download", 15), "Download")
      : null;

    parts.push(h("div", { class: "foot" }, closeBtn, renderBtn, downloadBtn));
    dlgBody.replaceChildren(...parts);
  }

  // Subtitles (.srt) or transcript (.txt) of the video as it will be exported (cut words left out). Saves pending edits first.
  async function downloadText(kind) {
    try {
      await flush();
      const res = await fetch(kind === "srt" ? `/api/jobs/${jobId}/srt?kind=sentence` : `/api/jobs/${jobId}/transcript`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Could not build the file.");
      const disp = res.headers.get("Content-Disposition") || "";
      const name = /filename="?([^";]+)"?/i.exec(disp)?.[1] || `${job.name || "video"}-${kind === "srt" ? "subtitles.srt" : "transcript.txt"}`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(await res.blob()); a.download = name;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) { toast(e.message, "error", 6000); }
  }

  async function startExport() {
    try {
      await flush();
      await captionsUi.saveNow();
      await brollUi.flush();
      await api.exportJob(jobId, clamp(Number(padInput.value) || 0, 0, 300) / 1000, {
        broll: hasVideo && brollUi.include() && brollUi.chosenCount() > 0,
        brollFit: brollUi.fit()
      });
    } catch (error) {
      toast(error.message, "error", 6000);
    }
  }

  exportBtn.addEventListener("click", () => { renderExport(); dialog.showModal(); });

  // ------------------------------------------------------------ Adobe Podcast: enhance the audio
  const ADOBE_URL = "https://podcast.adobe.com/en/enhance";
  const enhBody = h("div", { class: "dlg" });
  const enhDialog = h("dialog", {}, enhBody);
  document.body.append(enhDialog);
  let enh = { busy: "", progress: 0 };

  function reloadVideo() {
    const t = video.currentTime;
    video.pause();
    video.addEventListener("loadedmetadata", () => { video.currentTime = Math.min(t, duration); }, { once: true });
    video.src = `/api/jobs/${jobId}/media/base?v=${Date.now()}`;
    video.load();
  }

  async function downloadMp3() {
    enh = { busy: "mp3", progress: 0 }; renderEnhance();
    try {
      await flush();
      const res = await fetch(`/api/jobs/${jobId}/enhance/mp3`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Could not make the MP3.");
      const name = /filename="?([^";]+)"?/i.exec(res.headers.get("Content-Disposition") || "")?.[1] || `${job.name || "video"}-for-adobe.mp3`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(await res.blob()); a.download = name;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast("MP3 downloaded. Now open Adobe Podcast and enhance it.");
    } catch (e) { toast(e.message, "error", 6000); }
    enh = { busy: "", progress: 0 }; renderEnhance();
  }

  async function swapAudio(file) {
    if (!file) return;
    enh = { busy: "upload", progress: 0 }; renderEnhance();
    try {
      job = await api.enhanceUpload(jobId, file, p => { enh.progress = p; renderEnhance(); });
      reloadVideo();
      renderExport();
      toast("Audio replaced with the enhanced version.", "success");
    } catch (e) { toast(e.message, "error", 7000); }
    enh = { busy: "", progress: 0 }; renderEnhance();
  }

  async function useOriginalAudio() {
    enh = { busy: "revert", progress: 0 }; renderEnhance();
    try {
      job = await api.enhanceRevert(jobId);
      reloadVideo();
      renderExport();
      toast("Original audio restored.");
    } catch (e) { toast(e.message, "error", 6000); }
    enh = { busy: "", progress: 0 }; renderEnhance();
  }

  function renderEnhance() {
    const working = Boolean(enh.busy);
    const drop = h("div", { class: "cap-drop", tabindex: "0", role: "button", "aria-label": "Choose the enhanced audio file" },
      enh.busy === "upload"
        ? [h("strong", {}, `Replacing audio… ${Math.round(enh.progress * 100)}%`)]
        : [h("strong", {}, "Drop the enhanced file here"), h("span", { class: "hint" }, "or click to browse · MP3, WAV or M4A from Adobe")]);
    const input = h("input", { type: "file", accept: "audio/*,video/*,.mp3,.wav,.m4a", hidden: true });
    input.addEventListener("change", () => { swapAudio(input.files[0]); input.value = ""; });
    if (!working) {
      drop.addEventListener("click", () => input.click());
      drop.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
      drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
      drop.addEventListener("dragleave", () => drop.classList.remove("over"));
      drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); swapAudio(e.dataTransfer.files[0]); });
    }

    const step = (n, title, body) => h("div", { class: "enh-step" }, h("b", { class: "num" }, String(n)), h("div", {}, h("strong", {}, title), body));

    enhBody.replaceChildren(
      h("h2", {}, icon("mic", 20), "Enhance audio with Adobe Podcast"),
      h("p", { class: "hint", style: { margin: 0 } }, "Your cuts, captions and B-roll stay exactly as they are. Only the sound is swapped."),
      job.enhanced ? h("div", { class: "banner" }, icon("check"),
        `Enhanced audio is in use (${job.enhanced.originalName}).`,
        h("button", { class: "btn small", disabled: working, onclick: useOriginalAudio }, icon("restore", 14), "Use original audio")) : null,
      step(1, "Download the audio as MP3", h("div", { class: "row" },
        h("button", { class: "btn", disabled: working, onclick: downloadMp3 },
          icon("download", 15), enh.busy === "mp3" ? "Preparing MP3…" : "Download MP3"))),
      step(2, "Enhance it on Adobe Podcast", h("div", { class: "row" },
        h("button", { class: "btn primary", disabled: working, onclick: () => window.open(ADOBE_URL, "_blank", "noopener") },
          icon("external", 15), "Open Adobe Podcast"),
        h("span", { class: "hint" }, "Upload the MP3 there, enhance, then download the result."))),
      step(3, "Drop the enhanced file back here", drop),
      input,
      h("div", { class: "foot" }, h("button", { class: "btn", onclick: () => enhDialog.close() }, "Close")));
  }
  enhanceBtn.addEventListener("click", () => { renderEnhance(); enhDialog.showModal(); });

  // ------------------------------------------------------------ shortcuts
  const keysDialog = h("dialog", {}, h("div", { class: "dlg" },
    h("h2", {}, "Keyboard shortcuts"),
    h("dl", { class: "keys" },
      h("dt", {}, h("kbd", {}, "Space")), h("dd", {}, "Play / pause"),
      h("dt", {}, h("kbd", {}, "←"), " ", h("kbd", {}, "→")), h("dd", {}, "Move the selection by one word (Shift extends it)"),
      h("dt", {}, h("kbd", {}, "↑"), " ", h("kbd", {}, "↓")), h("dd", {}, "Previous / next sentence"),
      h("dt", {}, h("kbd", {}, "X"), " / ", h("kbd", {}, "Delete")), h("dd", {}, "Cut the selection, or restore it if it is already cut"),
      h("dt", {}, h("kbd", {}, "N"), " / ", h("kbd", {}, "P")), h("dd", {}, "Hear the next / previous cut with context"),
      h("dt", {}, h("kbd", {}, "Ctrl"), "+", h("kbd", {}, "Z")), h("dd", {}, "Undo (add Shift to redo)"),
      h("dt", {}, "Double-click"), h("dd", {}, "Toggle a single word")),
    h("div", { class: "foot" }, h("button", { class: "btn", onclick: () => keysDialog.close() }, "Close"))));
  document.body.append(keysDialog);
  keysBtn.addEventListener("click", () => keysDialog.showModal());

  function onKey(e) {
    if (dialog.open || keysDialog.open || enhDialog.open) return;
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? editor.redo() : editor.undo(); return; }
    if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); editor.redo(); return; }
    if (mod || e.altKey) return;

    const onButton = tag === "BUTTON" || tag === "A" || tag === "SUMMARY";
    if (e.key === " " && !onButton) { e.preventDefault(); togglePlay(); return; }
    if (activeTab !== "transcript") return;

    switch (e.key) {
      case "Delete": case "Backspace": case "x": case "X": e.preventDefault(); toggleSelection(); break;
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
      captionsUi.saveNow(true);
      captionsUi.destroy();
      brollUi.flush();
      brollUi.destroy();
      cancelAnimationFrame(raf);
      video.pause();
      video.removeAttribute("src");
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", closeMore);
      document.removeEventListener("keydown", closeMoreKey);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("beforeunload", onUnload);
      dialog.remove();
      keysDialog.remove();
      enhDialog.remove();
    }
  };
}
