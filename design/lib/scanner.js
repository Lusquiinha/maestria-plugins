'use strict';
// The scanner: a blue band over what Claude is editing. It starts on the
// PreToolUse hook of a Write/Edit/MultiEdit on a file of the canvas linked to
// that tab (last.json byTab) and ends when the board's next render arrives,
// or after TIMEOUT_MS. The edit's own end also counts: PostToolUseFailure
// drops its scans at once; PostToolUse leaves GRACE_MS for the render to come
// (an edit that changed nothing renders nothing).
//   boards/<name>.html      → that board
//   components/<Name>.html  → every board that uses it
//   a design_ref mark of that tab (lib/marks) → only that element
const path = require('node:path');
const components = require('./components');
const marksMod = require('./marks');

const TIMEOUT_MS = 30000;
const GRACE_MS = 3000;
const TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const BOARD_RE = /^boards\/([^/]+)\.html$/;
const COMPONENT_RE = /^components\/([^/]+)\.html$/;

// targets(evt, ctx) → [{ dir, board, rect|null }], pure.
// ctx: { canvases: [{ dir, boards: string[], uses: Map<board, Set<Name>> }],
//        linkedDir(tabId) → dir|null, now, marks }
// The edit of a hook event: { dir (the tab's canvas), file } or null.
function editOf(evt, ctx) {
  const p = evt && evt.payload;
  if (!p || !TOOLS.has(p.tool_name)) return null;
  const raw = p.tool_input && p.tool_input.file_path;
  if (typeof raw !== 'string' || !raw) return null;
  const linked = evt.tabId && ctx.linkedDir(evt.tabId);
  if (!linked) return null;
  const dir = path.resolve(linked);
  return { dir, file: path.resolve(typeof p.cwd === 'string' ? p.cwd : dir, raw) };
}

function targets(evt, ctx) {
  const edit = editOf(evt, ctx);
  if (!edit) return [];
  const { dir, file } = edit;
  const canvas = (ctx.canvases || []).find((c) => path.resolve(c.dir) === dir);
  if (!canvas) return [];
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

// create({ timeoutMs, graceMs, onChange(dir), marks }) → the scans of every open canvas.
function create({ timeoutMs = TIMEOUT_MS, graceMs = GRACE_MS, onChange = () => {}, marks = marksMod } = {}) {
  const scans = new Map(); // `${dir}\0${board}` -> { dir, board, rect, tabId, file, until, timer }
  const keyOf = (dir, board) => `${path.resolve(dir)}\0${board}`;

  function drop(key) {
    const s = scans.get(key);
    if (!s) return false;
    clearTimeout(s.timer);
    scans.delete(key);
    return true;
  }

  // (re)arms the scan `key` to end in `ms` (and tell onChange when it does)
  function arm(key, s, now, ms) {
    clearTimeout(s.timer);
    s.until = now + ms;
    s.timer = setTimeout(() => { if (drop(key)) onChange(s.dir); }, ms);
    if (s.timer.unref) s.timer.unref();
  }

  // PreToolUse: start scanning what the edit touches.
  function onHook(evt, ctx) {
    const now = ctx.now ?? Date.now();
    const got = targets(evt, { ...ctx, now, marks });
    if (!got.length) return got;
    const { file } = editOf(evt, ctx);
    for (const t of got) {
      const key = keyOf(t.dir, t.board);
      drop(key);
      const s = { ...t, tabId: evt.tabId, file, until: 0, timer: null };
      scans.set(key, s);
      arm(key, s, now, timeoutMs);
    }
    return got;
  }

  // PostToolUse / PostToolUseFailure of that tab's edit. Returns the canvas
  // dirs whose scans changed now (to redraw).
  function finish(evt, ctx) {
    const edit = editOf(evt, ctx);
    if (!edit) return [];
    const now = ctx.now ?? Date.now();
    const failed = evt.name === 'PostToolUseFailure';
    const dirs = new Set();
    for (const [key, s] of scans) {
      if (s.tabId !== evt.tabId || s.file !== edit.file) continue;
      if (failed) { drop(key); dirs.add(s.dir); } else if (now + graceMs < s.until) arm(key, s, now, graceMs);
    }
    return [...dirs];
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

  return { onHook, finish, end, active, clear };
}

module.exports = { create, targets, TIMEOUT_MS, GRACE_MS };
