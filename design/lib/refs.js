'use strict';
// Short codes (`@n<k>`) the user copies from the canvas and pastes in the chat.
// A code names a node by where it is written: board + source file + structural
// path (components.scanElements paths) + the component calls around it (`via`,
// so the same element in three instances gives three codes). It keeps a SHA-1
// of the opening tags on its path (see fingerprint); resolve() refuses (stale)
// when the path no longer resolves or those tags changed. Nothing is written
// into the sources.
// Persisted per canvas in <dataDir>/refs.json; the numbers come from one
// counter for the whole plugin (<dataDir>/../refs-counter.json, dataDir being
// <plugin data>/<canvas hash>), so a code pasted into another canvas's chat is
// unknown there instead of naming something else.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const canvasMod = require('./canvas');
const components = require('./components');

const FILE_RE = /^(boards|components)\/[A-Za-z0-9_-]+\.html$/;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const samePath = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
const site = (n) => ({ file: n.file, path: n.path, componentFile: n.componentFile || null });

// The end of the element opened at `open` (counts nested same-name tags).
function closeOf(html, open) {
  if (open.selfClosing || VOID.has(open.tag)) return open.end;
  const re = new RegExp(`<!--|<(/?)${open.tag}(?=[\\s/>])`, 'gi');
  re.lastIndex = open.end;
  let depth = 1;
  for (let m; (m = re.exec(html));) {
    if (m[0] === '<!--') { const e = html.indexOf('-->', re.lastIndex); if (e < 0) break; re.lastIndex = e + 3; continue; }
    const gt = html.indexOf('>', re.lastIndex);
    if (gt < 0) break;
    if (m[1]) { if (--depth === 0) return gt + 1; } else if (html[gt - 1] !== '/') depth++;
    re.lastIndex = gt + 1;
  }
  return html.length;
}

// { tag, text, line } of the element at `p` in `html`, or null.
function outer(html, p) {
  let hit = null;
  components.scanElements(html, (t) => { if (!hit && samePath(t.path, p)) hit = t; });
  if (!hit) return null;
  const text = html.slice(hit.start, closeOf(html, hit));
  return { tag: hit.tag, text, line: html.slice(0, hit.start).split('\n').length };
}

// The fingerprint of the element at `p`: its opening tag plus the opening tags
// of every ancestor and of every preceding sibling at each level, in source
// order. Inner content does not count, so editing inside keeps the code; a
// changed attribute or anything inserted before it on the path makes it stale.
function fingerprint(html, p) {
  const parts = [];
  let found = false;
  components.scanElements(html, (t) => {
    const q = t.path;
    if (q.length > p.length) return;
    for (let d = 0; d < q.length - 1; d++) if (q[d] !== p[d]) return;
    const last = q.length - 1;
    if (q[last] > p[last]) return; // a later sibling
    if (q.length === p.length && q[last] === p[last]) found = true; // itself (else: ancestor or preceding sibling)
    parts.push(html.slice(t.start, t.end));
  });
  return found ? sha1(parts.join('\n')) : null;
}

function readSource(canvasDir, file) {
  if (!FILE_RE.test(file)) return null;
  try { return fs.readFileSync(path.join(canvasDir, file), 'utf8'); } catch { return null; }
}

// { tag, text, line, fp } of the element at `p` in a source file, or null.
function at(canvasDir, file, p) {
  const html = readSource(canvasDir, file);
  const o = html == null ? null : outer(html, p);
  return o && { ...o, fp: fingerprint(html, p) };
}

// The component calls around node `k` in a nodes tree, outermost first.
function viaOf(roots, k) {
  const walk = (list, chain) => {
    for (const n of list) {
      if (n.k === k) return chain;
      const r = walk(n.children || [], n.kind === 'component' ? [...chain, site(n)] : chain);
      if (r) return r;
    }
    return null;
  };
  return walk(roots || [], []) || [];
}

// The node of { file, path, via } in a nodes tree, or null.
function locate(roots, ref) {
  const via = ref.via || [];
  const walk = (list, chain) => {
    for (const n of list) {
      if (n.file === ref.file && samePath(n.path, ref.path) && chain.length === via.length
        && chain.every((c, i) => c.file === via[i].file && samePath(c.path, via[i].path))) return n;
      const r = walk(n.children || [], n.kind === 'component' ? [...chain, n] : chain);
      if (r) return r;
    }
    return null;
  };
  return walk(roots || [], []);
}

function usedIn(canvasDir, name) {
  let canvas;
  try { canvas = canvasMod.read(canvasDir); } catch { return []; }
  const comps = components.load(canvasDir);
  return canvas.order.filter((b) => {
    const src = readSource(canvasDir, `boards/${b}.html`);
    return src != null && components.expand(src, comps).uses.has(name);
  });
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

const parseCode = (code) => { const m = /^@?n?(\d+)$/.exec(String(code || '').trim()); return m ? Number(m[1]) : null; };

class Refs {
  constructor(dataDir, canvasDir) {
    if (!dataDir || !canvasDir) throw new Error('refs.open precisa de dataDir e canvasDir');
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'refs.json');
    this.counterFile = path.join(path.dirname(path.resolve(dataDir)), 'refs-counter.json');
    this.canvasDir = canvasDir;
  }

  // The next free number across canvases (never below this canvas's own `next`,
  // for maps written before the shared counter).
  take(localNext) {
    let next = 1;
    try { const j = JSON.parse(fs.readFileSync(this.counterFile, 'utf8')); if (Number.isInteger(j.next) && j.next > 0) next = j.next; } catch { /* first code */ }
    const k = Math.max(next, localNext);
    writeAtomic(this.counterFile, JSON.stringify({ next: k + 1 }));
    return k;
  }

  // Throws when a file the node comes from was saved after the board's last
  // node map: the boxes on screen may not be that element any more.
  checkFresh(board, files, canvasDir) {
    let mapAt;
    try { mapAt = fs.statSync(path.join(this.dataDir, 'nodes', `${board}.json`)).mtimeMs; } catch { return; }
    for (const f of files) {
      if (!FILE_RE.test(f)) continue;
      let at;
      try { at = fs.statSync(path.join(canvasDir, f)).mtimeMs; } catch { continue; }
      if (at > mapAt) throw new Error('A tela mudou: espere a imagem nova');
    }
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (j && typeof j.next === 'number' && j.codes && j.keys) return j;
    } catch { /* first code */ }
    return { next: 1, keys: {}, codes: {} };
  }

  save(j) { writeAtomic(this.file, JSON.stringify(j)); }

  // node: a nodes-tree node ({ kind, name, file, path, componentFile }) plus
  // `via` (viaOf) when it sits inside component calls. Selecting again
  // refreshes the fingerprint under the same code.
  codeFor(board, node, canvasDir = this.canvasDir) {
    if (String(node.file).startsWith('components/') && !(node.via && node.via.length)) {
      throw new Error(`codeFor: ${node.file} ${JSON.stringify(node.path)} está num componente e veio sem via (use refs.viaOf)`);
    }
    const via = (node.via || []).map((v) => ({ file: v.file, path: [...v.path], componentFile: v.componentFile || null }));
    this.checkFresh(board, [node.file, ...via.map((v) => v.file)], canvasDir);
    const key = JSON.stringify([board, node.file, node.path, via.map((v) => [v.file, v.path])]);
    const j = this.load();
    let k = j.keys[key];
    if (k == null) { k = this.take(j.next); j.next = k + 1; j.keys[key] = k; }
    const fp = (file, p) => { const o = at(canvasDir, file, p); return o ? o.fp : null; };
    j.codes[k] = {
      board, file: node.file, path: [...node.path], kind: node.kind, name: node.name,
      componentFile: node.componentFile || null, via, fp: fp(node.file, node.path), viaFp: via.map((v) => fp(v.file, v.path)),
    };
    this.save(j);
    return `@n${k}`;
  }

  entry(code) {
    const k = parseCode(code);
    return k == null ? null : this.load().codes[k] || null;
  }

  // -> { board, file, path, line, tag, kind, call, snippet, componentFile?, usedIn, via }
  //  | { stale: true } | { unknown: true }
  // { e, o, sites } while the code's element and its call sites still match
  // their fingerprints; 'unknown' / 'stale' otherwise.
  check(code, canvasDir) {
    const e = this.entry(code);
    if (!e) return 'unknown';
    const o = at(canvasDir, e.file, e.path);
    if (!o || !e.fp || o.fp !== e.fp) return 'stale';
    const sites = [];
    for (let i = 0; i < e.via.length; i++) {
      const v = at(canvasDir, e.via[i].file, e.via[i].path);
      if (!v || !v.fp || v.fp !== e.viaFp[i]) return 'stale';
      sites.push(v);
    }
    return { e, o, sites };
  }

  // The entry of a code that still points at its element (for locate), or null.
  current(code, canvasDir = this.canvasDir) {
    const c = this.check(code, canvasDir);
    return typeof c === 'string' ? null : c.e;
  }

  resolve(code, canvasDir = this.canvasDir) {
    const c = this.check(code, canvasDir);
    if (typeof c === 'string') return { [c]: true };
    const { e, o, sites } = c;
    const out = { board: e.board, file: e.file, path: e.path, line: o.line, tag: o.tag, kind: e.kind, snippet: o.text, call: null, usedIn: [], via: e.via };
    let componentFile = null;
    if (e.kind === 'component') {
      componentFile = e.componentFile;
      out.call = { file: e.file, path: e.path, line: o.line, snippet: o.text };
    } else if (e.file.startsWith('components/')) {
      componentFile = e.file;
      // the instance: the innermost call of the component this element is written in
      for (let i = e.via.length - 1; i >= 0; i--) {
        if (e.via[i].componentFile === e.file) {
          out.call = { file: e.via[i].file, path: e.via[i].path, line: sites[i].line, snippet: sites[i].text };
          break;
        }
      }
    }
    if (componentFile) {
      out.componentFile = componentFile;
      out.usedIn = usedIn(canvasDir, path.basename(componentFile, '.html'));
    }
    return out;
  }
}

const open = (dataDir, canvasDir) => new Refs(dataDir, canvasDir);

module.exports = { open, viaOf, locate, outer, fingerprint, parseCode };
