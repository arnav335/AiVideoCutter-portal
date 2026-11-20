# ADD-ON to CLAUDE_PROMPTS_SPEC.md: Block H "Viewer psychology"

Purpose: Claude should not only pick a layout that fits the words. It should first decide **what the viewer feels and wants at that moment, what their eye should land on, and which visual cue says it without words**, and only then choose the mode, the symbol or scene, the palette, the composition and the colour roles.

Example of the problem this fixes: a line about earning money currently gets a text card with a button. With this block it gets a big money amount with a green coin or a scene with a bag of coins, because a symbol is understood faster than a sentence.

Everything below follows the existing rules of the spec: no caps, Claude-only (`llm.profile === 'rich'`), Groq unchanged, Claude never writes hex values or art-style words (code owns them).

---

## 1. Where it goes

| Item | Change |
|---|---|
| New **Block H** (section 2) | Insert **after Block E (palettes) and before Block F (examples)**. |
| New **Block F2** (section 3) | Extra psychology examples. Insert at the end of Block F, before `</examples>`. |
| **T3 CARDS, T4 NEW IDEA, T6 PICK AND DESIGN** | Now use blocks in this order: **A, B, C, D, E, H, F (with F2), G**. |
| **T2 CHOOSE** | Add the `<viewer_attention>` snippet (section 4). |
| **Block D rule 10 (CHECK)** | Replace with the version in section 5. |
| **Block C (forms)** | Add one optional key `"psych"` to every form (section 5). |
| **T1 PLAN, T5 RE-DESCRIBE, T7** | No change. Descriptions must stay plain information with no style words. |

Estimated size of Block H: about 1,100 words. There is no length cap, so this is fine.

---

## 2. Block H (exact text, paste as is)

```text
<viewer_psychology>
You are not decorating a sentence. You are directing a viewer's attention and emotion for about one second on a phone. For EVERY picture, think through these five questions silently before you choose anything.

1. FEELING. What should the viewer feel or want at this exact moment? Pick one: curiosity, desire, fear of missing out, pride, relief, tension, trust, surprise, belonging, urgency, calm. Every element of the picture serves that ONE feeling. A picture that sits comfortably in the middle is forgettable: choose a clear emotional direction.
2. FOCAL POINT. What is the ONE thing the eye must land on first? Make it the biggest, most contrasting or most unusual element. Everything else is quieter. Too many urgent elements cancel each other out.
3. NO-WORDS TEST. Could someone understand the emotion and the point in under one second without reading a word? If not, replace words with a symbol, an object, a number or a scene. Symbols beat sentences: a coin says money faster than the word money, a magnifier says search, a bell says distraction, an arrow says next.
4. EYE PATH. The eye travels from the top-left to the bottom-right, and it follows arrows, triangles, gazes, diagonals and pointing hands. Put the bait or the main thing first (top or centre), the explanation or the number second, the small label last.
5. ONE EMPHASIS. If a card has words, exactly one word or phrase carries the emphasis (the accent role). Everything else is muted or plain. If nothing is emphasised, nothing is read.

SYMBOL BEFORE TEXT
- When the line is about money, earnings, savings, a price or a payout, the picture contains a money symbol (a coin, a stack of coins, a banknote, a wallet, a money bag), not only digits. With a ui card, keep the number as the hero and add a "hero_icon" if the form allows it; otherwise use mode symbol with icon coin, or a scene whose focal object is the money.
- Growth, progress, a goal: an upward arrow, a stair, a seed and a tree, a filling bar.
- Danger, warning, a trap: a warning shape, a trap, a crack, a sharp angular object.
- Time, waiting, patience: a clock, a sand timer, a slow figure.
- Trust, safety, security: a lock, a shield, a handshake drawn simply, a round and calm shape.
- Community, belonging, audience: a circle of figures, one figure joining a group.
- Search, discovery, "find out": a magnifier, a door, a path, a light in a window.
- Never put an emoji character inside card text. Express the emoji idea through the symbol mode, a hero_icon or a scene object.

WHAT SHAPES SAY (use them in the subject and setting of scenes and in the choice of icon):
- Circles and round forms: unity, warmth, safety, community, wholeness. Good for belonging, calm, friendliness.
- Squares, rectangles, grids: stability, order, reliability, professionalism. Good for facts, structure, steps, education.
- Triangles and arrows: movement, direction, action, energy. An upward one means growth and ambition, a downward one means falling or grounding, a right-pointing one means forward and play.
- Sharp, angular, jagged forms: tension, danger, strength, intensity, durability.
- Organic, wavy, free forms: nature, comfort, health, human connection.
- Vertical lines: energy and dominance. Horizontal lines: peace and stability. Diagonals and slanted lines: speed, motion, something new coming.
- Asymmetry and off-centre placement: action and excitement. Symmetry: calm and order.

WHAT COMPOSITION SAYS (for the "composition" field):
- low_angle: pride, power, authority, a threat.
- high_angle: being small, trapped, watched, overwhelmed.
- from_behind: anonymity, anticipation, "this could be you".
- tilted: unease, instability, something about to go wrong.
- wide: loneliness, scale, the big picture.
- close_up: intimacy, emotion, detail, a face that says it all.
- over_shoulder: perspective, "you are the viewer in this moment".
- A face or figure looking upward suggests aspiration and hope; looking down suggests defeat or humility; looking straight at the camera creates trust and confrontation.

COLOUR PSYCHOLOGY (palettes on scenes, roles on cards)
- Warm and bright colours (yellow, orange) lift mood: choose them for happiness, optimism and energy. Blue means calm, trust, technology, discipline. Red means urgency, danger, excitement, desire. Green means growth, money in a hopeful way, health, renewal. Pink means desire, fantasy, fame. Sepia means the past, regret, being stuck.
- Match the shape feeling with the colour feeling: calm round shapes get calm desaturated palettes, sharp tense shapes get high-contrast palettes. Do not mix a calm subject with an alarm palette.
- Contrast creates hierarchy. Use ONE accent for the single thing that matters: on cards the accent role goes only on the key word or the key bar, never on everything. The secondary role is for the negative, the other side or the warning. Use the red-dot principle: one powerful accent, everything else calm.
- Cards: accent = the winner, the positive, the thing to remember. secondary = the loser, the loss, the warning. muted = background facts. This is how you steer attention with colour.

PERSUASION TOOLS (honest ones only, use when they fit the line)
- Curiosity gap: show the intriguing part and hide the answer (a closed door with light under it, a covered object, a question-shaped shadow). Good for hooks.
- Fear of missing out: show the crowd that is already ahead or the door that is closing. Good for urgency lines. Never invent a deadline or a number.
- Bait then offer: first show the thing the viewer wants (the result, the prize, the food), then the information that gets it. Two steps in one second.
- Before and after, contrast, and "one different among many identical" make the point without words.
- Narrative compression: one frozen moment that tells the whole story (a figure frozen mid-step with cracks spreading ahead of him).
- Hidden detail: one small clever detail that rewards a second look (a bottle cap as an eye, a thread loose from a sweater) goes in "extra". It must support the meaning, never be a gimmick.
- Nostalgia: when the line is about the past, childhood, an older era or "how it used to be", use the sepia or pink palette and period objects.
- Authenticity: handmade, hand-drawn and textured feel more human and trustworthy than glossy and generic. Prefer a concrete, specific, slightly imperfect object over a generic stock idea.
- Polarity: a confident emotional direction beats a neutral one, even if it will not suit everybody.

AUDIENCE FIT. The viewer is on a phone, scrolling fast, knows nothing about the topic. Think about WHO is watching (their age, their goal, what they fear) from the video brief and the lines, and speak their visual language. A fast, modern, trendy topic gets a bold, clean, energetic picture. A warm, human topic gets round, soft, human subjects. A serious, factual topic gets a clean grid or a calm composition.

EVERYTHING MUST STAY HONEST. Use psychology to make the true message clearer, never to mislead. No fake urgency, no invented statistics, no hidden or subliminal messages that contradict the line, no shaming, nothing manipulative about health, money promises or fear.

DECISION SHORTCUT. First the feeling, then the symbol, then the mode, then the palette and composition, then the single emphasis. If the first idea you think of is the generic one (a lightbulb, a handshake, a person at a laptop, a plain text button), throw it away and ask what the viewer actually wants to SEE at this moment.
</viewer_psychology>
```

---

## 3. Block F2: extra examples (add inside Block F, before `</examples>`)

These teach the habit "symbol and focal point first". They use only the existing form fields plus the optional `psych` key (section 5) and, where marked, the optional `hero_icon` (section 6).

```text
"I made five thousand four hundred dollars in one month."
{"id":"b030","mode":"ui","layout":"big_number","pill":"one month","value_text":"$5,400","hero_icon":"coin","psych":"wants proof of money: big number plus coin, accent on the number","reason":"the amount is the hook, the coin says money"}

"I made five thousand four hundred dollars in one month." (version if hero_icon is not built yet)
{"id":"b030","mode":"symbol","pill":"one month","icon":"coin","icon_role":"accent","name":"$5,400","psych":"coin says money before the number is read","reason":"symbol first, amount under it"}

"Everyone around you is already doing it, and you are still thinking."
{"id":"b031","mode":"scene","palette":"black_yellow","subject":"a single person standing still at the edge of a platform while a long line of identical figures walk through a glowing door that is slowly closing","action":"the person lifts one hand toward the door but does not step forward","setting":"a dim empty hall with a long tiled floor","composition":"wide","extra":"the door light narrows to a thin slit","psych":"fear of missing out: closing door, one figure left behind","alt_idea":"a train pulling away with a hand-shaped glove left on the platform","reason":"the closing door makes the viewer feel what they are missing"}

"Nobody tells you what happens after you hit a million views."
{"id":"b032","mode":"scene","palette":"pink","subject":"a tall closed wooden door with golden light leaking under it, and a small person in a hoodie standing in front of it","action":"the person leans in to peek through the keyhole","setting":"a quiet corridor with a patterned floor","composition":"from_behind","psych":"curiosity gap: the answer is hidden behind the door","alt_idea":"a giant covered sculpture with one hand pulling the cloth","reason":"hiding the answer makes the viewer want it"}

"You are so close to quitting, and that is exactly when it changes."
{"id":"b033","mode":"scene","palette":"sepia","subject":"a tired figure kneeling on a dusty road, in front of them a tiny green sprout cracking through the ground","action":"the figure stares at the sprout with wide eyes","setting":"a long empty road under swirling outlined clouds","composition":"high_angle","extra":"one small flower petal drifts toward the sprout","psych":"relief and hope: low colour, one small green accent as the focal point","alt_idea":"a hand about to let go of a rope while the rope top is almost over a wall","reason":"small hope in a dull scene pulls the eye"}

"Subscribers trust you when you show up every single week."
{"id":"b034","mode":"scene","palette":"blue_grey","subject":"a small figure putting a glowing round stone on a long row of identical stones leading toward a bright house","action":"the figure kneels and places the stone with care","setting":"a calm riverbank with a low horizon","composition":"medium","psych":"trust: round calm shapes, repetition, horizontal calm lines","alt_idea":"a calendar page drifting by with a single circled day","reason":"a patient repeated action builds trust"}

"There are three kinds of viewers: casual, loyal and superfans."
{"id":"b035","mode":"ui","layout":"list","pill":"3 kinds of viewers","rows":[{"text":"casual","role":"muted"},{"text":"loyal","role":"muted"},{"text":"superfans","role":"accent"}],"psych":"one emphasis: the best group is the only accent, eye ends on it","reason":"three steps with the valuable one highlighted"}

"Do not buy it today, because the price drops tomorrow."
{"id":"b036","mode":"ui","layout":"before_after","pill":"the price","before":{"label":"today","text":"full price"},"after":{"label":"tomorrow","text":"lower price"},"psych":"wait for the reward: simple contrast, no invented numbers","reason":"a change with no numbers said, so no digits"}
```

---

## 4. T2 CHOOSE: add this section (put it right after `<what_earns_a_picture>`)

```text
<viewer_attention>
Choose the lines where the viewer's attention or emotion peaks, not only the lines with facts. Strong moments: the hook in the first seconds (curiosity), the claim that surprises, the line that names a fear or a desire, the numbers that prove something, the moment of contrast (before and after, amateur and professional), the turning point, and the closing lesson. Prefer a picture when the voice alone would let the viewer's attention slip, and leave plain video when the speaker's face is already the strongest thing on screen (a direct, emotional, personal sentence). Alternate moments of high energy with calmer ones so the viewer is not tired by a wall of urgent pictures.
</viewer_attention>
```

---

## 5. Small changes in existing blocks

**Block C (forms), add at the end of the first paragraph:**

```text
Every form may also have "psych" (max 12 words, only for you and the editor, never shown in the picture): the viewer feeling you aimed for and the cue you used, for example "fear of missing out: closing door, one figure left behind".
```

Code: add `psych` to the validator's allowed keys (max 12 words, rich only), store it on the item, show it as a small tooltip on the item in the UI next to `reason`. The template never uses it. Check that the parsers already ignore unknown keys, as for `notes`.

**Block D rule 10 (CHECK), replace with:**

```text
10. CHECK silently before you answer: every id present and in order; numbers grounded; text within limits; no layout or palette repeated back to back; every mode follows the decision order; every scene is one idea with at most three elements; every picture has one clear feeling, one focal point and one emphasis; where the line is about money, growth, danger, time, trust or search a matching symbol is visible; no generic first idea survived; nothing is manipulative or invented.
```

**Block D rule 2:** keep "No emojis" as it is. The money-emoji idea is done with symbol mode, `hero_icon` or a scene object, because image models handle a drawn coin better than an emoji character in text.

**T3 notes contract:** change to "at most three short sentences: the argument of the video, the recurring ideas you reuse, and which emotions got which palettes." (unchanged). Optionally add: "and the single feeling you aimed for in the opening hook and in the closing lesson."

---

## 6. Optional code change: `hero_icon` (recommended, this is what fixes "just text with a button")

Today `ui` cards (`big_number`, `bars`, `milestone`, `before_after`, `list`) are text only, and `symbol` is a separate mode. A money line often needs both: the number and the coin.

Add an optional field to `ui` cards:

- `hero_icon` (enum): `coin`, `trophy`, `heart`, `bell`, `lock`, `magnifier`, `lightbulb`, `book`, `globe`, `chat_bubble`, `play_button`, `arrow_up`, `arrow_down`, `clock`, `shield`, `check`, `warning`. (The first part reuses the `symbol` icon enum; add `arrow_up`, `arrow_down`, `clock`, `shield`, `check`, `warning`.)
- Validator: not in the enum -> dropped (card still works). Not allowed for `chips`, `toggles`, `columns` (too crowded).
- Template: add one sentence to the `ui` template when present, using the same style as `LOOK.symbol` for icons: `A single bold {icon} icon in the accent colour sits above (or beside) the main element, about the size of the number.`
- If you do not want to build it now, Claude still works: the Block F2 fallback example uses `mode: symbol` with `icon: coin`.

---

## 7. Tests and acceptance

Unit tests:
- Block assembly: T3, T4 and T6 system prompts contain `<viewer_psychology>` after `<palettes>` and before `<examples>`; T1, T5 and T7 do not; Groq prompts are byte-for-byte unchanged.
- `validateCard`: `psych` longer than 12 words is trimmed, `psych` is stored and not used by `buildPrompt`; unknown `hero_icon` is dropped, a valid one is kept on `ui` big_number only if the template change is built.
- Parsers accept the extra keys `psych` and `notes`.

Manual acceptance (use real scripts, rich profile):
1. A line about earnings or a payout produces a coin or money object (`hero_icon: coin`, `symbol` coin, or a scene with money), not a text-only card.
2. An opening hook that hides the answer produces a curiosity-gap scene (closed door, covered object), not a generic person.
3. A fear-of-missing-out line produces a scene with a crowd ahead and one person left behind, with a high-contrast palette.
4. A chips or list card has exactly one accent item or word, the rest muted.
5. No card shows a generic first idea (lightbulb, handshake, person at laptop, plain button) when a more specific one fits.
6. The editor can read `psych` and `reason` on each item and understands why the picture was chosen.
7. No invented numbers, no fake deadlines, no manipulative claims in any card.

## 8. Do NOT

- Do not let Claude write hex colours, art-style words or layout wording because of this block: it still only chooses roles, palettes, compositions and subjects.
- Do not add emoji characters to card text.
- Do not cap the length of Block H or of `psych` beyond the 12 words above.
- Do not apply this block to the T1 PLAN descriptions: they stay plain information with no style words.
