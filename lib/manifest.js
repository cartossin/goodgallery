// Per-gallery manifest: the committed listing a pageview renders from.
// Pageviews read a tiny JSON manifest mirrored in RAM, never readdir on the
// gallery dir. Mutations (upload/trash/restore/mkdir) update the manifest
// in-place. Full Rescan (admin button) is the only path that readdir's during
// normal operation.
import { isOrphanTmp } from './paths.js';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { GG_DIR, isImage, isReservedName } from './config.js';

export const MANIFEST_VERSION = 1;
export const manifestCache = new Map(); // galleryAbs -> { version, builtAt, folders, images }

export function manifestPathFor(galleryAbs) {
  return path.join(galleryAbs, GG_DIR, '_manifest.json');
}

export async function listFolder(absDir) {
  let entries;
  try { entries = await fsp.readdir(absDir, { withFileTypes: true }); }
  catch { return { folders: [], images: [] }; }

  const folders = [];
  const images  = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) {
      if (isReservedName(e.name)) continue;
      folders.push(e.name);
    } else if (e.isFile() && isImage(e.name) && !isOrphanTmp(e.name)) {
      images.push(e.name);  // a half-assembled upload (name.__tmp.jpg) is not an image yet
    }
  }
  const cmp = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
  folders.sort(cmp);
  images.sort(cmp);
  return { folders, images };
}

export async function writeManifest(galleryAbs, m) {
  const p = manifestPathFor(galleryAbs);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p + '.tmp', JSON.stringify(m));
  await fsp.rename(p + '.tmp', p);
  manifestCache.set(galleryAbs, m);
}

export async function loadManifest(galleryAbs) {
  const cached = manifestCache.get(galleryAbs);
  if (cached) {
    // Cache coherence: if the disk file was deleted out from under us
    // (manual rm, Full Rescan staging, etc.), the cached copy is stale.
    // Verify presence on the cheap before trusting the cache.
    if (fs.existsSync(manifestPathFor(galleryAbs))) return cached;
    manifestCache.delete(galleryAbs);
  }
  try {
    const raw = await fsp.readFile(manifestPathFor(galleryAbs), 'utf8');
    const m = JSON.parse(raw);
    if (m && m.version === MANIFEST_VERSION && Array.isArray(m.folders) && Array.isArray(m.images)) {
      manifestCache.set(galleryAbs, m);
      return m;
    }
  } catch {}
  // Cold gallery: caller is expected to kick rebuildFolderIfNeeded and
  // render a placeholder. We do NOT auto-write a manifest here — that would
  // violate the invariant "manifest exists ⇒ all referenced files are built".
  return null;
}

// Hidden state is canonical on disk as <folder>/gg/hidden (empty sentinel
// file). Manifest still caches hiddenFolders for O(1) pageview reads, but a
// full rebuild can derive it fresh from disk without merging old state in.
export async function readHiddenSentinels(galleryAbs, folderNames) {
  const hidden = [];
  for (const name of folderNames) {
    try {
      await fsp.access(path.join(galleryAbs, name, GG_DIR, 'hidden'));
      hidden.push(name);
    } catch {}
  }
  hidden.sort();
  return hidden;
}

// Hidden folders are filtered from the public folder grid but stay reachable
// by direct URL. Source of truth is the disk sentinel; this updates that
// sentinel first, then mirrors the change into the cached hiddenFolders array.
// Toggle the hidden sentinel for a child folder. The parent's manifest
// rebuild reads sentinels into manifest.hiddenFolders[]; this function
// just touches the disk state. Caller is responsible for triggering the
// parent rebuild.
export async function toggleHiddenSentinel(folderAbs, hide) {
  const ggDir = path.join(folderAbs, GG_DIR);
  const sentinel = path.join(ggDir, 'hidden');
  if (hide) {
    await fsp.mkdir(ggDir, { recursive: true });
    try { await fsp.access(sentinel); } catch { await fsp.writeFile(sentinel, ''); }
  } else {
    try { await fsp.unlink(sentinel); } catch {}
  }
}
