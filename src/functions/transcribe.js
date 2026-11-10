import { BatchClient } from "@speechmatics/batch-client";
import { openAsBlob } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fmtSrt, round3 } from "../shared/editModel.js";

// Extract words and attach punctuation to the preceding word.
function extractWords(results) {
  const words = [];

  for (const result of results) {
    const content = result.alternatives?.[0]?.content;
    if (!content) continue;

    if (
      result.type === "punctuation" &&
      result.attaches_to === "previous" &&
      words.length > 0
    ) {
      words[words.length - 1].t += content;
      continue;
    }

    if (result.type !== "word") continue;

    words.push({
      t: content,
      s: round3(result.start_time),
      e: round3(result.end_time)
    });
  }

  return words;
}

// Transcribe an audio file with Speechmatics and return [{ t, s, e }].
export async function transcribeAudio({
  inputPath,
  apiKey = process.env.SPEECHMATICS_API_KEY,
  language = "en",
  onStatus
} = {}) {
  if (!apiKey) {
    throw new Error("SPEECHMATICS_API_KEY is missing from your .env file.");
  }

  await fs.access(inputPath);

  const client = new BatchClient({ apiKey, appId: "AiVideoCutter" });

  onStatus?.("Uploading audio to Speechmatics...");

  const blob = await openAsBlob(inputPath);
  const file = new File([blob], path.basename(inputPath));

  onStatus?.("Transcribing...");

  let response;
  try {
    response = await client.transcribe(
      file,
      {
        transcription_config: {
          language,
          model: "enhanced"
        }
      },
      "json-v2"
    );
  } catch (error) {
    throw new Error(`Speechmatics transcription failed: ${error.message}`);
  }

  const words = extractWords(response.results || []);

  if (words.length === 0) {
    throw new Error("Speechmatics returned no recognizable words.");
  }

  return words;
}

// ---------- SRT output (command-line workflow) ----------

export function wordsToWordSrt(words) {
  return words.map((w, i) =>
    [i + 1, `${fmtSrt(w.s)} --> ${fmtSrt(w.e)}`, w.t].join("\n")
  ).join("\n\n");
}

export function wordsToSentenceSrt(words) {
  const sentences = [];
  let current = [];

  for (const word of words) {
    current.push(word);
    if (/[.!?]["')\]]*$/.test(word.t)) {
      sentences.push(current);
      current = [];
    }
  }
  if (current.length > 0) sentences.push(current);

  return sentences.map((sentence, i) => [
    i + 1,
    `${fmtSrt(sentence[0].s)} --> ${fmtSrt(sentence[sentence.length - 1].e)}`,
    sentence.map(w => w.t).join(" ")
  ].join("\n")).join("\n\n");
}

// Transcribe output/raw.wav and write the two SRT files (original behaviour).
export async function transcribeRawAudio() {
  const outputDir = path.resolve("output");
  const inputPath = path.join(outputDir, "raw.wav");

  const wordOutputPath = path.join(outputDir, "wordByWordTranscription.srt");
  const sentenceOutputPath = path.join(outputDir, "sentenceBySentenceTranscription.srt");

  const words = await transcribeAudio({ inputPath, onStatus: console.log });

  await Promise.all([
    fs.writeFile(wordOutputPath, wordsToWordSrt(words), "utf8"),
    fs.writeFile(sentenceOutputPath, wordsToSentenceSrt(words), "utf8")
  ]);

  console.log("Word-by-word and sentence-by-sentence SRT files saved.");

  return { wordOutputPath, sentenceOutputPath, words };
}
