'use strict';
// The element design_ref pointed a session at: one mark per tab, valid until
// the next render of that board and at most 2 minutes. The scanner reads it
// to look only at that element.
const TTL_MS = 2 * 60 * 1000;
const byTab = new Map(); // tabId -> { board, rect, canvas?, at }

function set(tabId, mark, now = Date.now()) {
  if (!tabId) return;
  byTab.set(tabId, { ...mark, at: now });
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
  for (const [tab, m] of byTab) if (m.board === board && (!canvas || !m.canvas || m.canvas === canvas)) byTab.delete(tab);
}

module.exports = { set, get, clearBoard, TTL_MS };
