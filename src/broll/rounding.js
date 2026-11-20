'use strict';
/**
 * Rounded corners for B-roll pictures that are NOT green-screen UI cards (anime scenes, logos, people, real photos).
 * The radius is a percentage of the picture's SHORTER side (0 = square corners, 50 = a pill / circle).
 * The preview (public/js/broll.js) and both exports (video overlay + Premiere track) use the same numbers.
 */
const DEFAULT_ROUND = 6;   // % of the shorter side: the soft card look of the reference picture
const MAX_ROUND = 50;
// Green-screen UI cards keep their own shape; every other picture (scene, logo, person, real photo) gets rounded corners.
const CARD_MODES = ['ui', 'material', 'symbol'];
const isRoundable = mode => !CARD_MODES.includes(mode);

// Returns a clean percentage, or `fallback` when the value is missing / not a number.
function cleanRound(v, fallback = DEFAULT_ROUND) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(MAX_ROUND, Math.max(0, n)) * 10) / 10;
}

// The ffmpeg filter that cuts the corners away (anti-aliased alpha). Needs an RGBA picture; ends in yuva420p.
// Quoted expression, so the commas are safe inside a filter graph file.
function filterOf(pct) {
  const p = cleanRound(pct, 0);
  if (p <= 0) return '';
  const R = `(min(W,H)*${(p / 100).toFixed(5)})`;
  const dx = `max(abs(X+0.5-W/2)-(W/2-${R}),0)`;
  const dy = `max(abs(Y+0.5-H/2)-(H/2-${R}),0)`;
  const a = `clip(255*(${R}+0.5-sqrt(pow(${dx},2)+pow(${dy},2))),0,255)`;
  return `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${a}'`;
}

module.exports = { DEFAULT_ROUND, MAX_ROUND, CARD_MODES, isRoundable, cleanRound, filterOf };
