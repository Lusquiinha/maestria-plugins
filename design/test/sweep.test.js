'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { readPng } = require('./png');
const sweep = require('../lib/sweep');

// encode() writes filter 0 rows only
function pixels(png) {
  const raw = zlib.inflateSync(png.idat);
  const stride = png.width * 4;
  return (x, y) => {
    const o = y * (stride + 1) + 1 + x * 4;
    assert.strictEqual(raw[y * (stride + 1)], 0);
    return [raw[o], raw[o + 1], raw[o + 2], raw[o + 3]];
  };
}

test('sweep.png decodes: 24 frames side by side, rgba, a blue band moving down', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-sweep-'));
  try {
    const file = sweep.ensure(tmp);
    assert.strictEqual(file, path.join(tmp, 'cache', 'sweep.png'));
    assert.strictEqual(sweep.SHEET, 'cache/sweep.png');
    const png = readPng(fs.readFileSync(file));
    assert.strictEqual(sweep.FRAMES, 24);
    assert.strictEqual(png.width, sweep.FRAMES * sweep.CELL_W);
    const period = sweep.FRAMES / sweep.FPS;
    assert.ok(period >= 1.1 && period <= 1.3, `sweep period ${period} s (~1.2 s)`);
    const ui = fs.readFileSync(path.join(__dirname, '..', 'ui', 'canvas.rfwtxt'), 'utf8');
    assert.match(ui, new RegExp(`sheet: "${sweep.SHEET}", columns: ${sweep.FRAMES}, rows: 1, frames: ${sweep.FRAMES}, fps: ${sweep.FPS}\\.0`));
    assert.strictEqual(png.height, sweep.CELL_H);
    assert.strictEqual(png.colorType, 6);
    assert.strictEqual(png.bitDepth, 8);
    const px = pixels(png);
    let prevPeak = -Infinity;
    let maxA = 0;
    for (let f = 1; f < sweep.FRAMES - 1; f++) {
      let peak = 0;
      let peakY = 0;
      for (let y = 0; y < png.height; y++) {
        const [r, g, b, a] = px(f * sweep.CELL_W, y);
        if (a) assert.deepStrictEqual([r, g, b], [0x3b, 0x82, 0xf6]);
        if (a > peak) { peak = a; peakY = y; }
        // every column of a frame is the same
        assert.deepStrictEqual(px(f * sweep.CELL_W + sweep.CELL_W - 1, y), [r, g, b, a]);
      }
      assert.ok(peakY > prevPeak, `frame ${f} peak ${peakY} <= ${prevPeak}`);
      prevPeak = peakY;
      maxA = Math.max(maxA, peak);
    }
    assert.ok(maxA >= 85 && maxA <= 92, `peak alpha ${maxA} (~35%)`);
    // written once: a second call keeps the file
    const before = fs.statSync(file).mtimeMs;
    sweep.ensure(tmp);
    assert.strictEqual(fs.statSync(file).mtimeMs, before);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
