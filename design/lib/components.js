'use strict';
// Reusable components for boards: <canvas>/components/<Name>.html used as
// <x-kebab-name param="v">children</x-kebab-name> (or self-closing).
const fs = require('node:fs');
const path = require('node:path');

const NAME_RE = /^[A-Z][A-Za-z0-9]{0,63}$/;
const MAX_DEPTH = 10;
const SLOTS = ['<slot></slot>', '<slot/>', '<slot />'];

const kebab = (name) => name.replace(/[A-Z]/g, (c, i) => (i ? '-' : '') + c.toLowerCase());
const pascal = (tag) => tag.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// load(dir): dir is the canvas folder. Returns Map<Name, html>; files with an
// invalid name are skipped and listed in the `errors` property of the Map.
function load(dir) {
  const map = new Map();
  map.errors = [];
  let files;
  try { files = fs.readdirSync(path.join(dir, 'components')); } catch { return map; }
  for (const f of files.sort()) {
    if (!f.endsWith('.html')) continue;
    const name = f.slice(0, -5);
    if (!NAME_RE.test(name)) { map.errors.push(`nome de componente inválido: ${f}`); continue; }
    try { map.set(name, fs.readFileSync(path.join(dir, 'components', f), 'utf8')); }
    catch (e) { map.errors.push(`${f}: ${e.message}`); }
  }
  return map;
}

// Reads an opening tag starting at html[i] === '<' ("<x-name ...>"). Returns
// { tag, attrs, end, selfClosing } or null if malformed. Attribute values may
// be "double" or 'single' quoted, or unquoted. An attribute without a value
// (`<x-nav-item active>`) is given the string "true" so `{{active}}` is usable.
function readOpen(html, i) {
  let j = i + 1;
  while (j < html.length && /[A-Za-z0-9-]/.test(html[j])) j++;
  const tag = html.slice(i + 1, j);
  const attrs = {};
  for (;;) {
    while (j < html.length && /\s/.test(html[j])) j++;
    if (j >= html.length) return null;
    if (html[j] === '>') return { tag, attrs, end: j + 1, selfClosing: false };
    if (html[j] === '/' && html[j + 1] === '>') return { tag, attrs, end: j + 2, selfClosing: true };
    if (html[j] === '/') { j++; continue; }
    let k = j;
    while (k < html.length && !/[\s=>/]/.test(html[k])) k++;
    const key = html.slice(j, k);
    if (!key) return null;
    j = k;
    while (j < html.length && /\s/.test(html[j])) j++;
    if (html[j] !== '=') { attrs[key] = 'true'; continue; }
    j++;
    while (j < html.length && /\s/.test(html[j])) j++;
    const q = html[j];
    if (q === '"' || q === "'") {
      const e = html.indexOf(q, j + 1);
      if (e < 0) return null;
      attrs[key] = html.slice(j + 1, e);
      j = e + 1;
    } else {
      k = j;
      while (k < html.length && !/[\s>]/.test(html[k])) k++;
      attrs[key] = html.slice(j, k);
      j = k;
    }
  }
}

// Finds the matching </tag> for an open tag ending at `from`, counting nested
// same-name tags. Returns { start, end } of the close tag or null.
function findClose(html, tag, from) {
  const open = '<' + tag;
  const close = '</' + tag;
  let depth = 1;
  let i = from;
  while (i < html.length) {
    const next = html.indexOf('<', i);
    if (next < 0) return null;
    if (html.startsWith(close, next) && /[\s>]/.test(html[next + close.length] || '')) {
      const gt = html.indexOf('>', next);
      if (gt < 0) return null;
      if (--depth === 0) return { start: next, end: gt + 1 };
      i = gt + 1;
    } else if (html.startsWith(open, next) && /[\s/>]/.test(html[next + open.length] || '')) {
      const o = readOpen(html, next);
      if (!o) return null;
      if (!o.selfClosing) depth++;
      i = o.end;
    } else i = next + 1;
  }
  return null;
}

function substitute(tpl, params) {
  let out = '';
  let i = 0;
  while (i < tpl.length) {
    if (tpl.startsWith('{{{', i)) {
      const e = tpl.indexOf('}}}', i + 3);
      if (e >= 0) {
        const k = tpl.slice(i + 3, e).trim();
        out += Object.prototype.hasOwnProperty.call(params, k) ? params[k] : '';
        i = e + 3;
        continue;
      }
    } else if (tpl.startsWith('{{', i)) {
      const e = tpl.indexOf('}}', i + 2);
      if (e >= 0) {
        const k = tpl.slice(i + 2, e).trim();
        out += Object.prototype.hasOwnProperty.call(params, k) ? esc(params[k]) : '';
        i = e + 2;
        continue;
      }
    }
    out += tpl[i++];
  }
  return out;
}

// ---- element scanner (node ids) --------------------------------------------
// Paths are child-element indexes from the file root, counting every element
// open tag in the source (x- calls included; comments and the text of
// script/style/textarea/title skipped). Void elements and `/>` have no
// children. Implicit closes (`<p><div>`) are not modelled: the same scanner
// resolves a path in the source again, so paths stay consistent with it.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const NAME_AT = /[A-Za-z][A-Za-z0-9-]*/y;

// onOpen({ start, nameEnd, end, tag, path, selfClosing }, parentData) -> data
// kept for the element's children.
function scanElements(html, onOpen) {
  const stack = []; // { tag, path, count, data }
  let roots = 0;
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      const e = html.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    const close = html[lt + 1] === '/';
    NAME_AT.lastIndex = lt + (close ? 2 : 1);
    const m = NAME_AT.exec(html);
    if (!m) {
      if (html[lt + 1] === '!' || html[lt + 1] === '?') { const gt = html.indexOf('>', lt); i = gt < 0 ? n : gt + 1; }
      else i = lt + 1;
      continue;
    }
    const tag = m[0].toLowerCase();
    if (close) {
      for (let d = stack.length - 1; d >= 0; d--) if (stack[d].tag === tag) { stack.length = d; break; }
      const gt = html.indexOf('>', lt);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    let j = NAME_AT.lastIndex;
    let quote = null;
    for (; j < n; j++) {
      const c = html[j];
      if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (j >= n) break;
    const selfClosing = html[j - 1] === '/';
    const parent = stack[stack.length - 1];
    const path = parent ? [...parent.path, parent.count++] : [roots++];
    const data = onOpen({ start: lt, nameEnd: NAME_AT.lastIndex, end: j + 1, tag, path, selfClosing }, parent ? parent.data : undefined);
    i = j + 1;
    if (selfClosing || VOID.has(tag)) continue;
    stack.push({ tag, path, count: 0, data });
    if (RAW.has(tag)) {
      const re = new RegExp(`</${tag}[\\s>/]`, 'ig');
      re.lastIndex = i;
      const e = re.exec(html);
      i = e ? e.index : n;
    }
  }
}

// Inserts a temporary origin marker ` data-dn-s="<fid>.<path>"` into every tag
// (not <slot>: it is replaced by the children; it still counts in paths).
function mark(src, fid) {
  let out = '';
  let last = 0;
  scanElements(src, (t) => {
    if (t.tag === 'slot') return;
    out += src.slice(last, t.nameEnd) + ` data-dn-s="${fid}.${t.path.join('_')}"`;
    last = t.nameEnd;
  });
  return out + src.slice(last);
}

const S_RE = / data-dn-s="(\d+)\.([\d_]+)"/;
const C_RE = / data-dn-c="(\d+)"/;

// Replaces the markers with data-dn="k" (every element gets one) and builds
// `sources`: Map<k, record>. Every record names a tag exactly where it is
// written (file + path, found again with scanElements; tag = what is there):
// - element: { file, path, tag, kind: 'element', name: tag, inst? }
// - component call (one per <x-…>, no DOM element of its own; k after the
//   elements): { file, path, tag, kind: 'component', name, componentFile,
//   call: { file, path }, inst? }
// `inst` = k of the call whose template has this at its top level (nodes.tree
// boxes a call around those). Elements with no marker ({{{raw}}} html) get a
// data-dn but no record.
function number(html, files, calls) {
  const sources = new Map();
  let out = '';
  let last = 0;
  let k = 0;
  const at = (fid, p) => ({ file: files[Number(fid)], path: p.split('_').map(Number) });
  const pending = [];
  scanElements(html, (t) => {
    const tagText = html.slice(t.nameEnd, t.end);
    const s = S_RE.exec(tagText);
    const c = C_RE.exec(tagText);
    k++;
    if (s) {
      const src = { ...at(s[1], s[2]), tag: t.tag, kind: 'element', name: t.tag };
      if (c) pending.push([src, Number(c[1])]);
      sources.set(k, src);
    }
    let rest = tagText;
    if (s) rest = rest.replace(S_RE, '');
    if (c) rest = rest.replace(C_RE, '');
    out += html.slice(last, t.nameEnd) + ` data-dn="${k}"` + rest;
    last = t.end;
  });
  const base = k; // call i -> k = base + 1 + i
  for (const [src, i] of pending) src.inst = base + 1 + i;
  calls.forEach((c, i) => {
    const where = at(c.fid, c.path);
    const rec = { ...where, tag: 'x-' + kebab(c.name), kind: 'component', name: c.name,
      componentFile: `components/${c.name}.html`, call: { ...where } };
    if (c.parent != null) rec.inst = base + 1 + c.parent;
    sources.set(base + 1 + i, rec);
  });
  return { html: out + html.slice(last), sources };
}

function expand(html, comps, { annotate = false, file = 'boards/board.html' } = {}) {
  const uses = new Set();
  const errors = [];
  const byTag = new Map();
  for (const name of comps.keys()) byTag.set('x-' + kebab(name), name);
  const err = (m) => { if (!errors.includes(m)) errors.push(m); };

  function run(src, stack) {
    let out = '';
    let i = 0;
    while (i < src.length) {
      const lo = src.indexOf('<x-', i);
      const lc = src.indexOf('</x-', i);
      const lt = lo < 0 ? lc : lc < 0 ? lo : Math.min(lo, lc);
      if (lt < 0) { out += src.slice(i); break; }
      out += src.slice(i, lt);
      if (src.startsWith('</x-', lt)) {
        const gt = src.indexOf('>', lt);
        const m = /^<\/x-[A-Za-z0-9-]*/.exec(src.slice(lt))[0];
        err(`tag de fechamento sem abertura: ${m}>`);
        i = gt < 0 ? src.length : gt + 1;
        continue;
      }
      const o = readOpen(src, lt);
      if (!o || o.tag.length <= 2) {
        const gt = src.indexOf('>', lt);
        const frag = /^<x-[A-Za-z0-9-]*/.exec(src.slice(lt))[0];
        err(`marcação inválida perto de "${frag}…"`);
        i = !o && gt >= 0 ? gt + 1 : o ? o.end : src.length;
        continue;
      }
      let children = '';
      let end = o.end;
      if (!o.selfClosing) {
        const c = findClose(src, o.tag, o.end);
        if (c) { children = src.slice(o.end, c.start); end = c.end; }
        else { err(`tag <${o.tag}> não fechada`); children = src.slice(o.end); end = src.length; }
      }
      i = end;
      const name = byTag.get(o.tag);
      if (!name) {
        err(`componente não existe: ${pascal(o.tag.slice(2))}`);
        out += run(children, stack);
        continue;
      }
      uses.add(name);
      if (stack.includes(name) || stack.length >= MAX_DEPTH) {
        err(`componente em ciclo: ${[...stack, name].join(' → ')}`);
        continue;
      }
      const inner = run(children, stack);
      let body;
      if (annotate) {
        const attrs = { ...o.attrs };
        const callS = attrs['data-dn-s']; // where this call is written
        const callC = attrs['data-dn-c']; // the call whose top level this call is at
        delete attrs['data-dn-s'];
        delete attrs['data-dn-c'];
        const tpl = template(name);
        body = substitute(tpl.html, attrs);
        const m = callS && /^(\d+)\.([\d_]+)$/.exec(callS);
        if (m) {
          // every call is its own instance; the template's top-level tags point at it
          const id = calls.push({ fid: m[1], path: m[2], name, parent: callC != null ? Number(callC) : null }) - 1;
          body = body.replace(tpl.top, (x) => `${x} data-dn-c="${id}"`);
        }
      } else body = substitute(comps.get(name), o.attrs);
      for (const s of SLOTS) body = body.split(s).join(inner);
      out += run(body, [...stack, name]);
    }
    return out;
  }

  if (!annotate) return { html: run(html, []), uses, errors };
  const files = [file];
  const calls = []; // { fid, path, name, parent } in the order they are expanded
  const marked = new Map(); // Name -> { html, top }
  function template(name) {
    if (!marked.has(name)) {
      const fid = files.push(`components/${name}.html`) - 1;
      marked.set(name, { html: mark(comps.get(name), fid), top: new RegExp(` data-dn-s="${fid}\\.\\d+"`, 'g') });
    }
    return marked.get(name);
  }
  const out = number(run(mark(html, 0), []), files, calls);
  return { html: out.html, uses, errors, sources: out.sources };
}

function dependents(boards, changed) {
  const out = new Set();
  for (const [board, used] of boards) if (used.has(changed)) out.add(board);
  return out;
}

module.exports = { load, expand, dependents, scanElements, kebab, NAME_RE };
