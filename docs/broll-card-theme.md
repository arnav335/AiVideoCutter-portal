# B-roll theme: "UI Card (green screen)"

Every B-roll picture is **one dark rounded UI card on a solid pure green (#00FF00) background**. Remove the green with Ultra Key in Premiere and only the card stays. The old behaviour is still available as the theme **Free style**.

## Why it is built this way

The planning AI is a small model (Groq `openai/gpt-oss-20b`). It understands speech well but writes long, strict image prompts badly. So:

> The LLM only fills a small, validated JSON form. **Code** writes the final Nano Banana prompt from fixed templates. The LLM never writes style, colours or layout wording.

```
transcript
  -> plan step    AI describes every line; picker chooses lines (theme-aware rules)
  -> prompts step AI fills a CARD FORM per B-roll (batches of 8)          src/broll/cardAi.js
                  code validates the form (limits, number grounding)      src/broll/cardSpec.js
                  code runs the variety pass                              src/broll/cardSpec.js + cardAi.js
                  code builds the final prompt from templates             src/broll/cardPrompt.js
  -> images step  unchanged (Flow / Nano Banana)
```

## Themes

| id | label | behaviour |
|---|---|---|
| `card` | UI Card (green screen) | new projects; card forms + templates |
| `free` | Free style | the original prompt writer; projects saved before themes existed |

`options.theme` is stored per project (`src/broll/themes.js`, defaults in `flow.config.json` -> `themes`). Changing the theme after prompts exist asks for confirmation and clears prompts, cards and the image job of that plan; **the plan (times and descriptions) is kept**. The default suffix `Flat graphic on solid #00FF00, no green spill.` is added when you switch to the card theme and removed again when you leave it, but only if you did not edit it.

## Files

| file | job |
|---|---|
| `src/broll/themes.js` | theme registry |
| `src/broll/cardSpec.js` | modes, layouts, limits, `validateCard`, `fallbackCard`, `varietyCheck`, number grounding |
| `src/broll/cardPrompt.js` | style constants (palette, `FRAME`, `LOOK`) and one template per layout/mode; `buildPrompt` |
| `src/broll/cardAi.js` | system prompt, 14 few-shot examples, `cardsFor` (batches, retry, fallback, variety re-ask) |
| `src/broll/planner.js` | theme-aware director/picker rules; merged groups clear their card |
| `src/broll/projects.js` | `options.theme`, card branch of `startPrompts`, `newCardIdea`, saving keeps card fields |
| `tests/cardSpec.test.js`, `tests/cardPrompt.test.js`, `tests/cardAi.test.js`, `tests/brollCards.test.js` | unit and project-level tests (no network) |

## The card form

Every form has `id`, `mode`, `pill` (max 4 words, 32 characters), optional `pill_dot` (a role) and optional `caption` (max 8 words). Colours are only ever **role names**: `accent` (yellow #FFCE2B), `secondary` (coral red #FF5F57), `muted` (grey #8A8A8A), `text` (white). Code maps a role to a hex.

| mode | fields |
|---|---|
| `ui` | `layout` + its fields (below) |
| `animated` | `subject`, `action`, `setting`, optional `prop` + `prop_role` |
| `material` | `object`, or `halves` (2 x `{heading, object, role}`); optional `texture_notes` |
| `symbol` | `icon` (fixed list) or `line_art`, plus `name`, `icon_role` |
| `real_image` | `search_hint`, `pill`. No prompt is made; the item gets `needsRealImage` and the UI shows "Needs your own image: ..." |

UI layouts: `big_number`, `bars`, `milestone`, `chips`, `list`, `toggles`, `columns`, `formula`, `before_after` (fields in `LAYOUTS` in `cardSpec.js`).

### Validation (`validateCard(form, quote)` -> `{ ok, card, errors }`)

1. Unknown mode/layout or missing required fields -> invalid. Unknown fields are dropped.
2. Text over the limit is **shortened at a word boundary**, never rejected. Emojis, double quotes and line breaks are stripped; everything is lowercase except `value_text` and `name`. A `·` does not count as a word.
3. **Number grounding:** every number in `big_number`, `bars` and `milestone` must be said in the spoken line, as digits (`3,104`, `$5.4k`) or English number words (`three thousand one hundred four`, `two and a half million`).
4. Roles outside the four names become `accent`. `bars` fill percentages are computed in code (largest value = 100).
5. When invalid, `cardsFor` asks **once more** for just those ids with the error text in the message. Still invalid -> **fallback card**: `chips` with the 2 to 3 most meaningful words of the line. So every chosen B-roll always ends with a usable card.

### Variety pass

Walking the cards in time order, a card is flagged when it uses the same layout (or the same `animated`/`material` mode) as the card before, more than 2 of one layout in any window of 10, or the same mode more than 3 times in a row. Flagged cards are re-asked **once** with `avoid_layouts`; if the AI still repeats, it is accepted (never loops). `real_image` cards and fallback cards are ignored.

## Prompts, per card

`buildPrompt(card, { common, suffix })` = `LOOK[mode]` + `FRAME` + pill sentence + body template + caption sentence + "Extra instructions" box + suffix. The aspect ratio is never written (it comes from the Flow settings). In this theme the instructions box is relabelled "Extra instructions for every card (optional)".

## What the UI shows

* A **Theme** dropdown at the top of the Plan step, mirrored in the Prompts step.
* Per prompt: a mode chip, a layout chip, the "Needs your own image" badge, the editable prompt, and **New card idea** (asks for a different card for that one B-roll, never the layout it has now).
* **Only the empty ones** never overwrites a prompt you edited and leaves "needs your own image" items alone. **Write prompts for all** replaces everything.

## Plan step in the card theme

Only two rules are added (nothing else about planning changes): descriptions must keep every number, name, date and comparison from the speech; and the picker favours lines with something to put on a card, skips repeated takes (only the last near-identical take gets a picture), and aims for about one card per 8 to 12 seconds with no gap over about 25 seconds. A merged group clears the card, mode and prompt of its member; split parts have no cards. Regenerating a B-roll clears its card and prompt.

## How to add a layout

1. `cardSpec.js`: add it to `LAYOUTS` (field summary, shown to the AI) and write its checker in `LAYOUT_CHECK` (limits, roles, grounding).
2. `cardPrompt.js`: add its template to `BODY`.
3. `cardAi.js`: add a few-shot example to `FEW_SHOT` (it is also run through the tests).
4. Tests: a sample in `tests/cardPrompt.test.js` (`EXTRA`), and validation cases in `tests/cardSpec.test.js`. The test "the layouts and modes covered by the samples are every layout and mode" fails until every layout has a sample.

## Tuning notes

* The AI calls use `temperature: 0.2` and `reasoning: 'low'`. `llm.chat()` now accepts both per call (defaults unchanged for every other step). Groq's `gpt-oss` models take `reasoning_effort`; the existing 400-fallback in `llm.js` drops the field if a model rejects it. JSON mode was already on.
* `planning.cardBatchSize` (default 8) in `flow.config.json`.
* Deviations from the task text: label limit is **4 words** (headings stay 3) because the tested few-shot examples use 4-word toggle labels; `bars` accepts an optional `unit` (`$ € £ %`) so "3,104" can show as "$3,104"; a `symbol` card without `name` uses its pill; an unknown icon becomes `generic`.

## Phase 4 (green removal and auto-crop): not implemented

It is optional and off by default in the task, and it needs real Nano Banana images to tune. Outline if you want it later: per-project `options.keyGreen`; find the bounding box of non-green pixels (for example `chromakey` -> `alphaextract` -> `cropdetect` in ffmpeg) and crop with a few pixels of padding, which also removes the sparkle watermark in the bottom-right corner; then `chromakey=0x00FF00:0.14:0.06,despill=type=green:mix=0.5` into a PNG with alpha cached per image; use it in the preview and in `premiere.js` `makeTrack`; never touch the original file.
