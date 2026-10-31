'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const scanner = require('../lib/scanner');
const marks = require('../lib/marks');

const DIR = path.resolve('/w/acme/design/sac');
const OTHER = path.resolve('/w/acme/design/outro');
const uses = new Map([['inbox', new Set(['NavItem'])], ['settings', new Set(['NavItem', 'Card'])], ['login', new Set()]]);
const ctx = (o = {}) => ({
  canvases: [{ dir: DIR, boards: ['inbox', 'settings', 'login'], uses }],
  linkedDir: (tab) => ({ t1: DIR, t2: OTHER }[tab] || null),
  now: 1000,
  ...o,
});
const hook = (tool, file, tabId = 't1') => ({ tabId, payload: { tool_name: tool, tool_input: { file_path: file } } });
const make = () => scanner.create({ timeoutMs: 30000, onChange: () => {} });

test('board edit → scan the whole board', () => {
  const s = make();
  const got = s.onHook(hook('Edit', path.join(DIR, 'boards', 'inbox.html')), ctx());
  assert.deepStrictEqual(got, [{ dir: DIR, board: 'inbox', rect: null }]);
  assert.deepStrictEqual(s.active(DIR, 1000), [{ board: 'inbox', rect: null }]);
  for (const t of ['Write', 'MultiEdit']) {
    assert.strictEqual(s.onHook(hook(t, path.join(DIR, 'boards', 'login.html')), ctx()).length, 1, t);
  }
  s.clear(DIR);
});

test('component edit → scans every board that uses it', () => {
  const s = make();
  const got = s.onHook(hook('Write', path.join(DIR, 'components', 'NavItem.html')), ctx());
  assert.deepStrictEqual(got.map((x) => x.board).sort(), ['inbox', 'settings']);
  assert.ok(got.every((x) => x.rect === null));
  assert.deepStrictEqual(s.onHook(hook('Edit', path.join(DIR, 'components', 'Unused.html')), ctx()), []);
  s.clear(DIR);
});

test('a design_ref mark narrows the scan to its element, and expires', () => {
  const s = make();
  const rect = { x: 10, y: 20, w: 100, h: 40 };
  marks.set('t1', { board: 'settings', rect, canvas: DIR }, 1000);
  const got = s.onHook(hook('Edit', path.join(DIR, 'components', 'NavItem.html')), ctx());
  assert.deepStrictEqual(got, [{ dir: DIR, board: 'settings', rect }]);
  s.clear(DIR);
  // a mark of another canvas does not narrow
  marks.set('t1', { board: 'settings', rect, canvas: OTHER }, 1000);
  assert.deepStrictEqual(s.onHook(hook('Edit', path.join(DIR, 'boards', 'settings.html')), ctx()), [{ dir: DIR, board: 'settings', rect: null }]);
  s.clear(DIR);
  // past 2 minutes the mark is gone: the whole board again
  marks.set('t1', { board: 'settings', rect, canvas: DIR }, 1000);
  const late = s.onHook(hook('Edit', path.join(DIR, 'boards', 'settings.html')), ctx({ now: 1000 + marks.TTL_MS + 1 }));
  assert.deepStrictEqual(late, [{ dir: DIR, board: 'settings', rect: null }]);
  s.clear(DIR);
});

test('nothing for files outside the canvas, other tools, unlinked tabs or tabs of a closed canvas', () => {
  const s = make();
  const none = (evt) => assert.deepStrictEqual(s.onHook(evt, ctx()), [], JSON.stringify(evt));
  none(hook('Edit', '/w/acme/repo/src/app.tsx'));
  none(hook('Edit', path.join(DIR, '..', 'sac-x', 'boards', 'inbox.html')));
  none(hook('Edit', path.join(DIR, 'canvas.json')));
  none(hook('Edit', path.join(DIR, 'boards', 'nope.html'))); // no board entry
  none(hook('Edit', path.join(DIR, 'boards', 'sub', 'inbox.html')));
  none(hook('Read', path.join(DIR, 'boards', 'inbox.html')));
  none(hook('Bash', path.join(DIR, 'boards', 'inbox.html')));
  none(hook('Edit', path.join(DIR, 'boards', 'inbox.html'), 't9')); // not linked
  none(hook('Edit', path.join(DIR, 'boards', 'inbox.html'), 't2')); // linked to a canvas that is not open
  none({ tabId: 't1', payload: { tool_name: 'Edit' } });
  none({ tabId: 't1' });
  none(null);
  assert.deepStrictEqual(s.active(DIR, 1000), []);
});

test('the render of a board ends its scan and clears its mark', () => {
  const s = make();
  marks.set('t1', { board: 'inbox', rect: { x: 0, y: 0, w: 1, h: 1 }, canvas: DIR }, 1000);
  s.onHook(hook('Edit', path.join(DIR, 'components', 'NavItem.html')), ctx());
  assert.strictEqual(s.active(DIR, 1000).length, 1);
  assert.strictEqual(s.end('inbox', DIR), true);
  assert.deepStrictEqual(s.active(DIR, 1000), []);
  assert.strictEqual(marks.get('t1', 1000), null);
  assert.strictEqual(s.end('inbox', DIR), false);
  s.clear(DIR);
});

test('a scan times out after 30 s and tells onChange', async () => {
  const changed = [];
  const s = scanner.create({ timeoutMs: 20, onChange: (dir) => changed.push(dir) });
  s.onHook(hook('Edit', path.join(DIR, 'boards', 'login.html')), ctx({ now: Date.now() }));
  assert.strictEqual(s.active(DIR).length, 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepStrictEqual(s.active(DIR), []);
  assert.deepStrictEqual(changed, [DIR]);
  assert.strictEqual(scanner.TIMEOUT_MS, 30000);
  const t = make();
  t.onHook(hook('Edit', path.join(DIR, 'boards', 'login.html')), ctx({ now: 0 }));
  assert.strictEqual(t.active(DIR, 29999).length, 1);
  assert.deepStrictEqual(t.active(DIR, 30001), []);
  t.clear(DIR);
});

test('a relative file_path is read against the hook cwd', () => {
  const s = make();
  const evt = { tabId: 't1', payload: { cwd: DIR, tool_name: 'Edit', tool_input: { file_path: 'boards/inbox.html' } } };
  assert.deepStrictEqual(s.onHook(evt, ctx()).map((x) => x.board), ['inbox']);
  s.clear(DIR);
});
