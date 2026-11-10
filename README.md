# AiVideoCutter

Turn a raw talking recording into a clean video. The AI marks retakes, stutters and false starts, **you review every cut in a web portal**, then the app renders the trimmed video.

```
upload → extract audio → transcribe (Speechmatics) → remove long silences
       → AI marks bad parts (Groq) → you review & edit → export final video
```

## Setup

1. Install [Node.js](https://nodejs.org) 20+ and [ffmpeg](https://ffmpeg.org) (`ffmpeg` and `ffprobe` must be on your PATH).
2. `npm install`
3. Copy `.env.example` to `.env` and add `SPEECHMATICS_API_KEY` and `GROQ_API_KEY`.

## Use the review portal

```
npm start
```

Open http://127.0.0.1:3000, drop in a recording (or pick one from the `input/` folder) and wait for processing. Then:

| Do this | To |
| --- | --- |
| Click a word | Select it and jump the video there |
| Drag across words, or Shift-click | Select a range |
| `Delete` / `X` | Cut the selection |
| `R` | Restore the selection |
| Double-click a word | Toggle just that word |
| `N` / `P` | Hear the next / previous cut with 1.5 s of context |
| `Space` | Play / pause (with **Skip cuts** on, playback jumps over cuts) |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |

Colours: **red** = cut by the AI, **blue** = cut by you, **yellow** = selected, dotted red underline = an AI cut you restored.

The **Cuts** tab lists every cut with *Hear the join*, *Hear what's cut* and *Restore*. **AI notes** shows why the AI cut things and lets you re-run it. Edits save automatically. **Export video** renders the final file (edge padding is adjustable) and gives you a download link; it is also kept in `workspace/<project>/`.

Projects live in `workspace/`. The transcript is cached per project, so re-running the AI never pays for transcription again.

## Command line (no review)

```
npm run cli                  # first file in input/
npm run cli -- my-video.mp4
```

Runs the whole pipeline, applies the AI's cuts as they are and writes `output/<name>-trimmed.mp4`.

## Tuning the AI

The prompt is in `src/prompts/retakePrompt.js`. Model and effort come from `GROQ_MODEL` and `GROQ_REASONING_EFFORT` in `.env`. Transcripts longer than ~100 sentences are reviewed in overlapping chunks of 100.

## Project layout

```
src/server/      portal backend (jobs, pipeline, HTTP)
src/shared/      cut maths used by both server and browser (so preview = export)
src/functions/   transcribe, Groq review, SRT helpers
src/utils/       ffmpeg helpers
public/          the portal (plain ES modules, no build step)
tests/           npm test
```

## Notes

- Everything runs locally; the portal only listens on 127.0.0.1 (set `HOST` to change, but there is no login).
- Playback in the editor skips cuts live and can hiccup a little at each cut; the exported video is cut precisely.
- Browsers need H.264/AAC (MP4) or MP3/WAV/M4A to preview. Other containers are converted automatically.
