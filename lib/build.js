// Per-image LoD builds, with broken-tile substitution for unreadable sources.

import fsp from 'fs/promises';
import path from 'path';
import { BROKEN_DIR, BROKEN_SVG, GG_DIR, LOD_TIERS, lodPath } from './config.js';
import { MAX_SOURCE_PIXELS, readPhotoSize, runStep, vipsHeightThumbAVIF, vipsHeightThumbV } from './vips.js';

// vips failures are caught per-tier in buildRenditions; we copy the matching
// pre-rendered broken tile into the actual LoD path. Downstream (sprite
// build, URL serving) reads the LoD path unconditionally — the gallery
// never knows the image was unbuildable, it just shows a red-X tile.
function brokenTilePath(height, format) {
  return path.join(BROKEN_DIR, 'broken.h' + height + '.' + format);
}
let _brokenTilesP = null;
export function brokenTilesReady() {
  if (!_brokenTilesP) _brokenTilesP = _ensureBrokenTiles().catch(e => { console.warn('[broken] generation failed:', e.message); _brokenTilesP = null; });
  return _brokenTilesP;
}
async function _ensureBrokenTiles() {
  let svgStat;
  try { svgStat = await fsp.stat(BROKEN_SVG); }
  catch { console.warn('[broken] missing public/broken.svg — placeholder substitution disabled'); return; }
  await fsp.mkdir(BROKEN_DIR, { recursive: true });
  for (const tier of LOD_TIERS) {
    const out = brokenTilePath(tier.h, tier.format);
    let outMtime = 0;
    try { outMtime = (await fsp.stat(out)).mtimeMs; } catch {}
    if (outMtime >= svgStat.mtimeMs) continue;
    const tmp = out + '.__tmp.' + tier.format;
    if (tier.format === 'v') {
      const t1 = out + '.__tmp.step1.v', t2 = out + '.__tmp.step2.v';
      await runStep('vips', ['thumbnail', BROKEN_SVG, t1, '99999', '--height', String(tier.h), '--size', 'both'], t1);
      await runStep('vips', ['colourspace', t1, t2, 'srgb'], t2);
      await runStep('vips', ['extract_band', t2, tmp, '0', '--n', '3'], tmp);
      await fsp.unlink(t1).catch(()=>{});
      await fsp.unlink(t2).catch(()=>{});
    } else {
      await runStep('vips', ['thumbnail', BROKEN_SVG, tmp + '[Q=' + tier.quality + ']', '99999', '--height', String(tier.h), '--size', 'both'], tmp);
    }
    await fsp.rename(tmp, out);
    console.log('[broken] generated', path.basename(out));
  }
}

// Make the given sizes (LOD_TIERS entries) of one photo; which sizes need
// making is the caller's decision (see build_plan.js). A size vips cannot make
// gets the pre-rendered red-X tile at its path, so every size exists and the
// gallery shows the placeholder. Resolves with
//   { missing: true }                       the photo is gone
//   { built, placeholders, failure }        tiers made for real, tiers given
//                                           the placeholder, and why (or null)
export async function buildRenditions(folderAbs, filename, tiers) {
  const src = path.join(folderAbs, filename);
  let st;
  try { st = await fsp.stat(src); } catch { return { missing: true }; }
  if (process.env.GG_DEBUG_BUILDS) {
    console.log('[build]', filename, 'size=' + st.size);
  }
  const thumbDir = path.join(folderAbs, GG_DIR);
  await fsp.mkdir(thumbDir, { recursive: true });
  await brokenTilesReady();
  // Read the header first: it is cheap, and it says whether the photo is
  // too big to convert before any vips process tries to hold it whole.
  let refusal = null;
  try {
    const { width, height } = await readPhotoSize(src);
    if (width * height > MAX_SOURCE_PIXELS) {
      refusal = `${width}x${height} is ${Math.round(width * height / 1e6)} megapixels, above the limit of ` +
        `${Math.round(MAX_SOURCE_PIXELS / 1e6)} (MAX_SOURCE_MEGAPIXELS)`;
    }
  } catch (e) {
    refusal = e.message;
  }
  const built = [];
  const placeholders = [];
  let failure = null;
  for (const tier of tiers) {
    const out = lodPath(thumbDir, filename, tier.h, tier.format);
    try {
      if (refusal) {
        throw new Error(refusal);
      } else if (tier.format === 'v') {
        await vipsHeightThumbV(src, out, tier.h);
      } else if (tier.format === 'avif') {
        await vipsHeightThumbAVIF(src, out, tier.h, tier.quality);
      }
      built.push(tier);
    } catch (e) {
      // Not vips's own temp name: a vips child killed for its timeout may
      // still be closing that file.
      const tmp = out + '.__tmp.p';
      await fsp.copyFile(brokenTilePath(tier.h, tier.format), tmp);
      await fsp.rename(tmp, out);
      placeholders.push(tier);
      failure = String(e.message).split('\n').find(line => line.trim()) || 'unknown error';
    }
  }
  // One line per file, not one multi-line error per size.
  if (placeholders.length) {
    console.warn('[build:broken] ' + JSON.stringify(filename) + ' could not be read, placeholder used for ' +
      placeholders.length + ' sizes: ' + failure.trim().slice(0, 200));
  }
  return { built, placeholders, failure };
}
