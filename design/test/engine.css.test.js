'use strict';
// A canvas in plain css mode renders without any Tailwind: nothing is spawned
// or downloaded, the board's own css and the canvas theme style it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chromeMod = require('../lib/chrome');
const engineMod = require('../lib/engine');
const canvasMod = require('../lib/canvas');
const { readPng, firstRowPixel } = require('./png');

const skip = !chromeMod.findExecutable() && 'no chrome';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-engine-css-'));
const pluginData = path.join(tmp, 'plugin-data');
const prevData = process.env.MAESTRIA_PLUGIN_DATA;
let eng = null;

test.after(async () => {
  if (eng) await eng.close();
  if (prevData === undefined) delete process.env.MAESTRIA_PLUGIN_DATA; else process.env.MAESTRIA_PLUGIN_DATA = prevData;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const pixel = (file, x) => firstRowPixel(readPng(fs.readFileSync(file)), x).slice(0, 3);

test('a plain css canvas renders with its theme in both modes and no tailwind', { skip, timeout: 30000 }, async () => {
  process.env.MAESTRIA_PLUGIN_DATA = pluginData;
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const dir = path.join(tmp, 'canvas');
  canvasMod.init(dir, { repo });
  fs.writeFileSync(path.join(dir, 'styles', 'theme.css'), ':root { --bg: rgb(255, 0, 0); }\n.dark { --bg: rgb(0, 0, 255); }\n');
  const { canvas } = canvasMod.upsertBoard(canvasMod.read(dir), { name: 'card', w: 200, h: 100 });
  canvasMod.write(dir, canvas);
  fs.writeFileSync(path.join(dir, 'boards', 'card.html'),
    '<style>.card { width: 200px; height: 100px; background: var(--bg); }</style><div class="card"></div>');
  eng = await engineMod.open(dir, { dataDir: path.join(tmp, 'data'), log: () => {} });
  assert.strictEqual(eng.tw, null);
  const s = (await eng.render(['card'])).get('card');
  assert.ok(s && !s.error, JSON.stringify(s));
  assert.deepStrictEqual(pixel(s.light, 20), [255, 0, 0]);
  assert.deepStrictEqual(pixel(s.dark, 20), [0, 0, 255]);
  assert.ok(!fs.existsSync(path.join(pluginData, 'tailwind')), 'nothing downloaded');
});

test('editing the canvas theme re-renders its boards', { skip, timeout: 30000 }, async () => {
  const dir = path.join(tmp, 'canvas');
  const seen = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no re-render after editing theme.css')), 8000);
    eng.on('board', (n, s) => {
      if (n === 'card' && s && !s.error && pixel(s.light, 20)[1] === 255) { clearTimeout(t); resolve(); }
    });
  });
  fs.writeFileSync(path.join(dir, 'styles', 'theme.css'), ':root { --bg: rgb(0, 255, 0); }\n.dark { --bg: rgb(0, 0, 255); }\n');
  await seen;
});
