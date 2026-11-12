// Sprite atlases: metadata, the serialized worker bake, content hashing and
// the sweeps that remove stale derived files.

import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { Worker } from 'worker_threads';
import { BROKEN_DIR, GG_DIR, MAX_SPRITE_PIXELS, SPRITE_CELL_W_MAX, SPRITE_ENCODE_PARALLEL } from './config.js';
import { manifestCache } from './manifest.js';
import { isOrphanTmp } from './paths.js';

// spriteMeta is cached in RAM after first read so pageviews skip the disk JSON.
// Each entry remembers which atlas it was read from, and is used only while
// the committed manifest still names that atlas. A rebuild commits a new
// manifest with a new atlas, so the next page view reads the new meta, with
// no separate invalidation to get in the wrong order: a page view that read
// the previous manifest just before the commit may store the previous meta,
// but nobody uses it once the new manifest is in place.
export const spriteMetaCache = new Map(); // galleryAbs -> { atlasDir, meta } (meta null if unreadable)

export async function readSpriteMeta(galleryAbs) {
  const m = manifestCache.get(galleryAbs);
  const atlasDir = (m && m.atlasDir) || '';  // '' is the legacy flat layout
  const cached = spriteMetaCache.get(galleryAbs);
  if (cached && cached.atlasDir === atlasDir) return cached.meta;
  const meta = await loadSpriteMetaFile(galleryAbs, atlasDir);
  spriteMetaCache.set(galleryAbs, { atlasDir, meta });
  return meta;
}

// The atlas meta of one atlas directory, ready for the page, or null.
async function loadSpriteMetaFile(galleryAbs, atlasDir) {
  try {
    const raw = await fsp.readFile(path.join(galleryAbs, GG_DIR, atlasDir, '_sprite.json'), 'utf8');
    const meta = JSON.parse(raw);
    if (meta && atlasDir) {
      meta._atlasDir = atlasDir;
      // Prepend atlasDir to sprite filenames so the client's URL builder
      // (folderURL + GG_DIR + '/' + sprites[i].file) lands at the right
      // path. Legacy galleries (no atlasDir) keep their flat filenames.
      for (const k of Object.keys(meta.atlases || {})) {
        for (const s of meta.atlases[k].sprites) {
          if (!s.file.includes('/')) s.file = atlasDir + '/' + s.file;
        }
      }
    }
    return meta;
  } catch { return null; }
}

// Sprite atlas builds are CPU-heavy synchronous JS (pixel-copy 100k tiles at
// 100k-image scale takes minutes). Run them in a worker thread so pageview
// handling on the main thread stays responsive. We still gate concurrency to
// one worker at a time globally — a single 100k atlas build holds ~1GB; running
// several at once on a moderate-RAM host risks OOM.
let _spriteWorkerChain = Promise.resolve();
export function bakeAtlasSerialized(galleryAbs, images, outputDir) {
  const next = _spriteWorkerChain.then(() => _runSpriteWorker(galleryAbs, images, outputDir));
  _spriteWorkerChain = next.catch(() => {});
  return next;
}
function _runSpriteWorker(galleryAbs, images, outputDir) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./sprite_worker.js', import.meta.url), {
      workerData: {
        galleryAbs,
        images,
        outputDir,  // subdir under gg/ (e.g. "atlas_<hash>_building")
        brokenDir: BROKEN_DIR,
        maxSpritePixels: MAX_SPRITE_PIXELS,
        spriteCellWMax: SPRITE_CELL_W_MAX,
        spriteEncodeParallel: SPRITE_ENCODE_PARALLEL,
      },
    });
    let settled = false;
    w.on('message', (msg) => {
      if (settled) return;
      settled = true;
      if (msg && msg.ok) resolve(msg.meta);
      else reject(new Error((msg && msg.error) || 'sprite worker failed'));
    });
    w.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    w.on('exit', (code) => {
      if (!settled) {
        settled = true;
        if (code === 0) resolve(null);
        else reject(new Error('sprite worker exited with code ' + code));
      }
    });
  });
}
// Hash the gallery's current source state — sorted image names + their
// mtimes. The atlas content is fully determined by the originals, so if
// this hash is unchanged the existing atlas is byte-identical. (h5.v is
// derived, so we don't hash it.) ensureBuilt regenerates LoDs whenever a
// source becomes newer than its LoD, so source-mtime changes propagate
// correctly through to atlas content on rebuild.
export async function computeAtlasHash(galleryAbs, images) {
  const h = crypto.createHash('sha256');
  for (const name of images) {
    const stat = await fsp.stat(path.join(galleryAbs, name)).catch(() => null);
    h.update(name + '\0' + (stat ? Math.floor(stat.mtimeMs) : 0) + '\0');
  }
  return h.digest('hex').slice(0, 16);
}

// keepDirs holds the atlas the new manifest names and the one the previous
// manifest named. A page opened before this rebuild still asks for sheets
// from the previous atlas when it zooms, so that one lives until the next
// rebuild instead of being deleted under it.
export async function sweepStaleAtlases(thumbDir, keepDirs) {
  let entries;
  try { entries = await fsp.readdir(thumbDir); } catch { return; }
  for (const e of entries) {
    if (!/^atlas_[a-f0-9]+(_building)?$/.test(e)) continue;
    if (keepDirs.includes(e)) continue;
    try { await fsp.rm(path.join(thumbDir, e), { recursive: true, force: true }); } catch {}
  }
}

// Remove per-image LoDs whose source file no longer exists (deletion left
// orphans behind). Matches <name>.h<digits>.<v|avif> and tests <name> for
// membership in the live image set.
export async function sweepOrphanLoDs(thumbDir, imageSet) {
  let entries;
  try { entries = await fsp.readdir(thumbDir); } catch { return; }
  for (const e of entries) {
    const m = /^(.+)\.h\d+\.(v|avif)$/.exec(e);
    if (!m) continue;
    if (!imageSet.has(m[1])) {
      try { await fsp.unlink(path.join(thumbDir, e)); } catch {}
    }
  }
}

// Remove pre-2b.2 flat-layout sprite+imagemap files at the gg/ root (they
// now live inside atlas_<hash>/). Called after a rebuild that produced a
// new-layout manifest — naturally migrates galleries on first rebuild.
export async function sweepLegacyAtlasFiles(thumbDir) {
  let entries;
  try { entries = await fsp.readdir(thumbDir); } catch { return; }
  for (const e of entries) {
    if (e === '_sprite.json' || e === '_imagemap.bin' ||
        /^sprite(-h\d+)?-\d+\.(jpg|avif)$/.test(e)) {
      try { await fsp.unlink(path.join(thumbDir, e)); } catch {}
    }
  }
}

// Atomic writes leave .__tmp.* on the way to their final names; a kill mid-
// write strands them. rebuildFolder sweeps these at the start of a bake.
export async function sweepFolderTmps(thumbDir) {
  let entries;
  try { entries = await fsp.readdir(thumbDir); } catch { return 0; }
  let removed = 0;
  for (const e of entries) {
    if (isOrphanTmp(e)) {
      try { await fsp.unlink(path.join(thumbDir, e)); removed++; } catch {}
    }
  }
  return removed;
}
