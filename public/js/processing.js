import { h, icon, toast } from "./dom.js";
import { api } from "./api.js";
import { topbar } from "./home.js";

const STEPS = [
  ["audio", "Extract audio", "Pull the sound out of your recording."],
  ["transcribe", "Transcribe", "Speechmatics turns speech into timed words."],
  ["trim", "Remove long silences", "Shorten dead air between sentences."],
  ["ai", "AI retake review", "Groq marks false starts, stutters and repeated takes."],
  ["srt", "Subtitle file (.srt)", "Builds subtitles from the words that stay in the video."],
  ["broll", "B-roll", "Plans the pictures and writes their prompts."]
];

export function mountProcessing(root, initialJob) {
  const list = h("ol", { class: "steps" });
  const title = h("h1", {});
  const sub = h("p", { class: "muted", style: { margin: 0 } });
  const errorBox = h("div", {});
  const actions = h("div", { class: "actions" });

  root.replaceChildren(
    topbar(),
    h("div", { class: "page" }, h("div", { class: "process" }, title, sub, list, errorBox, actions))
  );

  function render(job) {
    title.textContent = job.name;
    sub.textContent = job.state === "running" ? "Working on it. You can leave this page and come back later."
      : job.state === "error" ? "Something went wrong. You can try this step again."
      : "Ready when you are.";

    list.replaceChildren(...STEPS.map(([key, label, defaultBlurb]) => {
      const blurb = key === "ai" && job.settings?.cutAi === "claude"
        ? "Claude (claude.ai) marks false starts, stutters and repeated takes."
        : defaultBlurb;
      const step = job.steps[key] || { status: "skipped", message: "Not part of this project's run." };
      const mark = step.status === "done" ? icon("check", 14)
        : step.status === "error" ? icon("close", 14)
        : step.status === "running" ? h("span", { class: "spin" })
        : step.status === "skipped" ? "–" : "";
      return h("li", { class: `step ${step.status}` },
        h("span", { class: "mark" }, mark),
        h("div", {},
          h("div", { class: "label" }, label),
          h("div", { class: "detail" }, step.message || (step.status === "pending" || step.status === "running" ? blurb : "")),
          step.progress != null
            ? h("div", { class: "progress" }, h("i", { style: { width: `${Math.round(step.progress * 100)}%` } }))
            : null));
    }));

    errorBox.replaceChildren();
    actions.replaceChildren();

    if (job.state === "running") {
      const current = Object.entries(job.steps).find(([, s]) => s.status === "running")?.[0];
      const canSkip = ["ai", "srt", "broll"].includes(current);
      if (canSkip) {
        actions.append(h("button", {
          class: "btn", title: "Abandon this step and carry on with the next one",
          onclick: async () => { try { await api.skip(job.id); } catch (e) { toast(e.message, "error"); } }
        }, "Skip this step"));
      }
      actions.append(h("button", {
        class: "btn quiet", title: canSkip ? "Stop now; the remaining steps are skipped" : "Stops as soon as this step finishes",
        onclick: async () => {
          try { const r = await api.cancel(job.id); toast(r.immediate ? "Stopped." : "Stopping after this step…"); }
          catch (e) { toast(e.message, "error"); }
        }
      }, "Stop"));
    }
    if (job.steps.srt?.status === "done") {
      actions.append(
        h("a", { class: "btn", href: `/api/jobs/${job.id}/srt?kind=sentence`, download: "" }, "Download .srt"),
        h("a", { class: "btn", href: `/api/jobs/${job.id}/transcript`, download: "" }, "Download transcript"));
    }

    if (job.state === "error" && job.error) {
      errorBox.append(h("div", { class: "error-card" }, job.error.message));
      const from = job.error.step || "audio";
      actions.append(h("button", {
        class: "btn primary",
        onclick: async () => {
          try { await api.run(job.id, { from }); } catch (e) { toast(e.message, "error"); }
        }
      }, "Try again"));
    }
    if (job.base) {
      actions.append(h("button", {
        class: "btn", onclick: () => { location.hash = `#/p/${job.id}/edit`; }
      }, "Open editor"));
    }
    if (!job.source) {
      errorBox.append(h("div", { class: "error-card" }, "This project has no video attached."));
    }
    actions.append(h("a", { class: "btn quiet", href: "#/" }, "All projects"));
  }

  render(initialJob);

  return {
    update(job) {
      render(job);
      // Only transcription / subtitles requested: stay here so the downloads are in front of you.
      const justText = job.settings?.useAi === false && job.settings?.doBroll === false;
      if (job.state === "review" && !justText) location.hash = `#/p/${job.id}/edit`;
    }
  };
}
