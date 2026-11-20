# The Silent Shears

Turn a raw talking recording into a clean video. The AI marks retakes, stutters and false starts, **you review every cut in a web portal**, then the app renders the trimmed video.

```
upload → extract audio → transcribe (Speechmatics) → remove long silences
       → AI marks bad parts (Groq) → you review & edit → (optional) AI B-roll → export final video
```

## Setup

1. Install [Node.js](https://nodejs.org) 20+ and [ffmpeg](https://ffmpeg.org) (`ffmpeg` and `ffprobe` must be on your PATH).
2. `npm install`
3. Copy `.env.example` to `.env` and add `SPEECHMATICS_API_KEY` and `GROQ_API_KEY`. For B-roll also add `GEMINI_API_KEY` (or just use the Groq key). Keys can also be typed into the key button in the top bar.

## Start options

Before processing, the home page asks what to do. Everything is **on by default**: transcription (always), silence removal, AI retake marking, a subtitle `.srt` file and B-roll planning (with picture prompts). Untick what you don't need. While it runs you can **Skip this step** (AI review, SRT, B-roll) or **Stop**. If you only want the transcript and subtitles (AI and B-roll off), the project stays on the progress page with the `.srt` download buttons.

Groq is the default AI for every task. Gemini can be chosen for B-roll in the B-roll tab.

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

The editor has three tabs: **Transcript**, **Captions** (see below) and **B-roll**. Edits save automatically. **Export video** renders the final file (edge padding is adjustable) and gives you a download link; it is also kept in `workspace/<project>/`.

Projects live in `workspace/`. The transcript is cached per project, so re-running the AI never pays for transcription again.

## B-roll themes

The B-roll tab has a **Theme** picker. **UI Card (green screen)** is the default for new projects: every picture is a dark rounded card on solid green (#00FF00), ready for Ultra Key in Premiere. **Free style** is the original behaviour (the AI writes a free-form image prompt). Projects made before themes existed open as Free style. See `docs/broll-card-theme.md`.

**Ultra Key (automatic green removal).** For the green card pictures (modes `ui`, `material`, `symbol`) the app removes the green for you: it makes a transparent PNG copy of each picture in `workspace/broll/jobs/<job>/keyed/` (ffmpeg `colorkey` + `despill`; the original is never changed) and uses that copy in the editor preview, in the exported video and in the Premiere track/XML. Scenes, logos, people, real images and projects made before this feature are never keyed. Turn it off with the **Ultra Key (remove green on cards)** switch in the B-roll tab. Tune the key in `flow.config.json` under `ultraKey` (`similarity`, `blend`, `despill`, `modes`, `enabled`). The separate **Clips** step makes opaque `.mp4` files that cannot hold transparency, so they keep the green and show a warning; use the video export or the Premiere track for transparency.

## Using Claude instead of Groq (no API key)

On the start page pick **B-roll AI: Claude**. The app then uses your own claude.ai chat, driven in the Chrome window that Flow uses:

1. Open the **B-roll** tab and press **Launch Chrome**; sign in to claude.ai in that window once (the app never types your password).
2. Plan, choose, cards and prompts all go to one claude.ai chat. The link is kept in `claude-chat.json`. With `claude.newChatPerVideo` (default on) every new plan starts a fresh chat; you can also paste another chat link or press **Start a new chat** on the B-roll tab. `claude.newChatEvery` starts a new chat after N messages.
3. A free claude.ai plan has a message limit. When it is reached you get a clear message: try again later or switch to Groq.
4. Your transcript text is pasted into claude.ai, so only use it for videos you are happy to send there.
5. If claude.ai changes its page and nothing works any more, run `npm run inspect:claude` and fix the selectors in `flow.config.json` (`claude.selectors`). Nothing else needs to change.

Claude gets its own, richer prompts (`src/broll/prompts/rich/*.txt`, plain text you can edit). Groq and Gemini keep the compact ones. Set `claude.combineChooseCards` to `true` to let Claude choose the pictures and design the cards in one message.

Claude also gets **Block H, "Viewer psychology"** (`prompts/rich/H.txt`, spec in `docs/PSYCHOLOGY_BLOCK_SPEC.md`): before it picks a mode it decides what the viewer should feel, where the eye lands first, and which symbol says it without words (a money line gets a coin, not a text-only card). Cards can carry an optional `psych` note and an optional `hero_icon` (a bold icon next to the main element of a ui card); hover the *why this picture* chip in the prompt list to read them. Claude only; Groq and Gemini prompts are unchanged.

## AI for cuts: Groq or Claude

On the start page, **AI for cuts** picks who marks the false starts, stutters and repeated takes: **Groq** (default, needs `GROQ_API_KEY`) or **Claude** (your claude.ai chat in Chrome, no API key). Only the chosen AI runs; there is no automatic fallback from one to the other.

For Claude: press **Launch Chrome** (the same button as on the B-roll tab), sign in to claude.ai once, then press Start. If Chrome is not running or not signed in, the AI step stops with that message; fix Chrome and press **Try again** (or **Run AI review again** in the portal).

A normal 12 to 15 minute video needs 1 message to claude.ai; a repair of cut texts and/or a second look at the cuts adds 1 each (at most 3, 4 if the first answer was not valid JSON). The cuts are kept under 25 percent of all words, both in the prompt and in code: above that, Claude gets one strict second look. Settings are in the `claudeCut` block of `flow.config.json`:
`maxCutRatio` (0.25), `longWholeWords` (12, whole-line cuts longer than this are double-checked), `pauseFlagSec` (0.8), `partMaxWords` (6000, longer videos are sent in parts), `contextSegments` (10), `maxVerifyItems` (60).

## Picture modes: card, scene, logo, person

- **Card pictures** (`ui`, `material`, `symbol`): a dark rounded card on flat green. Unchanged.
- **Full-frame pictures** (no card, no green screen, never keyed or cropped):
  - `scene`: a hand-drawn illustration in the Tatami Galaxy style, in one of six palettes. **Three style reference images are always attached** (the palette's own image, then the next two of the ring). Three are bundled in `assets/style/tatami/` (pink, sepia, muted_multicolor), so nothing has to be added; you may add the other three later (see the README there) and they are picked up automatically. Only if the folder has no file at all does the images step stop before it starts.
  - `logo`: a brand logo on flat #121212. Put official logos in `assets/logos/` (`youtube.png`, `mrbeast.png`...) and they are used as they are, with no generation. A generated logo shows **Check the logo** and a **Save as logo** button. The same logo used twice in one video is made once.
  - `person`: a named real public person, drawn animated (Tatami style + references) or as a neutral realistic portrait. If the image model refuses or gets it wrong, the item offers **Try animated** or **Use a real photo**.

## Moving B-roll on the picture

Open the **B-roll** tab and put the playhead on a B-roll picture. Its outline turns dashed yellow: **drag it** on the preview to move it anywhere, and **scroll over it** (or use the Size slider) to resize. **Reset** goes back to filling/fitting the frame; **Apply to all** gives every B-roll that position and size. The export uses exactly the same placement.

## Subtitles (.srt) from the editor

The **SRT** button in the Transcript toolbar and the **Subtitles (.srt)** row in the export dialog download subtitles for the video as it will be exported: cut words are left out and times are on the cut timeline. Sentence-by-sentence or word-by-word.

## B-roll for Premiere Pro

In the B-roll tab (step 4) press **Make Premiere files**. You get, in `workspace/<project>/broll/premiere/` (and your chosen output folder):

- `broll_track.mov`: one transparent video (ProRes 4444) as long as the exported video. Drop it on V2 at 0:00, above the exported video, and every B-roll is already at its spoken moment.
- `broll_sequence.xml`: File → Import in Premiere. Each picture is its own clip at its exact time with its position and scale applied.

B-rolls without a chosen image leave empty space. The older **Make clips** output is unchanged.

## Captions

Subtitles are built automatically from the transcript, and **words you cut are left out**. They are burned into the exported video and show live on the player while you edit.

Open the **Captions** tab to style them:

| Setting | What it does |
| --- | --- |
| Presets | Classic, Bold pop, Boxed and Cinematic: one click sets the whole look (position and line limits are kept) |
| Font | System fonts, plus any font you add (see below) |
| **B** / *I* / AA | Bold, italic, ALL CAPS |
| Size, letter spacing | Sizes are relative to the shorter side of the video, so a style looks the same on 720p, 1080p, 4K and on vertical video |
| Text, outline, shadow | Colour and opacity, outline width, shadow distance |
| Background box | Colour, opacity and padding |
| Position | **Drag the captions on the video**, or use the sliders (they snap to the centre) |
| Wrapping | Characters per line and lines per caption |

**Adding fonts:** open *Add a font* and either search Google Fonts and click **Add**, or drop in your own `.ttf` / `.otf` file. Added fonts are shared by every project and kept in `workspace/fonts/`. Regular, bold and italic files of one family are collected together, so the **B** and **I** buttons use the real bold and italic faces. Google Fonts work without a key; if Google answers with web-font files ffmpeg cannot use, put a free `GOOGLE_FONTS_API_KEY` in `.env`.

Captions settings save automatically with the project. In the export dialog you can see whether captions are on. Burning them in needs an ffmpeg built with libass (almost every build has it; on Windows use the "full" build from gyan.dev). Audio-only files get no captions.

The command line has no caption editor, so it skips captions unless you run `npm run cli -- --captions` (default style).

## B-roll (AI cut-away pictures)

B-roll means pictures shown over the video while the voice keeps playing. Open the **B-roll** tab, which has four steps (Back / Next buttons at the bottom walk you through them):

1. **Plan**: the AI reads your *edited* transcript (words you cut are ignored) in two passes. First it writes a **plain description for every line**: just the information to show (the subject, objects, place or action the words talk about), with no style, mood or lighting; the style is added later in the Prompts step. Then, once every line has its description, a second pass decides which lines **deserve a picture** (concrete things, places, examples, numbers, demonstrations) and which **neighbouring lines share one picture**. Lines without a picture are unticked but keep their description, so you can tick any of them later. A group is one row that lists all its lines, with one description and one image. Use **Join with next** to make a line share a picture with the line below it, and **Ungroup** to split a group back into its lines (each gets its own description back). You can also edit times and descriptions, or **Regenerate** a single one. Moments that fall entirely in cut parts are flagged and never cost image credits; **Trim to kept parts** fixes ones that reach into a cut. If the second pass fails, every line is left on and a warning says so.
2. **Prompts**: the AI writes one image prompt per moment from your common style text and an optional suffix. Edit any prompt.
3. **Images**: a real Chrome window opens (on a copy of the Chrome profile you pick in the B-roll tab, so you are already signed into Google; or a fresh profile in `.chrome-profile/` if you pick *New profile*). Chrome blocks remote control of its normal profile folder, so the chosen profile (for example "Arthur" or "Nimbu") is copied once into `.chrome-profile/` and your real profile is never changed. Close your other Chrome windows the first time so every file can be copied; use *Copy again* if Google asks you to sign in. You can also set `CHROME_PROFILE` (folder name like `Profile 1`, or the profile's name) instead of clicking. In that window it opens [Google Flow](https://labs.google/fx/tools/flow), types each prompt, sets model / aspect ratio / alternatives / reference images, and saves the results. Pick the best picture per moment. Press **Launch Chrome** (or `npm run chrome`) once, sign into Google, open a Flow project, then generate. **Test mode** makes placeholder pictures without Flow or Chrome, so you can try everything for free. A daily counter warns before Flow's limit.
4. **Clips** (optional): each chosen picture as its own gap-free 30 fps clip on the *exported* timeline, plus `timeline.csv` / `timeline.json`, for use in another editor.

Chosen pictures show over the video in the editor preview and are burned into the exported video (under the captions). The export dialog says how many pictures will be used; *Fill frame* crops the picture to the video, *Fit inside* keeps the whole picture and leaves the sides transparent, so the video shows through. They are only added to videos, not audio files. If Flow's page changes and automation breaks, use **Inspect Flow page** and fix `selectors` in `flow.config.json` (re-read on every run).

Notes:
- B-roll can control your logged-in Chrome, so it only answers requests addressed to `localhost` / `127.0.0.1`, even if you set `HOST`.
- Re-transcribing a project clears its B-roll plan (it was made for the old words). Changing cuts keeps it and shows what the new cuts mean for each moment.
- Heavy ffmpeg work for the clips runs at low priority on all cores but two (`FFMPEG_THREADS`, `FFMPEG_PRIORITY=normal` to change). ffmpeg for the clips can be bundled by `ffmpeg-static` (installed automatically if it can be) or set with `FFMPEG_PATH`.

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
src/server/      portal backend (jobs, pipeline, HTTP; broll.js connects the B-roll module)
src/broll/       B-roll module (planner, AI clients, Flow automation, clips); plain CommonJS, knows nothing of the portal
src/shared/      cut and caption maths used by both server and browser (so preview = export)
src/functions/   transcribe, Groq review, SRT helpers
src/utils/       ffmpeg helpers
public/          the portal (plain ES modules, no build step)
tests/           npm test
```

## Notes

- Everything runs locally; the portal only listens on 127.0.0.1 (set `HOST` to change, but there is no login).
- Playback in the editor skips cuts live and can hiccup a little at each cut; the exported video is cut precisely.
- Browsers need H.264/AAC (MP4) or MP3/WAV/M4A to preview. Other containers are converted automatically.


## Added: Melia model, safe re-render, rounded corners

- **Transcription model** (start page): *Enhanced* (best for one language) or *Melia 1 (Hindi)* for Hindi / mixed-language videos. Saved per project as `settings.asrModel`.
- **Render again** always works: each render is written to its own `final-<time>.mp4`, old ones are removed afterwards, and a failed render keeps the previous good video.
- **Rounded corners** for B-roll pictures that are not green-screen cards (scene, logo, person, real image). Default 6% of the picture's shorter side. In the B-roll tab, *Corners > Roundness* follows the All B-rolls / This B-roll only switch. It shows in the preview, the exported video and the Premiere track (`src/broll/rounding.js`).
