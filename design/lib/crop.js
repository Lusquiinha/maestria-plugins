'use strict';
// Cuts a rectangle out of a PNG (8-bit gray/RGB/RGBA, not interlaced) with
// node:zlib only: the element image design_ref hands Claude.
const zlib = require('node:zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const COLOR = { 1: 0, 2: 4, 3: 2, 4: 6 };

// encode(w, h, channels, data, filtered): data = rows of pixels, or rows
// already prefixed by their filter byte when `filtered`.
function encode(w, h, channels, data, filtered = false) {
  let raw = data;
  if (!filtered) {
    const stride = w * channels;
    raw = Buffer.alloc((stride + 1) * h);
    for (let y = 0; y < h; y++) data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = COLOR[channels];
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 3 })), chunk('IEND', Buffer.alloc(0))]);
}

function parse(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) return null;
  let pos = 8;
  let hdr = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') hdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!hdr || hdr.depth !== 8 || hdr.interlace || !CHANNELS[hdr.color]) return null;
  return { ...hdr, ch: CHANNELS[hdr.color], idat: Buffer.concat(idat) };
}

// cropPng(buf, rect in image px, maxSide) -> PNG Buffer, or null when the
// image cannot be read or the rect misses it. Rows past the rect are never
// unfiltered; a crop wider/taller than maxSide is box-averaged down.
function cropPng(buf, rect, maxSide) {
  const p = parse(buf);
  if (!p) return null;
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(p.w, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(p.h, Math.ceil(rect.y + rect.h));
  if (x1 <= x0 || y1 <= y0) return null;
  const bpp = p.ch;
  const stride = p.w * bpp;
  const raw = zlib.inflateSync(p.idat);
  let prev = Buffer.alloc(stride);
  let cur = Buffer.alloc(stride);
  const cw = x1 - x0;
  const ch = y1 - y0;
  const out = Buffer.alloc(cw * bpp * ch);
  for (let y = 0; y < y1; y++) {
    const off = y * (stride + 1);
    const f = raw[off];
    const src = raw.subarray(off + 1, off + 1 + stride);
    if (f === 0) src.copy(cur);
    else if (f === 1) for (let i = 0; i < stride; i++) cur[i] = (src[i] + (i >= bpp ? cur[i - bpp] : 0)) & 255;
    else if (f === 2) for (let i = 0; i < stride; i++) cur[i] = (src[i] + prev[i]) & 255;
    else if (f === 3) for (let i = 0; i < stride; i++) cur[i] = (src[i] + (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1)) & 255;
    else if (f === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        const q = a + b - c;
        const pa = Math.abs(q - a); const pb = Math.abs(q - b); const pc = Math.abs(q - c);
        cur[i] = (src[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    } else return null;
    if (y >= y0) cur.copy(out, (y - y0) * cw * bpp, x0 * bpp, x1 * bpp);
    [prev, cur] = [cur, prev];
  }
  const f = Math.max(1, Math.ceil(Math.max(cw, ch) / maxSide));
  if (f === 1) return encode(cw, ch, bpp, out);
  const sw = Math.floor(cw / f) || 1;
  const sh = Math.floor(ch / f) || 1;
  const small = Buffer.alloc(sw * sh * bpp);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      for (let k = 0; k < bpp; k++) {
        let sum = 0;
        let cnt = 0;
        for (let dy = 0; dy < f && y * f + dy < ch; dy++) {
          for (let dx = 0; dx < f && x * f + dx < cw; dx++) { sum += out[((y * f + dy) * cw + x * f + dx) * bpp + k]; cnt++; }
        }
        small[(y * sw + x) * bpp + k] = Math.round(sum / cnt);
      }
    }
  }
  return encode(sw, sh, bpp, small);
}

module.exports = { cropPng, encode };
