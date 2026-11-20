'use strict';
/**
 * The RICH prompt profile (used when the AI is Claude: llm.profile === 'rich').
 * The text of every block lives in src/broll/prompts/rich/*.txt so it can be read and edited without touching code.
 * Groq and Gemini never load this: they keep the compact prompts in planner.js and cardAi.js.
 *
 * Blocks: A role + world, B modes + decision order, C forms, D rules + creativity, E scene palettes, H viewer psychology, F examples (incl. F2), G output rules.
 * Order used by T3, T4 and T6: A, B, C, D, E, H, F, G (H sits after the palettes and before the examples).
 * Tasks:  T1 plan, T2 choose, T3 cards, T4 new idea, T5 re-describe, T6 pick and design (optional), T7 free-style writer.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'prompts', 'rich');
const cache = new Map();
const read = name => {
  if (!cache.has(name)) cache.set(name, fs.readFileSync(path.join(DIR, `${name}.txt`), 'utf8').replace(/\r\n/g, '\n').trim());
  return cache.get(name);
};
const join = (...parts) => parts.join('\n\n');

const isRich = llm => Boolean(llm) && llm.profile === 'rich';

// Block A-short: the <role> paragraph, the first sentence of <how_this_tool_works> and its three numbered steps.
function blockAShort() {
  const a = read('A');
  const role = (/<role>\n([\s\S]*?)\n<\/role>/.exec(a) || [])[1] || '';
  const how = (/<how_this_tool_works>\n([\s\S]*?)\n<\/how_this_tool_works>/.exec(a) || [])[1] || '';
  const lines = how.split('\n');
  const first = (lines[0].match(/^.*?one step at a time\./) || [lines[0]])[0];
  const steps = lines.filter(l => /^[123]\. /.test(l));
  return `<role>\n${role}\n</role>\n\n<how_this_tool_works>\n${[first, ...steps].join('\n')}\n</how_this_tool_works>`;
}
const withAShort = text => text.replace('<role>\n(Block A-short)\n</role>', blockAShort());
const blocksAtoG = () => join(read('A'), read('B'), read('C'), read('D'), read('E'), read('H'), read('F'), read('G'));

/* ---------------------------------------------------------------- system prompts */
const planSystemRich = () => withAShort(read('t1-plan'));
const selectSystemRich = () => withAShort(read('t2-choose'));
const regenSystemRich = () => withAShort(read('t5-redescribe'));
const cardSystemRich = () => join(blocksAtoG(), read('t3-task'));
const ideaSystemRich = () => join(blocksAtoG(), read('t4-task'));
const promptSystemRich = () => read('t7-freestyle');

// T6: choose + cards in one message (used when claude.combineChooseCards is true).
function pickDesignSystemRich() {
  const t2 = read('t2-choose');
  const section = tag => (new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`).exec(t2) || [''])[0];
  return join(blocksAtoG(), section('what_earns_a_picture'), section('viewer_attention'), section('grouping'), section('pacing'), read('t6-task'));
}

/* ---------------------------------------------------------------- user messages */
const mmss = sec => { const s = Math.max(0, Math.round(Number(sec) || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// T3. pictures: [{ id, time, line, description, before, after }]; earlier: lines like "b003 ui bars | skool vs youtube ads".
function cardUserRich({ duration, part = 1, parts = 1, earlier = [], pictures }) {
  return `<video_brief>\nDuration: ${mmss(duration)}. Part ${part} of ${parts}.\n</video_brief>\n\n` +
    `<earlier_cards>\n${earlier.length ? earlier.join('\n') : 'none'}\n</earlier_cards>\n\n` +
    `<pictures>\n${JSON.stringify(pictures, null, 1)}\n</pictures>\n\n` +
    (pictures.some(p => p.fix || p.avoid) ? 'A picture with a "fix" key: your earlier form for it was rejected for that reason; correct it. A picture with an "avoid" key: do not use those layouts, palettes or modes for it.\n\n' : '') +
    'Design one form for every picture now. Reply with only the JSON.';
}

// T6: every line with its description (and its neighbours), in one message.
function pickDesignUserRich({ duration, earlier = [], rows }) {
  return `<video_brief>\nDuration: ${mmss(duration)}. Part 1 of 1.\n</video_brief>\n\n` +
    `<earlier_cards>\n${earlier.length ? earlier.join('\n') : 'none'}\n</earlier_cards>\n\n` +
    `LINES:\n${JSON.stringify(rows, null, 1)}\n\nChoose the pictures and design every card now. Reply with only the JSON.`;
}

// T4.
function ideaUserRich({ picture, current, avoid = {}, wish = '' }) {
  const list = k => `[${(avoid[k] || []).join(', ')}]`;
  return `<picture>\n${JSON.stringify(picture)}\n</picture>\n<current_card>\n${JSON.stringify(current || null)}\n</current_card>\n` +
    `<avoid>\nmodes: ${list('modes')}  layouts: ${list('layouts')}  palettes: ${list('palettes')}\n</avoid>\n` +
    `<editor_wish>\n${String(wish || '').trim() || 'none'}\n</editor_wish>\nReply with only the JSON.`;
}

// One line describing a card, for <earlier_cards>: "id mode layout-or-palette | subject".
function cardLine(card) {
  const kind = card.mode === 'ui' ? card.layout : (card.palette || card.brand || card.render || '');
  const what = card.subject || card.name || card.display_name || card.pill || card.search_hint || '';
  return `${card.id} ${card.mode}${kind ? ' ' + kind : ''} | ${String(what).slice(0, 80)}`;
}

module.exports = {
  isRich, read, blockAShort, blocksAtoG, mmss, cardLine,
  planSystemRich, selectSystemRich, regenSystemRich, cardSystemRich, ideaSystemRich, pickDesignSystemRich, promptSystemRich,
  cardUserRich, ideaUserRich, pickDesignUserRich
};
