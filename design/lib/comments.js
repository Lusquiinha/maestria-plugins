'use strict';
// Comments on canvas elements, stored in <canvas>/comments.json next to the boards.
// Each comment names its element by the `@n…` code (see refs.js). Ids are 1-based
// and never reused (`next` keeps counting after a remove).
const fs = require('node:fs');
const path = require('node:path');

// 'user' is the person at the canvas; 'arthur' is how older files named them.
const AUTHORS = new Set(['user', 'claude']);
const LEGACY = { arthur: 'user' };
const authorOf = (a) => LEGACY[a] || a;
const normalize = (items) => items.map((c) => (Array.isArray(c.replies)
  ? { ...c, replies: c.replies.map((r) => (r && LEGACY[r.author] ? { ...r, author: authorOf(r.author) } : r)) }
  : c));

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function open(canvasDir) {
  const file = path.join(canvasDir, 'comments.json');
  const load = () => {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { next: Number.isInteger(d.next) ? d.next : 1, items: Array.isArray(d.items) ? normalize(d.items) : [] };
    } catch (e) {
      if (e && e.code === 'ENOENT') return { next: 1, items: [] };
      throw new Error(`comments.json ilegível (${e.message}): corrija ou apague o arquivo`);
    }
  };
  const save = (d) => writeAtomic(file, `${JSON.stringify(d, null, 2)}\n`);
  const find = (d, id) => {
    const c = d.items.find((x) => x.id === Number(id));
    if (!c) throw new Error(`Comentário ${id} não existe`);
    return c;
  };
  const now = () => new Date().toISOString();
  return {
    list(status = 'todos') {
      const { items } = load();
      return status === 'todos' ? items : items.filter((c) => c.status === status);
    },
    // rect: the element's box in image px when commented (where its pin stays
    // once the code goes stale); place() keeps it current.
    add({ board, code, text, rect }) {
      const d = load();
      const id = Math.max(d.next, ...d.items.map((c) => c.id + 1));
      const c = { id, board, code, text, status: 'aberto', created: now(), replies: [] };
      if (rect) c.rect = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
      d.items.push(c);
      d.next = id + 1;
      save(d);
      return id;
    },
    reply(id, { author: who, text, done }) {
      const author = authorOf(who);
      if (!AUTHORS.has(author)) throw new Error(`autor inválido: ${who}`);
      const d = load();
      const c = find(d, id);
      c.replies.push({ author, text, at: now() });
      if (done) c.status = 'feito';
      else if (author === 'user' && c.status === 'feito') c.status = 'aberto';
      save(d);
    },
    edit(id, text) {
      const d = load();
      find(d, id).text = text;
      save(d);
    },
    place(id, rect) {
      const d = load();
      find(d, id).rect = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
      save(d);
    },
    remove(id) {
      const d = load();
      const c = find(d, id);
      d.items.splice(d.items.indexOf(c), 1);
      save(d);
    },
  };
}

module.exports = { open };
