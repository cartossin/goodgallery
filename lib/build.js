// Per-image LoD builds, with broken-tile substitution for unreadable sources.

import fsp from 'fs/promises';
import path from 'path';
import { BROKEN_DIR, BROKEN_SVG, GG_DIR, LOD_TIERS, lodPath } from './config.js';
import { isPlaceholderCopy, placeholderTilePath } from './placeholders.js';
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

// Why vips could not make a photo's renditions, as placeholders.js records
// it. A header vips cannot read means the file is not an image it can use;
// any other failure (killed, timed out, not started, an encoder refusing)
// says nothing about the photo and is worth trying again.
async function checkPhotoBeforeBuilding(src) {
  let size;
  try {
    size = await readPhotoSize(src);
  } catch (e) {
    const reason = e.kind === 'exit' ? 'unreadable' : 'failed';
    return { reason, detail: firstLine(e.message) };
  }
  const pixels = size.width * size.height;
  if (pixels > MAX_SOURCE_PIXELS) {
    return {
      reason: 'too-large',
      detail: `${size.width}x${size.height} is ${Math.round(pixels / 1e6)} megapixels, above the limit of ` +
        `${Math.round(MAX_SOURCE_PIXELS / 1e6)} (MAX_SOURCE_MEGAPIXELS)`,
      pixels,
    };
  }
  return null;
}

function firstLine(message) {
  return String(message).split('\n').find(line => line.trim()) || 'unknown error';
}

// Make the given sizes (LOD_TIERS entries) of one photo; which sizes need
// making is the caller's decision (see build_plan.js). A size vips cannot make
// gets the pre-rendered red-X tile at its path, so every size exists and the
// gallery shows the placeholder. Resolves with
//   { missing: true }                       the photo is gone
//   { built, placeholders, failure }        tiers made for real, tiers given
//                                           the placeholder, and why: null, or
//                                           { reason, detail, pixels? } as
//                                           placeholders.js records it
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
  // Read the header first: it is cheap, it tells an unreadable file from a
  // tool failure, and it says whether the photo is too big to convert before
  // any vips process tries to hold it whole.
  const refusal = await checkPhotoBeforeBuilding(src);
  const built = [];
  const placeholders = [];
  let failure = refusal;
  for (const tier of tiers) {
    const out = lodPath(thumbDir, filename, tier.h, tier.format);
    try {
      if (refusal) {
        throw new Error(refusal.detail);
      } else if (tier.format === 'v') {
        await vipsHeightThumbV(src, out, tier.h);
      } else if (tier.format === 'avif') {
        await vipsHeightThumbAVIF(src, out, tier.h, tier.quality);
      }
      built.push(tier);
    } catch (e) {
      if (!refusal) failure = { reason: 'failed', detail: firstLine(e.message) };
      await putPlaceholder(out, tier);
      placeholders.push(tier);
    }
  }
  // One line per file, not one multi-line error per size.
  if (placeholders.length) {
    console.warn('[build:broken] ' + JSON.stringify(filename) + ' ' + REASON_TEXT[failure.reason] +
      ', placeholder used for ' + placeholders.length + ' sizes: ' + failure.detail.trim().slice(0, 200));
  }
  return { built, placeholders, failure };
}

const REASON_TEXT = {
  unreadable: 'could not be read',
  'too-large': 'is too large',
  failed: 'could not be converted (will be retried by a rescan)',
};

// Copy the placeholder tile to a rendition's path, unless the file there is
// already a copy of it (a retry that failed again rewrites nothing).
async function putPlaceholder(out, tier) {
  if (await isPlaceholderCopy(out, tier)) return;
  // Not vips's own temp name: a vips child killed for its timeout may
  // still be closing that file.
  const tmp = out + '.__tmp.p';
  await fsp.copyFile(placeholderTilePath(tier), tmp);
  await fsp.rename(tmp, out);
}
