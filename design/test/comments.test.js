'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const comments = require('../lib/comments');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-comments-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const fresh = () => fs.mkdtempSync(path.join(tmp, 'c-'));

test('add, list, reply, edit, remove round-trip through the file', () => {
  const dir = fresh();
  const C = comments.open(dir);
  assert.deepStrictEqual(C.list(), []);
  const id = C.add({ board: 'a', code: '@n1', text: 'azul' });
  assert.strictEqual(id, 1);
  C.reply(id, { author: 'claude', text: 'feito' });
  C.edit(id, 'verde');
  const again = comments.open(dir).list();
  assert.strictEqual(again.length, 1);
  assert.strictEqual(again[0].text, 'verde');
  assert.strictEqual(again[0].status, 'aberto');
  assert.strictEqual(again[0].replies[0].author, 'claude');
  assert.match(again[0].created, /^\d{4}-\d\d-\d\dT/);
  comments.open(dir).remove(id);
  assert.deepStrictEqual(C.list(), []);
  assert.deepStrictEqual(fs.readdirSync(dir), ['comments.json']);
});

test('ids are never reused after a remove', () => {
  const C = comments.open(fresh());
  const a = C.add({ board: 'a', code: '@n1', text: 'x' });
  const b = C.add({ board: 'a', code: '@n2', text: 'y' });
  C.remove(b);
  assert.strictEqual(C.add({ board: 'a', code: '@n3', text: 'z' }), b + 1);
  C.remove(a);
  assert.strictEqual(C.add({ board: 'a', code: '@n4', text: 'w' }), b + 2);
});

test('done marks feito; a user reply reopens; claude reply without done keeps it', () => {
  const C = comments.open(fresh());
  const id = C.add({ board: 'a', code: '@n1', text: 'x' });
  C.reply(id, { author: 'claude', text: 'ok', done: true });
  assert.strictEqual(C.list()[0].status, 'feito');
  C.reply(id, { author: 'claude', text: 'nota' });
  assert.strictEqual(C.list()[0].status, 'feito');
  C.reply(id, { author: 'user', text: 'ainda não' });
  assert.strictEqual(C.list()[0].status, 'aberto');
  assert.strictEqual(C.list()[0].replies[2].author, 'user');
});

test('a legacy "arthur" author reads (and writes) as "user"; others are refused', () => {
  const dir = fresh();
  fs.writeFileSync(path.join(dir, 'comments.json'), JSON.stringify({
    next: 2,
    items: [{ id: 1, board: 'a', code: '@n1', text: 'x', status: 'feito', created: 't', replies: [{ author: 'claude', text: 'ok', at: 't' }, { author: 'arthur', text: 'não', at: 't' }] }],
  }));
  const C = comments.open(dir);
  assert.deepStrictEqual(C.list()[0].replies.map((r) => r.author), ['claude', 'user']);
  C.reply(1, { author: 'arthur', text: 'de novo' });
  assert.strictEqual(C.list()[0].status, 'aberto', 'a legacy user reply reopens too');
  assert.deepStrictEqual(C.list()[0].replies.map((r) => r.author), ['claude', 'user', 'user']);
  assert.ok(!fs.readFileSync(path.join(dir, 'comments.json'), 'utf8').includes('arthur'));
  assert.throws(() => C.reply(1, { author: 'fulano', text: 'x' }), /autor inválido: fulano/);
});

test('list filters by status', () => {
  const C = comments.open(fresh());
  const a = C.add({ board: 'a', code: '@n1', text: 'x' });
  C.add({ board: 'a', code: '@n2', text: 'y' });
  C.reply(a, { author: 'claude', text: 'ok', done: true });
  assert.deepStrictEqual(C.list('aberto').map((c) => c.id), [2]);
  assert.deepStrictEqual(C.list('feito').map((c) => c.id), [1]);
  assert.strictEqual(C.list('todos').length, 2);
});

test('unknown id throws "Comentário <id> não existe"', () => {
  const C = comments.open(fresh());
  assert.throws(() => C.reply(9, { author: 'claude', text: 'x' }), /Comentário 9 não existe/);
  assert.throws(() => C.edit(9, 'x'), /Comentário 9 não existe/);
  assert.throws(() => C.remove(9), /Comentário 9 não existe/);
});

test('add keeps an optional rect; place moves it (the last known spot of the element)', () => {
  const dir = fresh();
  const C = comments.open(dir);
  const a = C.add({ board: 'a', code: '@n1', text: 'x', rect: { x: 1, y: 2, w: 3, h: 4 } });
  const b = C.add({ board: 'a', code: '@n2', text: 'y' });
  assert.deepStrictEqual(C.list()[0].rect, { x: 1, y: 2, w: 3, h: 4 });
  assert.ok(!('rect' in C.list()[1]));
  C.place(a, { x: 5, y: 6, w: 7, h: 8 });
  C.place(b, { x: 0, y: 0, w: 1, h: 1 });
  assert.deepStrictEqual(C.list().map((c) => c.rect), [{ x: 5, y: 6, w: 7, h: 8 }, { x: 0, y: 0, w: 1, h: 1 }]);
  assert.throws(() => C.place(99, { x: 0, y: 0, w: 1, h: 1 }), /99 não existe/);
});
