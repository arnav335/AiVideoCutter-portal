import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const INPUT_PATH = path.resolve(
    __dirname,
    "../../output/sentenceBySentenceTranscription.srt"
);

const OUTPUT_PATH = path.resolve(
    __dirname,
    "../../output/annotatedSentenceBySentenceTranscription.srt"
);

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

import { SYSTEM_PROMPT } from "../prompts/retakePrompt.js";

// Parse SRT while preserving its original formatting.
function parseSrt(transcript) {
    const parts = transcript.split(
        /(\r\n[ \t]*\r\n|\n[ \t]*\n|\r[ \t]*\r)/
    );

    const segments = [];
    const blocks = [];

    for (let i = 0; i < parts.length; i += 2) {
        const block = parts[i];

        if (!block || !block.trim()) {
            continue;
        }

        const match = block.match(
            /^(\uFEFF?\d+)(\r\n|\n|\r)([^\r\n]*-->[^\r\n]*)(\r\n|\n|\r)([\s\S]*)$/
        );

        if (!match) {
            throw new Error(
                `Could not parse SRT block:\n${block.slice(0, 150)}`
            );
        }

        const [
            ,
            rawId,
            firstLineBreak,
            timestamp,
            secondLineBreak,
            rawText
        ] = match;

        const id = Number(rawId.replace("\uFEFF", ""));

        if (!Number.isInteger(id)) {
            throw new Error(`Invalid subtitle ID: ${rawId}`);
        }

        const trailingNewlines = rawText.match(/(?:\r\n|\n|\r)+$/)?.[0] || "";

        const text = trailingNewlines
            ? rawText.slice(0, -trailingNewlines.length)
            : rawText;

        if (!text.trim()) {
            throw new Error(`Subtitle ${id} has no text.`);
        }

        if (segments.some(segment => segment.id === id)) {
            throw new Error(`Duplicate subtitle ID: ${id}`);
        }

        segments.push({
            id,
            timestamp,
            text
        });

        blocks.push({
            id,
            partIndex: i,
            prefix: rawId + firstLineBreak + timestamp + secondLineBreak,
            text,
            trailingNewlines
        });
    }

    if (segments.length === 0) {
        throw new Error("No valid subtitle segments found.");
    }

    return { parts, segments, blocks };
}

// Ask Groq which segments (or parts of segments) should be removed.
async function getRemovalDecisions(segments) {
    if (!GROQ_API_KEY) {
        throw new Error("GROQ_API_KEY is missing from your .env file.");
    }

    const response = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${GROQ_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: GROQ_MODEL,

                messages: [
                    {
                        role: "system",
                        content: SYSTEM_PROMPT
                    },
                    {
                        role: "user",
                        content:
                            "Review this recording and identify the subtitle IDs (or parts of subtitles) to remove:\n\n" +
                            JSON.stringify(segments, null, 2)
                    }
                ],

                response_format: {
                    type: "json_schema",
                    json_schema: {
                        name: "editorial_decisions",
                        strict: true,
                        schema: {
                            type: "object",
                            properties: {
                                analysis: {
                                    type: "array",
                                    items: { type: "string" }
                                },
                                remove_segment_ids: {
                                    type: "array",
                                    items: { type: "integer" }
                                },
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
                            required: [
                                "analysis",
                                "remove_segment_ids",
                                "partial_removals"
                            ],
                            additionalProperties: false
                        }
                    }
                },

                max_completion_tokens: 8192,
                reasoning_effort: "medium"
            })
        }
    );

    const responseText = await response.text();

    if (!response.ok) {
        throw new Error(
            `Groq API error (${response.status}):\n${responseText}`
        );
    }

    let data;

    try {
        data = JSON.parse(responseText);
    } catch {
        throw new Error("Groq returned an invalid API response.");
    }

    const content = data.choices?.[0]?.message?.content;

    if (!content) {
        throw new Error("Groq returned an empty response.");
    }

    let result;

    try {
        result = JSON.parse(content);
    } catch {
        throw new Error(
            `Could not parse Groq's editorial decisions:\n${content}`
        );
    }

    if (
        !Array.isArray(result.remove_segment_ids) ||
        !Array.isArray(result.partial_removals)
    ) {
        throw new Error("Groq returned an invalid response shape.");
    }

    if (Array.isArray(result.analysis) && result.analysis.length > 0) {
        console.log("Model analysis:");
        for (const note of result.analysis) {
            console.log(`  - ${note}`);
        }
        console.log("");
    }

    const validIds = new Set(segments.map(segment => segment.id));

    for (const id of result.remove_segment_ids) {
        if (!Number.isInteger(id) || !validIds.has(id)) {
            throw new Error(`Groq returned an unknown segment ID: ${id}`);
        }
    }

    const removeIds = new Set(result.remove_segment_ids);
    const partials = new Map(); // segment id -> array of snippets

    for (const item of result.partial_removals) {
        if (!validIds.has(item.segment_id)) {
            console.warn(
                `Ignoring partial removal for unknown ID ${item.segment_id}`
            );
            continue;
        }

        // A whole-segment removal always wins over a partial one.
        if (removeIds.has(item.segment_id)) {
            continue;
        }

        if (!partials.has(item.segment_id)) {
            partials.set(item.segment_id, []);
        }

        partials.get(item.segment_id).push(item.remove_text);
    }

    return { removeIds, partials };
}

// Wrap each snippet found in the text with [ ].
// Snippets that can't be found verbatim are skipped, so the text stays
// untouched (safe default: nothing gets wrongly deleted).
function markPartialText(text, snippets, id) {
    const lowerText = text.toLowerCase();
    const ranges = [];

    for (const raw of snippets) {
        const snippet = raw.trim();

        if (!snippet) {
            continue;
        }

        const lowerSnippet = snippet.toLowerCase();
        let start = -1;
        let from = 0;

        // Find the first occurrence that doesn't overlap an existing range.
        while (true) {
            const idx = lowerText.indexOf(lowerSnippet, from);

            if (idx === -1) {
                break;
            }

            const end = idx + snippet.length;

            if (!ranges.some(([s, e]) => idx < e && end > s)) {
                start = idx;
                break;
            }

            from = idx + 1;
        }

        if (start === -1) {
            console.warn(
                `[${id}] Partial text not found, skipped: "${snippet}"`
            );
            continue;
        }

        ranges.push([start, start + snippet.length]);
    }

    ranges.sort((a, b) => a[0] - b[0]);

    let result = "";
    let cursor = 0;

    for (const [s, e] of ranges) {
        result += text.slice(cursor, s) + "[" + text.slice(s, e) + "]";
        cursor = e;
    }

    return result + text.slice(cursor);
}

// Apply decisions to the ORIGINAL SRT.
// No transcript text is rewritten or reconstructed by Groq.
function applyAnnotations(parts, blocks, removeIds, partials) {
    const outputParts = [...parts];

    for (const block of blocks) {
        let annotatedText = block.text;

        if (removeIds.has(block.id)) {
            annotatedText = `[${block.text}]`;
        } else if (partials.has(block.id)) {
            annotatedText = markPartialText(
                block.text,
                partials.get(block.id),
                block.id
            );
        }

        outputParts[block.partIndex] =
            block.prefix +
            annotatedText +
            block.trailingNewlines;
    }

    return outputParts.join("");
}

// Main function.
export async function cleanTranscript() {
    console.log("Reading transcript...");

    const originalTranscript = await fs.readFile(
        INPUT_PATH,
        "utf8"
    );

    const { parts, segments, blocks } = parseSrt(originalTranscript);

    console.log(`Found ${segments.length} subtitle segments.`);
    console.log(`Using Groq model: ${GROQ_MODEL}`);
    console.log("Sending transcript to Groq for editorial decisions...\n");

    const { removeIds, partials } = await getRemovalDecisions(segments);

    console.log("Editorial decisions received.");
    console.log(`Segments fully removed: ${removeIds.size}`);
    console.log(`Segments partially trimmed: ${partials.size}`);
    console.log(
        `Segments untouched: ${
            segments.length - removeIds.size - partials.size
        }\n`
    );

    const annotatedTranscript = applyAnnotations(
        parts,
        blocks,
        removeIds,
        partials
    );

    await fs.writeFile(
        OUTPUT_PATH,
        annotatedTranscript,
        "utf8"
    );

    console.log("Annotated transcript saved:");
    console.log(OUTPUT_PATH);

    console.log("\nSegments fully marked for removal:");

    for (const segment of segments) {
        if (removeIds.has(segment.id)) {
            console.log(`[${segment.id}] ${segment.text}`);
        }
    }

    console.log("\nSegments partially marked:");

    for (const block of blocks) {
        if (partials.has(block.id)) {
            console.log(
                `[${block.id}] ${markPartialText(
                    block.text,
                    partials.get(block.id),
                    block.id
                )}`
            );
        }
    }

    return annotatedTranscript;
}

export default cleanTranscript;