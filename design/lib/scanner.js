'use strict';
// The scanner: a blue band over what Claude is editing. It starts on the
// PreToolUse hook of a Write/Edit/MultiEdit on a file of the canvas linked to
// that tab (last.json byTab) and ends when the board's next render arrives,
// or after TIMEOUT_MS.
//   boards/<name>.html      → that board
//   components/<Name>.html  → every board that uses it
//   a design_ref mark of that tab (lib/marks) → only that element
const path = require('node:path');
const components = require('./components');
const marksMod = require('./marks');

const TIMEOUT_MS = 30000;
const TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const BOARD_RE = /^boards\/([^/]+)\.html$/;
const COMPONENT_RE = /^components\/([^/]+)\.html$/;

// targets(evt, ctx) → [{ dir, board, rect|null }], pure.
// ctx: { canvases: [{ dir, boards: string[], uses: Map<board, Set<Name>> }],
//        linkedDir(tabId) → dir|null, now, marks }
function targets(evt, ctx) {
  const p = evt && evt.payload;
  if (!p || !TOOLS.has(p.tool_name)) return [];
  const raw = p.tool_input && p.tool_input.file_path;
  if (typeof raw !== 'string' || !raw) return [];
  const linked = evt.tabId && ctx.linkedDir(evt.tabId);
  if (!linked) return [];
  const dir = path.resolve(linked);
  const canvas = (ctx.canvases || []).find((c) => path.resolve(c.dir) === dir);
  if (!canvas) return [];
  const file = path.resolve(typeof p.cwd === 'string' ? p.cwd : dir, raw);
  const rel = path.relative(dir, file).split(path.sep).join('/');
  const known = new Set(canvas.boards || []);
  let boards = [];
  let m;
  if ((m = BOARD_RE.exec(rel))) boards = known.has(m[1]) ? [m[1]] : [];
  else if ((m = COMPONENT_RE.exec(rel))) boards = [...components.dependents(canvas.uses || new Map(), m[1])].filter((b) => known.has(b));
  if (!boards.length) return [];
  const marks = ctx.marks || marksMod;
  const mark = marks.get(evt.tabId, ctx.now);
  if (mark && mark.rect && boards.includes(mark.board) && (!mark.canvas || path.resolve(mark.canvas) === dir)) {
    return [{ dir, board: mark.board, rect: mark.rect }];
  }
  return boards.map((board) => ({ dir, board, rect: null }));
}

// create({ timeoutMs, onChange(dir), marks }) → the scans of every open canvas.
function create({ timeoutMs = TIMEOUT_MS, onChange = () => {}, marks = marksMod } = {}) {
  const scans = new Map(); // `${dir}\0${board}` -> { dir, board, rect, until, timer }
  const keyOf = (dir, board) => `${path.resolve(dir)}\0${board}`;

  function drop(key) {
    const s = scans.get(key);
    if (!s) return false;
    clearTimeout(s.timer);
    scans.delete(key);
    return true;
  }

  function onHook(evt, ctx) {
    const now = ctx.now ?? Date.now();
    const got = targets(evt, { ...ctx, now, marks });
    for (const t of got) {
      const key = keyOf(t.dir, t.board);
      drop(key);
      const timer = setTimeout(() => { if (drop(key)) onChange(t.dir); }, timeoutMs);
      if (timer.unref) timer.unref();
      scans.set(key, { ...t, until: now + timeoutMs, timer });
    }
    return got;
  }

  // end(board, dir): the board rendered: its scan stops and its mark goes.
  function end(board, dir) {
    marks.clearBoard(board, dir && path.resolve(dir));
    return drop(keyOf(dir, board));
  }

  function active(dir, now = Date.now()) {
    const d = path.resolve(dir);
    const out = [];
    for (const [key, s] of scans) {
      if (s.dir !== d) continue;
      if (now > s.until) { drop(key); continue; }
      out.push({ board: s.board, rect: s.rect });
    }
    return out;
  }

  function clear(dir) {
    const d = path.resolve(dir);
    for (const [key, s] of scans) if (s.dir === d) drop(key);
  }

  return { onHook, end, active, clear };
}

module.exports = { create, targets, TIMEOUT_MS };
