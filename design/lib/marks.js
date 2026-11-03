'use strict';
// The element design_ref pointed a session at: one mark per tab, valid until
// the next render of that board and at most 2 minutes. The scanner reads it
// to look only at that element. The module is the plugin's store;
// `create()` makes a separate one (tests).
const path = require('node:path');

const TTL_MS = 2 * 60 * 1000;

// canvas dirs are compared resolved, so `/a/b/` and `/a/b` are the same canvas
const norm = (dir) => (dir ? path.resolve(dir) : dir);

function create() {
  const byTab = new Map(); // tabId -> { board, rect, canvas?, at }

  function set(tabId, mark, now = Date.now()) {
    if (!tabId) return;
    byTab.set(tabId, { ...mark, ...(mark.canvas ? { canvas: norm(mark.canvas) } : {}), at: now });
  }

  function get(tabId, now = Date.now()) {
    const m = byTab.get(tabId);
    if (!m) return null;
    if (now - m.at > TTL_MS) { byTab.delete(tabId); return null; }
    const { at, ...mark } = m;
    return mark;
  }

  // clearBoard(board, canvas?): `canvas` limits it to the marks of that canvas.
  function clearBoard(board, canvas) {
    const c = norm(canvas);
    for (const [tab, m] of byTab) if (m.board === board && (!c || !m.canvas || m.canvas === c)) byTab.delete(tab);
  }

  return { set, get, clearBoard, TTL_MS };
}

module.exports = { ...create(), create, TTL_MS };
