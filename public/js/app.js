import { api } from "./api.js";
import { h, toast } from "./dom.js";
import { mountHome, topbar } from "./home.js";
import { mountProcessing } from "./processing.js";
import { mountReview } from "./review.js";

const root = document.getElementById("app");

let view = null;        // { update(job), destroy?() }
let stopWatching = null;
let token = 0;          // guards against out-of-order async mounts

function teardown() {
  stopWatching?.(); stopWatching = null;
  view?.destroy?.(); view = null;
}

async function route() {
  const mine = ++token;
  const [, kind, id, mode] = location.hash.replace(/^#\/?/, "#/").match(/^#\/(?:(p)\/([a-f0-9]{12})(?:\/(edit|progress))?)?$/) || [];
  teardown();

  try {
    if (kind !== "p") {
      await mountHome(root);
      return;
    }

    const job = await api.job(id);
    if (mine !== token) return;

    const wantEditor = mode === "edit" || (job.state === "review" && mode !== "progress");
    if (wantEditor && job.base) {
      view = await mountReview(root, id, { topbar });
    } else {
      view = mountProcessing(root, job);
    }
    if (mine !== token) { teardown(); return; }

    stopWatching = api.watch(id, next => {
      view?.update(next);

      // The AI review was started from the editor: show progress.
      if (view?.destroy && next.state === "running") {
        location.hash = `#/p/${id}/progress`;
      }
    });
  } catch (error) {
    if (mine !== token) return;
    root.replaceChildren(topbar(), h("div", { class: "page" }, h("div", { class: "process" },
      h("h1", {}, "Couldn't open this"),
      h("div", { class: "error-card" }, error.message),
      h("a", { class: "btn", href: "#/" }, "Back to projects"))));
    toast(error.message, "error");
  }
}

window.addEventListener("hashchange", route);
route();
