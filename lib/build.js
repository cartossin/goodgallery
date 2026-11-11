// Per-image LoD builds, with broken-tile substitution for unreadable sources.

import fsp from 'fs/promises';
import path from 'path';
import { BROKEN_DIR, BROKEN_SVG, GG_DIR, LOD_TIERS, isImage, lodPath } from './config.js';
import { runStep, vipsHeightThumbAVIF, vipsHeightThumbV } from './vips.js';

// vips failures are caught per-tier in ensureBuilt; we copy the matching
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

// force rebuilds every size even when one exists: the caller knows the
// source was replaced (see sources.js), which file times alone cannot show.
export async function ensureBuilt(folderAbs, filename, force = false) {
  if (!isImage(filename)) throw new Error('unsupported');
  const src = path.join(folderAbs, filename);
  let st;
  try { st = await fsp.stat(src); } catch { throw new Error('missing original'); }
  if (process.env.GG_DEBUG_BUILDS) {
    console.log('[build]', filename, 'size=' + st.size);
  }
  const thumbDir = path.join(folderAbs, GG_DIR);
  await fsp.mkdir(thumbDir, { recursive: true });
  await brokenTilesReady();
  const srcMtime = st.mtimeMs;
  let did = 0;
  const unreadableSizes = [];
  let unreadableReason = '';
  for (const tier of LOD_TIERS) {
    const out = lodPath(thumbDir, filename, tier.h, tier.format);
    // Skip only if the LoD is at least as new as the source. A replaced
    // original (same name, newer mtime) invalidates every existing tier.
    if (!force) {
      try {
        const outSt = await fsp.stat(out);
        if (outSt.mtimeMs >= srcMtime) continue;
      } catch {}
    }
    try {
      if (tier.format === 'v') {
        await vipsHeightThumbV(src, out, tier.h);
      } else if (tier.format === 'avif') {
        await vipsHeightThumbAVIF(src, out, tier.h, tier.quality);
      }
    } catch (e) {
      // Source can't be rendered (corrupt, libheif limit, exotic format).
      // Drop in the pre-rendered broken tile so the LoD exists and the
      // gallery shows a red-X. mtime check on the LoD prevents retry.
      const tmp = out + '.__broken.tmp';
      await fsp.copyFile(brokenTilePath(tier.h, tier.format), tmp);
      await fsp.rename(tmp, out);
      unreadableSizes.push('h' + tier.h);
      unreadableReason = String(e.message).split('\n').find(line => line.trim()) || 'unknown error';
    }
    did++;
  }
  // One line per file, not one multi-line error per size.
  if (unreadableSizes.length) {
    console.warn('[build:broken] ' + JSON.stringify(filename) + ' could not be read, placeholder used for ' +
      unreadableSizes.length + ' sizes: ' + unreadableReason.trim().slice(0, 200));
  }
  return did;
}
