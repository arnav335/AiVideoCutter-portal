'use strict';
/**
 * B-roll themes.
 *   card  every picture is a dark rounded UI card on solid green (#00FF00): the LLM fills a small form, CODE writes the prompt.
 *   free  the original behaviour: the LLM writes a free-form image prompt for every B-roll.
 * Projects stored without a theme are `free`; new projects start with `card`.
 */
const THEMES = [
  { id: 'card', label: 'UI Card (green screen)', usesCards: true },
  { id: 'free', label: 'Free style', usesCards: false }
];

const DEFAULT_THEME = 'card';     // new projects
const LEGACY_THEME = 'free';      // projects saved before themes existed

const getTheme = id => THEMES.find(t => t.id === id) || null;
const isTheme = id => Boolean(getTheme(id));
const normalizeTheme = (id, fallback = LEGACY_THEME) => (isTheme(id) ? id : fallback);
const usesCards = id => Boolean(getTheme(id) && getTheme(id).usesCards);

module.exports = { THEMES, DEFAULT_THEME, LEGACY_THEME, getTheme, isTheme, normalizeTheme, usesCards };
