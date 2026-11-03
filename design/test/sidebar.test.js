'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sidebar = require('../lib/sidebar');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-sidebar-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function canvasAt(rel, design) {
  const d = path.join(tmp, rel);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'canvas.json'), JSON.stringify({ v: 1, title: path.basename(d), boards: {}, order: [] }));
  if (design) fs.writeFileSync(path.join(d, 'design.json'), JSON.stringify(design));
  return d;
}

test('the project of a canvas: its repo folder, else the company folder', () => {
  const a = canvasAt('home1/Desktop/Work/co/design/a', { repo: '../../payments' });
  const b = canvasAt('home1/Desktop/Work/co/design/b');
  assert.strictEqual(sidebar.projectOf(a), 'payments');
  assert.strictEqual(sidebar.projectOf(b), 'co');
});

test('canvases: most recent first, with name and project', () => {
  const home = path.join(tmp, 'home2');
  const x = canvasAt('home2/Desktop/Work/co/design/x', { repo: path.join(home, 'Desktop/Work/co/site') });
  const y = canvasAt('home2/Desktop/Work/co/design/y', { repo: path.join(home, 'Desktop/Work/co/app') });
  const z = canvasAt('home2/Desktop/Work/co/design/z');
  const list = sidebar.canvases({ home, last: { usedAt: { [x]: 1000, [y]: 3000, [z]: 2000 } } });
  assert.deepStrictEqual(list.map((c) => [c.dir, c.name, c.project]), [[y, 'y', 'app'], [z, 'z', 'co'], [x, 'x', 'site']]);
});

test('the sidebar data: the text, then the canvases opening on click', () => {
  const data = sidebar.data([{ dir: '/w/co/design/a', name: 'a', project: 'site' }, { dir: '/w/co/design/b', name: 'b', project: '' }]);
  assert.strictEqual(data.text, 'Para criar um design novo, peça ao Claude numa sessão: "cria uma tela de…"');
  assert.strictEqual(data.hasCanvases, true);
  assert.strictEqual(data.heading, 'Designs feitos');
  assert.deepStrictEqual(data.canvases, [
    { name: 'a', project: 'site', hasProject: true, open: 'open:/w/co/design/a' },
    { name: 'b', project: '', hasProject: false, open: 'open:/w/co/design/b' },
  ]);
});

test('the sidebar data with no canvas: only the text', () => {
  const data = sidebar.data([]);
  assert.strictEqual(data.hasCanvases, false);
  assert.deepStrictEqual(data.canvases, []);
  assert.match(data.text, /^Para criar um design novo/);
});

test('the sidebar ui: a "Designs feitos" ruler above the canvases, only when there are any; rounded hover rows', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'ui', 'sidebar.rfwtxt'), 'utf8').replace(/\/\/.*$/gm, '');
  // the ruler looks like the app's own "Janelas"/"Comandos": 11 px, bold, faint
  assert.match(ui, /switch data\.hasCanvases \{\s*true: Ruler\(\)/);
  assert.match(ui, /widget Ruler = [\s\S]*Text\(text: data\.heading, style: \{ fontSize: 11\.0, fontWeight: "w700", color: data\.theme\.faint \}/);
  assert.ok(ui.indexOf('Ruler()') < ui.indexOf('for c in data.canvases'), 'above the list');
  assert.match(ui, /widget Canvas = Pressable\([\s\S]*radius: 6\.0/);
});

test('the sidebar blocks (apps without rfw): the text and a list', () => {
  const blocks = sidebar.blocks([{ dir: '/d/a', name: 'a', project: 'site' }]);
  assert.deepStrictEqual(blocks[0], { type: 'text', text: sidebar.data([]).text });
  assert.deepStrictEqual(blocks[1].items, [{ title: 'a', subtitle: 'site', action: 'open:/d/a' }]);
  assert.strictEqual(sidebar.blocks([]).length, 1);
});

test('the abrir picker: only the canvases, name and "<project> · <dir>"', () => {
  const home = '/home/u';
  const items = sidebar.pickItems([{ dir: '/home/u/W/co/design/a', name: 'a', project: 'site' }, { dir: '/srv/b', name: 'b', project: '' }], { home });
  assert.deepStrictEqual(items, [
    { value: '/home/u/W/co/design/a', label: 'a', detail: 'site · ~/W/co/design/a' },
    { value: '/srv/b', label: 'b', detail: '/srv/b' },
  ]);
  assert.strictEqual(sidebar.EMPTY_BANNER, 'Nenhum canvas ainda. Peça ao Claude numa sessão: "cria uma tela de…"');
});

test('the canvas tab title', () => {
  assert.strictEqual(sidebar.viewTitle('Checkout'), 'Design · Checkout');
  assert.strictEqual(sidebar.viewTitle(''), 'Design');
});
