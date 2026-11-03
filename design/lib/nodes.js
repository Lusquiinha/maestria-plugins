'use strict';
// Element boxes for selection: measured once in the light render (light and
// dark share the layout), then turned into a tree of selectable nodes.

const MAX_NODES = 2000;
const MAX_DEPTH = 12;
const MAX_BOXES = 20000; // what the page hands back at most
const SAME = 0.5; // px: a wrapper whose rect is this close to its parent's is skipped

// Evaluated in the page. Walks the annotated elements (data-dn) and returns
// those with a visible box: [{ k, p, x, y, w, h, text }] in CSS px from the
// page origin, `p` = k of the nearest ancestor returned (null at the top),
// `text` = the element has its own non-blank text. An svg is one box (its
// shapes are not walked).
const collectScript = `(() => {
  const out = [];
  const sx = window.scrollX, sy = window.scrollY;
  const r1 = (v) => Math.round(v * 10) / 10;
  const walk = (el, p) => {
    for (const c of el.children) {
      if (out.length >= ${MAX_BOXES}) return;
      let next = p;
      const k = c.getAttribute('data-dn');
      if (k !== null) {
        const r = c.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && getComputedStyle(c).visibility !== 'hidden') {
          let text = false;
          for (const n of c.childNodes) if (n.nodeType === 3 && n.data.trim()) { text = true; break; }
          out.push({ k: +k, p, x: r1(r.left + sx), y: r1(r.top + sy), w: r1(r.width), h: r1(r.height), text });
          next = +k;
        }
      }
      if (c.namespaceURI !== 'http://www.w3.org/2000/svg') walk(c, next);
    }
  };
  if (document.body) walk(document.body, null);
  return out;
})()`;

const sameRect = (a, b) => Math.abs(a.x - b.x) <= SAME && Math.abs(a.y - b.y) <= SAME
  && Math.abs(a.w - b.w) <= SAME && Math.abs(a.h - b.h) <= SAME;

// A component call has no element of its own: its box is the union of the
// boxes at its template's top level (records with `inst`), placed where they
// sit in the page; nested calls nest (outer is the parent of inner).
const r1 = (v) => Math.round(v * 10) / 10;
function withCalls(boxes, sources) {
  const calls = new Map(); // call k -> synthetic box
  const out = [];
  for (const b of boxes) {
    const s = sources.get(b.k);
    if (!s || s.inst == null) { out.push(b); continue; }
    out.push({ ...b, p: s.inst });
    let rect = b;
    for (let ck = s.inst; ck != null;) {
      const cs = sources.get(ck);
      if (!cs) break;
      let cb = calls.get(ck);
      if (!cb) {
        cb = { k: ck, p: null, x: rect.x, y: rect.y, w: rect.w, h: rect.h, text: false };
        calls.set(ck, cb);
        out.push(cb);
      } else {
        const x2 = Math.max(cb.x + cb.w, rect.x + rect.w);
        const y2 = Math.max(cb.y + cb.h, rect.y + rect.h);
        cb.x = Math.min(cb.x, rect.x);
        cb.y = Math.min(cb.y, rect.y);
        cb.w = r1(x2 - cb.x);
        cb.h = r1(y2 - cb.y);
      }
      cb.p = cs.inst != null ? cs.inst : b.p;
      rect = cb;
      ck = cs.inst;
    }
  }
  return out;
}

// boxes: collectScript's output; sources: components.expand(..., { annotate }).sources.
// Returns { roots: Node[] }, Node = { k, rect, kind, name, file, path, call,
// componentFile, children } (call/componentFile null for elements).
// Skipped (their children move up): boxes with no source, and plain element
// wrappers without own text whose rect equals the parent's, and, with the
// board `viewport` ({ w, h }, CSS px), a top-level non-component that covers
// the whole board (the page wrapper: its children are the roots). Breadth-
// first, so the 2000-node cap keeps the outer levels; deeper than 12 levels is
// dropped.
function tree(boxes, sources, viewport = null) {
  const kids = new Map(); // parent k (null = top) -> boxes
  for (const b of withCalls(boxes, sources)) {
    const list = kids.get(b.p ?? null);
    if (list) list.push(b); else kids.set(b.p ?? null, [b]);
  }
  // kept children of a box, looking through skipped ones
  const coversBoard = (b) => viewport && Math.abs(b.x) <= SAME && Math.abs(b.y) <= SAME
    && Math.abs(b.w - viewport.w) <= SAME && b.h >= viewport.h - SAME;
  const keptUnder = (k, rect, acc = []) => {
    for (const b of kids.get(k) || []) {
      const src = sources.get(b.k);
      const skip = !src || (src.kind === 'element' && !b.text && rect && sameRect(b, rect))
        || (!rect && src.kind !== 'component' && coversBoard(b));
      if (skip) keptUnder(b.k, rect, acc);
      else acc.push(b);
    }
    return acc;
  };
  const make = (b) => {
    const s = sources.get(b.k);
    return { k: b.k, rect: { x: b.x, y: b.y, w: b.w, h: b.h }, kind: s.kind, name: s.name, file: s.file, path: s.path, call: s.call || null, componentFile: s.componentFile || null, children: [] };
  };
  const roots = [];
  let level = keptUnder(null, null).map((b) => ({ b, into: roots }));
  let count = 0;
  for (let depth = 1; depth <= MAX_DEPTH && level.length && count < MAX_NODES; depth++) {
    const next = [];
    for (const { b, into } of level) {
      if (count >= MAX_NODES) break;
      const node = make(b);
      into.push(node);
      count++;
      if (depth < MAX_DEPTH) for (const c of keptUnder(b.k, b)) next.push({ b: c, into: node.children });
    }
    level = next;
  }
  return { roots };
}

module.exports = { collectScript, tree, MAX_NODES, MAX_DEPTH };
