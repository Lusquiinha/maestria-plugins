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

// boxes: collectScript's output; sources: components.expand(..., { annotate }).sources.
// Returns { roots: Node[] }, Node = { k, rect, kind, name, file, path, call, children }.
// Skipped (their children move up): boxes with no source, and plain element
// wrappers without own text whose rect equals the parent's. Breadth-first, so
// the 2000-node cap keeps the outer levels; deeper than 12 levels is dropped.
function tree(boxes, sources) {
  const kids = new Map(); // parent k (null = top) -> boxes
  for (const b of boxes) {
    const list = kids.get(b.p ?? null);
    if (list) list.push(b); else kids.set(b.p ?? null, [b]);
  }
  // kept children of a box, looking through skipped ones
  const keptUnder = (k, rect, acc = []) => {
    for (const b of kids.get(k) || []) {
      const src = sources.get(b.k);
      const skip = !src || (src.kind === 'element' && !b.text && rect && sameRect(b, rect));
      if (skip) keptUnder(b.k, rect, acc);
      else acc.push(b);
    }
    return acc;
  };
  const make = (b) => {
    const s = sources.get(b.k);
    return { k: b.k, rect: { x: b.x, y: b.y, w: b.w, h: b.h }, kind: s.kind, name: s.name, file: s.file, path: s.path, call: s.call || null, children: [] };
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
