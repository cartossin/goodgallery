// Sprite atlases: metadata, the serialized worker bake, content hashing and
// the sweeps that remove stale derived files.

import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { Worker } from 'worker_threads';
import { BROKEN_DIR, GG_DIR, MAX_SPRITE_PIXELS } from './config.js';
import { manifestCache } from './manifest.js';
import { isOrphanTmp } from './paths.js';

// spriteMeta is cached in RAM after first read so pageviews skip the disk JSON.
export const spriteMetaCache = new Map(); // galleryAbs -> meta (or null if file is missing)

export async function readSpriteMeta(galleryAbs) {
  if (spriteMetaCache.has(galleryAbs)) return spriteMetaCache.get(galleryAbs);
  let meta = null;
  try {
    const m = manifestCache.get(galleryAbs);
    const dir = m && m.atlasDir
      ? path.join(galleryAbs, GG_DIR, m.atlasDir)
      : path.join(galleryAbs, GG_DIR);  // legacy flat layout
    const raw = await fsp.readFile(path.join(dir, '_sprite.json'), 'utf8');
    meta = JSON.parse(raw);
    if (meta && m && m.atlasDir) {
      meta._atlasDir = m.atlasDir;
      // Prepend atlasDir to sprite filenames so the client's URL builder
      // (folderURL + GG_DIR + '/' + sprites[i].file) lands at the right
      // path. Legacy galleries (no atlasDir) keep their flat filenames.
      for (const k of Object.keys(meta.atlases || {})) {
        for (const s of meta.atlases[k].sprites) {
          if (!s.file.includes('/')) s.file = m.atlasDir + '/' + s.file;
        }
      }
    }
  } catch {}
  spriteMetaCache.set(galleryAbs, meta);
  return meta;
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
        spriteCellWMax: parseInt(process.env.SPRITE_CELL_W_MAX || '600', 10),
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

export async function sweepStaleAtlases(thumbDir, keepDir) {
  let entries;
  try { entries = await fsp.readdir(thumbDir); } catch { return; }
  for (const e of entries) {
    if (!/^atlas_[a-f0-9]+(_building)?$/.test(e)) continue;
    if (e === keepDir) continue;
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
