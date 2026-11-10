import { h, icon, toast } from "./dom.js";
import { api } from "./api.js";
import { topbar } from "./home.js";

const STEPS = [
  ["audio", "Extract audio", "Pull the sound out of your recording."],
  ["transcribe", "Transcribe", "Speechmatics turns speech into timed words."],
  ["trim", "Remove long silences", "Shorten dead air between sentences."],
  ["ai", "AI retake review", "Groq marks false starts, stutters and repeated takes."]
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
    sub.textContent = job.state === "running" ? "Working on it. You can leave this page and come back."
      : job.state === "error" ? "Something stopped the process."
      : "Waiting to start.";

    list.replaceChildren(...STEPS.map(([key, label, blurb]) => {
      const step = job.steps[key];
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
      if (job.state === "review") location.hash = `#/p/${job.id}/edit`;
    }
  };
}
