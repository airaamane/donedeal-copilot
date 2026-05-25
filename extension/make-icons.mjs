// Generates the extension's PNG icons (no external deps — pure Node + zlib).
// Draws a magnifying-glass "audit" mark on a rounded blue→green tile.
//   node make-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const BLUE = [26, 115, 232]; // #1a73e8
const GREEN = [30, 142, 62]; // #1e8e3e
const WHITE = [255, 255, 255];

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

// Rounded-rectangle membership in normalized [0,1] space, corner radius r.
function inRoundedRect(u, v, r) {
  const dx = Math.max(r - u, u - (1 - r), 0);
  const dy = Math.max(r - v, v - (1 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

// Distance from point to a line segment, in normalized space.
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-9;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Returns straight RGBA [0..255] for one supersample point, or null = transparent.
function sample(u, v) {
  if (!inRoundedRect(u, v, 0.22)) return null;

  // Magnifying glass geometry (normalized).
  const cx = 0.43, cy = 0.43;          // lens centre
  const R = 0.235, ring = 0.072;       // lens outer radius + ring thickness
  const d = Math.hypot(u - cx, v - cy);
  const dir = Math.SQRT1_2;            // 45° handle direction
  const hx0 = cx + dir * (R - 0.02), hy0 = cy + dir * (R - 0.02);
  const hx1 = cx + dir * 0.46, hy1 = cy + dir * 0.46;
  const onRing = d <= R && d >= R - ring;
  const onHandle = distToSeg(u, v, hx0, hy0, hx1, hy1) <= 0.05;

  if (onRing || onHandle) return [...WHITE, 255];

  const bg = mix(BLUE, GREEN, (u + v) / 2);
  return [bg[0], bg[1], bg[2], 255];
}

function renderPng(size) {
  const ss = 4; // supersample factor
  const S = size * ss;
  const px = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Premultiplied accumulation for clean anti-aliased edges.
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x * ss + sx + 0.5) / S;
          const v = (y * ss + sy + 0.5) / S;
          const c = sample(u, v);
          if (c) {
            const af = c[3] / 255;
            r += c[0] * af; g += c[1] * af; b += c[2] * af; a += af;
          }
        }
      }
      const n = ss * ss;
      const alpha = a / n;
      const o = (y * size + x) * 4;
      if (alpha > 0) {
        px[o] = Math.round(r / a);
        px[o + 1] = Math.round(g / a);
        px[o + 2] = Math.round(b / a);
        px[o + 3] = Math.round(alpha * 255);
      } // else leaves transparent zeros
    }
  }
  return encodePng(size, size, px);
}

// --- Minimal PNG encoder (RGBA, no filter) ---------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const png = renderPng(size);
  const path = new URL(`./icons/icon${size}.png`, import.meta.url);
  writeFileSync(path, png);
  console.log(`wrote icons/icon${size}.png (${png.length} bytes)`);
}
