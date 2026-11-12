// Which renditions of a folder's photos exist, and which need (re)making.
//
// Renditions are named after their photo (a.jpg -> gg/a.jpg.h200.avif), so
// whether a rendition still shows its photo depends on what is known about
// the photo (see sources.js for the recorded signatures):
//   trusted   the photo matches its recorded signature: its renditions are
//             right, and only missing ones are made;
//   replaced  the photo differs from its record: every size is made again;
//   unknown   no record for it (a new photo, a folder built before records
//             existed, or the record was lost): a rendition is kept if it is
//             newer than the photo's modification time, the rule those
//             earlier builds used. The photo's ctime is deliberately not
//             consulted: chmod, chown, a copy or a restore of the tree all
//             change it, and a library that takes days to encode must not be
//             encoded again for that. The record written after this build is
//             what catches a replacement with an old mtime from then on.

import fsp from 'fs/promises';
import path from 'path';
import { GG_DIR, LOD_TIERS, lodPath } from './config.js';

export const ATLAS_TIER_HEIGHTS = new Set([5, 10, 50, 100]);  // the .v sizes the atlas is packed from
export const isAtlasTier = tier => tier.format === 'v' && ATLAS_TIER_HEIGHTS.has(tier.h);

const RENDITION_NAME = /^(.+)\.h(\d+)\.(v|avif)$/;
const ALL_TIERS_PRESENT = (1 << LOD_TIERS.length) - 1;

// For every photo in images, which of its renditions exist in gg/, as a bit
// mask over LOD_TIERS. Streams the directory, so a folder of 100k photos
// (800k renditions) never holds the whole listing at once.
export async function scanRenditions(thumbDir, images) {
  const present = new Map(images.map(name => [name, 0]));
  let dir;
  try { dir = await fsp.opendir(thumbDir, { bufferSize: 1024 }); } catch { return present; }
  for await (const entry of dir) {
    const match = RENDITION_NAME.exec(entry.name);
    if (!match || !present.has(match[1])) continue;
    const index = LOD_TIERS.findIndex(tier => tier.h === Number(match[2]) && tier.format === match[3]);
    if (index >= 0) present.set(match[1], present.get(match[1]) | (1 << index));
  }
  return present;
}

export function allRenditionsPresent(present) {
  for (const mask of present.values()) if (mask !== ALL_TIERS_PRESENT) return false;
  return true;
}

// The sizes of one photo that need making, given what is known about it.
export async function tiersToBuild(galleryAbs, name, trust, presentMask) {
  if (trust === 'replaced') return LOD_TIERS.slice();
  const missing = LOD_TIERS.filter((tier, index) => !(presentMask & (1 << index)));
  if (trust === 'trusted' || missing.length === LOD_TIERS.length) return missing;
  // unknown: keep a rendition that is not older than the photo.
  let photoChangedAt;
  try {
    photoChangedAt = (await fsp.stat(path.join(galleryAbs, name))).mtimeMs;
  } catch { return missing; }  // gone; the build will find out
  const stale = [];
  for (const [index, tier] of LOD_TIERS.entries()) {
    if (!(presentMask & (1 << index))) { stale.push(tier); continue; }
    const rendition = await fsp.stat(lodPath(path.join(galleryAbs, GG_DIR), name, tier.h, tier.format)).catch(() => null);
    if (!rendition || rendition.mtimeMs < photoChangedAt) stale.push(tier);
  }
  return stale;
}
