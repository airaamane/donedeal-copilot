// Regenerates the extension's PNG icons by downscaling the source artwork
// (icons/donedeal-copilot-icon.png) to the manifest sizes. The source is first
// centered on a square, transparent canvas (so a non-square source isn't
// distorted), then area-averaged down. To change the icon, replace that source
// PNG and re-run. No external deps — pure Node + zlib.
//   node make-icons.mjs
import { deflateSync, inflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";

const SOURCE = new URL("./icons/donedeal-copilot-icon.png", import.meta.url);
const SIZES = [16, 32, 48, 128];

// --- PNG decode (8-bit, non-interlaced, RGB or RGBA) → { width, height, rgba } ---

const PAETH = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// Reverse one scanline's filter in place (PNG filter types 0–4).
function unfilter(type, cur, prev, bpp) {
  const n = cur.length;
  switch (type) {
    case 0: break; // none
    case 1: for (let i = 0; i < n; i++) cur[i] = (cur[i] + (i >= bpp ? cur[i - bpp] : 0)) & 0xff; break; // sub
    case 2: for (let i = 0; i < n; i++) cur[i] = (cur[i] + prev[i]) & 0xff; break; // up
    case 3: for (let i = 0; i < n; i++) { const a = i >= bpp ? cur[i - bpp] : 0; cur[i] = (cur[i] + ((a + prev[i]) >> 1)) & 0xff; } break; // average
    case 4: for (let i = 0; i < n; i++) { const a = i >= bpp ? cur[i - bpp] : 0; const c = i >= bpp ? prev[i - bpp] : 0; cur[i] = (cur[i] + PAETH(a, prev[i], c)) & 0xff; } break; // paeth
    default: throw new Error(`unknown PNG filter type ${type}`);
  }
}

function decodePng(buf) {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error("source is not a PNG");

  let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); off += 4;
    const type = buf.toString("ascii", off, off + 4); off += 4;
    const data = buf.subarray(off, off + len); off += len + 4; // + 4 skips the CRC
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth} (need 8)`);
  if (colorType !== 2 && colorType !== 6) throw new Error(`unsupported colour type ${colorType} (need 2=RGB or 6=RGBA)`);
  if (interlace !== 0) throw new Error("interlaced PNGs are not supported");

  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const planar = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride); // virtual zero row above the first scanline
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const cur = planar.subarray(y * stride, y * stride + stride);
    raw.copy(cur, 0, rp, rp + stride);
    rp += stride;
    unfilter(filter, cur, prev, bpp);
    prev = cur;
  }

  if (colorType === 6) return { width, height, rgba: planar };
  const rgba = Buffer.alloc(width * height * 4); // expand RGB → RGBA (opaque)
  for (let i = 0, j = 0; i < planar.length; i += 3, j += 4) {
    rgba[j] = planar[i]; rgba[j + 1] = planar[i + 1]; rgba[j + 2] = planar[i + 2]; rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}

// --- Center on a square transparent canvas (max(W,H) side) → RGBA Buffer ----
// Keeps a non-square source from being stretched into the square icon.
function squarePad(src, W, H) {
  const side = Math.max(W, H);
  if (side === W && side === H) return { rgba: src, side };
  const out = Buffer.alloc(side * side * 4); // transparent
  const ox = Math.floor((side - W) / 2);
  const oy = Math.floor((side - H) / 2);
  for (let y = 0; y < H; y++) {
    const srow = y * W * 4;
    const drow = ((y + oy) * side + ox) * 4;
    src.copy(out, drow, srow, srow + W * 4);
  }
  return { rgba: out, side };
}

// --- Area-average downscale (premultiplied) → RGBA Buffer -------------------
// Each destination pixel averages the block of source pixels it covers; high
// quality for the large reductions here (1254px → 16–128px).
function resize(src, W, H, size) {
  const dst = Buffer.alloc(size * size * 4);
  for (let dy = 0; dy < size; dy++) {
    const sy0 = Math.floor((dy * H) / size);
    const sy1 = Math.max(sy0 + 1, Math.floor(((dy + 1) * H) / size));
    for (let dx = 0; dx < size; dx++) {
      const sx0 = Math.floor((dx * W) / size);
      const sx1 = Math.max(sx0 + 1, Math.floor(((dx + 1) * W) / size));
      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const o = (sy * W + sx) * 4;
          const af = src[o + 3];
          r += src[o] * af; g += src[o + 1] * af; b += src[o + 2] * af; a += af; count++;
        }
      }
      const o = (dy * size + dx) * 4;
      if (a > 0) {
        dst[o] = Math.round(r / a);
        dst[o + 1] = Math.round(g / a);
        dst[o + 2] = Math.round(b / a);
        dst[o + 3] = Math.round(a / count);
      } // else leaves transparent zeros
    }
  }
  return dst;
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

const source = decodePng(readFileSync(SOURCE));
const square = squarePad(source.rgba, source.width, source.height);
console.log(`source: ${source.width}×${source.height} → square ${square.side}×${square.side}`);
for (const size of SIZES) {
  const rgba = resize(square.rgba, square.side, square.side, size);
  const png = encodePng(size, size, rgba);
  writeFileSync(new URL(`./icons/icon${size}.png`, import.meta.url), png);
  console.log(`wrote icons/icon${size}.png (${png.length} bytes)`);
}
