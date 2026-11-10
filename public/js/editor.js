import {
  rangesToMask, maskToRanges, computeKeepIntervals, totalDuration
} from "/shared/editModel.js";

// Holds which words are cut, with undo/redo. No DOM in here.
export function createEditor({ words, duration, aiRanges = [], ranges = [], pad = 0.05 }) {
  const n = words.length;
  const aiMask = rangesToMask(aiRanges, n);
  let mask = rangesToMask(ranges, n);

  const undoStack = [];
  const redoStack = [];
  const listeners = new Set();
  let keepCache = null;

  function emit(from, to) {
    keepCache = null;
    for (const fn of listeners) fn({ from, to });
  }

  function clampRange(from, to) {
    return [Math.max(0, Math.min(from, to)), Math.min(n - 1, Math.max(from, to))];
  }

  function diffRange(a, b) {
    let from = -1, to = -1;
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) { if (from === -1) from = i; to = i; }
    }
    return from === -1 ? null : [from, to];
  }

  const editor = {
    words,
    duration,
    get size() { return n; },
    isCut: i => mask[i] === 1,
    isAi: i => aiMask[i] === 1,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    // Cut (value 1) or restore (value 0) words from..to. Returns true if anything changed.
    set(from, to, value) {
      [from, to] = clampRange(from, to);
      let changed = false;
      for (let i = from; i <= to; i++) if (mask[i] !== value) { changed = true; break; }
      if (!changed) return false;

      undoStack.push(mask.slice());
      if (undoStack.length > 300) undoStack.shift();
      redoStack.length = 0;

      mask.fill(value, from, to + 1);
      emit(from, to);
      return true;
    },

    // True when every word in the range is already cut.
    allCut(from, to) {
      [from, to] = clampRange(from, to);
      for (let i = from; i <= to; i++) if (!mask[i]) return false;
      return true;
    },

    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,

    undo() {
      if (!undoStack.length) return false;
      redoStack.push(mask.slice());
      const previous = undoStack.pop();
      const d = diffRange(mask, previous);
      mask = previous;
      if (d) emit(d[0], d[1]);
      return true;
    },

    redo() {
      if (!redoStack.length) return false;
      undoStack.push(mask.slice());
      const next = redoStack.pop();
      const d = diffRange(mask, next);
      mask = next;
      if (d) emit(d[0], d[1]);
      return true;
    },

    // Put every AI suggestion back (and drop manual cuts).
    resetToAi() {
      const next = aiMask.slice();
      const d = diffRange(mask, next);
      if (!d) return false;
      undoStack.push(mask.slice());
      redoStack.length = 0;
      mask = next;
      emit(d[0], d[1]);
      return true;
    },

    ranges: () => maskToRanges(mask),

    // Time intervals that survive the cuts (same maths the server uses to export).
    keep() {
      if (!keepCache) keepCache = computeKeepIntervals(words, mask, { duration, pad });
      return keepCache;
    },
    setPad(value) { pad = value; keepCache = null; },

    // Contiguous cut passages, each tagged AI / you / mixed.
    cutRuns() {
      return maskToRanges(mask).map(([a, b]) => {
        let ai = 0;
        for (let i = a; i <= b; i++) ai += aiMask[i];
        const count = b - a + 1;
        return {
          a, b,
          start: words[a].s,
          end: words[b].e,
          source: ai === count ? "ai" : ai === 0 ? "you" : "mixed",
          text: words.slice(a, b + 1).map(w => w.t).join(" ")
        };
      });
    },

    stats() {
      const keep = editor.keep();
      const finalSeconds = totalDuration(keep);
      let cutWords = 0;
      for (let i = 0; i < n; i++) cutWords += mask[i];
      return {
        finalSeconds,
        removedSeconds: Math.max(0, duration - finalSeconds),
        cutWords,
        cuts: maskToRanges(mask).length
      };
    }
  };

  return editor;
}
