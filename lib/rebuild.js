// No filesystem watcher: recursive fs.watch re-walks the tree on every event,
// which costs an entire core's worth of getdents64 once gg/ gets large.
// The uploader writes files we already know about; rsync drops are picked up
// via the admin "Full rescan" button.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import {
  bakeAtlasSerialized,
  computeAtlasHash,
  spriteMetaCache,
  sweepFolderTmps,
  sweepLegacyAtlasFiles,
  sweepOrphanLoDs,
  sweepStaleAtlases,
} from './atlas.js';
import { buildQueue } from './build_queue.js';
import { GG_DIR, isImage, isReservedName } from './config.js';
import {
  MANIFEST_VERSION,
  listFolder,
  loadManifest,
  manifestCache,
  readHiddenSentinels,
  writeManifest,
} from './manifest.js';

// rebuildFolder is the single entry point for putting a folder into a
// committed state. The contract: when this resolves successfully, a
// _manifest.json exists on disk and every file it references is fully
// built (LoDs + sprite + imagemap).
//
// Flow:
//   1. listFolder → target image+folder set from disk
//   2. enqueueImage(folderAbs, name) for each image → Promise.all
//   3. bakeAtlas(folderAbs, images) — serialized globally via _spriteWorkerChain
//   4. readHiddenSentinels → manifest.hiddenFolders
//   5. atomic write of _manifest.json

const rebuildInFlight = new Map();  // galleryAbs -> Promise<void>
const rebuildAgain = new Set();     // galleryAbs asked for again while in flight

function _arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// rebuildFolderIfNeeded is the public entry point. It does a cheap drift
// check first — list the folder, hash sources+mtimes, compare against the
// existing manifest's atlasDir+folders+hiddenFolders+images. If nothing
// drifted, returns immediately without touching the build queue or sprite
// worker. Otherwise calls rebuildFolder with the pre-computed target state.
// Legacy manifests (pre-2b.2, no atlasDir) lack a stored content hash.
// Detect source drift the only way we can: compare each source's mtime
// against the manifest builtAt. Any source newer than the build → drift.
async function legacyManifestFresh(galleryAbs, images, builtAt) {
  if (!builtAt) return false;
  for (const name of images) {
    const stat = await fsp.stat(path.join(galleryAbs, name)).catch(() => null);
    if (stat && stat.mtimeMs > builtAt) return false;
  }
  return true;
}

export function rebuildFolderIfNeeded(galleryAbs) {
  if (rebuildInFlight.has(galleryAbs)) {
    // The running rebuild listed the folder when it started, so a file that
    // landed since (upload, rsync drop) is not in it. Check once more after
    // it finishes instead of leaving that file invisible until the next rescan.
    rebuildAgain.add(galleryAbs);
    return rebuildInFlight.get(galleryAbs);
  }
  const p = (async () => {
    try {
      const { folders, images } = await listFolder(galleryAbs);
      const hiddenFolders = await readHiddenSentinels(galleryAbs, folders);
      const atlasDir = images.length > 0
        ? 'atlas_' + (await computeAtlasHash(galleryAbs, images))
        : null;
      const m = await loadManifest(galleryAbs);
      // Atlas-freshness check (sources only: an atlas packed under an older
      // SPRITE_LAYOUT_VERSION still serves, so it is re-packed when the
      // folder next changes, not forced — a tree of thousands of folders
      // would otherwise re-bake for hours. To re-pack one gallery now,
      // delete its gg/_manifest.json; the cold path rebuilds it, atlas only.)
      //   • new-layout manifest: stored atlasDir must equal the computed hash
      //   • legacy manifest (no atlasDir): no stored hash to compare, so fall
      //     back to comparing source mtimes against manifest.builtAt. This
      //     keeps Full Rescan from forcibly migrating untouched legacy
      //     galleries while still catching real source changes (touch / replace).
      const atlasFresh = m && m.atlasDir
        ? (m.atlasDir === atlasDir)
        : (m && await legacyManifestFresh(galleryAbs, images, m.builtAt));
      if (m &&
          _arraysEqual(m.images, images) &&
          _arraysEqual(m.folders, folders) &&
          _arraysEqual(m.hiddenFolders, hiddenFolders) &&
          atlasFresh) {
        return;
      }
      await rebuildFolder(galleryAbs, images, folders, hiddenFolders, atlasDir);
    } catch (e) { console.warn('[rebuild]', galleryAbs, e.message); throw e; }
    finally {
      rebuildInFlight.delete(galleryAbs);
      if (rebuildAgain.delete(galleryAbs)) rebuildFolderIfNeeded(galleryAbs).catch(() => {});
    }
  })();
  rebuildInFlight.set(galleryAbs, p);
  return p;
}

// Walk a gallery tree and run visitFolder for every folder with
// content, one folder at a time, top-level galleries before their
// subfolders. Sequential on purpose: a tree of thousands of small folders
// would otherwise flood the LoD queue and the sprite worker chain in readdir
// order, and the galleries people look at would be last to come current.
// Resolves with the count.
async function walkGalleryTree(rootAbs, visitFolder) {
  let checked = 0;
  const pending = [rootAbs];
  while (pending.length) {
    const dir = pending.shift();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    let hasContent = false;
    const subs = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        if (!isReservedName(e.name)) { subs.push(e.name); hasContent = true; }
      } else if (e.isFile() && isImage(e.name)) hasContent = true;
    }
    if (hasContent) {
      await visitFolder(dir).catch(e => console.warn('[tree walk]', dir, e.message));
      checked++;
    }
    subs.sort();
    for (const sub of subs) pending.push(path.join(dir, sub));
  }
  return checked;
}

async function rebuildFolder(galleryAbs, images, folders, hiddenFolders, atlasDir) {
  const thumbDir = path.join(galleryAbs, GG_DIR);
  await fsp.mkdir(thumbDir, { recursive: true });
  await sweepFolderTmps(thumbDir);

  // Phase 1: per-image LoDs (parallel via the global worker pool). ensureBuilt
  // is mtime-aware, so this is a near-no-op when LoDs are already current —
  // we still call it to handle the "one source replaced" case where the hash
  // changed but most LoDs are still valid.
  if (images.length > 0) {
    await Promise.all(images.map(name => buildQueue.enqueueImage(galleryAbs, name)));
  }

  // Phase 2: atlas + imagemap into atlas_<hash>/. Reuse if the hash dir
  // already exists (rare path now that the early-out check catches no-ops,
  // but could happen if the atlas dir survived a manifest deletion).
  if (atlasDir) {
    const atlasAbs = path.join(thumbDir, atlasDir);
    if (!fs.existsSync(atlasAbs)) {
      const buildingDir = atlasDir + '_building';
      const buildingAbs = path.join(thumbDir, buildingDir);
      await fsp.rm(buildingAbs, { recursive: true, force: true });
      await fsp.mkdir(buildingAbs, { recursive: true });
      await bakeAtlasSerialized(galleryAbs, images, buildingDir);
      await fsp.rename(buildingAbs, atlasAbs);
    }
    spriteMetaCache.delete(galleryAbs);
  } else {
    spriteMetaCache.delete(galleryAbs);
  }

  // Phase 3: commit manifest.
  const manifest = {
    version: MANIFEST_VERSION,
    builtAt: Date.now(),
    folders,
    images,
    hiddenFolders,
    atlasDir,
  };
  await writeManifest(galleryAbs, manifest);

  // Phase 4: cleanup stale atlas_* dirs + legacy flat-layout sprite files.
  await sweepStaleAtlases(thumbDir, atlasDir);
  await sweepLegacyAtlasFiles(thumbDir);
  await sweepOrphanLoDs(thumbDir, new Set(images));
}

// Drop every derived artifact in <folder>/gg/ so the next visit rebuilds
// from scratch. trash/ and the hidden sentinel are durable state that
// happens to live in gg/, not cache — leave them alone.
// Returns how many entries were removed, or null if the folder has no gg/.
async function deleteDerivedFiles(folderAbs) {
  const thumbDir = path.join(folderAbs, GG_DIR);
  let entries;
  try { entries = await fsp.readdir(thumbDir, { withFileTypes: true }); }
  catch { return null; }
  let removed = 0;
  for (const entry of entries) {
    if (entry.name === 'trash' || entry.name === 'hidden') continue;
    try {
      await fsp.rm(path.join(thumbDir, entry.name), { recursive: true, force: true });
      removed++;
    } catch {}
  }
  manifestCache.delete(folderAbs);
  spriteMetaCache.delete(folderAbs);
  return removed;
}

// "Rebuild from scratch" for one folder: answers as soon as the old build
// is gone, the new one runs in the background.
export async function clearcache(folderAbs) {
  const removed = await deleteDerivedFiles(folderAbs);
  if (removed === null) return 'nothing to clear';
  rebuildFolderIfNeeded(folderAbs).catch(() => {});
  return `cache cleared (${removed} entries removed); rebuilding`;
}

// The drift check is cheap for folders that are current.
export function rebuildTreeIfNeeded(rootAbs) {
  return walkGalleryTree(rootAbs, rebuildFolderIfNeeded);
}

// "Rebuild from scratch" for a folder and everything below it. A folder's
// old build is deleted only when the walk reaches it, and the walk waits
// for its new build before moving on, so the rest of the tree keeps
// serving what it has until its turn comes.
export function rebuildTreeFromScratch(rootAbs) {
  return walkGalleryTree(rootAbs, async folderAbs => {
    await deleteDerivedFiles(folderAbs);
    await rebuildFolderIfNeeded(folderAbs);
  });
}
