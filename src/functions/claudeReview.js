// Retake review with Claude (claude.ai chat driven through the signed-in Chrome), as an alternative to Groq.
// Returns the same shape as reviewWithGroq: { removeIds, partials, analysis, model }.
// No fallback to Groq and no Chrome pre-check: errors from claudeWeb (AUTH, NETWORK, ...) propagate to the step.
import claudeWebModule from "../broll/claudeWeb.js";
import llmModule from "../broll/llm.js";
import configModule from "../broll/config.js";
import { applyDecisions, normToken, segmentText, tokenize } from "../shared/editModel.js";
import { CLAUDE_RETAKE_PROMPT, CLAUDE_REPAIR_PROMPT, CLAUDE_VERIFY_PROMPT } from "../prompts/retakePromptClaude.js";

const { makeClaudeWeb, resetChat } = claudeWebModule;
const { parseJson } = llmModule;
const { loadConfig } = configModule;

export const CLAUDE_MODEL_LABEL = "claude.ai chat";

const DEFAULTS = { maxCutRatio: 0.25, longWholeWords: 12, pauseFlagSec: 0.8, partMaxWords: 6000, contextSegments: 10, maxVerifyItems: 60 };

const defaultLlm = onProgress => makeClaudeWeb({ cfg: loadConfig(), log: m => onProgress?.(m) });

// ---------- compact input ----------

export function fmtStart(seconds) {
  const tenths = Math.round(Math.max(0, seconds) * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths % 600) / 10;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

export function fmtPause(seconds) {
  return `+${Math.max(0, seconds).toFixed(1)}s`;
}

function transcriptLine(words, segments, i) {
  const seg = segments[i];
  const pause = i === 0 ? "-" : fmtPause(seg.start - segments[i - 1].end);
  return `${seg.id} | ${fmtStart(seg.start)} | ${pause} | ${segmentText(words, seg)}`;
}

export function buildTranscriptMessage({ words, segments, sendFrom, sendTo, ownFrom, ownTo, part, parts }) {
  const lines = [];
  for (let i = sendFrom; i < sendTo; i++) lines.push(transcriptLine(words, segments, i));
  const first = segments[sendFrom].id;
  const last = segments[sendTo - 1].id;
  const out = [
    "<transcript>",
    "Format: id | start | pause before | text",
    ...lines,
    "</transcript>",
    `Lines in this message: ${first}-${last}. (Part ${part} of ${parts}.)`
  ];
  if (parts > 1) {
    out.push(`You decide cuts only for ids ${segments[ownFrom].id}-${segments[ownTo - 1].id}. The other lines are context. Earlier parts of this video are above in this chat.`);
  }
  out.push("Reply with only the JSON.");
  return out.join("\n");
}

// ---------- helpers ----------

const maskCount = mask => { let n = 0; for (const v of mask) if (v) n++; return n; };

// Is remove_text found as a token sequence inside the segment (same matching as applyDecisions)?
function partialMatches(norm, seg, text) {
  if (!seg) return false;
  const tokens = tokenize(text);
  if (tokens.length === 0) return true; // applyDecisions ignores empty ones silently
  for (let i = seg.w0; i + tokens.length <= seg.w1; i++) {
    let ok = true;
    for (let k = 0; k < tokens.length; k++) if (norm[i + k] !== tokens[k]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

async function askJson(llm, system, user) {
  let text = await llm.chat({ system, user });
  try { return parseJson(text); }
  catch {
    text = await llm.chat({ system, user });   // ask ONCE more; a second failure rethrows
    return parseJson(text);
  }
}

async function askJsonOnce(llm, system, user) {
  return parseJson(await llm.chat({ system, user }));
}

const asArray = v => (Array.isArray(v) ? v : []);

// ---------- the reviewer ----------

export async function reviewWithClaude({ words, segments, onProgress, llm, cfg = loadConfig().claudeCut }) {
  const model = CLAUDE_MODEL_LABEL;
  if (segments.length === 0) return { removeIds: [], partials: [], analysis: [], model };

  const c = { ...DEFAULTS, ...(cfg || {}) };
  const usingDefault = !llm;
  llm = llm || defaultLlm(onProgress);

  // A fresh claude.ai chat per cut run: the follow-up messages depend on the conversation.
  const reset = llm.resetChat || (usingDefault ? resetChat : null);
  if (reset) reset();

  const byId = new Map(segments.map(s => [s.id, s]));
  const norm = words.map(w => normToken(w.t));

  // ----- parts -----
  const ranges = [];
  if (words.length <= c.partMaxWords) {
    ranges.push([0, segments.length]);
  } else {
    let from = 0;
    let count = 0;
    for (let i = 0; i < segments.length; i++) {
      count += segments[i].w1 - segments[i].w0;
      if (count >= c.partMaxWords) { ranges.push([from, i + 1]); from = i + 1; count = 0; }
    }
    if (from < segments.length) ranges.push([from, segments.length]);
  }

  // ----- MESSAGE 1 (per part) -----
  let removeIds = [];
  let partials = [];
  const analysis = [];
  const removeSet = new Set();

  onProgress?.("Claude is reviewing the transcript... this can take a few minutes");
  for (let p = 0; p < ranges.length; p++) {
    const [ownFrom, ownTo] = ranges[p];
    if (ranges.length > 1) onProgress?.(`Reviewing part ${p + 1} of ${ranges.length}...`);
    const user = buildTranscriptMessage({
      words, segments,
      sendFrom: Math.max(0, ownFrom - c.contextSegments),
      sendTo: Math.min(segments.length, ownTo + c.contextSegments),
      ownFrom, ownTo, part: p + 1, parts: ranges.length
    });
    const result = await askJson(llm, CLAUDE_RETAKE_PROMPT, user);
    const ownIds = new Set(segments.slice(ownFrom, ownTo).map(s => s.id));

    for (const id of asArray(result?.remove_segment_ids)) if (ownIds.has(id)) removeSet.add(id);
    for (const item of asArray(result?.partial_removals)) {
      if (item && ownIds.has(item.segment_id) && typeof item.remove_text === "string") {
        partials.push({ segment_id: item.segment_id, remove_text: item.remove_text });
      }
    }
    for (const note of asArray(result?.analysis)) analysis.push(String(note));
  }
  removeIds = [...removeSet];

  // ----- local checks -----
  const isUnmatched = item => !partialMatches(norm, byId.get(item.segment_id), item.remove_text);
  const unmatched = partials.filter(item => !removeSet.has(item.segment_id) && isUnmatched(item));

  // ----- MESSAGE 2a: repair -----
  if (unmatched.length) {
    onProgress?.("Fixing a few cut texts...");
    const lines = unmatched.map(item => {
      const seg = byId.get(item.segment_id);
      const real = seg ? segmentText(words, seg) : "(this segment does not exist)";
      return `[segment ${item.segment_id}] you wrote: ${JSON.stringify(item.remove_text)}   the line is: ${JSON.stringify(real)}`;
    });
    const user = `<not_found>\n${lines.join("\n")}\n</not_found>`;
    const unmatchedIds = new Set(unmatched.map(u => u.segment_id));
    let corrected = [];
    try {
      const fixed = await askJsonOnce(llm, CLAUDE_REPAIR_PROMPT, user);
      corrected = asArray(fixed?.partial_removals).filter(item =>
        item && unmatchedIds.has(item.segment_id) && typeof item.remove_text === "string" &&
        partialMatches(norm, byId.get(item.segment_id), item.remove_text));
    } catch { /* repair failed: just drop them */ }
    const drop = new Set(unmatched);
    partials = partials.filter(item => !drop.has(item));
    for (const item of corrected) partials.push({ segment_id: item.segment_id, remove_text: item.remove_text });
  }

  // ----- local checks again (after repair) -----
  const measure = () => {
    const { mask } = applyDecisions(words, segments, { removeIds, partials });
    return maskCount(mask) / words.length;
  };
  const cutRatio = measure();
  const longWhole = removeIds.filter(id => {
    const s = byId.get(id);
    return s && (s.w1 - s.w0) > c.longWholeWords;
  });
  const overBudget = cutRatio > c.maxCutRatio;

  // ----- MESSAGE 2b: verify -----
  if (overBudget || longWhole.length) {
    onProgress?.("Claude is checking a few cuts...");
    const items = [];
    const wholeSet = new Set(removeIds);
    const addWhole = id => { const s = byId.get(id); if (s) items.push({ kind: "whole", id, size: s.w1 - s.w0 }); };
    if (overBudget) {
      removeIds.forEach(addWhole);
      for (const p of partials) {
        if (wholeSet.has(p.segment_id) || !byId.has(p.segment_id)) continue;
        items.push({ kind: "part", id: p.segment_id, text: p.remove_text, size: tokenize(p.remove_text).length });
      }
    } else {
      longWhole.forEach(addWhole);
    }
    const chosen = items.sort((a, b) => b.size - a.size).slice(0, c.maxVerifyItems).sort((a, b) => a.id - b.id);

    const indexOf = new Map(segments.map((s, i) => [s.id, i]));
    const q = i => (segments[i] ? JSON.stringify(segmentText(words, segments[i])) : null);
    const ctxLine = (label, idx, step) => {
      const parts = [];
      for (let k = 1; k <= 2; k++) {
        const j = idx + step * k;
        if (segments[j]) parts.push(`${label} ${segments[j].id}: ${q(j)}`);
      }
      return parts.join("   ");
    };
    const blocks = chosen.map(it => {
      const i = indexOf.get(it.id);
      const head = it.kind === "whole"
        ? `[${it.id}] CUT WHOLE LINE (${it.size} words): ${q(i)}`
        : `[${it.id}] CUT PART ${JSON.stringify(it.text)} of: ${q(i)}`;
      return [head, `  ${ctxLine("before", i, -1)}`, `  ${ctxLine("after", i, 1)}`]
        .filter(l => l.trim()).join("\n");
    });
    let user = `<proposed_cuts>\n${blocks.join("\n")}\n</proposed_cuts>`;
    if (overBudget) user += `\nCuts are currently ${Math.round(cutRatio * 100)} percent of all words (limit ${Math.round(c.maxCutRatio * 100)}). Be strict.`;

    try {
      const v = await askJsonOnce(llm, CLAUDE_VERIFY_PROMPT, user);
      const undo = new Set(asArray(v?.undo_ids).map(Number));
      removeIds = removeIds.filter(id => !undo.has(id));
      const undoParts = asArray(v?.undo_partials)
        .filter(u => u && typeof u.remove_text === "string")
        .map(u => `${u.segment_id}|${normToken(u.remove_text)}`);
      const undoSet = new Set(undoParts);
      partials = partials.filter(p => !undoSet.has(`${p.segment_id}|${normToken(p.remove_text)}`));
      for (const note of asArray(v?.notes)) analysis.push(String(note));
    } catch {
      analysis.push("Verification could not be done.");
    }
  }

  return { removeIds: removeIds.sort((a, b) => a - b), partials, analysis, model };
}
