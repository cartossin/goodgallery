// What each source photo looked like when its renditions were last built.
//
// Renditions are named after the photo (a.jpg -> gg/a.jpg.h200.avif), so a
// photo replaced by a different file of the same name would keep its old
// renditions. Comparing file times alone misses a replacement that is older
// than the renditions (a restore from backup, cp -p, rsync -t). So each
// rebuild records every photo's modification time and size. The record is
// what decides whether a folder needs building at all (rebuild.js), and
// which renditions can be kept (build_plan.js).

import fsp from 'fs/promises';
import path from 'path';
import { GG_DIR } from './config.js';

function signaturesPath(galleryAbs) {
  return path.join(galleryAbs, GG_DIR, '_sources.json');
}

// { "a.jpg": "<mtimeMs>:<size>", ... } for the photos on disk now.
export async function currentSignatures(galleryAbs, images) {
  const signatures = {};
  for (const name of images) {
    const stat = await fsp.stat(path.join(galleryAbs, name)).catch(() => null);
    if (stat) signatures[name] = Math.floor(stat.mtimeMs) + ':' + stat.size;
  }
  return signatures;
}

// The signatures written by the last rebuild, or null if this folder was
// built before signatures were recorded.
export async function readRecordedSignatures(galleryAbs) {
  try {
    const recorded = JSON.parse(await fsp.readFile(signaturesPath(galleryAbs), 'utf8'));
    return recorded && typeof recorded === 'object' ? recorded : null;
  } catch { return null; }
}

export async function writeRecordedSignatures(galleryAbs, signatures) {
  const file = signaturesPath(galleryAbs);
  await fsp.writeFile(file + '.tmp', JSON.stringify(signatures));
  await fsp.rename(file + '.tmp', file);
}

// Is every photo exactly as recorded, with no photo missing or extra?
export function signaturesMatch(recorded, current) {
  const recordedNames = Object.keys(recorded);
  if (recordedNames.length !== Object.keys(current).length) return false;
  return recordedNames.every(name => current[name] === recorded[name]);
}

// What the record says about one photo's renditions (see build_plan.js):
// 'trusted', 'replaced', or 'unknown' when there is no record of it.
export function trustOf(recorded, current, name) {
  if (!recorded || recorded[name] === undefined) return 'unknown';
  return recorded[name] === current[name] ? 'trusted' : 'replaced';
}
