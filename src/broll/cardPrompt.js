'use strict';
/**
 * Writes the final Nano Banana prompt for a validated card form. Pure functions, no LLM.
 * The LLM only ever fills the form; every word about style, colour and layout comes from this file.
 * The aspect ratio is deliberately never mentioned (it is set in the Flow settings).
 */
const path = require('path');
const fs = require('fs');
const { applySuffix } = require('./planner');

/* ---------------------------------------------------------------- style constants (section 5) */
const COLORS = {
  bg: '#00FF00', card: '#121212', card2: '#1E1E1E', line: '#3A3A3A',
  accent: '#FFCE2B', secondary: '#FF5F57', text: '#FFFFFF', muted: '#8A8A8A'
};

// Role -> how the colour is written in a prompt.
const COLOR_NAMES = { accent: 'yellow (#FFCE2B)', secondary: 'coral red (#FF5F57)', muted: 'grey (#8A8A8A)', text: 'white' };
const c = r => COLOR_NAMES[r] || COLOR_NAMES.accent;

const FRAME = 'On a solid pure green (#00FF00) background with no gradient, shadow or noise, one centered dark card (#121212) with large rounded corners, ' +
  'a thin subtle border and a wide green margin around it. Bold Inter-style sans-serif for all text. ' +
  'The pill label, all text and the whole drawing sit fully inside the card with a clear margin from every edge. ' +
  'The pill label text is small and the same size on every card. No green inside the card and no green tint or reflection on any object. ' +
  'No real logos. Spell all text exactly as given.';

// FRAME and LOOK belong to the CARD modes only (ui, material, symbol). Full-frame pictures (scene, logo, person) have no card and no green.
const LOOK = {
  ui: 'Flat 2D UI graphic.',
  material: 'Photorealistic material render inside a flat UI card.',
  symbol: 'Flat 2D UI graphic.'
};

/* ---------------------------------------------------------------- full-frame constants (CLAUDE_PROMPTS_SPEC.md 3.5) */
const TATAMI_STYLE = 'Hand-drawn 2D Japanese TV-anime illustration in the exact art style of the attached reference images (The Tatami Galaxy, directed by Masaaki Yuasa): ' +
  'completely flat cel colours with no gradients, no soft shading and no 3D rendering; bold black ink outlines with a slightly wobbly, hand-drawn quality; ' +
  'characters with pale flat skin, solid-shape hair, small simple dot or almond eyes, a thin line for the nose, deadpan understated expressions and slightly elongated proportions; ' +
  'stylised graphic backgrounds made of simple flat shapes, dense speckled flat-colour foliage, swirling outlined clouds with two-tone flat shading, cracked walls drawn with thin line cracks; ' +
  'theatrical wide-angle or tilted camera angles; one dominant colour palette for the whole image. ' +
  'Create NEW characters and a NEW composition: use the references only for the art style (line quality, flat colour, shape language, mood), never copy their characters, faces or layouts.';

const PALETTE_DESC = {
  pink: 'a dominant hot-pink and pale-pink palette with white and soft coral accents',
  blue_grey: 'a dominant desaturated blue-grey palette: pale sky blue, soft greys and white',
  green: 'a dominant fresh lime and leaf-green palette against near-black shapes, with white highlights',
  sepia: 'a dominant dark sepia-brown palette: dusty beige, charcoal and dim warm light',
  black_yellow: 'a high-contrast palette of black, white and acid yellow with almost no other colours',
  muted_multicolor: 'a muted olive-grey and brown scene with a few vivid flat-colour figures in pink, yellow and purple'
};

const COMPOSITION_DESC = {
  close_up: 'close-up framing', medium: 'medium shot', wide: 'wide establishing shot', from_behind: 'seen from behind the subject',
  high_angle: 'high-angle camera looking down', low_angle: 'low-angle camera looking up', tilted: 'slightly tilted, off-balance camera', over_shoulder: 'over-the-shoulder view'
};

// Reference images: the palette's own picture first, then the next two of this ring (wrapping around). Always exactly three.
const RING = ['blue_grey', 'sepia', 'pink', 'green', 'black_yellow', 'muted_multicolor'];
const REF_COUNT = 3;
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const STYLE_DIR = path.join(ASSETS, 'style', 'tatami');
const LOGO_DIR = path.join(ASSETS, 'logos');
const LOGO_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'svg'];

const refNames = palette => {
  const i = Math.max(0, RING.indexOf(palette));
  return Array.from({ length: REF_COUNT }, (_, k) => `tatami-${RING[(i + k) % RING.length]}.jpg`);
};
// The six files are ideal, but fewer work too: if some are missing, walk the ring from the palette's own picture and use the
// first three that exist (all of them when only two or three exist). With NO file at all the nominal names are returned,
// so the images step can say exactly what is missing.
const refsFor = (palette, styleDir = STYLE_DIR) => {
  const nominal = refNames(palette);
  const exists = f => fs.existsSync(path.join(styleDir, f));
  if (nominal.every(exists) || !RING.some(n => exists(`tatami-${n}.jpg`))) return nominal.map(f => path.join(styleDir, f));
  const i = Math.max(0, RING.indexOf(palette));
  const walk = Array.from({ length: RING.length }, (_, k) => `tatami-${RING[(i + k) % RING.length]}.jpg`).filter(exists);
  return walk.slice(0, REF_COUNT).map(f => path.join(styleDir, f));
};

// Saved projects and jobs keep the absolute paths that were valid when the prompts were written. If the images were added
// later, or the project folder moved, those paths are stale. This re-points them at the current style folder: a path that
// still exists is kept; otherwise the same file name is looked up in styleDir; names that don't exist are dropped (duplicates
// too). If nothing is left but some style file exists, the palette's normal list is used. Returns [] only with NO file at all.
const healRefs = (refs, palette, styleDir = STYLE_DIR) => {
  if (!Array.isArray(refs) || !refs.length) return refs || [];
  const out = [];
  for (const r of refs) {
    const f = fs.existsSync(r) ? r : path.join(styleDir, path.basename(String(r).replace(/\\/g, '/')));
    if (fs.existsSync(f) && !out.includes(f)) out.push(f);
  }
  if (out.length) return out;
  const fresh = refsFor(palette, styleDir);
  return fresh.every(f => fs.existsSync(f)) ? fresh : [];
};

// A logo file the user put in assets/logos/ (named <brand>.png|jpg|jpeg|webp|svg), or null.
function logoFileFor(brand, logosDir = LOGO_DIR) {
  if (!brand) return null;
  for (const ext of LOGO_EXTS) {
    const f = path.join(logosDir, `${brand}.${ext}`);
    try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}

const DEFAULT_SUFFIX = 'Flat graphic on solid #00FF00, no green spill.';

const PILL = (t, dotRole) => `At the top left of the card, a small pill label with a ${c(dotRole || 'accent')} dot and the text "${t}".`;
const CAPTION = t => `At the bottom of the card, small grey (#8A8A8A) text "${t}".`;

// One short description per icon.
const ICON_TEXT = {
  play_button: 'rounded rectangle with a white play triangle',
  chat_bubble: 'speech bubble',
  heart: 'heart',
  bell: 'notification bell',
  magnifier: 'magnifying glass',
  lock: 'padlock',
  coin: 'coin',
  trophy: 'trophy',
  book: 'open book',
  lightbulb: 'light bulb',
  globe: 'globe',
  arrow_up: 'bold arrow pointing up',
  arrow_down: 'bold arrow pointing down',
  clock: 'clock',
  shield: 'shield',
  check: 'checkmark in a circle',
  warning: 'warning triangle with an exclamation mark',
  generic: 'rounded square badge'
};

/* ---------------------------------------------------------------- bodies, one per layout and mode */
const trim = s => String(s == null ? '' : s).trim().replace(/[.!?,;:\s]+$/, '');
const list = items => items.join(', ');
const fmtNum = n => (Number.isInteger(n) ? n.toLocaleString('en-US') : String(n));

const BODY = {
  big_number: k => `Centered, a huge bold ${c('accent')} number "${k.value_text}"${k.sub ? ` and below it small grey text "${k.sub}"` : ''}.`,

  bars: k => {
    const rows = k.rows.map((r, i) => {
      const shown = `${k.unit && k.unit !== '%' ? k.unit : ''}${fmtNum(r.value)}${k.unit === '%' ? '%' : ''}`;
      return `Row ${i + 1}: the label "${r.label}" in white on the left, a rounded horizontal bar in ${c(r.role)} whose length is ${r.fill}% of the full bar width, and the text "${shown}" on the right.`;
    });
    return `Below the pill, ${k.rows.length} horizontal rows. ${rows.join(' ')} Bar lengths are proportional.`;
  },

  milestone: k => `Centered white bold text "${k.headline}" with the percent in ${c('accent')}. ` +
    `Below it a wide rounded progress bar in dark grey with a thin white vertical marker at ${k.percent}% and the small white label "${k.marker_label}" under the marker.`,

  chips: k => `${k.headline ? `Centered white bold text "${k.headline}". ` : ''}Below it, ${k.items.length} rounded chips side by side, each with a dark grey fill and a thin border: ` +
    `${list(k.items.map(i => `${i.check ? `a ${c('accent')} checkmark icon and ` : ''}the text "${i.text}" in ${i.role ? c(i.role) : 'white'}`))}.`,

  list: k => `Below the pill, ${k.rows.length} stacked rows, each with a small ${c('accent')} dot on the left and white bold text: ${list(k.rows.map(r => `"${r.text}"`))}.`,

  toggles: k => `Below the pill, ${k.rows.length} stacked rows, each with a white bold label on the left and a pill-shaped toggle switch on the right. ` +
    `${k.rows.map(r => `Label "${r.label}", toggle switched ${r.on ? `ON in ${c(r.role)}` : 'OFF in dark grey'}.`).join(' ')}`,

  columns: k => `Below the pill, two equal columns separated by a thin vertical grey (#3A3A3A) line. ` +
    `Left column: the heading "${k.left.heading}" in ${c(k.left.role)} and under it in white "${k.left.text}". ` +
    `Right column: the heading "${k.right.heading}" in ${c(k.right.role)} and under it in white "${k.right.text}".`,

  formula: k => `Centered on one line, the words ${k.parts.map(p => `"${p}"`).join(` ${k.op} `)}, each word inside its own rounded chip, chips in ${c('accent')}, operators in white.`,

  before_after: k => `Two equal columns joined by a thick arrow from left to right. Left: heading "${k.before.label}" in grey and text "${k.before.text}" in white. ` +
    `Right: heading "${k.after.label}" in ${c('accent')} and text "${k.after.text}" in white.`,

  material: k => {
    if (k.halves) {
      const [l, r] = k.halves;
      return 'The card is split into two equal halves by a thin vertical grey line. ' +
        `Left half: ${trim(l.object)}. The heading "${l.heading}" in ${c(l.role)} at the top. ` +
        `Right half: ${trim(r.object)}. The heading "${r.heading}" in ${c(r.role)} at the top. ` +
        'Realistic textures, satin finishes (no mirror-like surfaces), plain dark backdrop in each half. All objects stay fully inside the card.';
    }
    const tex = k.texture_notes ? String(k.texture_notes).replace(/^realistic\s+/i, '').replace(/\s+texture$/i, '') : '';
    return `Inside the card, ${trim(k.object)}${tex ? `, with a realistic ${tex} texture` : ''}, satin finish, soft warm light, plain dark backdrop.`;
  },

  symbol: k => (k.line_art
    ? `Centered, simple white thick rounded line art of ${trim(k.line_art)} (a simple drawing, not a copy of any real artwork). Below it, white bold text "${k.name}".`
    : `Centered, a large flat ${c(k.icon_role)} ${ICON_TEXT[k.icon] || ICON_TEXT.generic} (a generic shape, not a real logo). Below it, white bold text "${k.name}".`)
};

// ui cards only: an optional hero_icon (Claude) gets one sentence, in the same style as the symbol mode.
const HERO = k => (k.hero_icon ? `A single bold flat ${c('accent')} ${ICON_TEXT[k.hero_icon] || ICON_TEXT.generic} icon (a generic shape, not a real logo) sits above the main element, about the size of the main text.` : '');

const bodyOf = card => (card.mode === 'ui' ? BODY[card.layout] : BODY[card.mode]);

const NO_TEXT_SCENE = 'No text, no letters, no captions, no logos, no watermark, and no recognisable real person.';
const FULL_FRAME_NOTE = 'Full-frame illustration filling the whole image: no card, no border, no frame, no rounded corners, no green background and no user-interface elements.';
const withExtra = e => (e ? ` ${trim(e)}.` : '');

function scenePrompt(card) {
  const scene = [trim(card.subject), card.action ? trim(card.action) : ''].filter(Boolean).join(', ');
  return `${TATAMI_STYLE} ${FULL_FRAME_NOTE} Palette: ${PALETTE_DESC[card.palette] || PALETTE_DESC.blue_grey}. Scene: ${scene}.` +
    `${card.setting ? ` Setting: ${trim(card.setting)}.` : ''} Camera: ${COMPOSITION_DESC[card.composition] || COMPOSITION_DESC.medium}.${withExtra(card.extra)} ${NO_TEXT_SCENE}`;
}

function logoPrompt(card) {
  return `Flat vector brand graphic. The official ${card.display_name} logo exactly as it really looks${card.look ? ` (${trim(card.look)})` : ''}, ` +
    'centered and large on a plain flat dark (#121212) background that fills the whole image. ' +
    "Nothing else: no card, no frame, no green background, no extra text besides the logo's own wordmark, no mockup, no shadow, no reflection, no 3D effect. " +
    'Crisp clean edges, correct brand colours and proportions.';
}

function personPrompt(card) {
  const cam = COMPOSITION_DESC[card.composition] || COMPOSITION_DESC.medium;
  const setting = card.setting ? ` Setting: ${trim(card.setting)}.` : '';
  if (card.render === 'real') {
    return `Photorealistic natural photograph of ${card.name}, a well-known public figure, true to how they publicly look: ${trim(card.action)}.${setting} Camera: ${cam}. ` +
      'Natural lighting, realistic skin and textures, sharp focus, a neutral and respectful depiction. Full-frame image: no card, no frame, no green background. No text, no captions, no logos, no watermark.';
  }
  return `${TATAMI_STYLE} ${FULL_FRAME_NOTE} Palette: ${PALETTE_DESC[card.palette] || PALETTE_DESC.blue_grey}. ` +
    `Scene: ${card.name}, a well-known public figure, drawn as a recognisable stylised animated character${card.look ? ` with ${trim(card.look)}` : ''}, ${trim(card.action)}.${setting} ` +
    `Camera: ${cam}. No text, no letters, no captions, no logos, no watermark.`;
}

/**
 * buildPrompt(card, { common, suffix, styleDir, logosDir }) -> { prompt, refs, source, file }
 *   prompt  the final image prompt ('' for a real_image card and for a logo that has the user's own file)
 *   refs    absolute paths of the Tatami reference images that MUST be attached (exactly three for a scene and an animated
 *           person, [] for everything else)
 *   source  'generated' | 'file' (a logo that comes from assets/logos/) | 'none' (real_image)
 *   file    the logo file path when source is 'file'
 * Card modes: LOOK, FRAME, PILL, body, CAPTION, common instructions, suffix. Full-frame modes have no card, so the common
 * instructions and the green-screen suffix are NOT added: the code owns their style.
 */
function buildPrompt(card, { common = '', suffix = '', styleDir = STYLE_DIR, logosDir = LOGO_DIR } = {}) {
  if (!card || card.mode === 'real_image') return { prompt: '', refs: [], source: 'none', file: null };

  if (card.mode === 'scene') return { prompt: scenePrompt(card), refs: refsFor(card.palette, styleDir), source: 'generated', file: null };
  if (card.mode === 'person') {
    const animated = card.render !== 'real';
    return { prompt: personPrompt(card), refs: animated ? refsFor(card.palette, styleDir) : [], source: 'generated', file: null };
  }
  if (card.mode === 'logo') {
    const file = logoFileFor(card.brand, logosDir);
    if (file) return { prompt: '', refs: [], source: 'file', file };
    return { prompt: logoPrompt(card), refs: [], source: 'generated', file: null };
  }

  const body = bodyOf(card);
  if (!LOOK[card.mode] || !body) throw new Error(`No prompt template for ${card.mode}/${card.layout || ''}.`);
  const parts = [LOOK[card.mode], FRAME, PILL(card.pill, card.pill_dot), body(card)];
  if (card.mode === 'ui' && card.hero_icon) parts.push(HERO(card));
  if (card.caption) parts.push(CAPTION(card.caption));
  if (String(common || '').trim()) parts.push(String(common).trim());
  return { prompt: applySuffix(parts.join(' '), suffix), refs: [], source: 'generated', file: null };
}

module.exports = {
  COLORS, COLOR_NAMES, FRAME, LOOK, DEFAULT_SUFFIX, ICON_TEXT, PILL, CAPTION, buildPrompt,
  TATAMI_STYLE, PALETTE_DESC, COMPOSITION_DESC, RING, REF_COUNT, STYLE_DIR, LOGO_DIR, LOGO_EXTS, refNames, refsFor, healRefs, logoFileFor
};
