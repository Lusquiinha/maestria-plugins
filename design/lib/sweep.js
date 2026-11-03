'use strict';
// The scanner's sprite sheet: 24 frames side by side, each a narrow column
// with a blue band going down (a sharp leading edge, a long soft tail, 35 %
// at its peak). The view stretches a frame over the rect being edited and
// plays it at FPS: 24 frames at 20 fps = one sweep every 1.2 s.
//
// The cell is tiny on purpose: the app upscales a cell by a whole factor (at
// most 32) before stretching it, so a small cell keeps every frame a few KB
// in memory whatever the zoom. Sprite reads sheets only from the plugin dir:
// the file lives in <pluginDir>/cache/ (gitignored).
const fs = require('node:fs');
const path = require('node:path');
const { encode } = require('./crop');

const FRAMES = 24;
const FPS = 20;
const CELL_W = 2;
const CELL_H = 64;
const SHEET = 'cache/sweep.png';
const COLOR = [0x3b, 0x82, 0xf6]; // blue-500
const PEAK = 0.35;
const LEAD = 0.035 * CELL_H; // the edge in front, going down
const TAIL = 0.2 * CELL_H; // the glow behind it

function alphaAt(y, center) {
  const d = y + 0.5 - center;
  const s = d > 0 ? LEAD : TAIL;
  return Math.round(255 * PEAK * Math.exp(-((d / s) ** 2)));
}

function sheet() {
  const w = FRAMES * CELL_W;
  const px = Buffer.alloc(w * CELL_H * 4);
  for (let f = 0; f < FRAMES; f++) {
    // from just above the top (empty) to just past the bottom (only the tail)
    const center = -0.05 * CELL_H + (f * 1.05 * CELL_H) / (FRAMES - 1);
    for (let y = 0; y < CELL_H; y++) {
      const a = alphaAt(y, center);
      if (!a) continue;
      for (let x = 0; x < CELL_W; x++) {
        const o = (y * w + f * CELL_W + x) * 4;
        px[o] = COLOR[0];
        px[o + 1] = COLOR[1];
        px[o + 2] = COLOR[2];
        px[o + 3] = a;
      }
    }
  }
  return encode(w, CELL_H, 4, px);
}

// ensure(pluginDir): writes <pluginDir>/cache/sweep.png unless it is already
// there with the same bytes. Returns its path.
function ensure(pluginDir) {
  const file = path.join(pluginDir, SHEET);
  const png = sheet();
  let old = null;
  try { old = fs.readFileSync(file); } catch { /* first run */ }
  if (!old || !old.equals(png)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, png);
    fs.renameSync(tmp, file);
  }
  return file;
}

module.exports = { ensure, sheet, SHEET, FRAMES, FPS, CELL_W, CELL_H };
