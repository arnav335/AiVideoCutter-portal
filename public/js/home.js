import { h, icon, toast, fmtBytes, fmtDate } from "./dom.js";
import { api } from "./api.js";
import { fmtClock } from "/shared/editModel.js";

export function topbar(...extra) {
  return h("header", { class: "topbar" },
    h("a", { class: "brand", href: "#/" }, h("span", { class: "brand-mark" }), "AiVideoCutter"),
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
  const startBtn = h("button", { class: "btn primary", disabled: true }, "Process recording");
  const startLabel = h("span", { class: "hint" }, "");
  const bar = h("div", { class: "progress", hidden: true }, h("i", {}));

  function renderDrop() {
    dropBody.replaceChildren(
      ...(file || inputName
        ? [h("span", { class: "file-chip" }, icon("film"), file ? file.name : inputName,
            h("span", { class: "muted" }, file ? fmtBytes(file.size) : ""))
          , h("span", { class: "hint" }, "Click to choose a different file")]
        : [icon("film", 30), h("strong", {}, "Drop a recording here"), h("span", {}, "or click to browse · MP4, MOV, MKV, WebM, MP3, WAV, M4A")])
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
  const trimOn = h("input", { type: "checkbox", class: "switch", checked: true });
  const maxPause = h("input", { class: "field num", type: "number", min: "0.1", max: "5", step: "0.1", value: "0.6" });
  const padding = h("input", { class: "field num", type: "number", min: "0", max: "0.5", step: "0.01", value: "0.08" });
  const language = h("input", { class: "field", value: "en", maxlength: "6" });
  const aiOn = h("input", { type: "checkbox", class: "switch", checked: config.groq, disabled: !config.groq });
  const options = h("div", { class: "options" },
    h("label", { class: "switch-row" }, trimOn, "Remove long silences first"),
    h("div", { class: "row" },
      h("label", { class: "stack" }, "Longest pause kept (s)", maxPause),
      h("label", { class: "stack" }, "Padding (s)", padding),
      h("label", { class: "stack" }, "Spoken language", language)),
    h("label", { class: "switch-row" }, aiOn,
      config.groq ? `AI marks the retakes (${config.groqModel})` : "AI marks the retakes (needs GROQ_API_KEY)")
  );
  trimOn.addEventListener("change", () => {
    maxPause.disabled = padding.disabled = !trimOn.checked;
  });

  startBtn.addEventListener("click", async () => {
    busy = true; startBtn.disabled = true; bar.hidden = false;
    const settings = {
      trimPauses: trimOn.checked,
      maxPause: Number(maxPause.value) || 0.6,
      padding: Number(padding.value) || 0,
      language: language.value.trim() || "en",
      useAi: aiOn.checked
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
  if (!config.groq) warnings.push(h("div", { class: "banner" }, icon("alert"),
    h("span", {}, "No ", h("code", {}, "GROQ_API_KEY"), " found. You can still cut by hand, but nothing will be marked automatically.")));

  const list = jobs.length
    ? h("div", { class: "project-list" }, jobs.map(job => {
        const [label, kind] = STATE_LABEL[job.state] || ["", ""];
        return h("div", {
          class: "project", tabindex: "0", role: "link",
          onclick: () => { location.hash = `#/p/${job.id}`; },
          onkeydown: e => { if (e.key === "Enter") location.hash = `#/p/${job.id}`; }
        },
          h("span", { class: "name" }, job.name),
          h("span", { class: "sub num" },
            [job.source?.duration ? fmtClock(job.source.duration, 0) : null, fmtDate(job.updatedAt)].filter(Boolean).join(" · ")),
          h("span", { class: "side" },
            h("span", { class: `badge ${kind}` }, label),
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
    : h("div", { class: "empty" }, "No projects yet. Your first one will show up here.");

  root.replaceChildren(
    topbar(),
    h("div", { class: "page" }, h("div", { class: "home" },
      h("section", {},
        h("h1", {}, "Keep the best take."),
        h("p", { class: "lede" }, "Drop in a raw recording. The AI marks the retakes and stumbles, you review every cut, then export the trimmed video."),
        ...warnings,
        drop, fileInput,
        inputs.length ? h("div", { class: "inputs" }, h("span", { class: "hint" }, "From the input folder:"), inputChips.map(c => c[1])) : null,
        options,
        h("div", { style: { display: "flex", gap: "12px", alignItems: "center", marginTop: "16px" } }, startBtn, startLabel),
        h("div", { style: { marginTop: "10px" } }, bar)
      ),
      h("section", {}, h("h2", {}, "Projects"), list)
    ))
  );
  renderDrop();
}
