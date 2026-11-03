'use strict';
// Builds the `data` of the canvas view (ui/canvas.rfwtxt) from the canvas
// index, the engine's board states and the view's own ui state. Pure, except
// for the Sprite fallback helpers at the bottom, which copy PNGs into the
// plugin dir (old Maestria builds draw files only from there).
const fs = require('node:fs');
const path = require('node:path');

const STRIP = 28; // name strip above the images
const GAP = 24; // between the light and the dark image
const MARGIN = 80; // around the whole canvas
const DEFAULT_H = 800; // a board not rendered yet and without `h`
const ERROR_H = 56; // the error line under the images (two lines of 16 px)
const EMPTY = { w: 1200, h: 800 };
const BORDER = 2; // the highlight border (always drawn, transparent when off)
const LABEL_H = 24; // the selected node's name, above its rect
const THEMES = ['both', 'light', 'dark'];
// the chords the canvas listens to (KeyListener), exactly as main.js reads them
const KEYS = ['ctrl+c', 'escape', 'ctrl+0', 'ctrl+=', 'ctrl+-'];

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const num = (n) => typeof n === 'number' && Number.isFinite(n);
const copyMenu = (board, k) => [{ action: `copy:${board}:${k}`, label: 'Copiar código' }];

function getter(states) {
  if (!states) return () => null;
  if (states instanceof Map) return (n) => states.get(n) || null;
  return (n) => (has(states, n) ? states[n] : null);
}

function picturePath(hash, name, theme) { return `${hash}/png/${name}.${theme}.png`; }
function spritePath(hash, name, theme, rev) { return `cache/${hash}/${name}.${theme}.${rev}.png`; }

// Theme "both" makes every box wider than its `w` in canvas.json (and a
// measured height may differ from `h`). Push each board right by the extra
// width of the boards to its left in the same row band (and down by the extra
// height of the boards above it in the same column band), so nothing overlaps
// that did not overlap in canvas.json.
function shift(items, pos, size, extra, crossPos, crossSize) {
  return items.map((it) => {
    let d = 0;
    for (const o of items) {
      if (o === it) continue;
      const before = pos(o) + size(o) <= pos(it);
      const band = crossPos(o) < crossPos(it) + crossSize(it) && crossPos(it) < crossPos(o) + crossSize(o);
      if (before && band) d += Math.max(0, extra(o));
    }
    return pos(it) + d;
  });
}

// The node `k` of a nodes tree ({ roots }), or null.
function findNode(tree, k) {
  const walk = (list) => {
    for (const n of list || []) {
      if (n.k === k) return n;
      const r = walk(n.children);
      if (r) return r;
    }
    return null;
  };
  return tree && k != null ? walk(tree.roots) : null;
}

// The parent of node `k` (null at the top or when missing).
function parentOf(tree, k) {
  const walk = (list, parent) => {
    for (const n of list || []) {
      if (n.k === k) return { parent };
      const r = walk(n.children, n);
      if (r) return r;
    }
    return null;
  };
  const r = tree ? walk(tree.roots, null) : null;
  return r ? r.parent : null;
}

function build({ canvas, states, ui = {}, caps = {}, hash = '', scans = [], nodes = null }) {
  const get = getter(states);
  const getNodes = getter(nodes);
  // selection needs the app's middle-drag pan and key listener; without them, v1
  const select = Number(caps.zoomPan) >= 1 && Number(caps.keyListener) >= 1;
  const theme = THEMES.includes(ui.theme) ? ui.theme : 'both';
  const both = theme === 'both';
  const picture = Number(caps.picture) >= 1;
  const zoomFocus = Number(caps.zoomFocus) >= 1;
  const boards = (canvas && canvas.boards) || {};
  const names = ((canvas && canvas.order) || []).filter((n) => has(boards, n));

  const items = names.map((name) => {
    const b = boards[name];
    const s = get(name);
    const imgW = s && num(s.width) && s.width > 0 ? s.width : b.w;
    const imgH = s && num(s.height) && s.height > 0 ? s.height : (num(b.h) ? b.h : DEFAULT_H);
    const error = s && s.error ? String(s.error) : '';
    const boxW = both ? 2 * imgW + GAP : imgW;
    const boxH = STRIP + imgH + (error ? ERROR_H : 0);
    return { name, b, s, imgW, imgH, error, boxW, boxH, H: num(b.h) ? b.h : DEFAULT_H };
  });

  const xs = shift(items, (o) => o.b.x, (o) => o.b.w, (o) => o.boxW - o.b.w, (o) => o.b.y, (o) => o.H);
  const ys = shift(items, (o) => o.b.y, (o) => o.H, (o) => o.boxH - o.H, (o) => o.b.x, (o) => o.b.w);

  let size = { ...EMPTY };
  let minX = 0;
  let minY = 0;
  if (items.length) {
    minX = Math.min(...xs);
    minY = Math.min(...ys);
    const maxX = Math.max(...items.map((it, i) => xs[i] + it.boxW));
    const maxY = Math.max(...items.map((it, i) => ys[i] + it.boxH));
    size = { w: maxX - minX + 2 * MARGIN, h: maxY - minY + 2 * MARGIN };
  }

  const image = (it, t) => {
    if (!it.s || !it.s[t]) return '';
    return picture ? picturePath(hash, it.name, t) : spritePath(hash, it.name, t, it.s.rev || 0);
  };

  const out = items.map((it, i) => ({
    name: it.name,
    title: typeof it.b.title === 'string' && it.b.title ? it.b.title : it.name,
    left: xs[i] - minX + MARGIN,
    top: ys[i] - minY + MARGIN,
    width: it.boxW,
    height: it.boxH,
    frameWidth: it.boxW + 2 * BORDER, // the highlight border sits around the box
    imageWidth: it.imgW,
    imageHeight: it.imgH,
    light: theme === 'dark' ? '' : image(it, 'light'),
    dark: theme === 'light' ? '' : image(it, 'dark'),
    showLight: theme !== 'dark',
    showDark: theme !== 'light',
    gap: both,
    error: it.error,
    cut: !!(it.s && it.s.cut),
    highlight: ui.highlight != null && ui.highlight === it.name,
    rev: (it.s && it.s.rev) || 0,
    focus: `focus:${it.name}`,
    rename: `rename:${it.name}`,
  }));

  // A rect in image px of board i -> canvas px over each shown copy (both in
  // "both"), clipped to the image; [] when nothing of it shows.
  const onImages = (i, r) => {
    const it = items[i];
    const x0 = Math.max(0, r.x);
    const y0 = Math.max(0, r.y);
    const width = Math.min(it.imgW, r.x + r.w) - x0;
    const height = Math.min(it.imgH, r.y + r.h) - y0;
    if (!(width > 0 && height > 0)) return [];
    const left = out[i].left + BORDER + x0;
    const top = out[i].top + BORDER + STRIP + y0;
    const copies = [];
    if (theme !== 'dark') copies.push({ left, top, width, height });
    if (theme !== 'light') copies.push({ left: left + (both ? it.imgW + GAP : 0), top, width, height });
    return copies;
  };

  // the scanner: over each shown image, clipped to it
  const scanRects = [];
  for (const sc of scans || []) {
    const i = items.findIndex((it) => it.name === sc.board);
    if (i < 0) continue;
    scanRects.push(...onImages(i, sc.rect || { x: 0, y: 0, w: items[i].imgW, h: items[i].imgH }));
  }

  // selection: the clickable nodes of the current level (the children of
  // ui.level on its board, the top nodes elsewhere) and the selected node
  const hits = [];
  const selections = [];
  if (select) {
    const level = ui.level || null;
    items.forEach((it, i) => {
      const tree = getNodes(it.name);
      if (!tree) return;
      const opened = level && level.board === it.name ? findNode(tree, level.k) : null;
      for (const n of opened ? opened.children || [] : tree.roots || []) {
        if (!n.rect) continue;
        for (const c of onImages(i, n.rect)) hits.push({ board: it.name, k: n.k, ...c, tap: `sel:${it.name}:${n.k}`, dbl: `in:${it.name}:${n.k}`, menu: copyMenu(it.name, n.k) });
      }
    });
    const sel = ui.sel || null;
    const i = sel ? items.findIndex((it) => it.name === sel.board) : -1;
    const n = i >= 0 ? findNode(getNodes(sel.board), sel.k) : null;
    if (n && n.rect) {
      // the selected node's children, over the level (Figma): one click keeps
      // the parent selected, a double click picks the child under the cursor
      for (const ch of n.children || []) {
        if (!ch.rect) continue;
        for (const c of onImages(i, ch.rect)) hits.push({ board: sel.board, k: ch.k, ...c, tap: `sel:${sel.board}:${n.k}`, dbl: `child:${sel.board}:${ch.k}`, menu: copyMenu(sel.board, ch.k) });
      }
      // the chrome keeps its size on screen: canvas px / (zoom scale x the
      // app's fit factor, 1 on apps that do not send it)
      const pos = (v) => (num(v) && v > 0 ? v : 1);
      const scale = pos(ui.scale) * pos(ui.fit);
      const labelH = LABEL_H / scale;
      const chrome = { labelH, fontSize: 14 / scale, padX: 6 / scale, padY: 2 / scale, border: 2 / scale };
      for (const c of onImages(i, n.rect)) selections.push({ ...c, label: String(n.name || ''), labelTop: c.top - labelH, ...chrome });
    }
  }

  const zoom = { command: '', focus: { x: 0, y: 0, w: 1, h: 1 }, rev: num(ui.rev) ? ui.rev : 0 };
  const cmd = ui.command;
  if (cmd && ['in', 'out', 'fit'].includes(cmd.kind)) zoom.command = cmd.kind;
  else if (cmd && cmd.kind === 'focus') {
    let rect = null;
    if (cmd.rect) rect = cmd.rect;
    else {
      const b = out.find((x) => x.name === cmd.board);
      if (b) rect = { x: b.left, y: b.top, w: b.width, h: b.height };
    }
    if (rect && zoomFocus) {
      const clamp = (v) => Math.min(1, Math.max(0, v));
      const x = clamp(rect.x / size.w);
      const y = clamp(rect.y / size.h);
      zoom.command = 'focus';
      zoom.focus = { x, y, w: Math.min(1 - x, clamp(rect.w / size.w)), h: Math.min(1 - y, clamp(rect.h / size.h)) };
    } else zoom.command = 'fit';
  }

  // the one menu of the bar: theme, follow and the boards (zoom is the wheel and the keys)
  const check = (on) => (on ? { icon: 'check' } : {});
  const menu = [
    { action: 'tema:light', label: 'claro', ...check(theme === 'light') },
    { action: 'tema:dark', label: 'escuro', ...check(theme === 'dark') },
    { action: 'tema:both', label: 'claro e escuro lado a lado', ...check(theme === 'both') },
    { type: 'divider' },
    { action: 'seguir', label: 'seguir o claude', ...check(!!ui.follow) },
  ];
  if (out.length) menu.push({ type: 'divider' }, ...out.map((b) => ({ action: b.focus, label: b.title, icon: 'layers' })));

  const selectData = select ? { panButtons: ['middle'] } : {};
  if (selections.length) selectData.selection = selections[0];
  return {
    title: (canvas && canvas.title) || '',
    theme,
    follow: !!ui.follow,
    menu,
    boards: out,
    scans: scanRects,
    select,
    keys: select ? [...KEYS] : [],
    hits,
    selections,
    ...selectData,
    hasBoards: out.length > 0,
    warnings: ((canvas && canvas.warnings) || []).map(String),
    hasWarnings: !!(canvas && canvas.warnings && canvas.warnings.length),
    message: ui.message ? String(ui.message) : '',
    zoom,
    size,
    picture,
  };
}

// rfw reads sizes and positions as doubles only, and JSON says `80`, not
// `80.0`: nudge every whole number off the integer (down, so a fraction of 1
// stays within 0..1). `rev` keys stay ints (commandRev takes either), and so
// do node ids (`k`).
const NUDGE = 1e-9;
function wire(v, key) {
  if (typeof v === 'number') {
    if (key === 'rev' || key === 'k' || !Number.isInteger(v)) return v;
    return v > 0 ? v - NUDGE : v + NUDGE;
  }
  if (Array.isArray(v)) return v.map((x) => wire(x));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = wire(x, k);
    return out;
  }
  return v;
}

// ---- Sprite fallback: copies under <pluginDir>/cache/<hash>/ ---------------

function cacheSprites({ pluginDir, hash, states }) {
  const dir = path.join(pluginDir, 'cache', hash);
  fs.mkdirSync(dir, { recursive: true });
  const keep = new Set();
  const entries = states instanceof Map ? [...states.entries()] : Object.entries(states || {});
  for (const [name, s] of entries) {
    if (!s) continue;
    for (const t of ['light', 'dark']) {
      if (!s[t]) continue;
      const rel = spritePath(hash, name, t, s.rev || 0);
      const to = path.join(pluginDir, rel);
      keep.add(path.basename(to));
      if (fs.existsSync(to)) continue;
      try { fs.copyFileSync(s[t], to); } catch { /* the png went away: next render brings it */ }
    }
  }
  for (const f of fs.readdirSync(dir)) if (!keep.has(f)) fs.rmSync(path.join(dir, f), { force: true });
}

function clearSprites({ pluginDir, hash }) {
  fs.rmSync(path.join(pluginDir, 'cache', hash), { recursive: true, force: true });
}

module.exports = { build, wire, findNode, parentOf, KEYS, cacheSprites, clearSprites, picturePath, STRIP, GAP, MARGIN };
