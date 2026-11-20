import { h, icon, toast, fmtBytes, fmtDate, brandMark } from "./dom.js";
import { api } from "./api.js";
import { fmtClock } from "/shared/editModel.js";
import { DESKS, getTheme, setTheme, getDesk, setDesk } from "./theme.js";

export function topbar(...extra) {
  return h("header", { class: "topbar" },
    h("a", { class: "brand", href: "#/" }, brandMark(30), "The Silent Shears"),
    ...extra
  );
}

const STATE_LABEL = {
  created: ["Not started", ""],
  running: ["Processing", "run"],
  review: ["Ready to review", "ok"],
  error: ["Needs attention", "err"]
};

export async function mountHome(root) {
  const [config, inputs, jobs] = await Promise.all([api.config(), api.inputs(), api.jobs()]);

  let file = null;          // File chosen in the browser
  let inputName = null;     // or a file from the input/ folder
  let busy = false;

  const fileInput = h("input", { type: "file", hidden: true, accept: config.extensions.join(",") + ",video/*,audio/*" });
  const dropBody = h("div", {});
  const drop = h("div", { class: "drop", tabindex: "0", role: "button", "aria-label": "Choose a video or audio file" }, dropBody);
  const startBtn = h("button", { class: "btn primary big", disabled: true }, icon("sparkles", 18), "Start cutting");
  const startLabel = h("span", { class: "hint" }, "");
  const bar = h("div", { class: "progress", hidden: true }, h("i", {}));

  function renderDrop() {
    dropBody.replaceChildren(
      ...(file || inputName
        ? [h("span", { class: "file-chip" }, icon("film"), file ? file.name : inputName,
            h("span", { class: "muted" }, file ? fmtBytes(file.size) : ""))
          , h("span", { class: "hint" }, "Click to choose a different file")]
        : [h("span", { class: "drop-ico" }, icon("upload", 28)), h("strong", {}, "Drop your recording here"), h("span", {}, "or click to browse your files"), h("span", { class: "hint" }, "Works with MP4, MOV, MKV, WebM, MP3, WAV and M4A")])
    );
    startBtn.disabled = busy || !(file || inputName);
    inputChips.forEach(([name, chip]) => chip.setAttribute("aria-pressed", String(name === inputName)));
  }

  function choose(f) { file = f; inputName = null; renderDrop(); }

  drop.addEventListener("click", () => fileInput.click());
  drop.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener("change", () => fileInput.files[0] && choose(fileInput.files[0]));
  drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", e => {
    e.preventDefault(); drop.classList.remove("over");
    if (e.dataTransfer.files[0]) choose(e.dataTransfer.files[0]);
  });

  const inputChips = inputs.map(f => [f.name, h("button", {
    class: "chip", "aria-pressed": "false", title: fmtBytes(f.size),
    onclick: () => { inputName = f.name; file = null; renderDrop(); }
  }, f.name)]);

  // options
  // Fixed defaults (the old switches were removed from the start page): long silences are trimmed, language is English.
  const TRIM = { trimPauses: true, maxPause: 0.6, padding: 0.08, language: "en" };
  // Shown only when there is no Groq key and Groq is the chosen cut AI.
  const keyBanner = h("div", { class: "banner" }, icon("alert"),
    h("span", {}, "No ", h("code", {}, "GROQ_API_KEY"), " found. You can still cut by hand, but nothing will be marked automatically."));
  // One main AI for everything (cuts + B-roll): Claude (claude.ai in Chrome, no key) or Groq (API key). Claude is the default.
  let mainAi = "claude";
  try { if (localStorage.getItem("mainAi") === "groq") mainAi = "groq"; } catch { /* storage may be blocked */ }
  const mainHint = h("p", { class: "hint ai-hint" });
  const launchBtn = h("button", { type: "button", class: "btn", onclick: async () => {
    try {
      await api.brollGlobalPost("chrome", { claude: true });
      launchBtn.textContent = "Starting…";
      setTimeout(() => { launchBtn.textContent = "Launch Chrome"; }, 4000);
    } catch (e) { toast(e.message, "error"); }
  } }, "Launch Chrome");
  const mainBtns = ["claude", "groq"].map(id => h("button", { type: "button", class: "seg-btn", dataset: { main: id },
    onclick: () => { mainAi = id; try { localStorage.setItem("mainAi", id); } catch { /* ignore */ } paintMain(); } }, id === "groq" ? "Groq" : "Claude"));
  function paintMain() {
    mainBtns.forEach(b => b.classList.toggle("on", b.dataset.main === mainAi));
    const claude = mainAi === "claude";
    mainHint.textContent = claude
      ? "Uses your claude.ai chat in Chrome (no API key). Launch Chrome, sign in to claude.ai once, then press Start."
      : config.groq ? `Uses your Groq API key (${config.groqModel}).` : "Uses your Groq API key. GROQ_API_KEY is not set yet.";
    launchBtn.hidden = !claude;
    keyBanner.hidden = claude || config.groq;
  }
  paintMain();
  const aiPick = h("div", { class: "ai-pick" }, h("strong", {}, "Main AI"), h("span", { class: "seg" }, mainBtns), mainHint, launchBtn);
  // Speech model: Enhanced (best for one language, e.g. English) or Melia 1 (Hindi / mixed languages). Remembered.
  let asrModel = "enhanced";
  try { if (localStorage.getItem("asrModel") === "melia-1") asrModel = "melia-1"; } catch { /* storage may be blocked */ }
  const asrHint = h("p", { class: "hint ai-hint" });
  const ASR = [["enhanced", "Enhanced"], ["melia-1", "Melia 1 (Hindi)"]];
  const asrBtns = ASR.map(([id, label]) => h("button", { type: "button", class: "seg-btn", dataset: { asr: id },
    onclick: () => { asrModel = id; try { localStorage.setItem("asrModel", id); } catch { /* ignore */ } paintAsr(); } }, label));
  function paintAsr() {
    asrBtns.forEach(b => b.classList.toggle("on", b.dataset.asr === asrModel));
    asrHint.textContent = asrModel === "melia-1"
      ? "Made for Hindi and mixed Hindi and English."
      : "Best accuracy for one language, English by default.";
  }
  const asrPick = h("div", { class: "ai-pick" }, h("strong", {}, "Transcription model"), h("span", { class: "seg" }, asrBtns), asrHint);
  // Look of the app: the soft dark theme or the retro old-computer theme (with a choice of desktop colour).
  let theme = getTheme();
  const themeHint = h("p", { class: "hint ai-hint" });
  const themeBtns = [["dark", "Soft dark"], ["retro", "Retro computer"]].map(([id, label]) => h("button", { type: "button", class: "seg-btn", dataset: { theme: id },
    onclick: () => { theme = id; setTheme(id); paintTheme(); } }, label));
  const deskBtns = DESKS.map(([id, label, color]) => h("button", { type: "button", class: "desk-swatch", title: `${label} desktop`, "aria-label": `${label} desktop`, dataset: { desk: id },
    style: { background: color, width: "28px", height: "28px", border: "2px solid currentColor", padding: "0", cursor: "pointer" },
    onclick: () => { setDesk(id); paintTheme(); } }));
  const deskRow = h("span", { class: "desk-row", style: { display: "inline-flex", alignItems: "center", gap: "8px" } }, h("span", { class: "hint" }, "Desktop"), ...deskBtns);
  function paintTheme() {
    themeBtns.forEach(b => b.classList.toggle("on", b.dataset.theme === theme));
    deskBtns.forEach(b => b.setAttribute("aria-pressed", String(b.dataset.desk === getDesk())));
    deskRow.hidden = theme !== "retro";
    themeHint.textContent = theme === "retro"
      ? "An old-computer look: cream windows, pixel type and a CRT monitor frame."
      : "The soft dark look.";
  }
  paintTheme();
  const themePick = h("div", { class: "ai-pick" }, h("strong", {}, "Theme"), h("span", { class: "seg" }, themeBtns), deskRow, themeHint);
  const options = h("details", { class: "options" },
    h("summary", {}, icon("sliders", 18), "Settings", h("small", {}, "Optional. The defaults work well.")),
    h("div", { class: "opt-body" },
      themePick,
      asrPick,
      aiPick));
  paintAsr();

  startBtn.addEventListener("click", async () => {
    busy = true; startBtn.disabled = true; bar.hidden = false;
    const settings = {
      trimPauses: TRIM.trimPauses,
      maxPause: TRIM.maxPause,
      padding: TRIM.padding,
      language: TRIM.language,
      asrModel,
      useAi: mainAi === "claude" || config.groq,   // the AI step is always on when the main AI can run
      doSrt: true, // always on: the .srt is offered for download when everything is done
      brollAi: mainAi,
      cutAi: mainAi,
      doBroll: config.groq || config.gemini || mainAi === "claude"
    };
    try {
      startLabel.textContent = "Creating project…";
      const job = await api.createJob({ name: "", settings, fromInput: inputName || undefined });
      if (file) {
        startLabel.textContent = "Uploading…";
        await api.upload(job.id, file, p => { bar.firstChild.style.width = `${Math.round(p * 100)}%`; });
      }
      await api.run(job.id);
      location.hash = `#/p/${job.id}`;
    } catch (error) {
      toast(error.message, "error", 7000);
      busy = false; bar.hidden = true; startLabel.textContent = "";
      renderDrop();
    }
  });

  const warnings = [];
  if (!config.speechmatics) warnings.push(h("div", { class: "banner" }, icon("alert"),
    h("span", {}, "Add ", h("code", {}, "SPEECHMATICS_API_KEY"), " to your .env file and restart, or transcription will fail.")));
  if (!config.groq) warnings.push(keyBanner);

  const list = jobs.length
    ? h("div", { class: "project-list" }, jobs.map(job => {
        const [label, kind] = STATE_LABEL[job.state] || ["", ""];
        return h("div", {
          class: "project", tabindex: "0", role: "link",
          onclick: () => { location.hash = `#/p/${job.id}`; },
          onkeydown: e => { if (e.key === "Enter") location.hash = `#/p/${job.id}`; }
        },
          h("span", { class: "thumb" }, icon("film", 20)),
          h("span", { class: "name" }, job.name),
          h("span", { class: "sub num" },
            [job.source?.duration ? fmtClock(job.source.duration, 0) : null, fmtDate(job.updatedAt)].filter(Boolean).join(" · "),
            h("span", { class: `badge ${kind}` }, label)),
          h("span", { class: "side" },
            h("span", { class: "btn small project-open", "aria-hidden": "true" }, job.state === "review" ? "Open" : "View"),
            h("button", {
              class: "btn quiet small square", title: "Delete project", "aria-label": `Delete ${job.name}`,
              onclick: async e => {
                e.stopPropagation();
                if (!confirm(`Delete "${job.name}" and its files?`)) return;
                try { await api.deleteJob(job.id); mountHome(root); } catch (err) { toast(err.message, "error"); }
              }
            }, icon("trash")))
        );
      }))
    : h("div", { class: "empty" }, icon("folder", 26), h("b", {}, "No projects yet"), h("span", {}, "Drop in your first recording and it will show up here."));

  const how = [
    ["upload", "Add a recording", "Any video or audio file."],
    ["sparkles", "AI finds retakes", "It marks stumbles and repeats."],
    ["eye", "You decide", "Keep or cut each one."],
    ["download", "Export", "Download the clean video."]
  ];

  root.replaceChildren(
    topbar(),
    h("div", { class: "page" }, h("div", { class: "home" },
      h("section", { class: "hero" },
        h("h1", {}, "Keep the best take, ", h("span", {}, "lose the rest.")),
        h("p", { class: "lede" }, "Drop in a raw recording. The AI marks the retakes and stumbles, you check each cut, and you export a clean video.")),
      h("ol", { class: "how" }, how.map(([ic, title, text]) =>
        h("li", {}, h("span", { class: "ico" }, icon(ic, 20)), h("div", {}, h("b", {}, title), h("span", { class: "t" }, text))))),
      h("div", { class: "home-grid" },
        h("section", { class: "card" },
          h("div", { class: "card-head" }, h("h2", {}, "New project")),
          ...warnings,
          drop, fileInput,
          inputs.length ? h("div", { class: "inputs" }, h("span", { class: "hint" }, "Or pick from the input folder:"), inputChips.map(c => c[1])) : null,
          options,
          h("div", { class: "start-row" }, startBtn, bar, startLabel)),
        h("section", { class: "card" },
          h("div", { class: "card-head" }, h("h2", {}, "Your projects"), h("span", { class: "count" }, jobs.length ? `${jobs.length} total` : "")),
          list))
    ))
  );
  renderDrop();
}
