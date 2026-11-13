// URL-segment to filesystem path resolution and name checks.

import path from 'path';
import { GALLERIES_ROOT, RESERVED, isReservedName } from './config.js';

const ON_WINDOWS = process.platform === 'win32';

// Windows does not read every name literally. "C:gg" is "gg on drive C",
// "a.jpg:x" is a hidden stream of a.jpg, "a." and "a " open "a", and NUL or
// COM1 (with any extension) is a device. No file on Windows can really have
// such a name, so on Windows they are refused: a name we accept must mean
// to the filesystem exactly what it says.
const WINDOWS_FORBIDDEN_CHARACTERS = /[<>:"|?*]/;
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
export function isLiteralNameOnWindows(name) {
  if (WINDOWS_FORBIDDEN_CHARACTERS.test(name)) return false;
  if (name.endsWith('.') || name.endsWith(' ')) return false;
  const beforeFirstDot = name.split('.')[0].trimEnd();
  if (WINDOWS_DEVICE_NAME.test(beforeFirstDot)) return false;
  return true;
}

// The one rule for which names in a gallery folder exist for us: the folder
// listing shows only these, and the router, the uploader, mkdir and the trash
// accept only these, so nothing is listed that cannot be served or trashed.
// Refused: dotfiles (including our own temp files), path separators and
// control characters, names that were not valid UTF-8 on disk (readdir hands
// them back with U+FFFD in place of the bad bytes, so the listed name opens
// nothing), every spelling of the gg data directory, and on Windows the
// names Windows does not read literally.
// windowsNames is a parameter only so the Windows rule can be checked on
// another system.
export function isServableName(name, windowsNames = ON_WINDOWS) {
  if (typeof name !== 'string' || name === '') return false;
  if (name.startsWith('.')) return false;
  if (/[\x00-\x1f/\\]/.test(name)) return false;
  if (name.includes('\uFFFD')) return false;
  if (isReservedName(name)) return false;
  if (windowsNames === true && !isLiteralNameOnWindows(name)) return false;
  return true;
}

// Resolve URL segments to an absolute path under a root folder.
// Returns null on traversal, dotfiles, control chars, or reserved names.
// The checked segments are joined onto the root as they are. They are not
// handed to path.resolve, which gives some names a meaning of their own (on
// Windows, resolve('C:\\Galleries', 'a', 'C:gg') is C:\Galleries\a\gg).
// pathRules and windowsNames are parameters only so the Windows behaviour
// can be checked on another system.
export function resolveUnder(root, segments, { allowReserved = false, pathRules = path, windowsNames = ON_WINDOWS } = {}) {
  const names = segments.filter(Boolean);
  for (const name of names) {
    // allowReserved admits the exact reserved name only, never a look-alike.
    if (allowReserved && RESERVED.has(name)) continue;
    if (!isServableName(name, windowsNames)) return null;
  }
  const abs = pathRules.join(root, ...names);
  if (abs !== root && !abs.startsWith(root + pathRules.sep)) return null;
  return abs;
}

export function resolveGallery(segments, { allowReserved = false } = {}) {
  return resolveUnder(GALLERIES_ROOT, segments, { allowReserved });
}

// A folder named in a request (JSON body or query string), relative to the
// gallery root: "a/b", "/a/b/", or "" for the root itself. Anything but a
// string is refused (null), never read as "the root".
export function resolveFolderField(value) {
  if (typeof value !== 'string') return null;
  return resolveGallery(value.split('/').filter(Boolean));
}

// Is this path a gg data directory, or inside one, under any spelling? The
// build asks before it touches a folder: whatever a name check upstream may
// one day let through, a data directory is never built as if it were a
// gallery (which would make a gg inside gg, one level deeper per request).
export function isInsideDataDirectory(abs, { root = GALLERIES_ROOT, pathRules = path } = {}) {
  return pathRules.relative(root, abs).split(pathRules.sep).some(isReservedName);
}

// Tmp suffixes left by killed atomic-writes; sweepFolderTmps cleans them up.
export function isOrphanTmp(name) {
  return /\.__tmp\.[^/]+$/.test(name) || name.endsWith('.tmp');
}
