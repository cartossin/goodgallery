// Sprite-atlas worker. Spawned via worker_threads from the main server so the
// minutes-long pixel-copy / vips-encode pass doesn't block pageview handling.
//
// Inputs (workerData):
//   - galleryAbs       absolute path to the gallery folder
//   - images           sorted list of image filenames to atlas
//   - outputDir        subdir under gg/ to write atlas files into (e.g. "atlas_<hash>_building").
//                      If absent, falls back to the legacy flat layout (gg/ itself).
//   - maxSpritePixels  byte-budget translated to pixels (matches main's MAX_SPRITE_PIXELS)
//   - spriteCellWMax   max cell width in pixels
//
// Posts back: { ok: true, meta: <newSpriteMeta or null> } | { ok: false, error }.

import { parentPort, workerData } from 'worker_threads';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { SPRITE_LAYOUT_VERSION } from './config.js';
// The same runner as the per-photo builds, so every vips child is started,
// prioritised and checked for errors the same way.
import { runStep } from './vips.js';

const { galleryAbs, images, outputDir, maxSpritePixels, spriteCellWMax, spriteEncodeParallel } = workerData;
const GG_DIR = 'gg';
const VIPS_HEADER_BYTES = 64;
const ATLAS_HEIGHTS = [
  { h: 5, format: 'v' },
  { h: 10, format: 'v' },
  { h: 50, format: 'v' },
  { h: 100, format: 'v' },
];

function lodPath(thumbDir, filename, height, format) {
  return path.join(thumbDir, filename + '.h' + height + '.' + format);
}

function readVipsHeader(absPath) {
  let fd;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(16);
    const n = fs.readSync(fd, buf, 0, 16, 0);
    if (n < 16) return null;
    const w = buf.readUInt32LE(4);
    const h = buf.readUInt32LE(8);
    if (w <= 0 || h <= 0 || w > 100000 || h > 100000) return null;
    return { w, h };
  } catch { return null; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

function readTileVRaw(absPath) {
  const fd = fs.openSync(absPath, 'r');
  try {
    const hdr = Buffer.alloc(VIPS_HEADER_BYTES);
    fs.readSync(fd, hdr, 0, VIPS_HEADER_BYTES, 0);
    const w = hdr.readInt32LE(4);
    const h = hdr.readInt32LE(8);
    const bands = hdr.readInt32LE(12);
    if (w <= 0 || h <= 0 || w > 100000 || h > 100000) throw new Error('bad .v dims: ' + absPath);
    if (bands !== 1 && bands !== 3 && bands !== 4) throw new Error('unsupported bands=' + bands + ' in ' + absPath);
    const px = Buffer.allocUnsafe(w * h * bands);
    fs.readSync(fd, px, 0, px.length, VIPS_HEADER_BYTES);
    return { w, h, bands, pixels: px };
  } finally { fs.closeSync(fd); }
}

// Resample raw pixel data to (dstW, dstH) using a box filter. Handles both
// up- and down-scale: each dst pixel averages the source pixels its area
// covers. For 1:1 dimensions, returns a copy. Used at pack time to fit each
// tile within its atlas cell preserving aspect ratio. Cost is O(dst*sample);
// for the typical case (wide image 1136x100 -> 600x53) this is a few hundred
// thousand ops per outlier, well under 50ms in JS.
function resampleBox(src, dstW, dstH) {
  const sW = src.w, sH = src.h, bands = src.bands, srcPx = src.pixels;
  const dst = Buffer.alloc(dstW * dstH * bands);
  if (sW === dstW && sH === dstH) { srcPx.copy(dst); return { w: dstW, h: dstH, bands, pixels: dst }; }
  for (let y = 0; y < dstH; y++) {
    const y0 = Math.floor(y * sH / dstH);
    const y1 = Math.min(sH, Math.max(y0 + 1, Math.floor((y + 1) * sH / dstH)));
    for (let x = 0; x < dstW; x++) {
      const x0 = Math.floor(x * sW / dstW);
      const x1 = Math.min(sW, Math.max(x0 + 1, Math.floor((x + 1) * sW / dstW)));
      for (let b = 0; b < bands; b++) {
        let sum = 0, cnt = 0;
        for (let yy = y0; yy < y1; yy++) {
          const rowOff = yy * sW * bands;
          for (let xx = x0; xx < x1; xx++) { sum += srcPx[rowOff + xx * bands + b]; cnt++; }
        }
        dst[(y * dstW + x) * bands + b] = Math.round(sum / cnt);
      }
    }
  }
  return { w: dstW, h: dstH, bands, pixels: dst };
}

// Compute the (storedW, storedH) for a tile of given (srcW, srcH) packed
// into a (cellW, cellH) atlas cell. Fits within the cell preserving aspect
// ratio. Both server (packAtlasBuffer) and client (buildStaticAtlasBuffers
// in gallery.js) MUST use this exact formula so UV sampling matches the
// stored bytes.
function fitInCell(srcW, srcH, cellW, cellH) {
  if (srcW <= 0 || srcH <= 0) return { w: 1, h: 1 };
  const aspect = srcW / srcH;
  if (aspect * cellH > cellW) {
    return { w: cellW, h: Math.max(1, Math.round(cellW / aspect)) };
  } else {
    return { w: Math.max(1, Math.round(cellH * aspect)), h: cellH };
  }
}

function packAtlasBuffer(inputPaths, cellW, cellH, across) {
  const N = inputPaths.length;
  const rows = Math.ceil(N / across);
  const atlasW = across * cellW;
  const atlasH = rows * cellH;
  const atlas = Buffer.alloc(atlasW * atlasH * 3);
  const stride = atlasW * 3;
  for (let i = 0; i < N; i++) {
    const rawTile = readTileVRaw(inputPaths[i]);
    const c = i % across;
    const r = (i / across) | 0;
    const dstX = c * cellW;
    const dstY = r * cellH;
    // Fit-within-cell, preserving aspect. Replaces the old
    // Math.min(tile.w, cellW) clip — that clip silently corrupted UV
    // sampling for wide images (>cellW px after height scaling) AND tiny
    // sources (vipsthumbnail doesn't upscale, so 1x1 source stays 1x1).
    const fit = fitInCell(rawTile.w, rawTile.h, cellW, cellH);
    const tile = (fit.w === rawTile.w && fit.h === rawTile.h)
      ? rawTile
      : resampleBox(rawTile, fit.w, fit.h);
    const storedW = tile.w, storedH = tile.h;
    if (tile.bands === 3) {
      const rowBytes = storedW * 3;
      for (let y = 0; y < storedH; y++) {
        const srcOff = y * storedW * 3;
        const dstOff = (dstY + y) * stride + dstX * 3;
        tile.pixels.copy(atlas, dstOff, srcOff, srcOff + rowBytes);
      }
    } else if (tile.bands === 1) {
      for (let y = 0; y < storedH; y++) {
        const srcOff = y * storedW;
        const dstOff = (dstY + y) * stride + dstX * 3;
        for (let x = 0; x < storedW; x++) {
          const v = tile.pixels[srcOff + x];
          atlas[dstOff + x*3]     = v;
          atlas[dstOff + x*3 + 1] = v;
          atlas[dstOff + x*3 + 2] = v;
        }
      }
    } else {
      for (let y = 0; y < storedH; y++) {
        const srcOff = y * storedW * 4;
        const dstOff = (dstY + y) * stride + dstX * 3;
        for (let x = 0; x < storedW; x++) {
          atlas[dstOff + x*3]     = tile.pixels[srcOff + x*4];
          atlas[dstOff + x*3 + 1] = tile.pixels[srcOff + x*4 + 1];
          atlas[dstOff + x*3 + 2] = tile.pixels[srcOff + x*4 + 2];
        }
      }
    }
  }
  return { buf: atlas, atlasW, atlasH };
}

async function packAndEncodeSprite(inputPaths, cellW, cellH, across, dstAvif) {
  const { buf, atlasW, atlasH } = packAtlasBuffer(inputPaths, cellW, cellH, across);
  const rawTmp = dstAvif + '.__tmp.raw';
  const avifTmp = dstAvif + '.__tmp.avif';
  await fsp.writeFile(rawTmp, buf);
  try {
    const vTmp = avifTmp + '.v';
    await runStep('vips', [
      'rawload', rawTmp, vTmp, String(atlasW), String(atlasH), '3',
      '--format', 'uchar', '--interpretation', 'srgb',
    ], vTmp);
    await runStep('vips', ['heifsave', vTmp, avifTmp, '--Q', '80'], avifTmp);
    await fsp.unlink(vTmp).catch(()=>{});
  } catch (e) {
    await fsp.unlink(rawTmp).catch(()=>{});
    throw e;
  }
  await fsp.unlink(rawTmp).catch(()=>{});
  await fsp.rename(avifTmp, dstAvif);
}

async function buildAtlasAtHeight(thumbDir, outputAbs, images, aspects, height, inputFormat) {
  const cellH = height;
  const widths = aspects.map(a => Math.round(a * height));
  // Cells are as wide as the widest image, capped at 4:1 — a wider panorama
  // is shrunk to fit (fitInCell). Without the cap one 19:1 image makes every
  // cell many times wider than the photos in it, and the h5 tier the client
  // keeps resident as a scroll floor outgrows what it will spend on it.
  const cellW = Math.min(spriteCellWMax, 4 * cellH, Math.max(cellH, ...widths));
  const cellArea = cellW * cellH;
  const cellsPerSprite = Math.max(1, Math.min(
    images.length,
    Math.floor(maxSpritePixels / cellArea)
  ));
  const across = Math.max(1, Math.round(Math.sqrt(cellsPerSprite * cellH / cellW)));
  if (inputFormat !== 'v') throw new Error('atlas only supports .v inputs (got ' + inputFormat + ')');
  const numChunks = Math.ceil(images.length / cellsPerSprite);
  const sprites = new Array(numChunks);
  // Packing a sprite is synchronous JS, so packs take turns on this thread;
  // the slow part is the vips encode, a child process, and several of those
  // run at once. One at a time, the 287 h100 sprites of a 100k gallery took
  // about 95 minutes.
  let nextChunk = 0;
  async function encodeChunks() {
    while (nextChunk < numChunks) {
      const c = nextChunk++;
      const chunk = images.slice(c * cellsPerSprite, (c + 1) * cellsPerSprite);
      const inputPaths = chunk.map(name => lodPath(thumbDir, name, height, inputFormat));
      const spriteFile = 'sprite-h' + height + '-' + c + '.avif';
      console.log('[sprite-worker] building ' + spriteFile + ': ' + chunk.length + ' tiles, cell ' + cellW + 'x' + cellH + ', across ' + across);
      await packAndEncodeSprite(inputPaths, cellW, cellH, across, path.join(outputAbs, spriteFile));
      sprites[c] = { file: spriteFile, count: chunk.length };
    }
  }
  const lanes = Math.max(1, Math.min(spriteEncodeParallel || 1, numChunks));
  await Promise.all(Array.from({ length: lanes }, encodeChunks));
  return { cellW, cellH, across, cellsPerSprite, sprites };
}

async function writeBinaryImagemap(outputAbs, images, aspects) {
  const enc = new TextEncoder();
  const nameBytes = images.map(n => enc.encode(n));
  const widths = images.map((_, i) => Math.min(65535, Math.round(aspects[i] * 200)));
  const namesTotal = nameBytes.reduce((sum, b) => sum + b.length + 1, 0);
  const buf = Buffer.alloc(12 + 2 * images.length + namesTotal);
  buf.write('GGMP', 0, 'ascii');
  buf.writeUInt16LE(1, 4);
  buf.writeUInt16LE(0, 6);
  buf.writeUInt32LE(images.length, 8);
  for (let i = 0; i < images.length; i++) buf.writeUInt16LE(widths[i], 12 + 2 * i);
  let pos = 12 + 2 * images.length;
  for (let i = 0; i < images.length; i++) {
    buf.set(nameBytes[i], pos);
    pos += nameBytes[i].length;
    buf[pos++] = 0;
  }
  const dst = path.join(outputAbs, '_imagemap.bin');
  await fsp.writeFile(dst + '.tmp', buf);
  await fsp.rename(dst + '.tmp', dst);
}

async function main() {
  const thumbDir = path.join(galleryAbs, GG_DIR);
  // LoDs (h5.v etc.) always live at thumbDir directly; atlas outputs go
  // into outputDir (a subdir like atlas_<hash>_building). Reads stay at
  // thumbDir, writes go to outputAbs.
  const outputAbs = outputDir ? path.join(thumbDir, outputDir) : thumbDir;
  await fsp.mkdir(outputAbs, { recursive: true });
  if (!Array.isArray(images) || images.length === 0) {
    parentPort.postMessage({ ok: true, meta: null });
    return;
  }

  // All LoDs are guaranteed present (rebuildFolder awaited them before calling
  // this worker). Still — verify defensively to surface bugs early.
  for (const f of images) {
    for (const at of ATLAS_HEIGHTS) {
      if (!fs.existsSync(lodPath(thumbDir, f, at.h, at.format))) {
        throw new Error('missing LoD: ' + f + ' h' + at.h + '.' + at.format);
      }
    }
  }

  const aspects = images.map(f => {
    const d = readVipsHeader(lodPath(thumbDir, f, 50, 'v'));
    return d ? d.w / 50 : 1.6;
  });

  const atlases = {};
  for (const at of ATLAS_HEIGHTS) {
    atlases[String(at.h)] = await buildAtlasAtHeight(thumbDir, outputAbs, images, aspects, at.h, at.format);
  }

  await writeBinaryImagemap(outputAbs, images, aspects);

  const meta = {
    version: SPRITE_LAYOUT_VERSION,
    atlases,
    imageCount: images.length,
    builtAt: Date.now(),
  };
  const metaPath = path.join(outputAbs, '_sprite.json');
  await fsp.writeFile(metaPath + '.tmp', JSON.stringify(meta));
  await fsp.rename(metaPath + '.tmp', metaPath);

  parentPort.postMessage({ ok: true, meta });
}

main().catch((e) => {
  parentPort.postMessage({ ok: false, error: e.message || String(e) });
});
