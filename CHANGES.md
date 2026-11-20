# UI simplification: what changed

Same look (colours, fonts, radii, buttons, chips, cards). Same features. Only files under `public/` changed. No test was edited.

## B-roll tab (`public/js/broll.js` template, `public/broll.css`)
- **Setup** is now one quiet line: `Setup  AI: Groq · key missing · Chrome not connected   Change`. Click it to open the AI picker, the Claude chat link and the Connect Chrome card. It opens by itself only when something needs attention (key missing, or Chrome not connected where Chrome is needed) and closes again by itself once that is fixed, unless you closed or opened it yourself.
- **Picture look** is one titled panel. Always visible: Show in video, Ultra Key, Fill frame / Fit inside. Behind the fold "Position and corners": All B-rolls / This B-roll only, Size slider, Corners slider with value and Default.
- In Position, Reset, Clear individual changes and Use as default for all are behind a small "More" button (two clicks from the panel).
- Hint paragraphs were cut to one or two sentences. The long text moved behind a "How this works" fold on Plan, B-roll list, Clips and Premiere.
- **Plan card:** "Plan B-roll" is now the big button, with the Theme picker right next to it.
- **B-roll list:** more even spacing, the time column is one tidy block (start, end, length and the play button).
- Wording: "Show in preview and put in the exported video" is now "Show in video" (the full sentence is in its tooltip). "Ultra Key (remove green on cards)" is now "Ultra Key" (full sentence in its tooltip).
- Disabled sliders and switches now look clearly off.

## Editor (`public/js/review.js`)
- Top bar: project name, save state, one **More** menu, and the **Export video** button. Enhance audio, Keyboard shortcuts and API keys are inside More. Escape or a click outside closes it.
- The shortcuts button left the transcript toolbar (it is in More now, and the `?` key still works).
- Export dialog: three status lines (Cuts, Captions, B-roll) with a green or grey dot. Subtitle (.srt) downloads and padding are behind "More options". Render / Download stay the main buttons.
- Space no longer toggles playback when a fold heading (`summary`) has focus, so the keyboard can open folds.

## Home (`public/js/home.js`)
- The drop area is first. "Transcription model" and "B-roll AI" moved into the existing Settings fold (one click). Hints are shorter.
- Project rows: name, then length, date and state under it, and one obvious "Open" button (the whole row still opens the project). Delete is unchanged.

## CSS
- B-roll uses a spacing scale (4 / 8 / 12 / 16 / 24) through `--s1` to `--s5`. Home cards have a lighter shadow.
- Removed the unused `.bbar-top` rule (no JS or HTML used it).

## Renamed or added ids (nothing removed)
- **Renamed:** the Premiere message span `id="b-pr-msg"` is now `id="b-pre-msg"`. The original file had `b-pr-msg` twice (Prompts card and Premiere card), so the Premiere message was written into the Prompts card. Updated in `broll.js` line 1280 (`$("#b-pre-msg")`). Prompts still uses `b-pr-msg` (line 1001).
- **Added:** `b-setup`, `b-setup-line`, `b-look`, `b-look-more`.
- `data-*` attributes: none renamed or removed.

## Honest notes
- Tested in a real browser against the real server with a demo project (fake video, transcript and a 4-item plan). No API keys, so planning, Claude, Chrome launch and image generation were **not** run. Only their screens, status line and fold behaviour were checked.
- Not browser-tested: dragging a picture on the preview while a chosen image is showing (the demo project has no chosen images), Reset / Clear / Use as default for all. The JS for them is untouched and their ids still exist.
- The server in this check needed two stand-in packages (`dotenv`, `@speechmatics/batch-client`) placed outside the project, because installs were off. With them present one backend test ("the real server serves B-roll and refuses outsiders") fails about 1 run in 4. It does not touch the UI. Without them (the normal condition for this check) the suite is 143 pass, 0 fail, 4 skipped.

## Added: "AI for cuts: Groq | Claude" (from ADD_CLAUDE_CUT_HANDOFF.md)
Applied steps 1 to 12 as written: new `src/prompts/retakePromptClaude.js`, `src/functions/claudeReview.js`, `src/server/settings.js`, `tests/claudeReview.test.js`; edits to `server.js` (cleanSettings moved out), `editModel.js` (`tokenize` exported), `jobs.js`, `pipeline.js`, `flow.config.json`, `home.js`, `processing.js`, `styles.css`, `README.md`. `reviewWithGroq`, `retakePrompt.js` and `applyDecisions` are untouched.
One adaptation: on Home, the "AI for cuts" control sits in the Settings fold, above "B-roll AI", because the earlier UI pass moved the pickers there.
