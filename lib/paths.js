// URL-segment to filesystem path resolution and name checks.

import path from 'path';
import { GALLERIES_ROOT, RESERVED, isReservedName } from './config.js';

// The one rule for which names in a gallery folder exist for us: the folder
// listing shows only these, and the router, the uploader, mkdir and the trash
// accept only these, so nothing is listed that cannot be served or trashed.
// Refused: dotfiles (including our own temp files), path separators and
// control characters, names that were not valid UTF-8 on disk (readdir hands
// them back with U+FFFD in place of the bad bytes, so the listed name opens
// nothing), and every spelling of the gg data directory.
export function isServableName(name) {
  if (typeof name !== 'string' || name === '') return false;
  if (name.startsWith('.')) return false;
  if (/[\x00-\x1f/\\]/.test(name)) return false;
  if (name.includes('�')) return false;
  if (isReservedName(name)) return false;
  return true;
}

// Resolve URL segments to an absolute path under GALLERIES_ROOT.
// Returns null on traversal, dotfiles, control chars, or reserved names.
export function resolveGallery(segments, { allowReserved = false } = {}) {
  for (const s of segments) {
    if (!s) continue;
    // allowReserved admits the exact reserved name only, never a look-alike.
    if (allowReserved && RESERVED.has(s)) continue;
    if (!isServableName(s)) return null;
  }
  const abs = path.resolve(GALLERIES_ROOT, ...segments);
  if (abs !== GALLERIES_ROOT && !abs.startsWith(GALLERIES_ROOT + path.sep)) return null;
  return abs;
}

// Tmp suffixes left by killed atomic-writes; sweepFolderTmps cleans them up.
export function isOrphanTmp(name) {
  return /\.__tmp\.[^/]+$/.test(name) || name.endsWith('.tmp');
}
