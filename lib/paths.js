// URL-segment to filesystem path resolution and name checks.

import path from 'path';
import { GALLERIES_ROOT, RESERVED, isReservedName } from './config.js';

// Resolve URL segments to an absolute path under GALLERIES_ROOT.
// Returns null on traversal, dotfiles, control chars, or reserved names.
export function resolveGallery(segments, { allowReserved = false } = {}) {
  for (const s of segments) {
    if (!s) continue;
    if (s === '.' || s === '..') return null;
    if (s.startsWith('.')) return null;
    // allowReserved admits the exact reserved name only, never a look-alike.
    if (isReservedName(s) && !(allowReserved && RESERVED.has(s))) return null;
    if (/[\x00-\x1f/\\]/.test(s)) return null;
  }
  const abs = path.resolve(GALLERIES_ROOT, ...segments);
  if (abs !== GALLERIES_ROOT && !abs.startsWith(GALLERIES_ROOT + path.sep)) return null;
  return abs;
}

// Tmp suffixes left by killed atomic-writes; sweepFolderTmps cleans them up.
export function isOrphanTmp(name) {
  return /\.__tmp\.[^/]+$/.test(name) || name.endsWith('.tmp');
}
