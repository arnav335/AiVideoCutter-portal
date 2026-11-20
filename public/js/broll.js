import { h, toast } from "./dom.js";
import { api } from "./api.js";
import { openKeys } from "./keys.js";

// ------------------------------------------------------------------ helpers
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAX_REF_MB = 10;
const STEP_TEXT = { idle: "Not started", running: "Working…", done: "Done", failed: "Failed" };
const JOB_TEXT = { queued: "Queued", running: "Running", done: "Done", partial: "Finished with errors", stopped: "Stopped", limit: "Daily limit reached", failed: "Failed" };
const ITEM_TEXT = { pending: "Waiting", running: "Generating…", done: "Done", failed: "Failed" };

function fmtT(sec) {
  const ms = Math.round(sec * 1000), hh = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
  const mm = hh ? String(m).padStart(2, "0") : String(m);
  return `${hh ? hh + ":" : ""}${mm}:${String(s).padStart(2, "0")}.${String(r).padStart(3, "0")}`;
}
function parseT(str) {
  const t = String(str).trim().replace(",", ".");
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
}
const dur = s => { const m = Math.floor(s / 60); return m ? `${m} min ${Math.round(s % 60)} s` : `${s.toFixed(1)} s`; };
const running = P => !!P && (Object.values(P.steps).some(s => s.status === "running") || (P.flowJob && ["running", "queued"].includes(P.flowJob.status)));
const logText = P => P.log.slice(-40).join("\n");
const readFile = f => new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = () => no(new Error(`Could not read ${f.name}`)); fr.readAsDataURL(f); });

const TEMPLATE = `
<div class="bsub" role="tablist">
  <button class="bsub-btn" data-sub="plan" role="tab">1 · Plan <i class="bdot" id="dot-plan"></i></button>
  <button class="bsub-btn" data-sub="prompts" role="tab">2 · Prompts <i class="bdot" id="dot-prompts"></i></button>
  <button class="bsub-btn" data-sub="images" role="tab">3 · Images <i class="bdot" id="dot-images"></i></button>
  <button class="bsub-btn" data-sub="clips" role="tab">4 · Clips <i class="bdot" id="dot-clips"></i></button>
</div>

<details class="bsetup" id="b-setup">
  <summary class="bsetup-sum">
    <strong>Setup</strong>
    <span id="b-setup-line" class="bsetup-line"></span>
    <span class="bsetup-change">Change</span>
  </summary>
  <div class="bsetup-body">
    <div class="brow">
      <label class="bfield">AI <select id="b-provider"></select></label>
      <span id="b-ai-line" class="bsmall"></span>
      <button id="b-add-key" class="btn small" hidden>Add key</button>
    </div>
    <div id="b-claude-box" class="brow bclaude" hidden>
      <span class="bsmall">Claude chat: <a id="b-claude-link" target="_blank" rel="noopener"></a><span id="b-claude-none">no chat yet, the first message opens a new one</span></span>
      <input id="b-claude-url" class="bfield-in" placeholder="Paste another claude.ai chat link" spellcheck="false">
      <button id="b-claude-use" class="btn small">Use this chat</button>
      <button id="b-claude-new" class="btn small">Start a new chat</button>
      <span class="bsmall">Sign in to claude.ai in the Launch Chrome window once.</span>
    </div>
    <div class="bcard" id="b-chrome-card" hidden>
      <div class="bhead"><h3>Connect Chrome</h3><span class="bpills"><span id="pill-chrome" class="bpill"></span><span id="pill-claude" class="bpill" hidden></span><span id="pill-usage" class="bpill"></span></span></div>
      <p class="bhint" id="b-chrome-hint">Pick the Chrome profile you are signed in with (Google, claude.ai).</p>
      <div class="bprofiles" id="b-profiles"></div>
      <p class="bsmall" id="b-profile-note"></p>
      <div class="brow">
        <button id="b-launch" class="btn primary">Launch Chrome</button>
        <button id="b-test-claude" class="btn" title="Checks that claude.ai is open and signed in, in the connected Chrome">Test Claude</button>
        <button id="b-inspect" class="btn b-images-only">Inspect Flow page</button>
        <button id="b-usage" class="blink b-images-only" title="Use this if the daily count is out of sync with Flow">Fix today's count</button>
      </div>
      <p class="bsmall" id="b-claude-test"></p>
      <pre id="b-inspect-out" class="bout" hidden></pre>
    </div>
  </div>
</details>

<div class="bcard blook" id="b-look">
  <div class="bhead"><h3>Picture look</h3></div>
  <div class="brow blook-main">
    <label class="bcheck" title="Show the pictures in the preview and put them in the exported video"><input type="checkbox" id="b-include" class="switch"> Show in video</label>
    <label class="bcheck" title="Removes the flat green around the dark UI cards (preview, video export and Premiere). The original pictures are never changed."><input type="checkbox" id="b-key" class="switch"> Ultra Key</label>
    <span class="bseg" id="b-fit" role="group" aria-label="How images fill the frame">
      <button class="btn small" data-fit="cover" title="Fill the whole frame, cropping the edges">Fill frame</button>
      <button class="btn small" data-fit="contain" title="Fit the whole image inside; the sides stay transparent">Fit inside</button>
    </span>
  </div>
  <details class="bfold" id="b-look-more">
    <summary>Position and corners</summary>
    <div class="bfold-body">
      <div class="brow bplace" id="b-place">
        <strong>Position</strong>
        <span class="bseg" id="b-scope" role="group" aria-label="What the position controls change">
          <button class="btn small" data-scope="all" title="Changes apply to every B-roll at once (the parent)">All B-rolls</button>
          <button class="btn small" data-scope="clip" title="Changes apply only to the B-roll under the playhead, on top of the All setting">This B-roll only</button>
        </span>
        <label class="bfield">Size <input type="range" id="b-size" min="10" max="250" value="100" disabled></label>
        <details class="bmore">
          <summary class="btn small">More</summary>
          <div class="bmore-body">
            <button class="btn small" id="b-pos-reset" disabled>Reset</button>
            <button class="btn small" id="b-pos-clear" disabled title="Remove every individual change so all B-rolls follow the All setting again">Clear individual changes</button>
            <button class="btn small" id="b-pos-all" disabled title="Make this B-roll's position and size the one every B-roll follows">Use as default for all</button>
          </div>
        </details>
      </div>
      <p id="b-place-hint" class="bsmall">Move the playhead onto a B-roll picture, then drag it on the preview.</p>
      <div class="brow bplace" id="b-round-row">
        <strong>Corners</strong>
        <label class="bfield">Roundness <input type="range" id="b-round" min="0" max="50" step="0.5" value="6" disabled> <output id="b-round-val">6%</output></label>
        <button class="btn small" id="b-round-reset" disabled>Default</button>
      </div>
      <p id="b-round-hint" class="bsmall">Rounded corners for scenes, logos and people.</p>
    </div>
  </details>
</div>

<section class="bsec" data-sec="plan">
  <div class="bcard">
    <div class="bhead"><h3>Plan the B-roll</h3><span id="chip-plan" class="bchip"></span></div>
    <p class="bhint">The AI reads your edited transcript and picks the lines that deserve a picture. Parts you cut never get one.</p>
    <details class="bfold bhow"><summary>How this works</summary><div class="bfold-body"><p class="bhint">First the AI writes a plain description of what a picture would show for <b>every</b> line. Then it decides which lines really <b>deserve</b> a picture and which neighbouring lines should <b>share one</b>. Lines without a picture are unticked. Their description is kept, so you can tick them later.</p></div></details>
    <div class="brow b-plan-row"><button id="b-plan" class="btn primary big">Plan B-roll</button><span class="b-theme-row"><label class="b-theme-label" for="b-theme-plan">Theme</label><select id="b-theme-plan" class="btext b-theme" aria-label="B-roll theme"></select></span><span id="b-plan-msg" class="bmuted"></span></div>
    <p class="bmuted b-theme-note"></p>
    <p id="b-plan-err" class="berr" hidden></p>
    <p id="b-plan-warn" class="bwarn" hidden></p>
    <details class="blog"><summary>Activity log</summary><pre id="b-plan-log"></pre></details>
  </div>
  <div class="bcard" id="b-brolls-card" hidden>
    <div class="bhead"><h3>B-roll list</h3><span id="b-plan-count" class="bchip"></span></div>
    <p class="bhint">Tick a row to use it. Times are on the original recording. Changes save automatically.</p>
    <details class="bfold bhow"><summary>How this works</summary><div class="bfold-body"><p class="bhint"><b>▶</b> jumps the preview there. <b>Regenerate</b> has the AI think of another picture. <b>Join with next</b> makes this line and the next one share one picture; <b>Ungroup</b> splits a group again. Times look like m:ss.mmm.</p></div></details>
    <div id="b-tidy" class="bro-cut tidy" hidden>
      <span id="b-tidy-msg"></span>
      <button type="button" class="btn small" id="b-tidy-btn">Trim to kept parts</button>
    </div>
    <div id="b-bro-list" class="bro-list"></div>
    <div class="brow bspread"><button id="b-add" class="btn">+ Add B-roll</button><span id="b-save-state" class="bmuted"></span></div>
  </div>
</section>

<section class="bsec" data-sec="prompts" hidden>
  <div class="bcard">
    <div class="bhead"><h3>Write image prompts</h3><span id="chip-prompts" class="bchip"></span></div>
    <div class="brow b-theme-row"><label class="b-theme-label" for="b-theme-prompts">Theme</label><select id="b-theme-prompts" class="btext b-theme" aria-label="B-roll theme"></select><span class="bmuted b-theme-note"></span></div>
    <p class="bhint" id="b-pr-hint">All B-roll descriptions go to the AI together, and it writes one image prompt for each.</p>
    <label class="bblock"><span id="b-common-label">Common instructions for every image (theme, style, palette…)</span>
      <textarea id="b-common" rows="4" placeholder="e.g. Flat vector illustration, warm teal and orange palette, soft shadows, no people's faces."></textarea>
    </label>
    <label class="bblock">Always add at the end of every prompt
      <input id="b-suffix" class="btext" placeholder="e.g. cinematic lighting, no text, no watermark">
    </label>
    <div class="brow b-actions-row">
      <button id="b-prompts" class="btn primary">Write prompts for all</button>
      <button id="b-prompts-missing" class="btn">Only the empty ones</button>
      <span id="b-pr-msg" class="bmuted"></span>
    </div>
    <p id="b-prompts-err" class="berr" hidden></p>
    <details class="blog"><summary>Activity log</summary><pre id="b-prompts-log"></pre></details>
  </div>
  <div class="bcard" id="b-prompt-card" hidden>
    <div class="bhead"><h3>Prompts</h3><span id="b-pr-count" class="bchip"></span></div>
    <p class="bhint">Edit any prompt. Changes save automatically.</p>
    <div id="b-prompt-list"></div>
  </div>
</section>

<section class="bsec" data-sec="images" hidden>

  <div class="bcard">
    <div class="bhead"><h3>Generation settings</h3></div>
    <p class="bhint">These are set in Flow's prompt bar for you before the run.</p>
    <div class="bfield2"><div class="blabel">Aspect ratio</div><div id="b-ratios" class="bseg2" role="radiogroup"></div></div>
    <div class="bfield2"><div class="blabel">Model</div><div id="b-models" class="bmodels" role="radiogroup"></div></div>
    <div class="bfield2"><div class="blabel">Alternatives per B-roll</div><div id="b-counts" class="bseg2" role="radiogroup"></div></div>
    <div class="bfield2">
      <div class="blabel">Reference images <span id="b-ref-count" class="bmuted"></span></div>
      <div id="b-refs" class="brefs"></div>
      <input type="file" id="b-ref-input" accept="image/png,image/jpeg,image/webp" multiple hidden>
      <p class="bsmall">Up to 3 images (PNG, JPG or WebP, 10 MB each). They are attached to every prompt.</p>
      <p id="b-ref-err" class="berr" hidden></p>
    </div>
  </div>

  <div class="bcard">
    <div class="bhead"><h3>Generate &amp; choose</h3><span id="b-job-status" class="bchip" hidden></span></div>
    <div class="brow bspread bnomargin">
      <div class="brow">
        <button id="b-start" class="btn primary">Generate images</button>
        <button id="b-stop" class="btn danger" hidden>Stop</button>
        <button id="b-resume" class="btn" hidden>Resume remaining</button>
      </div>
      <label class="bcheck"><input type="checkbox" id="b-mock"> Test mode (no Flow)</label>
    </div>
    <p id="b-img-summary" class="bsmall"></p>
    <p id="b-err" class="berr" hidden></p>
    <div id="b-progress" hidden>
      <p id="b-job-settings" class="bsmall"></p>
      <div class="bbar"><div id="b-bar-fill"></div></div>
    </div>
    <div id="b-items"></div>
    <div class="brow bspread" id="b-pick-row" hidden>
      <button id="b-pick-first" class="btn">Pick the first image of each</button>
      <span id="b-sel-count" class="bmuted"></span>
    </div>
    <details class="blog"><summary>Activity log</summary><pre id="b-log"></pre></details>
  </div>
</section>

<section class="bsec" data-sec="clips" hidden>
  <div class="bcard">
    <div class="bhead"><h3>Separate B-roll clips (optional)</h3><span id="chip-clips" class="bchip"></span></div>
    <p class="bhint">The export already puts your chosen images over the video. Use this only if you want each image as its own video file.</p>
    <details class="bfold bhow"><summary>How this works</summary><div class="bfold-body"><p class="bhint">The clips are laid on the <b>exported</b> timeline (after your cuts), back to back with no gaps, 30 fps, in number order.</p></div></details>
    <label class="bblock">Output folder (optional)
      <input id="b-dir" class="btext" placeholder="e.g. C:\\Videos\\my-broll  (empty = the project's own folder)" autocomplete="off" spellcheck="false">
    </label>
    <p class="bsmall" id="b-rd-hint"></p>
    <div class="brow b-actions-row"><button id="b-render" class="btn primary">Make clips</button><span id="b-rd-msg" class="bmuted"></span></div>
    <div id="b-rd-progress" hidden><div class="bbar"><div id="b-rd-fill"></div></div></div>
    <p id="b-render-err" class="berr" hidden></p>
    <details class="blog"><summary>Activity log</summary><pre id="b-render-log"></pre></details>
  </div>
  <div class="bcard" id="b-premiere-card">
    <div class="bhead"><h3>Premiere Pro files</h3><span id="b-pr-chip" class="bchip"></span></div>
    <p class="bhint">Use this if you edit in Premiere Pro. Every B-roll lands exactly where its line is spoken when you drop the file at 0:00.</p>
    <details class="bfold bhow"><summary>How this works</summary><div class="bfold-body"><p class="bhint">You get <b>broll_track.mov</b> (one transparent video as long as the exported video: put it on V2 above your video) and <b>broll_sequence.xml</b> (File → Import: each picture is its own clip at its exact time). Positions and sizes you set on the preview are included. B-rolls without a chosen image just leave empty space.</p></div></details>
    <div class="brow b-actions-row"><button id="b-premiere" class="btn primary">Make Premiere files</button><span id="b-pre-msg" class="bmuted"></span></div>
    <div id="b-pr-progress" hidden><div class="bbar"><div id="b-pr-fill"></div></div></div>
    <p id="b-pr-err" class="berr" hidden></p>
    <div id="b-pr-warnings"></div>
    <p id="b-pr-where" class="bhint" hidden></p>
    <div class="brow b-actions-row" id="b-pr-links" hidden></div>
  </div>
  <div class="bcard" id="b-result-card" hidden>
    <div class="bhead"><h3>Result</h3><span id="b-rd-info" class="bchip done"></span></div>
    <div id="b-rd-warnings"></div>
    <p id="b-rd-where" class="bhint"></p>
    <div class="brow b-actions-row" id="b-rd-links"></div>
    <div class="blabel">Clips (in timeline order)</div>
    <div id="b-rd-clips" class="bclips"></div>
  </div>
</section>

<nav class="bnav" id="b-nav" aria-label="B-roll steps">
  <button type="button" class="btn" id="b-back"></button>
  <div class="bnav-mid"><b id="b-step-label"></b><span id="b-step-hint" class="bmuted"></span></div>
  <button type="button" class="btn" id="b-next"></button>
</nav>
`;

export function createBroll({ jobId, video, player, hasVideo, beforeAction, seek, onChange, goTranscript, openExport }) {
  const root = h("div", { class: "pane broll" });
  root.innerHTML = TEMPLATE;
  const $ = sel => root.querySelector(sel);
  const $$ = sel => [...root.querySelectorAll(sel)];
  const show = (sel, on) => { $(sel).hidden = !on; };
  const setErr = (sel, msg) => { const el = $(sel); el.textContent = msg || ""; el.hidden = !msg; };
  const fail = e => toast(e.message || String(e), "error", 7000);

  const S = {
    opt: { ratios: ["16:9", "4:3", "1:1", "3:4", "9:16"], models: [], defaults: { ratio: "16:9", model: "", count: 2 }, maxReferenceImages: 3, llm: { providers: {} } },
    P: null, sub: "plan", active: false, destroyed: false, pollT: null, statusT: null,
    settings: { ratio: "16:9", model: "", count: 2 }, refs: [],
    include: true, fit: "cover", scope: "all",
    ui: { dirty: false, editSeq: 0, saveT: null, broSig: "", prSig: "", jobSig: "", resSig: "", reorderPending: false, regenId: null, ideaId: null }
  };
  try {
    const saved = JSON.parse(localStorage.getItem("brollView") || "null");
    if (saved) { S.include = saved.include !== false; S.fit = saved.fit === "contain" ? "contain" : "cover"; }
  } catch { /* ignore */ }
  const saveView = () => { try { localStorage.setItem("brollView", JSON.stringify({ include: S.include, fit: S.fit })); } catch { /* ignore */ } };

  // ------------------------------------------------------------ preview overlay
  const layer = h("div", { class: "broll-layer", hidden: true }); // hidden until a chosen image is due
  const pic = h("img", { class: "broll-pic", alt: "" });
  layer.append(pic);
  pic.addEventListener("load", () => place(curB()));   // the box depends on the picture's own aspect ratio
  video.after(layer); // right above the video, so the captions and the "Cut skipped" badge stay on top
  let shownUrl = "";
  let chosen = [];

  function layout() {
    const cw = player.clientWidth, ch = player.clientHeight;
    if (!cw || !ch) return;
    const a = (video.videoWidth || 16) / (video.videoHeight || 9);
    const fw = cw / ch > a ? ch * a : cw;
    const fh = cw / ch > a ? ch : cw / a;
    Object.assign(layer.style, { left: `${(cw - fw) / 2}px`, top: `${(ch - fh) / 2}px`, width: `${fw}px`, height: `${fh}px` });
  }
  const ro = new ResizeObserver(layout);
  ro.observe(player);
  video.addEventListener("loadedmetadata", layout);

  function computeChosen() {
    const P = S.P;
    const job = P && P.flowJob;
    if (!job) return [];
    const byId = new Map(P.brolls.map(b => [b.id, b]));
    return job.items
      .filter(i => i.selected && byId.has(i.brollId) && byId.get(i.brollId).enabled && !byId.get(i.brollId).cutOut)
      .map(i => {
        const b = byId.get(i.brollId);
        const im = i.images.find(x => x.file === i.selected);
        return im ? { id: b.id, start: b.start, end: b.end, url: (P.options.ultraKey !== false && im.keyedUrl) ? im.keyedUrl : im.url } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start);
  }

  // ---- placement: where a picture sits on the frame. A pos is { cx, cy, w }: centre and width as fractions of the frame.
  // Two levels, like a parent and child container:
  //   S.P.globalPos : the PARENT. Every B-roll follows it, so one change moves them all.
  //   b.pos         : a CHILD override on one B-roll. It may hold any of cx / cy / w; what it leaves out comes from the parent.
  // Nothing set at all = the picture fills (or fits) the whole frame, as chosen with "Fill frame" / "Fit inside".
  let curId = null;                       // the B-roll picture shown right now
  const curB = () => (curId && S.P ? S.P.brolls.find(b => b.id === curId) : null);
  const fin = Number.isFinite;
  const posOk = p => Boolean(p) && fin(p.cx) && fin(p.cy) && fin(p.w);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const KEYS = ["cx", "cy", "w"];
  const gPos = () => (S.P && posOk(S.P.globalPos) ? S.P.globalPos : null);
  const ownKeys = b => (b && b.pos ? KEYS.filter(k => fin(b.pos[k])) : []);
  // What this B-roll really uses: its own values on top of the parent's. null = fills / fits the frame.
  function effPos(b) {
    if (!b) return null;
    const g = gPos(), o = b.pos || {};
    const m = {};
    for (const k of KEYS) m[k] = fin(o[k]) ? o[k] : g ? g[k] : undefined;
    return posOk(m) ? m : null;
  }

  // ---- rounded corners: scenes, logos, people and photos (everything except the green-screen cards).
  // Same two levels as the position: S.P.globalRound is the parent, b.round a per-B-roll override. Radius = % of the shorter side.
  const RND = () => (S.P && S.P.rounding) || { default: 6, max: 50, cardModes: ["ui", "material", "symbol"] };
  const roundable = b => Boolean(b) && !RND().cardModes.includes(b.mode);
  const numOr = (v, d) => (v !== undefined && v !== null && v !== "" && fin(Number(v)) ? Number(v) : d);
  const gRound = () => (S.P ? numOr(S.P.globalRound, null) : null);
  const ownRound = b => (b ? numOr(b.round, null) : null);
  const effRound = b => (roundable(b) ? numOr(ownRound(b), numOr(gRound(), RND().default)) : 0);

  function place(b) {
    const pos = effPos(b);
    const W = layer.clientWidth, H = layer.clientHeight;
    const a = (pic.naturalWidth || 16) / (pic.naturalHeight || 9);
    let box;   // the picture's real box, so the rounded corners sit on the picture and not on the empty frame around it
    if (pos) {
      const pw = pos.w * W, ph = pw / a;
      box = { w: pw, h: ph, l: pos.cx * W - pw / 2, t: pos.cy * H - ph / 2 };
    } else if (S.fit === "contain") {
      const k = Math.min(W / a, H);
      box = { w: k * a, h: k, l: (W - k * a) / 2, t: (H - k) / 2 };
    } else {
      box = { w: W, h: H, l: 0, t: 0 };
    }
    Object.assign(pic.style, {
      objectFit: pos || S.fit === "contain" ? "fill" : "cover",
      width: `${box.w}px`, height: `${box.h}px`, left: `${box.l}px`, top: `${box.t}px`,
      borderRadius: `${Math.min(box.w, box.h) * effRound(b) / 100}px`
    });
  }

  // The starting pos of a picture that has none yet: exactly where it is drawn now (fit inside the frame).
  function startPos() {
    const W = layer.clientWidth || 16, H = layer.clientHeight || 9;
    const a = (pic.naturalWidth || 16) / (pic.naturalHeight || 9);
    return { cx: 0.5, cy: 0.5, w: a >= W / H ? 1 : (a * H) / W };
  }

  // Writes some of cx / cy / w to the level the user is editing: the parent (All B-rolls) or just this B-roll.
  function editPos(props) {
    const b = curB(); if (!b) return;
    if (S.scope === "all") {
      if (!gPos()) S.P.globalPos = startPos();
      Object.assign(S.P.globalPos, props);
    } else {
      const base = gPos() ? {} : (effPos(b) || startPos());   // with no parent every override must be complete
      b.pos = { ...base, ...(b.pos || {}), ...props };
    }
  }

  const overrideCount = () => (S.P ? S.P.brolls.filter(b => ownKeys(b).length || ownRound(b) !== null).length : 0);

  function renderPlace() {
    const b = curB(), has = Boolean(b), clip = S.scope === "clip";
    const own = ownKeys(b), n = overrideCount();
    $$("#b-scope button").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.scope === S.scope)));
    $("#b-size").disabled = !has;
    if (has) $("#b-size").value = String(Math.round((effPos(b) || startPos()).w * 100));
    // Reset: in All mode it clears the parent; in This-B-roll mode it makes this one follow the parent again.
    const reset = $("#b-pos-reset");
    reset.textContent = clip ? "Follow All" : "Reset";
    reset.title = clip ? "Drop this B-roll's own position / size so it follows the All setting again" : "Back to filling / fitting the frame for every B-roll that follows the All setting";
    reset.disabled = clip ? !own.length : !gPos();
    const clear = $("#b-pos-clear");
    clear.textContent = n ? `Clear individual changes (${n})` : "Clear individual changes";
    clear.disabled = !n;
    $("#b-pos-all").disabled = !has || !effPos(b);
    $("#b-pos-all").hidden = !clip;

    const names = { cx: "position", cy: "position", w: "size" };
    const what = [...new Set(own.map(k => names[k]))].join(" and ");
    let hint;
    if (!has) hint = "Move the playhead onto a B-roll picture, then drag it on the preview. Scroll or use the slider to resize.";
    else if (clip) hint = own.length
      ? `This B-roll has its own ${what}. The others follow All B-rolls.`
      : (gPos() ? "This B-roll follows All B-rolls. Drag or resize to give it its own." : "Drag the picture to place just this B-roll.");
    else hint = (gPos() ? "Drag or resize: every B-roll follows, except ones with their own change." : "Drag the picture to place every B-roll at once.")
      + (own.length ? ` This one has its own ${what}.` : "");
    $("#b-place-hint").textContent = hint;
    renderRound();
  }

  function renderRound() {
    const b = curB(), ok = roundable(b), clip = S.scope === "clip";
    const v = effRound(b);
    $("#b-round").disabled = !ok;
    $("#b-round").value = String(v);
    $("#b-round-val").textContent = ok ? `${v}%` : "–";
    const reset = $("#b-round-reset");
    reset.textContent = clip ? "Follow All" : "Default";
    reset.title = clip ? "Drop this picture's own roundness so it follows the All setting again" : "Back to the default roundness for every picture that follows the All setting";
    reset.disabled = !ok || (clip ? ownRound(b) === null : gRound() === null);
    $("#b-round-hint").textContent = !b ? "Move the playhead onto a B-roll picture to change its corners."
      : !ok ? "Green-screen cards keep their own shape. Roundness is for scenes, logos and people."
      : clip ? (ownRound(b) !== null ? "This picture has its own roundness. The others follow All B-rolls." : "This picture follows All B-rolls. Use the slider to give it its own.")
      : "Every picture follows this, except ones with their own roundness. Also applies to the export.";
  }

  function paint(t) {
    let url = "", id = null;
    if (S.include && hasVideo) {
      for (const c of chosen) if (t >= c.start && t < c.end) { url = c.url; id = c.id; break; }
    }
    if (url !== shownUrl) {
      shownUrl = url;
      if (url) pic.src = url; else pic.removeAttribute("src");
      layer.hidden = !url;
    }
    if (id !== curId) { curId = id; renderPlace(); }
    place(curB());
    pic.classList.toggle("movable", Boolean(id) && S.active);
  }

  // Drag to move, wheel to resize. Only while the B-roll tab is open, so the preview still plays on click otherwise.
  let drag = null;
  pic.addEventListener("pointerdown", ev => {
    const b = curB(); if (!b || !S.active) return;
    ev.preventDefault();
    const start = effPos(b) || startPos();
    pic.setPointerCapture(ev.pointerId);
    drag = { x: ev.clientX, y: ev.clientY, cx: start.cx, cy: start.cy, moved: false };
    video.pause?.();
  });
  pic.addEventListener("pointermove", ev => {
    const b = curB(); if (!drag || !b) return;
    const W = layer.clientWidth || 1, H = layer.clientHeight || 1;
    drag.moved = true;
    editPos({ cx: clamp(drag.cx + (ev.clientX - drag.x) / W, -0.5, 1.5), cy: clamp(drag.cy + (ev.clientY - drag.y) / H, -0.5, 1.5) });
    place(b);
  });
  const endDrag = () => { if (!drag) return; const moved = drag.moved; drag = null; if (moved) { renderPlace(); markDirty(); } };
  pic.addEventListener("pointerup", endDrag);
  pic.addEventListener("pointercancel", endDrag);
  pic.addEventListener("wheel", ev => {
    const b = curB(); if (!b || !S.active) return;
    ev.preventDefault();
    const cur = effPos(b) || startPos();
    editPos({ w: clamp(cur.w * Math.exp(-ev.deltaY * 0.0015), 0.1, 2.5) });
    place(b); renderPlace(); markDirty();
  }, { passive: false });
  $("#b-size").addEventListener("input", ev => {
    const b = curB(); if (!b) return;
    editPos({ w: clamp(Number(ev.target.value) / 100, 0.1, 2.5) });
    place(b); renderPlace(); markDirty();
  });
  $("#b-round").addEventListener("input", ev => {
    const b = curB(); if (!b || !roundable(b)) return;
    const v = clamp(Number(ev.target.value) || 0, 0, RND().max);
    if (S.scope === "clip") b.round = v; else S.P.globalRound = v;
    place(b); renderRound(); markDirty();
  });
  $("#b-round-reset").addEventListener("click", () => {
    const b = curB(); if (!b) return;
    if (S.scope === "clip") delete b.round; else delete S.P.globalRound;
    place(b); renderRound(); markDirty();
  });
  $("#b-scope").addEventListener("click", ev => {
    const x = ev.target.closest("[data-scope]"); if (!x) return;
    S.scope = x.dataset.scope === "clip" ? "clip" : "all";
    renderPlace();
  });
  $("#b-pos-reset").addEventListener("click", () => {
    if (S.scope === "clip") { const b = curB(); if (!b) return; delete b.pos; }
    else delete S.P.globalPos;
    place(curB()); renderPlace(); markDirty();
  });
  $("#b-pos-clear").addEventListener("click", () => {
    const n = overrideCount(); if (!n) return;
    for (const x of S.P.brolls) { delete x.pos; delete x.round; }
    place(curB()); renderPlace(); markDirty();
    toast(`${n} individual change${n === 1 ? "" : "s"} cleared. Every B-roll follows All B-rolls again.`);
  });
  $("#b-pos-all").addEventListener("click", () => {
    const b = curB(), e = effPos(b); if (!b || !e) return;
    S.P.globalPos = { ...e };
    for (const x of S.P.brolls) delete x.pos;
    if (roundable(b)) { S.P.globalRound = effRound(b); for (const x of S.P.brolls) delete x.round; }
    place(b); renderPlace(); markDirty();
    toast("Position and size applied to every B-roll.");
  });

  // ------------------------------------------------------------ status pills (Chrome, daily usage)
  async function refreshStatus() {
    try {
      const s = await api.brollGlobal("status");
      const chrome = $("#pill-chrome");
      chrome.textContent = s.chromeUp ? "Chrome: connected" : s.chromeFound ? "Chrome: not connected" : "Chrome: not found";
      chrome.className = "bpill " + (s.chromeUp ? "ok" : "warn");
      const u = $("#pill-usage");
      u.textContent = `Today: ${s.usage.count} / ${s.usage.limit} images`;
      u.className = "bpill " + (s.usage.count >= s.usage.limit ? "bad" : s.usage.count >= s.usage.limit * 0.8 ? "warn" : "");
      chromeIsUp = s.chromeUp; statusSeen = true;
      if (S.P) renderHeader();
      $("#b-profiles").classList.toggle("locked", s.chromeUp);
      $("#b-launch").disabled = s.chromeUp;
      $("#b-launch").textContent = s.chromeUp ? "Chrome launched" : "Launch Chrome";
    } catch { /* offline */ }
  }
  // ---- Chrome profile picker (like Chrome's own "Who's using Chrome?" window)
  const AVATARS = ["#00897b", "#689f38", "#7e57c2", "#ec6b9a", "#3d8bfd", "#f4a259"];
  const avatarColor = str => AVATARS[[...str].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATARS.length];
  let profState = null, chromeIsUp = false, statusSeen = false;
  function renderProfiles() {
    const box = $("#b-profiles"), note = $("#b-profile-note");
    if (!box || !profState) return;
    const list = profState.profiles || [];
    box.innerHTML = list.map(p => `<button type="button" class="bprofile" data-dir="${esc(p.dir)}" aria-pressed="${profState.selected === p.dir}">
        <span class="bavatar" style="background:${avatarColor(p.name)}">${esc((p.name || "?").charAt(0).toUpperCase())}</span>
        <span class="bpname">${esc(p.name)}</span>
        <span class="bpmail">${esc(p.email || p.fullName || "")}</span>
      </button>`).join("") +
      `<button type="button" class="bprofile add" data-dir="" aria-pressed="${!profState.selected}">
        <span class="bavatar plain">+</span><span class="bpname">New profile</span><span class="bpmail">Sign in once</span></button>`;
    if (!list.length) note.textContent = "No Chrome profiles were found on this computer, so a new profile will be used. Sign into Google in the window that opens, once.";
    else if (!profState.selected) note.textContent = "A new profile is used. Sign into Google in the window that opens, once. Or pick one of your profiles above.";
    else if (!profState.copied) note.textContent = "First time: close your other Chrome windows, then press Launch Chrome. Your login is copied once; your own profile is never changed.";
    else note.innerHTML = `Using a copy of this profile${profState.skipped ? ` (${profState.skipped} locked file${profState.skipped === 1 ? "" : "s"} skipped; close Chrome and copy again if you are asked to sign in)` : ""}. <button type="button" class="blink" id="b-profile-refresh" ${chromeIsUp ? "disabled" : ""}>Copy again</button>`;
  }
  async function loadProfiles() {
    try { profState = await api.brollGlobal("chrome-profiles"); renderProfiles(); } catch { /* offline */ }
  }
  $("#b-profiles").addEventListener("click", async ev => {
    const btn = ev.target.closest(".bprofile"); if (!btn || chromeIsUp) return;
    try { profState = await api.brollGlobalPost("chrome-profile", { dir: btn.dataset.dir }); renderProfiles(); } catch (e) { setErr("#b-err", e.message); }
  });
  $("#b-profile-note").addEventListener("click", async ev => {
    if (!ev.target.closest("#b-profile-refresh")) return;
    try {
      await api.brollGlobalPost("chrome", { refresh: true });
      $("#b-launch").textContent = "Copying…";
      for (let i = 0; i < 20; i++) { await sleep(1000); await refreshStatus(); if (chromeIsUp) break; }
      loadProfiles();
    } catch (e) { setErr("#b-err", e.message); }
  });

  // Chrome is needed for the image step (Flow) and for every AI step when the AI is Claude on claude.ai.
  const chromeNeeded = () => S.sub === "images" || (S.sub !== "clips" && Boolean(S.P && S.P.llm && S.P.llm.web));
  function syncStatusTimer() {
    const needs = chromeNeeded();
    const card = $("#b-chrome-card"); if (card) card.hidden = !needs;
    $$(".b-images-only").forEach(el => { el.hidden = S.sub !== "images"; });
    const want = S.active && needs && !S.destroyed;
    if (want && !S.statusT) { refreshStatus(); loadProfiles(); S.statusT = setInterval(refreshStatus, 6000); }
    if (!want && S.statusT) { clearInterval(S.statusT); S.statusT = null; }
  }

  // ------------------------------------------------------------ step navigation (Back / Next)
  const STEPS = [
    { key: "plan", name: "Plan" },
    { key: "prompts", name: "Prompts" },
    { key: "images", name: "Images" },
    { key: "clips", name: "Clips" }
  ];
  const stepIndex = () => STEPS.findIndex(x => x.key === S.sub);

  // What each step needs before the next one makes sense, in words.
  function stepState() {
    const P = S.P;
    if (!P) return { ready: false, hint: "Loading…" };
    const live = P.brolls.filter(b => b.enabled && !b.cutOut);
    switch (S.sub) {
      case "plan":
        if (P.steps.plan.status === "running") return { ready: false, hint: "The AI is planning…" };
        return live.length ? { ready: true, hint: `${live.length} B-roll${live.length === 1 ? "" : "s"} planned. Check them, then continue.` }
          : { ready: false, hint: "Press “Plan B-roll” first." };
      case "prompts": {
        if (P.steps.prompts.status === "running") return { ready: false, hint: "The AI is writing prompts…" };
        const need = live.filter(b => !b.needsRealImage), ownImg = live.length - need.length;
        const done = need.filter(b => b.prompt.trim()).length;
        const own = ownImg ? ` ${ownImg} need${ownImg === 1 ? "s" : ""} your own image.` : "";
        return need.length && done === need.length ? { ready: true, hint: `All ${done} prompts are written.${own}` }
          : !need.length && live.length ? { ready: false, hint: `Every B-roll needs your own image (nothing to generate).` }
          : { ready: false, hint: live.length ? `${done} of ${need.length} prompts written.${own}` : "Plan the B-roll first (step 1)." };
      }
      case "images": {
        const job = P.flowJob;
        if (job && ["running", "queued"].includes(job.status)) return { ready: false, hint: "Generating images…" };
        const picked = chosen.length;
        return picked ? { ready: true, hint: `${picked} of ${live.length} images chosen.` }
          : { ready: false, hint: job ? "Pick the best image for each B-roll." : "Generate images, then pick one for each B-roll." };
      }
      default:
        return { ready: true, hint: "Optional. Skip this if you only need the exported video." };
    }
  }

  function renderNav() {
    const i = stepIndex(), last = i === STEPS.length - 1;
    const st = stepState();
    $("#b-step-label").textContent = `Step ${i + 1} of ${STEPS.length} · ${STEPS[i].name}`;
    $("#b-step-hint").textContent = st.hint;
    $("#b-back").textContent = i === 0 ? "← Transcript" : `← Back: ${STEPS[i - 1].name}`;
    $("#b-back").title = i === 0 ? "Return to the transcript" : `Go back to step ${i}`;
    $("#b-next").textContent = last ? "Export video →" : `Next: ${STEPS[i + 1].name} →`;
    $("#b-next").title = last ? "Open the export dialog" : `Go to step ${i + 2}`;
    $("#b-next").className = "btn " + (st.ready ? "primary" : "") + (st.ready ? " ready" : "");
  }

  async function goStep(delta) {
    const i = stepIndex() + delta;
    try { await flushSave(); } catch { /* shown by the save indicator */ }
    if (i < 0) { goTranscript?.(); return; }
    if (i >= STEPS.length) { openExport?.(); return; }
    showSub(STEPS[i].key);
    root.scrollTop = 0;
  }
  $("#b-back").addEventListener("click", () => goStep(-1));
  $("#b-next").addEventListener("click", () => goStep(1));

  // ------------------------------------------------------------ sub tabs
  function showSub(name) {
    S.sub = name;
    $$(".bsub-btn").forEach(b => b.setAttribute("aria-selected", String(b.dataset.sub === name)));
    $$(".bsec").forEach(s => { s.hidden = s.dataset.sec !== name; });
    syncStatusTimer();
    renderSetup();
    renderNav();
  }
  $$(".bsub-btn").forEach(b => b.addEventListener("click", () => showSub(b.dataset.sub)));

  // ------------------------------------------------------------ loading / polling
  async function refreshProject() {
    try {
      S.P = await api.broll(jobId);
      renderAll();
    } catch (e) { /* project may be gone */ }
  }
  function schedulePoll() {
    clearTimeout(S.pollT);
    if (S.destroyed || !running(S.P)) return;
    S.pollT = setTimeout(async () => { await refreshProject(); schedulePoll(); }, 1500);
  }

  // ------------------------------------------------------------ saving B-roll edits
  function markDirty() {
    S.ui.dirty = true; S.ui.editSeq++;
    $("#b-save-state").textContent = "Saving…";
    clearTimeout(S.ui.saveT);
    S.ui.saveT = setTimeout(saveBrolls, 700);
  }
  async function saveBrolls() {
    clearTimeout(S.ui.saveT); S.ui.saveT = null;
    if (!S.ui.dirty || !S.P) return;
    const seq = S.ui.editSeq;
    try {
      const P = await api.brollPost(jobId, "save", { brolls: S.P.brolls, globalPos: gPos(), globalRound: gRound() });
      if (seq === S.ui.editSeq) {
        const reordered = P.brolls.map(b => b.id).join() !== S.P.brolls.map(b => b.id).join();
        S.P.brolls = P.brolls; S.ui.dirty = false;
        S.ui.broSig = broSig(); S.ui.prSig = prSig();
        if (reordered) {
          S.ui.reorderPending = true;
          if (!document.activeElement || !document.activeElement.closest(".bro-list")) { renderBroList(); S.ui.reorderPending = false; }
        }
        $("#b-save-state").textContent = "Saved";
        chosen = computeChosen(); paint(video.currentTime); onChange?.();
      }
      setErr("#b-plan-err", "");
    } catch (e) {
      S.ui.dirty = false;
      $("#b-save-state").textContent = "Not saved";
      setErr("#b-plan-err", e.message);
    }
  }
  const flushSave = async () => { if (S.ui.dirty) await saveBrolls(); };
  const broSig = () => JSON.stringify(S.P.brolls.map(b => [b.id, b.start, b.end, b.description, b.enabled, b.quote, b.cutOut, Math.round((b.cutSec || 0) * 10), b.needsTrim, (b.lines || []).length]));
  const prSig = () => JSON.stringify([themeOf(), S.ui.ideaId, S.P.brolls.map(b => [b.id, b.start, b.end, b.description, b.enabled, b.prompt, b.cutOut, b.mode, b.card && b.card.layout, b.card && b.card.palette, b.card && b.card.render, b.card && b.card.psych, b.card && b.card.reason, b.source, b.needsRealImage, b.searchHint])]);

  function setLog(sel, P, open) {
    const el = $(sel), atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    el.textContent = logText(P);
    if (atBottom) el.scrollTop = el.scrollHeight;
    if (open) el.parentElement.open = true;
  }
  function setChip(sel, status) { const el = $(sel); el.textContent = STEP_TEXT[status]; el.className = "bchip " + status; }

  // ------------------------------------------------------------ header (AI + include/fit)
  function renderHeader() {
    const P = S.P;
    const sel = $("#b-provider");
    if (!sel.options.length) {
      for (const [id, v] of Object.entries(S.opt.llm.providers || {})) sel.append(h("option", { value: id }, `${v.label}`));
    }
    if (P) {
      sel.value = P.llm.provider;
      $("#b-ai-line").textContent = P.llm.web ? "Claude (claude.ai) in Chrome, no API key" : `Model: ${P.llm.model}`;
      $("#b-add-key").hidden = P.llm.hasKey;
      if (!P.llm.hasKey) $("#b-ai-line").textContent = `No ${P.llm.label} key yet.`;
      $("#b-claude-box").hidden = !P.llm.web;
      if (P.llm.web) loadClaudeChat();
      syncStatusTimer();
    }
    // Claude needs the signed-in Chrome: say why the AI steps may not work yet.
    const needChrome = Boolean(P && P.llm.web && !chromeIsUp);
    for (const id of ["#b-plan", "#b-prompts", "#b-prompts-missing"]) {
      const el = $(id); if (!el) continue;
      el.title = needChrome ? "Press Launch Chrome and sign in to claude.ai first" : "";
    }
    renderSetup();
    $("#b-include").checked = S.include;
    $("#b-key").checked = !(P && P.options && P.options.ultraKey === false);
    $("#b-key").closest("label").hidden = !(P && P.ultraKey && P.ultraKey.enabled);
    $$("#b-fit button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.fit === S.fit)));
    $("#b-fit").hidden = !hasVideo;
  }
  // One short line for the collapsed Setup: which AI, and whether Chrome is ready. It opens by itself only when something needs attention.
  function renderSetup() {
    const P = S.P, box = $("#b-setup"), line = $("#b-setup-line");
    if (!P) { line.textContent = "Loading…"; return; }
    const parts = [`AI: ${P.llm.label}`];
    const noKey = !P.llm.hasKey;
    const chromeUsed = chromeNeeded();
    const chromeBad = chromeUsed && statusSeen && !chromeIsUp;
    if (noKey) parts.push("key missing");
    if (chromeUsed && statusSeen) parts.push(chromeIsUp ? "Chrome connected" : "Chrome not connected");
    line.textContent = parts.join(" · ");
    const attention = noKey || chromeBad;
    box.classList.toggle("attn", attention);
    if (attention && !S.setupAttn) { box.open = true; S.setupAuto = true; }
    if (!attention && S.setupAttn && S.setupAuto) { box.open = false; S.setupAuto = false; }
    S.setupAttn = attention;
  }
  $("#b-setup").addEventListener("toggle", () => { if (!$("#b-setup").open) S.setupAuto = false; });
  $("#b-provider").addEventListener("change", async ev => {
    try { S.P = await api.brollPost(jobId, "options", { provider: ev.target.value }); renderAll(); } catch (e) { fail(e); }
  });
  // The one shared claude.ai chat (claude-chat.json).
  async function loadClaudeChat() {
    try {
      const c = await api.brollGlobal("claude-chat");
      const a = $("#b-claude-link");
      a.hidden = !c.chatUrl; a.href = c.chatUrl || "#";
      a.textContent = c.chatUrl ? c.chatUrl.replace("https://", "") + (c.messages ? ` · ${c.messages} message${c.messages === 1 ? "" : "s"}` : "") : "";
      $("#b-claude-none").hidden = Boolean(c.chatUrl);
    } catch { /* the box stays as it was */ }
  }
  $("#b-claude-use").addEventListener("click", async () => {
    try { await api.brollGlobalPost("claude-chat", { chatUrl: $("#b-claude-url").value.trim() }); $("#b-claude-url").value = ""; toast("This chat will be used from now on."); loadClaudeChat(); } catch (e) { fail(e); }
  });
  $("#b-claude-new").addEventListener("click", async () => {
    try { await api.brollGlobalPost("claude-chat-reset"); toast("The next message opens a new claude.ai chat."); loadClaudeChat(); } catch (e) { fail(e); }
  });
  // Theme: "card" (dark UI card on green screen) or "free" (the AI writes free-form prompts). Chosen before planning, mirrored in the Prompts step.
  const THEME_NOTES = {
    card: "Every picture is a dark card on solid green (the green is removed automatically by Ultra Key). The AI only fills a small form; the app writes the prompt.",
    free: "The AI writes a free-form image prompt for every B-roll."
  };
  const themeOf = () => (S.P && S.P.options && S.P.options.theme) || "free";
  const isCard = () => themeOf() === "card";
  function renderTheme() {
    const P = S.P; if (!P) return;
    const list = P.themes && P.themes.length ? P.themes : [{ id: "card", label: "UI Card (green screen)" }, { id: "free", label: "Free style" }];
    for (const sel of $$(".b-theme")) {
      if (sel.options.length !== list.length) { sel.innerHTML = ""; for (const t of list) sel.append(h("option", { value: t.id }, t.label)); }
      sel.value = themeOf();
      sel.disabled = running(P);
    }
    for (const n of $$(".b-theme-note")) n.textContent = THEME_NOTES[themeOf()] || "";
  }
  async function changeTheme(ev) {
    const next = ev.target.value;
    if (!S.P || next === themeOf()) return;
    const written = S.P.brolls.some(b => (b.prompt && b.prompt.trim()) || b.card);
    const images = S.P.flowJob && S.P.flowJob.items && S.P.flowJob.items.length;
    if (written && !confirm("Changing the theme clears the written prompts" + (images ? " and the generated images of this plan" : "") + ". The plan itself (times and descriptions) is kept. Continue?")) { renderTheme(); return; }
    try {
      await flushSave();
      S.P = await api.brollPost(jobId, "options", { theme: next });
      S.ui.broSig = S.ui.prSig = S.ui.jobSig = ""; S.ui.resSig = "";
      renderAll();
    } catch (e) { fail(e); renderTheme(); }
  }
  for (const sel of $$(".b-theme")) sel.addEventListener("change", changeTheme);
  $("#b-add-key").addEventListener("click", () => openKeys({ onSaved: refreshProject }));
  $("#b-key").addEventListener("change", async ev => {
    try {
      S.P = await api.brollPost(jobId, "options", { ultraKey: ev.target.checked });
      S.ui.jobSig = ""; chosen = computeChosen(); renderAll(); paint(video.currentTime); onChange?.();
    } catch (e) { ev.target.checked = !ev.target.checked; fail(e); }
  });
  $("#b-include").addEventListener("change", ev => { S.include = ev.target.checked; saveView(); paint(video.currentTime); onChange?.(); });
  $("#b-fit").addEventListener("click", ev => {
    const b = ev.target.closest("[data-fit]"); if (!b) return;
    S.fit = b.dataset.fit; saveView(); renderHeader(); paint(video.currentTime); onChange?.();
  });

  // ------------------------------------------------------------ 1. plan
  function renderPlan() {
    const P = S.P, st = P.steps.plan;
    setChip("#chip-plan", st.status);
    $("#b-plan").disabled = running(P);
    $("#b-plan-msg").textContent = st.status === "running" ? "The AI is reading your transcript…" : "";
    if (st.status === "failed") setErr("#b-plan-err", st.error);
    else if (!S.ui.dirty && !$("#b-save-state").textContent.startsWith("Not")) setErr("#b-plan-err", "");
    setLog("#b-plan-log", P, st.status === "running");
    const warn = $("#b-plan-warn");
    warn.textContent = st.warning || ""; warn.hidden = !st.warning;
    show("#b-brolls-card", P.brolls.length > 0);
    $("#b-plan-count").textContent = planCount();
    renderTidy();
    if (!S.ui.dirty && !S.ui.reorderPending && S.ui.broSig !== broSig()) { renderBroList(); S.ui.broSig = broSig(); }
  }

  // "9 of 12 on" (+ how many lie in cut-out parts)
  const planCount = () => {
    const all = S.P.brolls, cut = all.filter(b => b.cutOut).length;
    const groups = all.filter(b => (b.lines || []).length > 1).length;
    return `${all.filter(b => b.enabled && !b.cutOut).length} of ${all.length} on` + (groups ? ` · ${groups} group${groups === 1 ? "" : "s"}` : "") + (cut ? ` · ${cut} in cut parts` : "");
  };
  const cutNote = b => b.cutOut
    ? `<div class="bro-cut">This part is cut out of the video, so no B-roll is made for it. Move it onto a kept part, or delete it.</div>`
    : b.needsTrim ? `<div class="bro-cut">Part of this lies in a cut (${b.cutSec.toFixed(1)} s). Use “Trim to kept parts” above.</div>`
    : b.cutSec > 0.05 ? `<div class="bro-cut soft">${b.cutSec.toFixed(1)} s of this overlaps a cut and won't be shown; ${b.keptSec.toFixed(1)} s stays.</div>` : "";

  // Offer a one-click fix when B-rolls reach into parts that were cut (e.g. the cuts changed after planning).
  function renderTidy() {
    const over = S.P.brolls.filter(b => b.cutOut || b.needsTrim);
    const gone = over.filter(b => b.cutOut).length;
    $("#b-tidy").hidden = over.length === 0;
    if (!over.length) return;
    $("#b-tidy-msg").textContent = `${over.length} B-roll${over.length === 1 ? "" : "s"} reach into parts you cut` +
      (gone ? ` (${gone} lie entirely in cut parts and will be removed)` : "") + ". No images are made for cut parts.";
  }
  $("#b-tidy-btn").addEventListener("click", async () => {
    try {
      await beforeAction?.();
      await flushSave();
      S.P = await api.brollPost(jobId, "tidy");
      S.ui.broSig = S.ui.prSig = S.ui.jobSig = "";
      renderAll();
      toast("B-rolls trimmed to the parts that stay in the video.");
    } catch (e) { fail(e); }
  });

  const isGroup = b => (b.lines || []).length > 1;
  const groupBlock = b => `<div class="bro-group"><span class="bro-badge">Group · ${b.lines.length} lines share one picture</span>
      <ul class="bro-lines">${b.lines.map(l => `<li><span class="btime">${fmtT(l.start)}</span> “${esc(l.quote)}”</li>`).join("")}</ul></div>`;

  function renderBroList() {
    const list = S.P.brolls;
    $("#b-bro-list").innerHTML = list.map((b, i) => `
      <div class="bro ${b.enabled && !b.cutOut ? "" : "off"} ${b.cutOut ? "cutout" : ""}" data-id="${esc(b.id)}">
        <input type="checkbox" class="b-en" ${b.enabled && !b.cutOut ? "checked" : ""} ${b.cutOut ? "disabled" : ""} title="${b.cutOut ? "Cut out of the video" : "Use this B-roll"}" aria-label="Use this B-roll">
        <div class="bro-time">
          <input class="btext b-start" value="${fmtT(b.start)}" aria-label="Start time">
          <input class="btext b-end" value="${fmtT(b.end)}" aria-label="End time">
          <small class="b-dur">${(b.end - b.start).toFixed(1)} s</small>
          <button type="button" class="btn small b-seek" title="Show this moment in the preview">▶</button>
        </div>
        <div class="bro-main">
          ${cutNote(b)}
          ${isGroup(b) ? groupBlock(b) : b.quote ? `<div class="bro-quote">${b.anchor ? `<b>${esc(b.anchor)}</b> · ` : ""}“${esc(b.quote)}”</div>` : ""}
          <textarea class="b-desc" rows="2" placeholder="What should the image show?">${esc(b.description)}</textarea>
          <div class="bro-actions">
            <button type="button" class="btn small b-regen" ${S.ui.regenId ? "disabled" : ""} title="Have the AI think of another picture">${S.ui.regenId === b.id ? "Regenerating…" : "↻ Regenerate"}</button>
            ${i < list.length - 1 ? `<button type="button" class="btn small b-join" title="This line and the next one will share one picture">Join with next</button>` : ""}
            ${isGroup(b) ? `<button type="button" class="btn small b-ungroup" title="Back to one picture per line">Ungroup</button>` : ""}
          </div>
        </div>
        <button class="bx b-del" title="Delete" aria-label="Delete this B-roll">×</button>
      </div>`).join("");
  }

  const broOf = el => { const row = el.closest(".bro"); return row && S.P.brolls.find(b => b.id === row.dataset.id); };
  const broList = $("#b-bro-list");
  broList.addEventListener("input", ev => {
    const b = broOf(ev.target); if (!b || !ev.target.classList.contains("b-desc")) return;
    b.description = ev.target.value; markDirty();
  });
  broList.addEventListener("change", ev => {
    const b = broOf(ev.target); if (!b) return;
    const row = ev.target.closest(".bro");
    if (ev.target.classList.contains("b-en")) { b.enabled = ev.target.checked; row.classList.toggle("off", !b.enabled); }
    else if (ev.target.classList.contains("b-start") || ev.target.classList.contains("b-end")) {
      const isStart = ev.target.classList.contains("b-start");
      const v = parseT(ev.target.value);
      if (!Number.isFinite(v) || v < 0) { toast("Use a time like 1:23.4 or 83.4"); ev.target.value = fmtT(isStart ? b.start : b.end); return; }
      if (isStart) b.start = v; else b.end = v;
      ev.target.value = fmtT(v);
      row.querySelector(".b-dur").textContent = `${(b.end - b.start).toFixed(1)} s`;
      if (b.end <= b.start) toast("The end time must be after the start time.");
    } else return;
    markDirty();
    $("#b-plan-count").textContent = planCount();
  });
  broList.addEventListener("click", async ev => {
    const seekBtn = ev.target.closest(".b-seek");
    if (seekBtn) { const b = broOf(seekBtn); if (b) seek(b.start + 0.01); return; }

    if (ev.target.classList.contains("b-del")) {
      const b = broOf(ev.target); if (!b) return;
      S.P.brolls = S.P.brolls.filter(x => x !== b);
      renderBroList(); markDirty();
      $("#b-plan-count").textContent = planCount();
      return;
    }

    // Group / ungroup: done on the server, which merges (or splits) the lines and keeps their descriptions.
    const join = ev.target.closest(".b-join"), split = ev.target.closest(".b-ungroup");
    if (join || split) {
      const b = broOf(ev.target); if (!b) return;
      const next = S.P.brolls[S.P.brolls.indexOf(b) + 1];
      try {
        await flushSave();
        S.P = split
          ? await api.brollPost(jobId, `ungroup/${encodeURIComponent(b.id)}`)
          : await api.brollPost(jobId, "group", { ids: [b.id, next.id] });
        S.ui.broSig = S.ui.prSig = S.ui.jobSig = "";
        renderAll();
      } catch (e) { fail(e); }
      return;
    }

    // Regenerate ONE B-roll: the AI re-plans just that item; its image prompt is cleared.
    const btn = ev.target.closest(".b-regen");
    if (!btn || S.ui.regenId) return;
    const b = broOf(btn); if (!b) return;
    if (b.prompt && b.prompt.trim() && !confirm("Regenerating replaces this B-roll and clears its image prompt (write prompts again in step 2). Continue?")) return;
    const id = b.id;
    try {
      await beforeAction?.();
      await flushSave();
      S.ui.regenId = id; broList.inert = true; $("#b-add").disabled = true; renderBroList();
      S.P = await api.brollPost(jobId, `regenerate/${encodeURIComponent(id)}`);
      S.ui.broSig = S.ui.prSig = S.ui.jobSig = ""; S.ui.resSig = "";
      toast("B-roll regenerated.");
    } catch (e) { fail(e); }
    finally {
      S.ui.regenId = null; broList.inert = false; $("#b-add").disabled = false;
      S.ui.broSig = ""; renderAll();
    }
  });
  broList.addEventListener("focusout", () => {
    setTimeout(() => { if (S.ui.reorderPending && !S.ui.dirty && !document.activeElement.closest(".bro-list")) { S.ui.reorderPending = false; renderBroList(); } }, 50);
  });
  $("#b-add").addEventListener("click", () => {
    const last = S.P.brolls.reduce((m, b) => Math.max(m, b.end), 0);
    const total = (video.duration && Number.isFinite(video.duration)) ? video.duration : last + 10;
    const start = Math.min(last + 1, Math.max(0, total - 3));
    S.P.brolls.push({ id: "n" + Date.now().toString(36), start, end: Math.min(start + 4, total), quote: "", anchor: "", description: "", prompt: "", enabled: true });
    renderBroList(); markDirty();
    const rows = broList.querySelectorAll(".bro"); rows[rows.length - 1].querySelector(".b-desc").focus();
  });
  $("#b-plan").addEventListener("click", async () => {
    if (S.P.llm.web && !chromeIsUp) { setErr("#b-plan-err", "Chrome is not connected yet. Pick a profile and press Launch Chrome above, sign in to claude.ai, then press Plan B-roll again."); $("#b-setup").open = true; $("#b-chrome-card").scrollIntoView({ block: "nearest" }); return; }
    if (S.P.brolls.length && !confirm("This replaces the current B-roll list, including your edits and prompts. Continue?")) return;
    try {
      await beforeAction?.();
      await flushSave();
      S.P = await api.brollPost(jobId, "plan");
      S.ui.broSig = S.ui.prSig = S.ui.jobSig = "";
      renderAll(); schedulePoll();
    } catch (e) { fail(e); }
  });

  // ------------------------------------------------------------ 2. prompts
  let optT;
  function saveOptionsSoon() {
    clearTimeout(optT);
    optT = setTimeout(() => {
      api.brollPost(jobId, "options", { prompts: { common: $("#b-common").value, suffix: $("#b-suffix").value } }).catch(() => {});
    }, 600);
  }
  ["#b-common", "#b-suffix"].forEach(s => $(s).addEventListener("input", saveOptionsSoon));

  function renderPrompts() {
    const P = S.P, st = P.steps.prompts;
    const cards = isCard();
    setChip("#chip-prompts", st.status);
    const enabled = P.brolls.filter(b => b.enabled && !b.cutOut);
    const needOwn = enabled.filter(b => b.needsRealImage), writable = enabled.filter(b => !b.needsRealImage && b.source !== "file");
    const busy = running(P);
    $("#b-prompts").disabled = busy || !enabled.length;
    $("#b-prompts-missing").disabled = busy || !writable.some(b => !b.prompt.trim());
    $("#b-pr-msg").textContent = !P.brolls.length ? "Plan the B-roll first (step 1)." : st.status === "running" ? (cards ? "The AI is filling the card forms…" : "The AI is writing the prompts…") : "";
    // The card theme relabels the instructions box: it is not a style box any more, the look is fixed.
    $("#b-common-label").textContent = cards ? "Extra instructions for every card (optional)" : "Common instructions for every image (theme, style, palette…)";
    $("#b-common").placeholder = cards ? "e.g. Keep every card minimal. Use short words only." : "e.g. Flat vector illustration, warm teal and orange palette, soft shadows, no people's faces.";
    $("#b-pr-hint").textContent = cards
      ? "For each B-roll the AI fills a small card form (mode, layout and a few short words). The app checks it and writes the final prompt from fixed templates: a dark rounded card on solid green."
      : "All B-roll descriptions go to the AI together, and it writes one image prompt for each.";
    setErr("#b-prompts-err", st.status === "failed" ? st.error : "");
    setLog("#b-prompts-log", P, st.status === "running");
    show("#b-prompt-card", enabled.length > 0);
    $("#b-pr-count").textContent = `${writable.filter(b => b.prompt.trim()).length} of ${writable.length} written` + (needOwn.length ? ` · ${needOwn.length} need your own image` : "");
    if (!S.ui.dirty && S.ui.prSig !== prSig()) {
      const focused = document.activeElement && document.activeElement.closest("#b-prompt-list");
      if (!focused) {
        $("#b-prompt-list").innerHTML = enabled.map(b => {
          const layout = b.card && b.card.layout;
          const c = b.card || {};
          const sceneLike = c.mode === "scene" || (c.mode === "person" && c.render === "animated");
          const extraChip = sceneLike ? c.palette : c.mode === "person" ? c.render : layout;
          const chips = cards && b.mode ? `<span class="bchip mode-chip" title="Picture mode">${esc(b.mode.replace("_", " "))}</span>${extraChip ? `<span class="bchip layout-chip" title="Layout, palette or render">${esc(String(extraChip).replace(/_/g, " "))}</span>` : ""}${c.mode === "person" && c.render === "animated" ? `<span class="bchip layout-chip">animated</span>` : ""}` : "";
          const logoBadge = c.mode === "logo" ? (b.source === "file" ? `<span class="bro-real ok">Your logo file</span>` : `<span class="bro-real">Check the logo</span><button type="button" class="btn small p-savelogo" title="Save the picked image as assets/logos/${esc(c.brand)}.png so every video uses it">Save as logo</button>`) : "";
          const personHint = c.mode === "person" && c.render === "real" ? `<span class="bmuted">A generated image of a living person can look slightly wrong, and the image model may refuse. An authentic photo is often better.</span>` : "";
          // Why the AI chose this picture: the viewer feeling it aimed for (psych) and the reason. Only shown to the editor, never drawn.
          const whyTip = [c.psych && `Viewer: ${c.psych}`, c.reason && `Why: ${c.reason}`].filter(Boolean).join("\n");
          const whyChip = cards && whyTip ? `<span class="bchip why-chip" tabindex="0" title="${esc(whyTip)}">why this picture</span>` : "";
          const badge = whyChip + (cards && b.needsRealImage ? `<span class="bro-real">Needs your own image: ${esc(b.searchHint || "")}</span>` : "") + logoBadge + personHint;
          const idea = cards ? `<button type="button" class="btn small p-newidea" ${S.ui.ideaId || busy ? "disabled" : ""} title="Ask the AI for a different card for this B-roll">${S.ui.ideaId === b.id ? "Thinking…" : "↻ New card idea"}</button>` : "";
          return `
          <div class="pcard" data-id="${esc(b.id)}">
            <div class="pmeta"><b>${fmtT(b.start)} → ${fmtT(b.end)}</b>${isGroup(b) ? ` · ${b.lines.length} lines, one picture` : ""} · ${esc(b.description)}</div>
            ${chips || badge || idea ? `<div class="pcard-tags">${chips}${badge}<span class="pcard-spacer"></span>${idea}</div>` : ""}
            <textarea class="p-text" rows="3" placeholder="${cards && (b.needsRealImage || b.source === "file") ? (b.source === "file" ? "No prompt: your own logo file is used, nothing is generated." : "No image prompt: use your own image for this one (or type a prompt).") : "Image prompt (write all, or type your own)"}">${esc(b.prompt)}</textarea>
          </div>`;
        }).join("");
        S.ui.prSig = prSig();
      }
    }
  }
  $("#b-prompt-list").addEventListener("input", ev => {
    if (!ev.target.classList.contains("p-text")) return;
    const b = S.P.brolls.find(x => x.id === ev.target.closest(".pcard").dataset.id);
    if (b) { b.prompt = ev.target.value; markDirty(); }
  });
  // "New card idea": the AI thinks of a different card for ONE B-roll (never the layout it has now); its prompt is rewritten.
  $("#b-prompt-list").addEventListener("click", async ev => {
    const logoBtn = ev.target.closest(".p-savelogo");
    if (logoBtn) {
      const lb = S.P.brolls.find(x => x.id === logoBtn.closest(".pcard").dataset.id); if (!lb) return;
      try { S.P = await api.brollPost(jobId, `save-logo/${encodeURIComponent(lb.id)}`); toast("Saved. Every later video uses this logo.", "success"); S.ui.prSig = ""; renderAll(); } catch (e) { fail(e); }
      return;
    }
    const btn = ev.target.closest(".p-newidea");
    if (!btn || S.ui.ideaId) return;
    const b = S.P.brolls.find(x => x.id === btn.closest(".pcard").dataset.id); if (!b) return;
    const images = S.P.flowJob && S.P.flowJob.items && S.P.flowJob.items.length;
    if ((b.prompt && b.prompt.trim() || images) &&
        !confirm("This replaces this card's prompt" + (images ? " and the generated images of this plan (they no longer match the prompts)" : "") + ". Continue?")) return;
    try {
      await flushSave();
      S.ui.ideaId = b.id; S.ui.prSig = ""; renderPrompts();
      let wish = "";
      if (S.P.llm.web) {
        wish = window.prompt('What should the new idea be? (optional, for example "make it a scene" or "use bars"). Leave empty for any different idea.', "");
        if (wish === null) { S.ui.ideaId = null; renderPrompts(); return; }
      }
      S.P = await api.brollPost(jobId, `card-idea/${encodeURIComponent(b.id)}`, { wish });
      toast("New card idea ready.");
    } catch (e) { fail(e); }
    finally { S.ui.ideaId = null; S.ui.broSig = S.ui.prSig = S.ui.jobSig = ""; S.ui.resSig = ""; renderAll(); }
  });
  async function runPrompts(onlyMissing) {
    if (!onlyMissing && S.P.brolls.some(b => b.enabled && b.prompt.trim()) && !confirm("This replaces all current prompts, including your edits. Continue?")) return;
    try {
      await flushSave();
      S.P = await api.brollPost(jobId, "prompts", { common: $("#b-common").value, suffix: $("#b-suffix").value, onlyMissing });
      S.ui.prSig = S.ui.jobSig = "";
      renderAll(); schedulePoll();
    } catch (e) { fail(e); }
  }
  $("#b-prompts").addEventListener("click", () => runPrompts(false));
  $("#b-prompts-missing").addEventListener("click", () => runPrompts(true));

  // ------------------------------------------------------------ 3. images
  function saveSettings() { try { localStorage.setItem("flowSettings", JSON.stringify(S.settings)); } catch { /* ignore */ } }
  function renderSettings() {
    const st = S.settings, o = S.opt;
    $("#b-ratios").innerHTML = o.ratios.map(r => {
      const [w, hh] = r.split(":").map(Number), k = 22 / Math.max(w, hh);
      return `<button type="button" class="bopt" role="radio" data-ratio="${esc(r)}" aria-checked="${st.ratio === r}"><span class="bshape" style="width:${Math.round(w * k)}px;height:${Math.round(hh * k)}px"></span><span class="bt">${esc(r)}</span></button>`;
    }).join("");
    $("#b-models").innerHTML = o.models.map(m => `<button type="button" class="bmodel" role="radio" data-model="${esc(m)}" aria-checked="${st.model === m}"><span class="bdotr"></span><span class="bt">${esc(m)}</span></button>`).join("");
    $("#b-counts").innerHTML = [1, 2, 3, 4].map(n => `<button type="button" class="bopt row" role="radio" data-count="${n}" aria-checked="${st.count === n}"><span class="bt">x${n}</span></button>`).join("");
  }
  function renderRefs() {
    const max = S.opt.maxReferenceImages;
    $("#b-refs").innerHTML = S.refs.map((r, i) => `<div class="bref"><img src="${esc(r.data)}" alt="Reference ${i + 1}" title="${esc(r.name)}"><span class="bn">${i + 1}</span><button type="button" class="bx2" data-remove="${i}" aria-label="Remove reference image ${i + 1}">×</button></div>`).join("") +
      (S.refs.length < max ? `<button type="button" class="bref-add" id="b-ref-add"><span class="bplus">+</span><span>Add reference image<br>or drop it here</span></button>` : "");
    $("#b-ref-count").textContent = `(${S.refs.length} / ${max})`;
  }
  async function addRefFiles(list) {
    setErr("#b-ref-err", "");
    const max = S.opt.maxReferenceImages, skipped = [];
    for (const f of [...list]) {
      if (S.refs.length >= max) { skipped.push(`Only ${max} reference images are allowed; extra files were ignored.`); break; }
      if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { skipped.push(`${f.name}: use a PNG, JPG or WebP image.`); continue; }
      if (f.size > MAX_REF_MB * 1048576) { skipped.push(`${f.name}: larger than ${MAX_REF_MB} MB.`); continue; }
      try { S.refs.push({ name: f.name, data: await readFile(f) }); } catch (e) { skipped.push(e.message); }
    }
    renderRefs();
    if (skipped.length) setErr("#b-ref-err", skipped.join(" "));
  }
  $("#b-ratios").addEventListener("click", ev => { const b = ev.target.closest("[data-ratio]"); if (b) { S.settings.ratio = b.dataset.ratio; saveSettings(); renderSettings(); } });
  $("#b-models").addEventListener("click", ev => { const b = ev.target.closest("[data-model]"); if (b) { S.settings.model = b.dataset.model; saveSettings(); renderSettings(); } });
  $("#b-counts").addEventListener("click", ev => { const b = ev.target.closest("[data-count]"); if (b) { S.settings.count = Number(b.dataset.count); saveSettings(); renderSettings(); } });
  $("#b-refs").addEventListener("click", ev => {
    const rm = ev.target.closest("[data-remove]");
    if (rm) { S.refs.splice(Number(rm.dataset.remove), 1); setErr("#b-ref-err", ""); renderRefs(); return; }
    if (ev.target.closest("#b-ref-add")) $("#b-ref-input").click();
  });
  $("#b-ref-input").addEventListener("change", async ev => { await addRefFiles(ev.target.files); ev.target.value = ""; });
  $("#b-refs").addEventListener("dragover", ev => { ev.preventDefault(); const a = $("#b-ref-add"); if (a) a.classList.add("drag"); });
  $("#b-refs").addEventListener("dragleave", () => { const a = $("#b-ref-add"); if (a) a.classList.remove("drag"); });
  $("#b-refs").addEventListener("drop", async ev => { ev.preventDefault(); const a = $("#b-ref-add"); if (a) a.classList.remove("drag"); await addRefFiles(ev.dataTransfer.files); });

  const eligible = P => P.brolls.filter(b => b.enabled && !b.cutOut && b.prompt.trim());

  function renderImages() {
    const P = S.P;
    const job = P.flowJob, n = eligible(P).length, total = P.brolls.filter(b => b.enabled && !b.cutOut).length;
    const jobRunning = job && ["running", "queued"].includes(job.status);
    $("#b-start").disabled = jobRunning || running(P) || n === 0;
    $("#b-start").textContent = n ? `Generate images for ${n} B-roll${n === 1 ? "" : "s"}` : "Generate images";
    $("#b-img-summary").textContent = !total ? "Plan the B-roll first (step 1)."
      : n < total ? `${total - n} enabled B-roll(s) have no prompt yet and will be skipped. Write them in step 2.`
        : `${S.settings.count} alternative${S.settings.count === 1 ? "" : "s"} per B-roll will be generated, so you can pick the best.`;
    show("#b-progress", !!job); show("#b-items", !!job); show("#b-job-status", !!job);
    show("#b-stop", !!jobRunning);
    show("#b-resume", !!job && !jobRunning && job.items.some(i => i.status !== "done"));
    if (!job) { show("#b-pick-row", false); return; }

    const chip = $("#b-job-status");
    chip.textContent = (job.mock ? "Test · " : "") + (JOB_TEXT[job.status] || job.status);
    chip.className = "bchip " + job.status;
    $("#b-job-settings").textContent = job.settings
      ? `${job.settings.model} · ${job.settings.ratio} · x${job.settings.count} per prompt · ${(job.refs || []).length} reference image${(job.refs || []).length === 1 ? "" : "s"}` : "";
    const done = job.items.filter(i => i.status === "done").length;
    $("#b-bar-fill").style.width = `${Math.round(done / Math.max(1, job.items.length) * 100)}%`;
    const log = $("#b-log"), atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
    log.textContent = job.log.slice(-60).join("\n") + (job.error ? `\nERROR: ${job.error}` : "");
    if (atBottom) log.scrollTop = log.scrollHeight;

    const picked = job.items.filter(i => i.selected).length;
    show("#b-pick-row", job.items.some(i => i.images.length));
    $("#b-sel-count").textContent = `${picked} of ${job.items.filter(i => i.images.length).length} selected`;
    const sig = JSON.stringify([job.items.map(i => [i.status, i.error, i.attention, i.selected, i.images.map(m => [m.file, m.keyedUrl])]), P.brolls.map(b => [b.id, b.start, b.end, b.cutOut])]);
    if (sig === S.ui.jobSig) return;
    S.ui.jobSig = sig;
    const byId = new Map(P.brolls.map(b => [b.id, b]));
    $("#b-items").innerHTML = job.items.filter(it => { const x = byId.get(it.brollId); return x && !x.cutOut; }).map(it => {
      const b = byId.get(it.brollId);
      const imgs = it.images.map(im => `<button class="bpick ${it.selected === im.file ? "sel" : ""}" data-index="${it.index}" data-file="${esc(im.file)}" title="Select this image"><img src="${esc(im.url)}" alt="Option for B-roll ${it.index + 1}" loading="lazy"><span class="btick">✓</span></button>`).join("");
      return `<div class="bitem"><div class="bitem-head"><span class="bitem-n">${it.index + 1}</span>
        <div class="bitem-p">${b ? `<div class="btime">${fmtT(b.start)} → ${fmtT(b.end)}</div>` : ""}${esc(it.prompt)}${it.error ? `<div class="bitem-err">${esc(it.error)}</div>` : ""}${it.attention === "person" ? `<div class="brow"><button class="btn small bitem-act" data-act="person-animated" data-id="${esc(it.brollId)}">Try animated</button><button class="btn small bitem-act" data-act="person-photo" data-id="${esc(it.brollId)}">Use a real photo</button></div>` : ""}${it.source === "file" ? `<div class="bmuted">Your own logo file</div>` : ""}</div>
        <span class="bchip ${it.status}">${ITEM_TEXT[it.status] || it.status}</span></div>
        ${imgs ? `<div class="bgrid">${imgs}</div>` : ""}</div>`;
    }).join("");
  }

  $("#b-items").addEventListener("click", async ev => {
    const btn = ev.target.closest(".bitem-act"); if (!btn) return;
    try {
      S.P = await api.brollPost(jobId, `${btn.dataset.act}/${encodeURIComponent(btn.dataset.id)}`);
      S.ui.prSig = S.ui.jobSig = ""; renderAll();
      toast(btn.dataset.act === "person-animated" ? "Will be drawn animated. Press Resume to generate it." : "Now it needs your own photo.");
    } catch (e) { fail(e); }
  });
  $("#b-launch").addEventListener("click", async () => {
    try {
      await api.brollGlobalPost("chrome", { claude: Boolean(S.P && S.P.llm && S.P.llm.web) });
      $("#b-launch").textContent = "Starting…";
      for (let i = 0; i < 20; i++) { await sleep(1000); await refreshStatus(); if ($("#pill-chrome").classList.contains("ok")) break; }
      loadProfiles();
    } catch (e) { setErr("#b-err", e.message); }
  });
  $("#b-test-claude").addEventListener("click", async () => {
    const out = $("#b-claude-test"), pill = $("#pill-claude");
    out.textContent = "Checking claude.ai in Chrome…";
    try {
      const r = await api.brollGlobal("claude-check");
      out.textContent = r.message; pill.hidden = false;
      pill.textContent = r.ready ? "Claude: ready" : "Claude: not ready"; pill.className = "bpill " + (r.ready ? "ok" : "warn");
    } catch (e) { out.textContent = e.message; pill.hidden = false; pill.textContent = "Claude: not ready"; pill.className = "bpill warn"; }
  });
  $("#b-inspect").addEventListener("click", async () => {
    const out = $("#b-inspect-out"); out.hidden = false; out.textContent = "Inspecting the Flow tab…";
    try {
      const r = await api.brollGlobal("inspect");
      out.textContent = `Page: ${r.title}\n${r.url}\n\nPrompt box candidates (${r.inputs.length}):\n` +
        (r.inputs.map(i => `  <${i.tag}> ${i.role ? `role=${i.role} ` : ""}"${i.placeholder}"`).join("\n") || "  none found") +
        `\n\nButtons (${r.buttons.length}):\n` + (r.buttons.map(b => `  "${b.text}"${b.aria ? ` aria-label="${b.aria}"` : ""}${b.disabled ? " (disabled)" : ""}`).join("\n") || "  none found") +
        `\n\nImages on page: ${r.images.length ? r.images.join(", ") : "none"}`;
    } catch (e) { out.textContent = e.message; }
  });
  $("#b-usage").addEventListener("click", async () => {
    const v = prompt("How many images does Flow say you've used today?", "0");
    if (v === null) return;
    try { await api.brollGlobalPost("usage", { count: Number(v) || 0 }); refreshStatus(); } catch (e) { fail(e); }
  });
  $("#b-start").addEventListener("click", async () => {
    setErr("#b-err", "");
    const old = S.P.flowJob;
    if (old && old.items.some(i => i.selected) && !confirm("This starts a new set of images and replaces your current selection. Continue?")) return;
    try {
      await flushSave();
      $("#b-start").disabled = true;
      S.P = await api.brollPost(jobId, "images", { mock: $("#b-mock").checked, settings: S.settings, refs: S.refs });
      S.ui.jobSig = "";
      renderAll(); schedulePoll();
    } catch (e) { setErr("#b-err", e.message); renderImages(); }
  });
  $("#b-stop").addEventListener("click", async () => {
    try { await api.brollGlobalPost(`flow/${S.P.flowJobId}/stop`); $("#b-stop").disabled = true; } catch (e) { fail(e); }
  });
  $("#b-resume").addEventListener("click", async () => {
    setErr("#b-err", "");
    try { await api.brollGlobalPost(`flow/${S.P.flowJobId}/resume`); await refreshProject(); schedulePoll(); } catch (e) { setErr("#b-err", e.message); }
  });
  $("#b-items").addEventListener("click", async ev => {
    const btn = ev.target.closest(".bpick");
    if (!btn || !S.P.flowJob) return;
    const index = Number(btn.dataset.index), already = S.P.flowJob.items[index].selected === btn.dataset.file;
    try {
      await api.brollGlobalPost(`flow/${S.P.flowJobId}/select`, { index, file: already ? null : btn.dataset.file });
      await refreshProject();
    } catch (e) { fail(e); }
  });
  $("#b-pick-first").addEventListener("click", async () => {
    try {
      for (const it of S.P.flowJob.items) {
        if (it.images.length && !it.selected) await api.brollGlobalPost(`flow/${S.P.flowJobId}/select`, { index: it.index, file: it.images[0].file });
      }
      await refreshProject();
    } catch (e) { fail(e); }
  });

  // ------------------------------------------------------------ 4. clips
  function renderClips() {
    const P = S.P, st = P.steps.render, job = P.flowJob;
    const byId = new Map(P.brolls.map(b => [b.id, b]));
    const sel = job ? job.items.filter(i => i.selected && byId.has(i.brollId) && byId.get(i.brollId).enabled && !byId.get(i.brollId).cutOut).length : 0;
    const tot = P.brolls.filter(b => b.enabled && !b.cutOut).length;
    setChip("#chip-clips", st.status);
    $("#b-render").disabled = running(P) || sel === 0;
    $("#b-render").textContent = st.status === "running" ? "Working…" : st.status === "done" ? "Make clips again" : "Make clips";
    $("#b-rd-msg").textContent = sel === 0 ? "Choose images in step 3 first." : `${sel} of ${tot} B-rolls have a chosen image.`;
    $("#b-rd-hint").textContent = sel > 0 && sel < tot ? `${tot - sel} B-roll(s) have no chosen image: the previous clip will cover their time, so nothing is missing.` : "";
    setErr("#b-render-err", st.status === "failed" ? st.error : "");
    setLog("#b-render-log", P, st.status === "running");
    show("#b-rd-progress", st.status === "running");
    if (st.status === "running" && st.progress) $("#b-rd-fill").style.width = `${Math.round(st.progress.done / Math.max(1, st.progress.total) * 100)}%`;
    const r = st.status === "done" ? st.result : null;
    show("#b-result-card", !!r);
    if (!r) { S.ui.resSig = ""; return; }
    const sig = JSON.stringify([r.outputDir, r.clips.map(c => c.file)]);
    if (sig === S.ui.resSig) return;
    S.ui.resSig = sig;
    $("#b-rd-info").textContent = `${r.clips.length} clips · ${r.fps} fps · ${dur(r.durationSec)} total`;
    $("#b-rd-warnings").innerHTML = r.warnings.map(w => `<div class="bwarn">${esc(w)}</div>`).join("");
    $("#b-rd-where").textContent = `Saved in: ${r.outputDir}. Together the clips cover 0:00.000 → ${fmtT(r.durationSec)} of the exported video with no gaps.`;
    $("#b-rd-links").innerHTML = `<button type="button" class="btn primary" id="b-open-folder">Open folder</button>` +
      `<a class="btn" href="${esc(r.timeline.csv)}" download>timeline.csv</a><a class="btn" href="${esc(r.timeline.json)}" download>timeline.json</a>`;
    $("#b-rd-clips").innerHTML = r.clips.map(c => `<div><span class="bt2">${fmtT(c.start)} → ${fmtT(c.end)} (${c.duration.toFixed(2)} s · ${c.width}×${c.height})</span><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.file)}</a><span class="bmuted">${esc((c.description || "").slice(0, 70))}</span></div>`).join("");
  }
  // ---- Premiere-ready files
  function renderPremiere() {
    const P = S.P, st = P.steps.premiere || { status: "idle" };
    const sel = chosen.length;
    $("#b-premiere").disabled = running(P) || sel === 0;
    $("#b-premiere").textContent = st.status === "running" ? "Working…" : st.status === "done" ? "Make Premiere files again" : "Make Premiere files";
    $("#b-pre-msg").textContent = sel === 0 ? "Choose images in step 3 first." : `${sel} picture${sel === 1 ? "" : "s"} will be placed.`;
    const chip = $("#b-pr-chip"); chip.textContent = STEP_TEXT[st.status] || ""; chip.className = "bchip " + st.status;
    setErr("#b-pr-err", st.status === "failed" ? st.error : "");
    show("#b-pr-progress", st.status === "running");
    const r = st.status === "done" ? st.result : null;
    show("#b-pr-where", !!r); show("#b-pr-links", !!r);
    $("#b-pr-warnings").innerHTML = r ? r.warnings.map(w => `<div class="bwarn">${esc(w)}</div>`).join("") : "";
    if (!r) return;
    $("#b-pr-where").textContent = `Saved in: ${r.outputDir}. ${r.count} picture(s), ${r.width}×${r.height}, ${r.fps} fps, ${dur(r.durationSec)} long (${(r.trackBytes / 1048576).toFixed(0)} MB).`;
    $("#b-pr-links").innerHTML = `<button type="button" class="btn primary" id="b-pr-open">Open folder</button>` +
      `<a class="btn" href="${esc(r.track)}" download>broll_track.mov</a><a class="btn" href="${esc(r.xml)}" download>broll_sequence.xml</a>`;
  }
  $("#b-premiere").addEventListener("click", async () => {
    try {
      await beforeAction?.();
      await flushSave();
      S.P = await api.brollPost(jobId, "premiere", { outputDir: $("#b-dir").value.trim(), fit: S.fit });
      renderAll(); schedulePoll();
    } catch (e) { fail(e); }
  });
  $("#b-pr-links").addEventListener("click", async ev => {
    if (!ev.target.closest("#b-pr-open")) return;
    try { await api.brollPost(jobId, "open-folder", { which: "premiere" }); } catch (e) { fail(e); }
  });

  $("#b-rd-links").addEventListener("click", async ev => {
    if (!ev.target.closest("#b-open-folder")) return;
    try { await api.brollPost(jobId, "open-folder"); } catch (e) { fail(e); }
  });
  let rdT;
  $("#b-dir").addEventListener("input", () => {
    clearTimeout(rdT);
    rdT = setTimeout(() => api.brollPost(jobId, "options", { render: { outputDir: $("#b-dir").value } }).catch(() => {}), 600);
  });
  $("#b-render").addEventListener("click", async () => {
    try {
      await beforeAction?.();
      await flushSave();
      S.ui.resSig = "";
      S.P = await api.brollPost(jobId, "render", { outputDir: $("#b-dir").value.trim() });
      renderAll(); schedulePoll();
    } catch (e) { fail(e); }
  });

  // ------------------------------------------------------------ everything
  function renderDots() {
    const P = S.P;
    const job = P.flowJob;
    const set = (id, status) => { $(id).className = "bdot " + (status || ""); };
    set("#dot-plan", P.steps.plan.status === "done" ? "done" : P.steps.plan.status === "running" ? "running" : P.steps.plan.status === "failed" ? "failed" : "");
    set("#dot-prompts", P.steps.prompts.status === "done" ? "done" : P.steps.prompts.status === "running" ? "running" : P.steps.prompts.status === "failed" ? "failed" : "");
    set("#dot-images", job ? (["running", "queued"].includes(job.status) ? "running" : job.items.some(i => i.selected) ? "done" : "") : "");
    set("#dot-clips", P.steps.render.status === "done" ? "done" : P.steps.render.status === "running" ? "running" : P.steps.render.status === "failed" ? "failed" : "");
  }

  // Pictures made before Ultra Key existed (or whose key failed) get their transparent copy once.
  function backfillKeys() {
    const P = S.P, job = P && P.flowJob;
    if (S.keyAsked || !job || !P.ultraKey || !P.ultraKey.enabled || P.options.ultraKey === false || job.status === "running") return;
    const byId = new Map(P.brolls.map(b => [b.id, b]));
    const missing = job.items.some(i => { const b = byId.get(i.brollId); return b && P.ultraKey.modes.includes(b.mode) && i.images.some(m => !m.keyedUrl); });
    if (!missing) return;
    S.keyAsked = true;
    api.brollPost(jobId, "key").then(P2 => { S.P = P2; S.ui.jobSig = ""; renderAll(); }).catch(() => {});
  }

  function renderAll() {
    const P = S.P;
    if (!P || S.destroyed) return;
    if (document.activeElement !== $("#b-common") && document.activeElement !== $("#b-suffix")) {
      $("#b-common").value = P.options.prompts.common; $("#b-suffix").value = P.options.prompts.suffix;
    }
    if (document.activeElement !== $("#b-dir")) $("#b-dir").value = P.options.render.outputDir || "";
    backfillKeys();
    renderHeader(); renderTheme(); renderPlan(); renderPrompts(); renderImages(); renderClips(); renderPremiere(); renderDots();
    const next = computeChosen();
    const changed = JSON.stringify(next) !== JSON.stringify(chosen);
    chosen = next;
    renderNav();
    if (changed) { paint(video.currentTime); onChange?.(); }
    schedulePoll();
  }

  async function init() {
    try { S.opt = { ...S.opt, ...(await api.brollGlobal("options")) }; } catch { /* old server */ }
    Object.assign(S.settings, S.opt.defaults);
    try {
      const saved = JSON.parse(localStorage.getItem("flowSettings") || "null");
      if (saved) {
        if (S.opt.ratios.includes(saved.ratio)) S.settings.ratio = saved.ratio;
        if (S.opt.models.includes(saved.model)) S.settings.model = saved.model;
        if ([1, 2, 3, 4].includes(saved.count)) S.settings.count = saved.count;
      }
    } catch { /* ignore */ }
    if (!S.settings.model) S.settings.model = S.opt.models[0] || "";
    renderSettings(); renderRefs();
    showSub("plan");
    await refreshProject();
  }
  init();

  return {
    panel: root,
    paint,
    refresh: refreshProject,
    chosenCount: () => chosen.length,
    include: () => S.include,
    fit: () => S.fit,
    setInclude(v) { S.include = Boolean(v); saveView(); renderHeader(); paint(video.currentTime); },
    setFit(v) { S.fit = v === "contain" ? "contain" : "cover"; saveView(); renderHeader(); paint(video.currentTime); },
    setActive(on) {
      S.active = on; syncStatusTimer(); paint(video.currentTime);
      if (on) Promise.resolve(beforeAction?.()).catch(() => {}).then(refreshProject); // save the cuts first so the cut info is current
    },
    flush: flushSave,
    destroy() {
      S.destroyed = true;
      clearTimeout(S.pollT); clearInterval(S.statusT); clearTimeout(S.ui.saveT); clearTimeout(optT); clearTimeout(rdT);
      ro.disconnect();
      layer.remove();
    }
  };
}
