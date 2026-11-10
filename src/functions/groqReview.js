import { SYSTEM_PROMPT } from "../prompts/retakePrompt.js";
import { fmtSrt, segmentText } from "../shared/editModel.js";

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    analysis: { type: "array", items: { type: "string" } },
    remove_segment_ids: { type: "array", items: { type: "integer" } },
    partial_removals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          segment_id: { type: "integer" },
          remove_text: { type: "string" }
        },
        required: ["segment_id", "remove_text"],
        additionalProperties: false
      }
    }
  },
  required: ["analysis", "remove_segment_ids", "partial_removals"],
  additionalProperties: false
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// When the model runs out of tokens while "thinking" it returns nothing and Groq
// answers 400 json_validate_failed. Retry with less reasoning and more room.
const EFFORT_LADDER = ["high", "medium", "low"];

async function callGroq({ payload, apiKey, model, baseUrl, reasoningEffort }) {
  let effortIndex = Math.max(0, EFFORT_LADDER.indexOf(reasoningEffort));
  let maxTokens = 16384;
  let lastError;

  for (let attempt = 0; attempt < 5; attempt++) {
    const body = JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content:
            "Review this recording and identify the subtitle IDs (or parts of subtitles) to remove:\n\n" +
            JSON.stringify(payload, null, 2)
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "editorial_decisions", strict: true, schema: RESPONSE_SCHEMA }
      },
      max_completion_tokens: maxTokens,
      reasoning_effort: EFFORT_LADDER[effortIndex]
    });

    let response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(240_000)
      });
    } catch (error) {
      lastError = new Error(`Could not reach Groq: ${error.message}`);
      await sleep(1500 * (attempt + 1));
      continue;
    }

    const text = await response.text();

    if (response.ok) {
      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error("Groq returned an invalid API response."); }

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        lastError = new Error("Groq returned an empty response.");
        effortIndex = Math.min(EFFORT_LADDER.length - 1, effortIndex + 1);
        maxTokens = Math.min(32768, maxTokens * 2);
        continue;
      }

      try { return JSON.parse(content); }
      catch { throw new Error(`Could not parse Groq's decisions:\n${content.slice(0, 300)}`); }
    }

    lastError = new Error(`Groq API error (${response.status}): ${text.slice(0, 400)}`);

    if (response.status === 400 && text.includes("json_validate_failed")) {
      if (effortIndex < EFFORT_LADDER.length - 1) effortIndex++;
      else maxTokens = Math.min(32768, maxTokens * 2);
      continue;
    }

    // Retry rate limits and server errors only.
    if (response.status === 429 || response.status >= 500) {
      const wait = Number(response.headers.get("retry-after")) * 1000 || 2000 * (attempt + 1);
      await sleep(Math.min(wait, 20_000));
      continue;
    }
    throw lastError;
  }

  throw lastError;
}

// Ask Groq which sentences (or parts of sentences) to cut.
// Long transcripts are reviewed in chunks; each chunk also sees a few
// neighbouring sentences so retakes that straddle a boundary are still caught,
// but only decisions about the chunk's own sentences are kept.
export async function reviewWithGroq({
  words,
  segments,
  apiKey = process.env.GROQ_API_KEY,
  model = process.env.GROQ_MODEL || "openai/gpt-oss-20b",
  baseUrl = process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
  reasoningEffort = process.env.GROQ_REASONING_EFFORT || "medium",
  chunkSize = 100,
  context = 10,
  onProgress
}) {
  if (!apiKey) throw new Error("GROQ_API_KEY is missing from your .env file.");
  if (segments.length === 0) return { removeIds: [], partials: [], analysis: [], model };

  const toPayload = seg => ({
    id: seg.id,
    timestamp: `${fmtSrt(seg.start)} --> ${fmtSrt(seg.end)}`,
    text: segmentText(words, seg)
  });

  const chunks = [];
  for (let from = 0; from < segments.length; from += chunkSize) {
    chunks.push({
      ownFrom: from,
      ownTo: Math.min(segments.length, from + chunkSize),
      sendFrom: Math.max(0, from - context),
      sendTo: Math.min(segments.length, from + chunkSize + context)
    });
  }

  const removeIds = new Set();
  const partials = [];
  const analysis = [];

  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    onProgress?.(chunks.length > 1
      ? `Reviewing part ${c + 1} of ${chunks.length}...`
      : "Reviewing the transcript...");

    const payload = segments.slice(chunk.sendFrom, chunk.sendTo).map(toPayload);
    const result = await callGroq({ payload, apiKey, model, baseUrl, reasoningEffort });

    const ownIds = new Set(segments.slice(chunk.ownFrom, chunk.ownTo).map(s => s.id));

    for (const id of result.remove_segment_ids || []) {
      if (ownIds.has(id)) removeIds.add(id);
    }
    for (const item of result.partial_removals || []) {
      if (ownIds.has(item.segment_id) && typeof item.remove_text === "string") {
        partials.push({ segment_id: item.segment_id, remove_text: item.remove_text });
      }
    }
    for (const note of result.analysis || []) analysis.push(String(note));
  }

  return { removeIds: [...removeIds].sort((a, b) => a - b), partials, analysis, model };
}
