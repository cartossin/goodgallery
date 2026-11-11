// What each source photo looked like when its renditions were last built.
//
// Renditions are named after the photo (a.jpg -> gg/a.jpg.h200.avif), so a
// photo replaced by a different file of the same name would keep its old
// renditions. Comparing file times alone misses a replacement that is older
// than the renditions (a restore from backup, cp -p, rsync -t). So each
// rebuild records every photo's modification time and size, and the next
// rebuild rebuilds any photo whose record no longer matches.

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

// Which photos were replaced since the record was written, and whether any
// recorded photo is gone.
export function compareSignatures(recorded, current) {
  const replaced = [];
  let removedAny = false;
  for (const name of Object.keys(recorded)) {
    if (current[name] === undefined) removedAny = true;
    else if (current[name] !== recorded[name]) replaced.push(name);
  }
  return { replaced, removedAny };
}
