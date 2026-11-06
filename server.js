// Goodgallery 2.0 — Node.js. Zero runtime npm deps. libvips for image work.
//
// On-disk layout:
//   GALLERIES_ROOT/<path...>/<image>                    originals
//   GALLERIES_ROOT/<path...>/gg/<image>.h<H>.<format>   per-image LoDs (avif/v)
//   GALLERIES_ROOT/<path...>/gg/sprite-h<H>-<N>.avif    sprite atlases
//   GALLERIES_ROOT/<path...>/gg/_manifest.json          per-gallery manifest
//   GALLERIES_ROOT/<path...>/gg/trash/<image>           soft-deleted (per-folder)
//
// Each folder is its own gallery; subfolders appear as cards in the parent.

import http from 'http';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Single-threaded vips per subprocess. We do our own parallelism via the
// BuildQueue worker pool — letting libvips spin internal threads on top
// only causes lock contention and thread-setup overhead (esp. on tiny h5/h10
// LoDs that finish in milliseconds).
process.env.VIPS_CONCURRENCY = process.env.VIPS_CONCURRENCY || "1";

// ---------- config ----------
const PORT             = parseInt(process.env.PORT || '3000', 10);
const HOST             = process.env.HOST || '0.0.0.0';
const GALLERIES_ROOT   = path.resolve(process.env.GALLERIES_ROOT || '/var/lib/goodgallery/galleries');
const STATE_DIR        = path.resolve(process.env.STATE_DIR     || '/var/lib/goodgallery');
const PUBLIC_DIR       = path.join(__dirname, 'public');
const PASSKEY_FILE     = path.join(STATE_DIR, 'passkey.json');
const SITE_TITLE       = process.env.SITE_TITLE || 'Goodgallery';
// Small tiers are lossless `.v` (raw, fast to decode for atlas packing);
// large tiers are AVIF Q=80.
const LOD_TIERS = [
  { h: 5,   format: 'v',    quality: null },
  { h: 10,  format: 'v',    quality: null },
  { h: 50,  format: 'v',    quality: null },
  { h: 100, format: 'v',    quality: null },
  { h: 200, format: 'avif', quality: 80 },
  { h: 400, format: 'avif', quality: 80 },
  { h: 800,  format: 'avif', quality: 80 },
  { h: 1600, format: 'avif', quality: 80 },
];
function lodPath(thumbDir, filename, height, format) {
  return path.join(thumbDir, filename + '.h' + height + '.' + format);
}

// Sprite size is capped by target file bytes. Translate bytes → pixel budget via
// an empirical bytes/pixel constant; tune BYTES_PER_PIXEL_Q92 lower for flat-color
// content, higher for extreme detail.
const MAX_SPRITE_BYTES   = parseInt(process.env.MAX_SPRITE_BYTES || String(4 * 1024 * 1024), 10);
const BYTES_PER_PIXEL_Q92 = parseFloat(process.env.BYTES_PER_PIXEL_Q92 || '0.30');
const MAX_SPRITE_PIXELS   = Math.max(1, Math.floor(MAX_SPRITE_BYTES / BYTES_PER_PIXEL_Q92));

const SESSION_DURATION = 24 * 60 * 60 * 1000;
const LOGIN_LINK_TTL   = 10 * 60 * 1000;
const RP_NAME          = SITE_TITLE;

// Each gallery folder owns a child dir named GG_DIR holding all derived state
// (manifest, per-image LoDs, atlases). RESERVED names are excluded from listings.
const GG_DIR = 'gg';
const RESERVED = new Set([GG_DIR]);

// Cache-bust static assets by mtime so edits land without a restart while
// unchanged files stay browser-cached.
function _assetVer(name) {
  try { return String(Math.floor(fs.statSync(path.join(PUBLIC_DIR, name)).mtimeMs)); }
  catch { return Date.now().toString(); }
}
const SUPPORTED_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif']);

// ---------- bootstrap ----------
fs.mkdirSync(GALLERIES_ROOT, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });
// Per-folder trash: each folder owns its own bin at <folder>/gg/trash/.
function trashDirFor(folderAbs) {
  return path.join(folderAbs, GG_DIR, 'trash');
}
function isValidTrashName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.includes('\0') || name.includes('/') || name.includes('\\')) return false;
  if (name === '.' || name === '..' || name.startsWith('.')) return false;
  return true;
}

// ---------- broken-image placeholder ----------
// vips failures are caught per-tier in ensureBuilt; we copy the matching
// pre-rendered broken tile into the actual LoD path. Downstream (sprite
// build, URL serving) reads the LoD path unconditionally — the gallery
// never knows the image was unbuildable, it just shows a red-X tile.
const BROKEN_SVG = path.join(PUBLIC_DIR, 'broken.svg');
const BROKEN_DIR = path.join(STATE_DIR, '_broken');
function brokenTilePath(height, format) {
  return path.join(BROKEN_DIR, 'broken.h' + height + '.' + format);
}
let _brokenTilesP = null;
function brokenTilesReady() {
  if (!_brokenTilesP) _brokenTilesP = _ensureBrokenTiles().catch(e => { console.warn('[broken] generation failed:', e.message); _brokenTilesP = null; });
  return _brokenTilesP;
}
async function _ensureBrokenTiles() {
  let svgStat;
  try { svgStat = await fsp.stat(BROKEN_SVG); }
  catch { console.warn('[broken] missing public/broken.svg — placeholder substitution disabled'); return; }
  await fsp.mkdir(BROKEN_DIR, { recursive: true });
  for (const tier of LOD_TIERS) {
    const out = brokenTilePath(tier.h, tier.format);
    let outMtime = 0;
    try { outMtime = (await fsp.stat(out)).mtimeMs; } catch {}
    if (outMtime >= svgStat.mtimeMs) continue;
    const tmp = out + '.__tmp.' + tier.format;
    if (tier.format === 'v') {
      const t1 = out + '.__tmp.step1.v', t2 = out + '.__tmp.step2.v';
      await runStep('vips', ['thumbnail', BROKEN_SVG, t1, '99999', '--height', String(tier.h), '--size', 'both'], t1);
      await runStep('vips', ['colourspace', t1, t2, 'srgb'], t2);
      await runStep('vips', ['extract_band', t2, tmp, '0', '--n', '3'], tmp);
      await fsp.unlink(t1).catch(()=>{});
      await fsp.unlink(t2).catch(()=>{});
    } else {
      await runStep('vips', ['thumbnail', BROKEN_SVG, tmp + '[Q=' + tier.quality + ']', '99999', '--height', String(tier.h), '--size', 'both'], tmp);
    }
    await fsp.rename(tmp, out);
    console.log('[broken] generated', path.basename(out));
  }
}

async function listFolderTrash(folderAbs) {
  // Lazy GC of any .trash-emptying-* parks left over from a prior crash.
  const ggDir = path.join(folderAbs, GG_DIR);
  try {
    const sibs = await fsp.readdir(ggDir);
    for (const s of sibs) {
      if (s.startsWith('.trash-emptying-')) {
        fsp.rm(path.join(ggDir, s), { recursive: true, force: true }).catch(()=>{});
      }
    }
  } catch {}
  const tdir = trashDirFor(folderAbs);
  let entries;
  try { entries = await fsp.readdir(tdir, { withFileTypes: true }); }
  catch { return []; }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(tdir, e.name);
    let st; try { st = await fsp.stat(full); } catch { continue; }
    out.push({
      name: e.name,
      isFolder: e.isDirectory(),
      size: e.isFile() ? st.size : null,
      trashedAt: st.mtimeMs,
    });
  }
  out.sort((a, b) => b.trashedAt - a.trashedAt);
  return out;
}

// Tmp suffixes left by killed atomic-writes; sweepFolderTmps cleans them up.
function isOrphanTmp(name) {
  return /\.__tmp\.[^/]+$/.test(name) || name.endsWith('.tmp');
}

// ---------- build queue ----------
// Concurrency = N CPUs (vips is single-threaded per process). Per-(folder,file)
// dedupe collapses repeated triggers. ensureBuilt is idempotent + atomic, so a
// process kill loses only in-memory progress counters, never on-disk integrity.
const BUILD_CONCURRENCY = parseInt(process.env.BUILD_CONCURRENCY || '0', 10) || os.cpus().length;

class BuildQueue {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.queue = [];
    this.inFlight = new Map();
    this.workers = 0;
    this.progress = new Map();
    this.doneAt = [];  // timestamps of completed jobs (trimmed to last 60s on read)
  }
  _key(g, f) { return g + '\0' + f; }
  _bumpProgress(g, fn) {
    const p = this.progress.get(g) || { pending: 0, inProgress: 0, done: 0, total: 0 };
    fn(p);
    this.progress.set(g, p);
  }
  // Enqueue a single image build. Returns a Promise that resolves once
  // ensureBuilt completes (success OR failure — failures are logged and
  // resolved; rebuildFolder's atlas step handles missing LoDs by retrying
  // on the next call). Per-(folder,file) dedupe: a second concurrent
  // enqueue for the same image returns the existing in-flight promise.
  enqueueImage(galleryAbs, filename) {
    const k = this._key(galleryAbs, filename);
    if (this.inFlight.has(k)) return this.inFlight.get(k);
    const p = new Promise((resolve, reject) => {
      this.queue.push({ galleryAbs, filename, resolve, reject });
    });
    this.inFlight.set(k, p);
    this._bumpProgress(galleryAbs, x => { x.pending++; x.total++; });
    this._kick();
    return p;
  }
  _kick() {
    while (this.workers < this.concurrency && this.queue.length) {
      this.workers++;
      this._runOne();
    }
  }
  async _runOne() {
    try {
      while (this.queue.length) {
        const { galleryAbs, filename, resolve } = this.queue.shift();
        const k = this._key(galleryAbs, filename);
        this._bumpProgress(galleryAbs, p => { p.pending--; p.inProgress++; });
        try {
          await ensureBuilt(galleryAbs, filename);
          this._bumpProgress(galleryAbs, p => { p.done++; });
          this.doneAt.push(Date.now());
        } catch (e) {
          // ensureBuilt substitutes broken.svg on vips errors (commit 1),
          // so we only end up here for missing-source / unsupported-type
          // failures. Resolve the promise anyway so Promise.all in
          // rebuildFolder doesn't hang; the atlas bake will read whatever's
          // on disk (and re-enqueue happens on the next rebuild trigger).
          this._bumpProgress(galleryAbs, p => { p.lastError = filename + ': ' + e.message; });
          console.warn('[build]', filename, 'in', galleryAbs, '-', e.message);
        } finally {
          this._bumpProgress(galleryAbs, p => { p.inProgress--; });
          this.inFlight.delete(k);
          resolve();
        }
      }
    } finally { this.workers--; }
  }
  // Drop all queued (not-yet-started) work. Workers currently inside
  // _runOne keep running — interrupting a half-written tile would orphan a
  // .__tmp file. Returns the count of queued items dropped.
  clear() {
    const dropped = this.queue.length;
    for (const job of this.queue) {
      const k = this._key(job.galleryAbs, job.filename);
      this.inFlight.delete(k);
      // Awaiting rebuildFolder coroutines need their promises resolved so they
      // don't hang. Treat clear() as "all queued jobs finished" (no-op build).
      job.resolve();
    }
    const perGallery = new Map();
    for (const job of this.queue) {
      perGallery.set(job.galleryAbs, (perGallery.get(job.galleryAbs) || 0) + 1);
    }
    for (const [g, n] of perGallery) {
      this._bumpProgress(g, p => { p.pending -= n; p.total -= n; if (p.pending < 0) p.pending = 0; if (p.total < 0) p.total = 0; });
    }
    this.queue.length = 0;
    return dropped;
  }
  // Rolling ETA across all galleries. Rate is files completed in the last
  // ~60s; if we don't have enough history yet, etaSeconds is null.
  globalProgress() {
    let remaining = 0;
    for (const p of this.progress.values()) remaining += p.pending + p.inProgress;
    const now = Date.now();
    while (this.doneAt.length && now - this.doneAt[0] > 60000) this.doneAt.shift();
    let etaSeconds = null;
    if (remaining > 0 && this.doneAt.length >= 5) {
      const spanSec = (now - this.doneAt[0]) / 1000;
      if (spanSec > 0) {
        const rate = this.doneAt.length / spanSec;
        if (rate > 0) etaSeconds = Math.round(remaining / rate);
      }
    }
    return { remaining, etaSeconds };
  }
  progressFor(galleryAbs) {
    const p = this.progress.get(galleryAbs);
    if (!p) return { pending: 0, inProgress: 0, done: 0, total: 0 };
    return { pending: p.pending, inProgress: p.inProgress, done: p.done, total: p.total, lastError: p.lastError };
  }
}

// ---------- tmp-file sweep ----------
// Atomic writes leave .__tmp.* on the way to their final names; a kill mid-
// write strands them. rebuildFolder sweeps these at the start of a bake.
async function sweepFolderTmps(thumbDir) {
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

const buildQueue = new BuildQueue(BUILD_CONCURRENCY);
let fullrescanInProgress = false;

// No filesystem watcher: recursive fs.watch re-walks the tree on every event,
// which costs an entire core's worth of getdents64 once gg/ gets large.
// The uploader writes files we already know about; rsync drops are picked up
// via the admin "Full rescan" button.

// ---------- in-memory state ----------
const sessions         = new Map();  // token -> { createdAt }
const pendingChallenges = new Map(); // chalId -> { challenge, timestamp }
const loginLinks       = new Map(); // token -> { createdAt } — single-use, 10min TTL

// Persist sessions so a restart doesn't 401 everyone whose cookie is still valid.
const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
function loadSessions() {
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
    const obj = JSON.parse(raw);
    const now = Date.now();
    for (const [tok, data] of Object.entries(obj)) {
      if (now - data.createdAt < SESSION_DURATION) {
        if (!data.origin) data.origin = 'passkey';
        sessions.set(tok, data);
      }
    }
    if (sessions.size) console.log(`Restored ${sessions.size} admin session(s) from disk.`);
  } catch {}
}
function saveSessions() {
  const obj = Object.fromEntries(sessions);
  const tmp = SESSIONS_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, SESSIONS_FILE);
  } catch (e) { console.warn('saveSessions failed:', e.message); }
}
loadSessions();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingChallenges) if (now - v.timestamp > 5 * 60 * 1000) pendingChallenges.delete(k);
  for (const [k, v] of sessions)         if (now - v.createdAt  > SESSION_DURATION) sessions.delete(k);
  for (const [k, v] of loginLinks)       if (now - v.createdAt  > LOGIN_LINK_TTL)   loginLinks.delete(k);
}, 60 * 1000);

// ---------- helpers ----------
function hxEscape(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function jsString(s) {
  return JSON.stringify(String(s));
}
function parseCookies(h) {
  const out = {};
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const raw = part.slice(i + 1).trim();
    // decodeURIComponent throws URIError on malformed %-escapes (e.g.
    // `Cookie: x=%`), which would otherwise crash the request handler and
    // hand an anonymous DoS to any client. Fall back to the raw value —
    // our own cookies (ggSession base64url) contain no percent-escapes.
    try { out[k] = decodeURIComponent(raw); }
    catch { out[k] = raw; }
  }
  return out;
}
function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': body.length });
  res.end(body);
}
function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text);
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': body.length });
  res.end(body);
}
function notFound(res, msg = 'not found') { sendText(res, 404, msg); }
function badRequest(res, msg = 'bad request') { sendText(res, 400, msg); }

// Resolve URL segments to an absolute path under GALLERIES_ROOT.
// Returns null on traversal, dotfiles, control chars, or reserved names.
function resolveGallery(segments, { allowReserved = false } = {}) {
  for (const s of segments) {
    if (!s) continue;
    if (s === '.' || s === '..') return null;
    if (s.startsWith('.')) return null;
    if (!allowReserved && RESERVED.has(s)) return null;
    if (/[\x00-\x1f/\\]/.test(s)) return null;
  }
  const abs = path.resolve(GALLERIES_ROOT, ...segments);
  if (abs !== GALLERIES_ROOT && !abs.startsWith(GALLERIES_ROOT + path.sep)) return null;
  return abs;
}

function isImage(name) {
  return SUPPORTED_EXT.has(path.extname(name).toLowerCase());
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > limit) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------- listing ----------
async function listFolder(absDir) {
  let entries;
  try { entries = await fsp.readdir(absDir, { withFileTypes: true }); }
  catch { return { folders: [], images: [] }; }

  const folders = [];
  const images  = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) {
      if (RESERVED.has(e.name)) continue;
      folders.push(e.name);
    } else if (e.isFile() && isImage(e.name)) {
      images.push(e.name);
    }
  }
  const cmp = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
  folders.sort(cmp);
  images.sort(cmp);
  return { folders, images };
}

// ---------- per-gallery manifest cache ----------
// Pageviews read a tiny JSON manifest mirrored in RAM, never readdir on the
// gallery dir. Mutations (upload/trash/restore/mkdir) update the manifest
// in-place. Full Rescan (admin button) is the only path that readdir's during
// normal operation.
const MANIFEST_VERSION = 1;
const manifestCache = new Map(); // galleryAbs -> { version, builtAt, folders, images }
const _natCmp = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;

function manifestPathFor(galleryAbs) {
  return path.join(galleryAbs, GG_DIR, '_manifest.json');
}

// Cold-path only: full rescan or first-time index, never the hot pageview path.
async function buildManifestFromDisk(galleryAbs) {
  const { folders, images } = await listFolder(galleryAbs);
  // Read hidden state from disk sentinels so a cold build (first index or
  // post-delete recovery) picks up any pre-existing <folder>/gg/hidden files.
  const hiddenFolders = await readHiddenSentinels(galleryAbs, folders);
  return { version: MANIFEST_VERSION, builtAt: Date.now(), folders, images, hiddenFolders };
}

async function writeManifest(galleryAbs, m) {
  const p = manifestPathFor(galleryAbs);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p + '.tmp', JSON.stringify(m));
  await fsp.rename(p + '.tmp', p);
  manifestCache.set(galleryAbs, m);
}

async function loadManifest(galleryAbs) {
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

// Insort into a natural-numeric-sorted array; returns false on dup.
function insortUnique(arr, name) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const c = _natCmp(arr[mid], name);
    if (c < 0) lo = mid + 1;
    else if (c > 0) hi = mid;
    else return false;
  }
  arr.splice(lo, 0, name);
  return true;
}
function spliceName(arr, name) {
  const i = arr.indexOf(name);
  if (i < 0) return false;
  arr.splice(i, 1);
  return true;
}



// Hidden state is canonical on disk as <folder>/gg/hidden (empty sentinel
// file). Manifest still caches hiddenFolders for O(1) pageview reads, but a
// full rebuild can derive it fresh from disk without merging old state in.
async function readHiddenSentinels(galleryAbs, folderNames) {
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
async function toggleHiddenSentinel(folderAbs, hide) {
  const ggDir = path.join(folderAbs, GG_DIR);
  const sentinel = path.join(ggDir, 'hidden');
  if (hide) {
    await fsp.mkdir(ggDir, { recursive: true });
    try { await fsp.access(sentinel); } catch { await fsp.writeFile(sentinel, ''); }
  } else {
    try { await fsp.unlink(sentinel); } catch {}
  }
}


// ---------- image build via libvips ----------
// Per-image LoDs written via tmp+rename for atomicity. AVIF for displayable
// tiers; lossless .v for atlas-input tiers so packing is decode-free.
// libheif enforces a per-axis cap on AVIF saves (16384 on this build; HEIF
// spec ceiling). Passing this as the vips thumbnail max-width means extreme-
// wide panoramas land slightly under the nominal tier height — e.g. an
// h1600 of a 46592×3720 image becomes 1308×16384 instead of failing
// outright. The tier filename still says "h1600"; the renderer uses that as
// an identifier, not a literal dimension promise.
const AVIF_MAX_DIM = parseInt(process.env.AVIF_MAX_DIM || '16384', 10);
function vipsHeightThumbAVIF(srcAbs, dstAbs, height, quality) {
  return new Promise((resolve, reject) => {
    const tmp = dstAbs + '.__tmp.avif';
    const args = [
      'thumbnail', srcAbs, tmp + '[Q=' + quality + ']', String(AVIF_MAX_DIM),
      '--height', String(height),
      '--size', 'down',
    ];
    runStep('vips', args, tmp).then(() =>
      fs.promises.rename(tmp, dstAbs).then(resolve, reject)
    ).catch(reject);
  });
}

// Build a .v thumb in a single vipsthumbnail call. Three wins over the prior
// three-spawn (thumbnail → colourspace srgb → extract_band) pipeline:
//   1. One process spawn instead of three. vips startup is ~65 ms; saving two
//      spawns is ~130 ms per build at the cheapest tiers (h5..h100).
//   2. vipsthumbnail uses libjpeg shrink-on-load, decoding JPEGs at 1/2, 1/4,
//      or 1/8 native resolution without fully decompressing. h100 from a 5000-
//      wide JPEG decodes ~8x faster.
//   3. No intermediate .v files on disk between steps. Less ZFS write traffic.
//
// Band normalization (forcing exactly 3 bands) used to be done via extract_band.
// We drop that step entirely: the sprite atlas packer (`packAtlasBuffer` in
// sprite_worker.js) already handles 1, 3, and 4-band raw .v inputs and copies
// them into a 3-band RGB atlas on the fly. The on-disk .v can be whatever vips
// produced; the consumer normalizes at pack time.
function vipsHeightThumbV(srcAbs, dstAbs, height) {
  return new Promise((resolve, reject) => {
    const tmp = dstAbs + '.__tmp.v';
    runStep('vipsthumbnail', [
      srcAbs,
      '--size', '99999x' + height,
      '--export-profile', 'srgb',
      '-o', tmp,
    ], tmp).then(() =>
      fs.promises.rename(tmp, dstAbs).then(resolve, reject)
    ).catch(reject);
  });
}

// Run a vips subcommand and verify expectedOutput exists.
function runStep(cmd, args, expectedOutput) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let err = '', out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('error', reject);
    proc.on('close', code => {
      const exists = fs.existsSync(expectedOutput);
      if (code !== 0 || !exists) {
        console.warn(`[runStep] ${cmd} ${args.slice(0,2).join(' ')}: code=${code}, expectedOutput=${expectedOutput}, exists=${exists}, stderr=${err.trim()||'(empty)'}, stdout=${out.trim()||'(empty)'}`);
        return reject(new Error(`${cmd} ${args[0]} produced no output (code=${code}): ${err.trim() || '(silent)'}`));
      }
      resolve();
    });
  });
}

async function ensureBuilt(folderAbs, filename) {
  if (!isImage(filename)) throw new Error('unsupported');
  const src = path.join(folderAbs, filename);
  let st;
  try { st = await fsp.stat(src); } catch { throw new Error('missing original'); }
  if (process.env.GG_DEBUG_BUILDS) {
    console.log('[build]', filename, 'size=' + st.size);
  }
  const thumbDir = path.join(folderAbs, GG_DIR);
  await fsp.mkdir(thumbDir, { recursive: true });
  await brokenTilesReady();
  const srcMtime = st.mtimeMs;
  let did = 0;
  for (const tier of LOD_TIERS) {
    const out = lodPath(thumbDir, filename, tier.h, tier.format);
    // Skip only if the LoD is at least as new as the source. A replaced
    // original (same name, newer mtime) invalidates every existing tier.
    try {
      const outSt = await fsp.stat(out);
      if (outSt.mtimeMs >= srcMtime) continue;
    } catch {}
    try {
      if (tier.format === 'v') {
        await vipsHeightThumbV(src, out, tier.h);
      } else if (tier.format === 'avif') {
        await vipsHeightThumbAVIF(src, out, tier.h, tier.quality);
      }
    } catch (e) {
      // Source can't be rendered (corrupt, libheif limit, exotic format).
      // Drop in the pre-rendered broken tile so the LoD exists and the
      // gallery shows a red-X. mtime check on the LoD prevents retry.
      const tmp = out + '.__broken.tmp';
      await fsp.copyFile(brokenTilePath(tier.h, tier.format), tmp);
      await fsp.rename(tmp, out);
      console.warn('[build:broken]', filename, 'tier h' + tier.h + ':', e.message);
    }
    did++;
  }
  return did;
}


// ---------- sprite atlas ----------
// spriteMeta is cached in RAM after first read so pageviews skip the disk JSON.
const spriteMetaCache = new Map(); // galleryAbs -> meta (or null if file is missing)

async function readSpriteMeta(galleryAbs) {
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
// ---------- atlas-dir content hash ----------
// Hash the gallery's current source state — sorted image names + their
// mtimes. The atlas content is fully determined by the originals, so if
// this hash is unchanged the existing atlas is byte-identical. (h5.v is
// derived, so we don't hash it.) ensureBuilt regenerates LoDs whenever a
// source becomes newer than its LoD, so source-mtime changes propagate
// correctly through to atlas content on rebuild.
async function computeAtlasHash(galleryAbs, images) {
  const h = crypto.createHash('sha256');
  for (const name of images) {
    const stat = await fsp.stat(path.join(galleryAbs, name)).catch(() => null);
    h.update(name + '\0' + (stat ? Math.floor(stat.mtimeMs) : 0) + '\0');
  }
  return h.digest('hex').slice(0, 16);
}

async function sweepStaleAtlases(thumbDir, keepDir) {
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
async function sweepOrphanLoDs(thumbDir, imageSet) {
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
async function sweepLegacyAtlasFiles(thumbDir) {
  let entries;
  try { entries = await fsp.readdir(thumbDir); } catch { return; }
  for (const e of entries) {
    if (e === '_sprite.json' || e === '_imagemap.bin' ||
        /^sprite(-h\d+)?-\d+\.(jpg|avif)$/.test(e)) {
      try { await fsp.unlink(path.join(thumbDir, e)); } catch {}
    }
  }
}

// ---------- atomic per-folder rebuild ----------
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

function rebuildFolderIfNeeded(galleryAbs) {
  if (rebuildInFlight.has(galleryAbs)) return rebuildInFlight.get(galleryAbs);
  const p = (async () => {
    try {
      const { folders, images } = await listFolder(galleryAbs);
      const hiddenFolders = await readHiddenSentinels(galleryAbs, folders);
      const atlasDir = images.length > 0
        ? 'atlas_' + (await computeAtlasHash(galleryAbs, images))
        : null;
      const m = await loadManifest(galleryAbs);
      // Atlas-freshness check:
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
    finally { rebuildInFlight.delete(galleryAbs); }
  })();
  rebuildInFlight.set(galleryAbs, p);
  return p;
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
      const next = _spriteWorkerChain.then(() => _runSpriteWorker(galleryAbs, images, buildingDir));
      _spriteWorkerChain = next.catch(() => {});
      await next;
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

// ---------- chunked upload ----------
// Flow: create → chunk (per-chunk SHA-256, tmp+rename per chunk) → status (for
// resume) → finalize (concat to .__tmp.<ext>, rename, kick build queue).
// Every write is tmp+rename; meta and final file are atomic; meta reloaded on
// boot so interrupted uploads resume by replaying only missing chunks. Stale
// uploads (>UPLOAD_TTL) are GC'd on startup and hourly.
const UPLOAD_DIR = path.join(STATE_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || String(16 * 1024 * 1024), 10);
const UPLOAD_TTL = 24 * 60 * 60 * 1000;

const uploads = new Map();  // in-memory mirror of on-disk upload state

function saveUploadMeta(id, info) {
  const dest = path.join(UPLOAD_DIR, id, '_meta.json');
  const tmp = dest + '.tmp';
  const persistable = { ...info, chunksReceived: Array.from(info.chunksReceived) };
  fs.writeFileSync(tmp, JSON.stringify(persistable));
  fs.renameSync(tmp, dest);
}
function loadAllUploadMeta() {
  let restored = 0;
  if (!fs.existsSync(UPLOAD_DIR)) return;
  for (const id of fs.readdirSync(UPLOAD_DIR)) {
    const metaPath = path.join(UPLOAD_DIR, id, '_meta.json');
    try {
      const obj = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      obj.chunksReceived = new Set(obj.chunksReceived);
      uploads.set(id, obj);
      restored++;
    } catch {}
  }
  if (restored) console.log(`Restored ${restored} in-progress upload(s) from disk.`);
  gcStaleUploads();
}
function gcStaleUploads() {
  const now = Date.now();
  let n = 0;
  for (const [id, info] of uploads) {
    if (now - info.createdAt > UPLOAD_TTL) {
      uploads.delete(id);
      try { fs.rmSync(path.join(UPLOAD_DIR, id), { recursive: true, force: true }); n++; } catch {}
    }
  }
  if (n) console.log(`Garbage-collected ${n} stale upload(s).`);
}
loadAllUploadMeta();
setInterval(gcStaleUploads, 60 * 60 * 1000);

async function handleUploadAPI(req, res, pathname, method) {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin only' });

  if (method === 'POST' && pathname === '/api/upload/create') {
    if ((req.headers['content-type']||'').split(';')[0].trim() !== 'application/json') return sendJson(res, 415, { error: 'expected application/json' });
    let body;
    try { body = JSON.parse(await readBody(req, 1024 * 1024)); } catch { return badRequest(res); }
    const { filename, size, targetFolder } = body;
    if (!filename || typeof filename !== 'string' || filename.length > 255) return sendJson(res, 400, { error: 'invalid filename' });
    const baseName = path.basename(filename);
    if (baseName.startsWith('.') || RESERVED.has(baseName) || isOrphanTmp(baseName)) return sendJson(res, 400, { error: 'invalid filename' });
    if (!isImage(baseName)) return sendJson(res, 400, { error: 'unsupported file type' });
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) return sendJson(res, 400, { error: 'invalid size' });
    const totalChunks = Math.ceil(size / CHUNK_SIZE) || 1;

    const tfSegs = (typeof targetFolder === 'string' ? targetFolder : '/').split('/').filter(Boolean);
    const targetAbs = resolveGallery(tfSegs);
    if (!targetAbs) return sendJson(res, 400, { error: 'invalid targetFolder' });
    let st;
    try { st = fs.statSync(targetAbs); } catch { return sendJson(res, 400, { error: 'targetFolder does not exist' }); }
    if (!st.isDirectory()) return sendJson(res, 400, { error: 'targetFolder is not a folder' });

    const destPath = path.join(targetAbs, baseName);
    if (fs.existsSync(destPath)) return sendJson(res, 409, { error: 'a file with that name already exists in the target folder' });

    const id = crypto.randomBytes(16).toString('hex');
    fs.mkdirSync(path.join(UPLOAD_DIR, id));
    const info = {
      id,
      filename: baseName,
      targetFolderRel: '/' + tfSegs.join('/') + (tfSegs.length ? '/' : ''),
      size,
      totalChunks,
      chunksReceived: new Set(),
      chunkHashes: new Array(totalChunks).fill(null),
      createdAt: Date.now(),
    };
    uploads.set(id, info);
    saveUploadMeta(id, info);
    return sendJson(res, 200, { id, chunkSize: CHUNK_SIZE, totalChunks });
  }

  // POST /api/upload/chunk/:id/:idx
  const cm = pathname.match(/^\/api\/upload\/chunk\/([a-f0-9]+)\/(\d+)$/);
  if (method === 'POST' && cm) {
    const id = cm[1], idx = parseInt(cm[2], 10);
    const info = uploads.get(id);
    if (!info) return sendJson(res, 404, { error: 'unknown upload' });
    if (idx < 0 || idx >= info.totalChunks) return sendJson(res, 400, { error: 'bad index' });
    const expectedHash = req.headers['x-chunk-hash'];

    const chunks = [];
    const hash = crypto.createHash('sha256');
    let totalLen = 0, aborted = false;
    req.on('data', c => {
      if (aborted) return;
      totalLen += c.length;
      if (totalLen > CHUNK_SIZE + 4096) { aborted = true; req.destroy(); sendJson(res, 400, { error: 'chunk too large' }); return; }
      chunks.push(c);
      hash.update(c);
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        const data = Buffer.concat(chunks);
        const computed = hash.digest('hex');
        if (expectedHash && computed !== expectedHash) return sendJson(res, 400, { error: 'hash mismatch' });
        const isLast = idx === info.totalChunks - 1;
        const expectedSize = isLast ? (info.size - CHUNK_SIZE * (info.totalChunks - 1)) : CHUNK_SIZE;
        if (data.length !== expectedSize) return sendJson(res, 400, { error: 'wrong chunk size: got ' + data.length + ', expected ' + expectedSize });

        const chunkPath = path.join(UPLOAD_DIR, id, `chunk_${idx}`);
        const tmpPath = chunkPath + '.__tmp';
        fs.writeFileSync(tmpPath, data);
        fs.renameSync(tmpPath, chunkPath);
        info.chunksReceived.add(idx);
        info.chunkHashes[idx] = computed;
        saveUploadMeta(id, info);
        sendJson(res, 200, { received: info.chunksReceived.size, total: info.totalChunks });
      } catch (e) {
        sendJson(res, 500, { error: 'write failed: ' + e.message });
      }
    });
    req.on('error', () => { if (!aborted) try { sendJson(res, 500, { error: 'req error' }); } catch {} });
    return;
  }

  // GET /api/upload/status/:id  — for resume: lists which chunks are present
  const stm = pathname.match(/^\/api\/upload\/status\/([a-f0-9]+)$/);
  if (method === 'GET' && stm) {
    const info = uploads.get(stm[1]);
    if (!info) return sendJson(res, 404, { error: 'unknown' });
    return sendJson(res, 200, {
      id: info.id,
      filename: info.filename,
      size: info.size,
      totalChunks: info.totalChunks,
      chunksReceived: Array.from(info.chunksReceived).sort((a, b) => a - b),
    });
  }

  // POST /api/upload/finalize/:id  — assemble and commit
  const fm = pathname.match(/^\/api\/upload\/finalize\/([a-f0-9]+)$/);
  if (method === 'POST' && fm) {
    const id = fm[1];
    const info = uploads.get(id);
    if (!info) return sendJson(res, 404, { error: 'unknown upload' });
    if (info.chunksReceived.size !== info.totalChunks) {
      return sendJson(res, 400, { error: 'not all chunks received', missing: info.totalChunks - info.chunksReceived.size });
    }
    const tfSegs = info.targetFolderRel.split('/').filter(Boolean);
    const targetAbs = resolveGallery(tfSegs);
    if (!targetAbs) return sendJson(res, 400, { error: 'targetFolder no longer valid' });
    const destPath = path.join(targetAbs, info.filename);
    if (fs.existsSync(destPath)) return sendJson(res, 409, { error: 'destination already exists' });
    const tmpDest = destPath + '.__tmp' + path.extname(destPath);

    try {
      const ws = fs.createWriteStream(tmpDest);
      for (let i = 0; i < info.totalChunks; i++) {
        const cp = path.join(UPLOAD_DIR, id, `chunk_${i}`);
        const buf = fs.readFileSync(cp);
        await new Promise((resolve, reject) => ws.write(buf, err => err ? reject(err) : resolve()));
      }
      await new Promise(resolve => ws.end(resolve));
      await fsp.rename(tmpDest, destPath);
    } catch (e) {
      try { await fsp.unlink(tmpDest); } catch {}
      return sendJson(res, 500, { error: 'assemble failed: ' + e.message });
    }

    try { await fsp.rm(path.join(UPLOAD_DIR, id), { recursive: true, force: true }); } catch {}
    uploads.delete(id);

    // Trigger a folder rebuild — when it completes, the manifest will
    // include the new image and the page will render normally.
    rebuildFolderIfNeeded(targetAbs).catch(()=>{});

    return sendJson(res, 200, { ok: true, path: info.targetFolderRel + info.filename });
  }

  // DELETE /api/upload/:id  — cancel
  const dm = pathname.match(/^\/api\/upload\/([a-f0-9]+)$/);
  if (method === 'DELETE' && dm) {
    const id = dm[1];
    if (!uploads.has(id)) return sendJson(res, 404, { error: 'unknown' });
    uploads.delete(id);
    try { fs.rmSync(path.join(UPLOAD_DIR, id), { recursive: true, force: true }); } catch {}
    return sendJson(res, 200, { ok: true });
  }

  return notFound(res);
}

// ---------- auth: passkey state ----------
function getPasskey() {
  try { return JSON.parse(fs.readFileSync(PASSKEY_FILE, 'utf8')); }
  catch { return null; }
}
function savePasskey(pk) {
  fs.writeFileSync(PASSKEY_FILE + '.tmp', JSON.stringify(pk, null, 2));
  fs.renameSync(PASSKEY_FILE + '.tmp', PASSKEY_FILE);
}

// HttpOnly session cookie: sent automatically, not readable by JS.
const SESSION_COOKIE = 'ggSession';
function setSessionCookie(req, res, token) {
  const isSecure = req.headers['x-forwarded-proto'] === 'https' || (req.connection && req.connection.encrypted);
  const flags = ['HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${Math.floor(SESSION_DURATION/1000)}`];
  if (isSecure) flags.push('Secure');
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; ${flags.join('; ')}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function newSession(origin) {
  if (origin !== 'passkey' && origin !== 'link') {
    throw new Error('newSession: origin must be "passkey" or "link"');
  }
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { createdAt: Date.now(), origin: origin });
  saveSessions();
  return token;
}
// Returns 'passkey' | 'link' | null. Used by endpoints that need to make
// origin-aware decisions (e.g. only passkey sessions can mint login links).
function sessionOriginFor(req) {
  const cookies = parseCookies(req.headers.cookie);
  const tok = cookies[SESSION_COOKIE];
  if (!tok) return null;
  const s = sessions.get(tok);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_DURATION) return null;
  return s.origin || 'passkey';
}
function isAdmin(req) {
  const cookies = parseCookies(req.headers.cookie);
  const tok = cookies[SESSION_COOKIE];
  if (!tok) return false;
  const s = sessions.get(tok);
  if (!s) return false;
  if (Date.now() - s.createdAt > SESSION_DURATION) { sessions.delete(tok); saveSessions(); return false; }
  return true;
}

// ---------- WebAuthn primitives ----------
function b64uToBuf(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64 + '='.repeat((4 - b64.length % 4) % 4);
  return Buffer.from(pad, 'base64');
}
function bufToB64u(b) { return Buffer.from(b).toString('base64url'); }

function parseAuthenticatorData(authData) {
  const rpIdHash = authData.slice(0, 32);
  const flags = authData[32];
  const signCount = authData.readUInt32BE(33);
  const result = { rpIdHash, flags, signCount };
  if (flags & 0x40) {
    const aaguid = authData.slice(37, 53);
    const credIdLen = authData.readUInt16BE(53);
    const credentialId = authData.slice(55, 55 + credIdLen);
    const publicKeyBytes = authData.slice(55 + credIdLen);
    result.aaguid = aaguid;
    result.credentialId = credentialId;
    result.publicKeyBytes = publicKeyBytes;
  }
  return result;
}
function decodeCBOR(buffer) {
  let offset = 0;
  function read() {
    const first = buffer[offset++];
    const major = first >> 5;
    const additional = first & 0x1f;
    let value;
    if (additional < 24) value = additional;
    else if (additional === 24) value = buffer[offset++];
    else if (additional === 25) { value = buffer.readUInt16BE(offset); offset += 2; }
    else if (additional === 26) { value = buffer.readUInt32BE(offset); offset += 4; }
    else if (additional === 27) { value = Number(buffer.readBigUInt64BE(offset)); offset += 8; }
    else throw new Error('bad CBOR additional ' + additional);
    switch (major) {
      case 0: return value;
      case 1: return -1 - value;
      case 2: { const b = buffer.slice(offset, offset + value); offset += value; return b; }
      case 3: { const t = buffer.slice(offset, offset + value).toString('utf8'); offset += value; return t; }
      case 4: { const a = []; for (let i = 0; i < value; i++) a.push(read()); return a; }
      case 5: { const m = {}; for (let i = 0; i < value; i++) { const k = read(); m[k] = read(); } return m; }
      default: throw new Error('bad CBOR major ' + major);
    }
  }
  return read();
}
function coseToPublicKey(coseKey) {
  const kty = coseKey[1], alg = coseKey[3];
  if (kty === 2 && alg === -7) {
    const x = coseKey[-2], y = coseKey[-3];
    return { algorithm: 'ES256', publicKey: Buffer.concat([Buffer.from([0x04]), x, y]) };
  }
  throw new Error(`Unsupported COSE key kty=${kty} alg=${alg}`);
}
function verifyES256Signature(publicKeyUncompressed, signature, data) {
  const header = Buffer.from([
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00
  ]);
  const derKey = Buffer.concat([header, publicKeyUncompressed]);
  const pem = '-----BEGIN PUBLIC KEY-----\n' +
              derKey.toString('base64').match(/.{1,64}/g).join('\n') +
              '\n-----END PUBLIC KEY-----';
  const verify = crypto.createVerify('SHA256');
  verify.update(data);
  verify.end();
  return verify.verify(pem, signature);
}

// ---------- gallery HTML render ----------
function galleryHTML({ urlPath, folders, hiddenFolders, images, spriteMeta, isAdminFlag, hasPasskey }) {
  // urlPath has leading and trailing /, e.g. "/" or "/vacation/2024/".
  const breadcrumbs = (() => {
    const parts = urlPath.split('/').filter(Boolean);
    let acc = '/';
    const out = [`<a href="/">${hxEscape(SITE_TITLE)}</a>`];
    for (const p of parts) {
      acc += encodeURIComponent(p) + '/';
      out.push(`<a href="${hxEscape(acc)}">${hxEscape(p)}</a>`);
    }
    return out.join('');
  })();

  // Hidden folders: filtered out for anon, tagged for admin.
  const hiddenSet = new Set(hiddenFolders || []);
  const visibleFolders = isAdminFlag ? folders : folders.filter(n => !hiddenSet.has(n));
  const folderCards = visibleFolders.map(name => {
    const href = encodeURIComponent(name) + '/';
    const isHidden = hiddenSet.has(name);
    const cls = isHidden ? 'folder folder-hidden' : 'folder';
    const tag = isHidden ? '<span class="folder-hidden-tag">(hidden)</span>' : '';
    return `<a class="${cls}" href="${hxEscape(href)}"><span class="folder-icon">📁</span><span class="folder-name">${hxEscape(name)}</span>${tag}</a>`;
  }).join('');

  const lastImageValue = images.length;
  // New layout: atlas_<hash>/_imagemap.bin. Legacy (no atlasDir): flat gg/_imagemap.bin.
  const _atlasSub = (spriteMeta && spriteMeta._atlasDir) ? (spriteMeta._atlasDir + '/') : '';
  const imagemapURL = spriteMeta ? jsString(urlPath + GG_DIR + '/' + _atlasSub + '_imagemap.bin') : 'null';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
<title>${hxEscape(SITE_TITLE)} — ${hxEscape(urlPath)}</title>
<link rel="stylesheet" href="/_static/goodgallery.css?v=${_assetVer('goodgallery.css')}" />
<link rel="icon" type="image/svg+xml" href="/_static/favicon.svg" />
</head>
<body>

<div id="topcontrols">
<header id="topbar">
  <nav id="breadcrumb">${breadcrumbs}</nav>
  <a id="adminlink" href="/_admin/" title="Admin">⚙</a>
</header>

<div id="adminnotify"></div>

${visibleFolders.length ? `<details id="foldersWrap"${images.length ? '' : ' open'}><summary>folders (${visibleFolders.length})</summary><nav id="folders">${folderCards}</nav></details>` : ''}

<div id="prevnext">
  <div id="zoomControl" class="zoom-control"></div>
</div>

<div id="counter"></div>
<div id="realtime"></div>
</div>
<div id="topreveal" aria-label="Show controls"></div>
<div id="thumbs"></div>

<script>
var images           = [null];
var lastimagevalue   = ${lastImageValue};
var isadmin          = ${isAdminFlag ? 1 : 0};
var hasPasskey       = ${hasPasskey ? 'true' : 'false'};
var folderURL        = ${jsString(urlPath)};
var spriteMeta       = ${spriteMeta ? JSON.stringify(spriteMeta) : 'null'};
var imagemapURL      = ${imagemapURL};
</script>
<script src="/_static/gallery.js?v=${_assetVer('gallery.js')}"></script>

</body>
</html>`;
}

// ---------- request handler ----------
async function handle(req, res) {
  const method = req.method;
  let u, pathname;
  try {
    u = new URL(req.url, `http://${req.headers.host}`);
    pathname = decodeURIComponent(u.pathname);
  } catch {
    return badRequest(res, 'malformed URL');
  }

  if (pathname.startsWith('/_static/')) {
    return serveStatic(req, res, pathname.slice('/_static/'.length));
  }
  if (pathname === '/favicon.ico' || pathname === '/favicon.svg') {
    return serveStaticFile(req, res, path.join(PUBLIC_DIR, 'favicon.svg'));
  }
  if (pathname === '/_admin' || pathname === '/_admin/') {
    return serveStaticFile(req, res, path.join(PUBLIC_DIR, 'admin.html'));
  }

  if (pathname.startsWith('/api/admin/')) return handleAdminAPI(req, res, pathname, method);
  if (pathname.startsWith('/api/upload/')) return handleUploadAPI(req, res, pathname, method);
  if (pathname.startsWith('/api/trash')) return handleTrashAPI(req, res, pathname, method, u);

  // Gallery view: any other path is a folder under GALLERIES_ROOT, must end with /.
  const segs = pathname.split('/').filter(Boolean);
  const abs = resolveGallery(segs, { allowReserved: true });
  if (abs === null) return notFound(res, 'invalid path');

  // File or dir-needs-redirect under a gallery folder.
  if (!pathname.endsWith('/')) {
    const fileName  = segs[segs.length - 1];
    const dirOfFile = segs[segs.length - 2];
    const grandparent = segs.slice(0, -2);

    // gg/_imagemap.bin and gg/sprite-h<H>-<N>.{jpg,avif} (legacy flat layout)
    if (dirOfFile === GG_DIR && fileName === '_imagemap.bin') {
      const galleryAbs = resolveGallery(grandparent);
      if (!galleryAbs) return notFound(res);
      return serveStaticFile(req, res, path.join(galleryAbs, GG_DIR, fileName));
    }
    if (dirOfFile === GG_DIR && /^sprite(?:-h\d+)?-\d+\.(jpg|avif)$/.test(fileName)) {
      const galleryAbs = resolveGallery(grandparent);
      if (!galleryAbs) return notFound(res);
      return serveStaticFile(req, res, path.join(galleryAbs, GG_DIR, fileName));
    }
    // gg/atlas_<hash>/_imagemap.bin and gg/atlas_<hash>/sprite-h<H>-<N>.{jpg,avif}
    if (/^atlas_[a-f0-9]+$/.test(dirOfFile) && segs.length >= 3 && segs[segs.length - 3] === GG_DIR &&
        (fileName === '_imagemap.bin' || /^sprite(?:-h\d+)?-\d+\.(jpg|avif)$/.test(fileName))) {
      const galleryAbs = resolveGallery(segs.slice(0, -3));
      if (!galleryAbs) return notFound(res);
      return serveStaticFile(req, res, path.join(galleryAbs, GG_DIR, dirOfFile, fileName));
    }
    if (dirOfFile === GG_DIR && /\.h\d+\.avif$/.test(fileName)) {
      const galleryAbs = resolveGallery(grandparent);
      if (!galleryAbs) return notFound(res);
      // Unbuildable sources had their broken tile copied to the LoD path
      // by ensureBuilt — just serve whatever's there.
      return serveStaticFile(req, res, path.join(galleryAbs, GG_DIR, fileName));
    }

    // Anything else: parent must be a real, non-reserved gallery folder.
    const parentAbs = resolveGallery(segs.slice(0, -1));
    if (parentAbs === null) return notFound(res);

    if (isImage(fileName)) {
      // Direct-URL requests get the actual file bytes (even if vips can't parse
      // it — the original is what the URL names). Tier requests substitute the
      // placeholder above; that's what the gallery uses for rendering.
      return serveStaticFile(req, res, path.join(parentAbs, fileName));
    }

    try {
      const st = fs.statSync(abs);
      if (st.isDirectory()) { res.writeHead(301, { Location: pathname + '/' }); return res.end(); }
    } catch {}
    return notFound(res);
  }

  if (segs.some(s => RESERVED.has(s))) return notFound(res, 'reserved');
  let st;
  try { st = fs.statSync(abs); } catch { return notFound(res, 'no such gallery'); }
  if (!st.isDirectory()) return notFound(res, 'not a folder');

  const q = u.searchParams;
  if (q.has('clearcache'))  return adminAction(req, res, () => clearcache(abs));
  if (q.has('deletefolder')) return adminAction(req, res, () => deleteFolderToTrash(abs));
  if (q.has('movetotrash')) return adminAction(req, res, () => movetotrash(abs, q.get('movetotrash')));
  if (q.has('build-status')) {
    // Global rolling counters. spriteUpToDate is per-folder and answers
    // "does this folder have a committed manifest yet?" — the reload-after-
    // upload poller waits for it. Never displayed.
    const status = buildQueue.globalProgress();
    status.spriteUpToDate = fs.existsSync(manifestPathFor(abs));
    return sendJson(res, 200, status);
  }
  if (q.get('api') === 'list') {
    const { folders, images } = await listFolder(abs);
    if (isAdmin(req)) {
      const ml = await loadManifest(abs).catch(() => ({}));
      const hiddenFolders = Array.isArray(ml.hiddenFolders) ? ml.hiddenFolders : [];
      return sendJson(res, 200, { folders, images, hiddenFolders });
    }
    // Anon: filter hidden folders out — names are sensitive (URL == name).
    const ml = await loadManifest(abs).catch(() => ({}));
    const hidden = new Set(Array.isArray(ml.hiddenFolders) ? ml.hiddenFolders : []);
    const visibleFolders = folders.filter(n => !hidden.has(n));
    return sendJson(res, 200, { folders: visibleFolders, images });
  }
  if (q.has('mkdir') && method === 'POST') {
    if (!isAdmin(req)) return sendText(res, 403, 'admin only');
    const name = q.get('mkdir').trim();
    if (!name || /[\/\\\x00]/.test(name) || name.startsWith('.') || RESERVED.has(name))
      return badRequest(res, 'invalid name');
    let made = true;
    try { await fsp.mkdir(path.join(abs, name), { recursive: false }); }
    catch { made = false; }
    if (made) rebuildFolderIfNeeded(abs).catch(()=>{});
    return sendJson(res, 200, { ok: true });
  }
  if (q.has('sethidden') && method === 'POST') {
    if (!isAdmin(req)) return sendText(res, 403, 'admin only');
    const name = q.get('sethidden').trim();
    if (!name || /[\/\\\x00]/.test(name) || name.startsWith('.') || RESERVED.has(name))
      return badRequest(res, 'invalid name');
    // Disk check covers folders added via rsync/scp before any manifest update.
    let st;
    try { st = fs.statSync(path.join(abs, name)); } catch { return badRequest(res, 'no such subfolder'); }
    if (!st.isDirectory()) return badRequest(res, 'not a folder');
    const hide = q.get('hide') !== '0';
    await toggleHiddenSentinel(path.join(abs, name), hide);
    rebuildFolderIfNeeded(abs).catch(()=>{});
    return sendJson(res, 200, { ok: true, name, hidden: hide });
  }

  // Cold path: no manifest yet (first visit or post-mutation). Kick a
  // rebuild and render a placeholder gallery (folders+images from disk,
  // spriteMeta=null → client shows "Building…" banner and polls).
  let m = await loadManifest(abs);
  let folders, images, hiddenFolders, spriteMeta;
  if (m) {
    folders = m.folders;
    images = m.images;
    hiddenFolders = Array.isArray(m.hiddenFolders) ? m.hiddenFolders : [];
    spriteMeta = await readSpriteMeta(abs);
  } else {
    rebuildFolderIfNeeded(abs).catch(()=>{});
    const live = await listFolder(abs);
    folders = live.folders;
    images = live.images;
    hiddenFolders = await readHiddenSentinels(abs, folders);
    spriteMeta = null;
  }
  const html = galleryHTML({
    urlPath: pathname,
    folders,
    hiddenFolders,
    images,
    spriteMeta,
    isAdminFlag: isAdmin(req),
    hasPasskey: !!getPasskey(),
  });
  // Pageviews are dynamic (admin state, gallery contents). No-cache so the
  // browser revalidates; Cloudflare won't edge-cache HTML by default
  // anyway, but be explicit so a future cache-everything rule doesn't
  // surprise us.
  res.setHeader('Cache-Control', 'no-cache');
  return sendText(res, 200, html, 'text/html; charset=utf-8');
}

// ---------- admin actions on a folder ----------
async function adminAction(req, res, fn) {
  if (req.method !== 'POST') return sendText(res, 405, 'POST required');
  if (!isAdmin(req)) return sendText(res, 403, 'admin only');
  try { const out = await fn(); sendText(res, 200, out == null ? 'ok' : String(out)); }
  catch (e) { sendText(res, 500, 'error: ' + e.message); }
}
// Drop every derived artifact in <folder>/gg/ so the next visit rebuilds
// from scratch. trash/ and the hidden sentinel are durable state that
// happens to live in gg/, not cache — leave them alone.
async function clearcache(folderAbs) {
  const thumbDir = path.join(folderAbs, GG_DIR);
  let entries;
  try { entries = await fsp.readdir(thumbDir, { withFileTypes: true }); }
  catch { return 'nothing to clear'; }
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
  rebuildFolderIfNeeded(folderAbs).catch(() => {});
  return `cache cleared (${removed} entries removed); rebuilding`;
}
// Per-folder trash: <folder>/gg/trash/<filename>. LoDs at <folder>/gg/*.h*.avif
// stay where they are — restore is just renaming the image back. Trash-side
// name collisions get a .trashed-<stamp> suffix so trashing always succeeds.
async function movetotrash(folderAbs, filename) {
  if (!filename || !isImage(filename)) throw new Error('bad filename');
  const src = path.join(folderAbs, filename);
  const tdir = trashDirFor(folderAbs);
  await fsp.mkdir(tdir, { recursive: true });
  let dst = path.join(tdir, filename);
  let renamed = false;
  if (fs.existsSync(dst)) {
    const ext = path.extname(filename);
    const base = ext && filename.endsWith(ext) ? filename.slice(0, -ext.length) : filename;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    dst = path.join(tdir, `${base}.trashed-${stamp}${ext}`);
    renamed = true;
  }
  await fsp.rename(src, dst);
  rebuildFolderIfNeeded(folderAbs).catch(()=>{});
  return renamed
    ? `${filename} moved to trash (renamed to avoid collision)`
    : `${filename} moved to trash`;
}

// Restore from <folder>/gg/trash/<name> back to <folder>/<name>. Handles
// both single images and whole folders. Refuses on destination collision.
async function restoreFromTrash(folderAbs, name) {
  if (!isValidTrashName(name)) throw new Error('invalid trash item name');
  const src = path.join(trashDirFor(folderAbs), name);
  let st;
  try { st = await fsp.stat(src); } catch { throw new Error('not in trash'); }
  const dst = path.join(folderAbs, name);
  if (fs.existsSync(dst)) throw new Error(`'${name}' already exists; rename or remove it first, then retry`);
  await fsp.rename(src, dst);
  try { await fsp.rmdir(trashDirFor(folderAbs)); } catch {}
  rebuildFolderIfNeeded(folderAbs).catch(()=>{});
  return `restored ${name}`;
}

// Single-rename folder trash. The folder's gg/ travels with it so all
// derived state (manifests, LoDs, sprite) is preserved for restore. Refuses
// the gallery root.
async function deleteFolderToTrash(folderAbs) {
  if (folderAbs === GALLERIES_ROOT) throw new Error('cannot delete the gallery root');
  if (!folderAbs.startsWith(GALLERIES_ROOT + path.sep)) {
    throw new Error('refusing: not under galleries root');
  }
  const parentAbs = path.dirname(folderAbs);
  const name = path.basename(folderAbs);
  const tdir = trashDirFor(parentAbs);
  await fsp.mkdir(tdir, { recursive: true });
  let dst = path.join(tdir, name);
  let renamed = false;
  if (fs.existsSync(dst)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    dst = path.join(tdir, `${name}.trashed-${stamp}`);
    renamed = true;
  }
  await fsp.rename(folderAbs, dst);
  manifestCache.delete(folderAbs);
  for (const k of Array.from(manifestCache.keys())) {
    if (k.startsWith(folderAbs + path.sep)) manifestCache.delete(k);
  }
  rebuildFolderIfNeeded(parentAbs).catch(()=>{});
  return renamed
    ? `${name} moved to trash (renamed to avoid collision)`
    : `${name} moved to trash`;
}

// Permanent delete. For trashed images, also drop the LoDs that
// movetotrash left behind in the source folder's gg/. Folder-trashed
// items carry their own gg/ inside so no extra LoD cleanup needed.
async function deleteFromTrash(folderAbs, name) {
  if (!isValidTrashName(name)) throw new Error('invalid trash item name');
  const src = path.join(trashDirFor(folderAbs), name);
  let st;
  try { st = await fsp.stat(src); } catch { throw new Error('not in trash'); }
  if (st.isDirectory()) {
    await fsp.rm(src, { recursive: true, force: true });
  } else {
    await fsp.unlink(src);
    if (isImage(name)) {
      const orig = name.replace(/\.trashed-[\d\-TZ]+(\.[^.]+)?$/, (m, ext) => ext || '');
      const thumbDirAbs = path.join(folderAbs, GG_DIR);
      for (const tier of LOD_TIERS) {
        try { await fsp.unlink(lodPath(thumbDirAbs, orig, tier.h, tier.format)); } catch {}
      }
      try { await fsp.unlink(path.join(thumbDirAbs, orig + '.resized.v')); } catch {}
    }
  }
  try { await fsp.rmdir(trashDirFor(folderAbs)); } catch {}
  return `deleted ${name}`;
}

async function restoreAllInFolder(folderAbs) {
  const items = await listFolderTrash(folderAbs);
  let ok = 0, fail = 0;
  const errs = [];
  for (const it of items) {
    try { await restoreFromTrash(folderAbs, it.name); ok++; }
    catch (e) { fail++; errs.push(`${it.name}: ${e.message}`); }
  }
  let msg = `restored ${ok}`;
  if (fail) {
    msg += ` (${fail} failed`;
    if (errs.length) msg += '; ' + errs.slice(0, 3).join('; ');
    if (errs.length > 3) msg += '; ...';
    msg += ')';
  }
  return msg;
}

// Atomic park-then-background-rm. Renames <folder>/gg/trash to a hidden
// sibling, then rm -rf in the background. User-facing latency is one rename
// regardless of how much is in the trash. Lazy GC in listFolderTrash sweeps
// any parked entries left by a prior crash.
async function emptyFolderTrash(folderAbs) {
  const tdir = trashDirFor(folderAbs);
  if (!fs.existsSync(tdir)) return 'trash already empty';
  const parked = path.join(folderAbs, GG_DIR, '.trash-emptying-' + Date.now());
  try { await fsp.rename(tdir, parked); }
  catch (e) {
    if (e.code === 'ENOENT') return 'trash already empty';
    throw e;
  }
  (async () => {
    try { await fsp.rm(parked, { recursive: true, force: true }); }
    catch (e) { console.warn('[trash:empty:rm]', parked, e.message); }
  })();
  return 'trash emptied (background cleanup in progress)';
}

// One-time startup cleanup of the legacy global trash dir, if empty. Hands
// back a clean state dir without surprising the operator with mystery
// directories. Non-empty legacy dirs are left alone.
(async () => {
  const legacy = path.join(STATE_DIR, 'trash');
  try {
    const entries = await fsp.readdir(legacy);
    if (entries.length === 0) await fsp.rmdir(legacy);
  } catch {}
})();

// ---------- admin auth API ----------
async function handleTrashAPI(req, res, pathname, method, u) {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin only' });
  function resolveFolderFromString(rel) {
    const segs = typeof rel === 'string' ? rel.split('/').filter(Boolean) : [];
    return resolveGallery(segs);
  }
  if (method === 'GET' && pathname === '/api/trash') {
    const folderAbs = resolveFolderFromString(u && u.searchParams.get('folder'));
    if (!folderAbs) return sendJson(res, 400, { error: 'invalid folder' });
    return sendJson(res, 200, { items: await listFolderTrash(folderAbs) });
  }
  if (method === 'POST') {
    if ((req.headers['content-type']||'').split(';')[0].trim() !== 'application/json') {
      return sendJson(res, 415, { error: 'expected application/json' });
    }
    let body; try { body = JSON.parse(await readBody(req, 64 * 1024)); } catch { return badRequest(res); }
    const folderAbs = resolveFolderFromString(body && body.folder);
    if (!folderAbs) return sendJson(res, 400, { error: 'invalid folder' });
    if (pathname === '/api/trash/restore') {
      try { return sendJson(res, 200, { ok: true, message: await restoreFromTrash(folderAbs, body.name) }); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (pathname === '/api/trash/delete') {
      try { return sendJson(res, 200, { ok: true, message: await deleteFromTrash(folderAbs, body.name) }); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (pathname === '/api/trash/restoreAll') {
      try { return sendJson(res, 200, { ok: true, message: await restoreAllInFolder(folderAbs) }); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (pathname === '/api/trash/empty') {
      try { return sendJson(res, 200, { ok: true, message: await emptyFolderTrash(folderAbs) }); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
  }
  return notFound(res);
}

async function handleAdminAPI(req, res, pathname, method) {
  if (method === 'POST' && pathname === '/api/admin/logout') {
    const cookies = parseCookies(req.headers.cookie);
    const tok = cookies[SESSION_COOKIE];
    if (tok && sessions.delete(tok)) saveSessions();
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }
  if (method === 'GET' && pathname === '/api/admin/probe') {
    const admin = isAdmin(req);
    return sendJson(res, admin ? 200 : 401, { admin: admin, origin: admin ? sessionOriginFor(req) : null });
  }
  if (method === 'GET' && pathname === '/api/admin/status') {
    return sendJson(res, 200, { passkeyExists: !!getPasskey() });
  }
  if (method === 'POST' && pathname === '/api/admin/clearqueue') {
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin only' });
    const n = buildQueue.clear();
    console.log('[clearqueue] dropped=' + n + ' (workers still draining in-flight tiles)');
    return sendJson(res, 200, { ok: true, dropped: n });
  }
  if (method === 'POST' && pathname === '/api/admin/fullrescan') {
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin only' });
    if (fullrescanInProgress) return sendJson(res, 409, { error: 'a full rescan is already running' });
    fullrescanInProgress = true;
    // Fire-and-forget. walkRebuild dispatches a rebuildFolderIfNeeded per
    // folder; the client polls ?build-status to track progress.
    (async () => {
      try {
        // Walk the gallery tree. For each folder with content, dispatch a
        // rebuildFolderIfNeeded (fire-and-forget). The drift check is cheap
        // for already-current folders; actual rebuilds run in the background.
        let rebuilt = 0;
        async function walkRebuild(dir) {
          let entries;
          try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
          let hasContent = false;
          const subs = [];
          for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            if (e.isDirectory()) {
              if (!RESERVED.has(e.name)) { subs.push(e.name); hasContent = true; }
            } else if (e.isFile() && isImage(e.name)) hasContent = true;
          }
          if (hasContent) {
            // Fire-and-forget per folder. rebuildFolderIfNeeded handles dedup
            // and per-folder atomicity internally; the walk just dispatches.
            rebuildFolderIfNeeded(dir).catch(e => console.warn('[fullrescan:rebuild]', dir, e.message));
            rebuilt++;
          }
          for (const sub of subs) await walkRebuild(path.join(dir, sub));
        }
        rebuildFolderIfNeeded(GALLERIES_ROOT).catch(()=>{}); rebuilt++;
        await walkRebuild(GALLERIES_ROOT);
        console.log('[fullrescan] folders=' + rebuilt);
      } catch (e) { console.warn('[fullrescan]', e.message); }
      finally { fullrescanInProgress = false; }
    })();
    return sendJson(res, 200, { ok: true, started: true });
  }
  if (method === 'POST' && pathname === '/api/admin/register/start') {
    if (getPasskey()) return sendJson(res, 400, { error: 'passkey already registered' });
    const challenge = crypto.randomBytes(32);
    const challengeId = crypto.randomBytes(16).toString('base64url');
    pendingChallenges.set(challengeId, { challenge, timestamp: Date.now() });
    res.setHeader('Set-Cookie', `webauthn_challenge=${challengeId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=300`);
    return sendJson(res, 200, {
      challenge: bufToB64u(challenge),
      rp: { name: RP_NAME },
      user: { id: bufToB64u(crypto.randomBytes(16)), name: 'admin', displayName: 'Goodgallery Admin' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      timeout: 60000,
      attestation: 'none'
    });
  }
  if (method === 'POST' && pathname === '/api/admin/register/finish') {
    if (getPasskey()) return sendJson(res, 400, { error: 'passkey already registered' });
    if ((req.headers['content-type']||'').split(';')[0].trim() !== 'application/json') return sendJson(res, 415, { error: 'expected application/json' });
    let body;
    try { body = JSON.parse(await readBody(req, 1024 * 1024)); } catch { return badRequest(res); }
    const cookies = parseCookies(req.headers.cookie);
    const ch = pendingChallenges.get(cookies['webauthn_challenge']);
    if (!ch) return sendJson(res, 400, { error: 'challenge expired' });
    pendingChallenges.delete(cookies['webauthn_challenge']);

    const attestationBuffer = b64uToBuf(body.response.attestationObject);
    const attestation = decodeCBOR(attestationBuffer);
    const authData = parseAuthenticatorData(attestation.authData);
    const clientData = JSON.parse(b64uToBuf(body.response.clientDataJSON).toString('utf8'));
    if (clientData.type !== 'webauthn.create') return sendJson(res, 400, { error: 'bad clientData type' });
    const expectedChallenge = bufToB64u(ch.challenge);
    if (clientData.challenge !== expectedChallenge) return sendJson(res, 400, { error: 'challenge mismatch' });
    // clientData.origin is authenticator-signed; must match the Origin header.
    const reqOrigin = req.headers.origin;
    if (reqOrigin && clientData.origin !== reqOrigin) {
      console.warn('[webauthn] register origin mismatch:', clientData.origin, 'vs', reqOrigin);
      return sendJson(res, 400, { error: 'origin mismatch' });
    }
    if (!reqOrigin) console.warn('[webauthn] register: no Origin header on request, skipping origin check');

    const coseKey = decodeCBOR(authData.publicKeyBytes);
    const { algorithm, publicKey } = coseToPublicKey(coseKey);

    savePasskey({
      credentialId: bufToB64u(authData.credentialId),
      publicKey: bufToB64u(publicKey),
      algorithm,
      signCount: authData.signCount,
      origin: clientData.origin,
      createdAt: Date.now(),
    });
    const token = newSession("passkey");
    setSessionCookie(req, res, token);
    console.log('Admin passkey registered. Origin:', clientData.origin);
    return sendJson(res, 200, { success: true });
  }
  if (method === 'POST' && pathname === '/api/admin/login/start') {
    const pk = getPasskey();
    if (!pk) return sendJson(res, 400, { error: 'no passkey registered' });
    const challenge = crypto.randomBytes(32);
    const challengeId = crypto.randomBytes(16).toString('base64url');
    pendingChallenges.set(challengeId, { challenge, timestamp: Date.now() });
    res.setHeader('Set-Cookie', `webauthn_challenge=${challengeId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=300`);
    return sendJson(res, 200, {
      challenge: bufToB64u(challenge),
      timeout: 60000,
      userVerification: 'preferred',
      allowCredentials: [{ type: 'public-key', id: pk.credentialId }],
    });
  }
  if (method === 'POST' && pathname === '/api/admin/login/finish') {
    const pk = getPasskey();
    if (!pk) return sendJson(res, 400, { error: 'no passkey' });
    if ((req.headers['content-type']||'').split(';')[0].trim() !== 'application/json') return sendJson(res, 415, { error: 'expected application/json' });
    let body;
    try { body = JSON.parse(await readBody(req, 1024 * 1024)); } catch { return badRequest(res); }
    const cookies = parseCookies(req.headers.cookie);
    const ch = pendingChallenges.get(cookies['webauthn_challenge']);
    if (!ch) return sendJson(res, 400, { error: 'challenge expired' });
    pendingChallenges.delete(cookies['webauthn_challenge']);

    if (body.id !== pk.credentialId) return sendJson(res, 400, { error: 'unknown credential' });
    const clientDataBuf = b64uToBuf(body.response.clientDataJSON);
    const authDataBuf   = b64uToBuf(body.response.authenticatorData);
    const sigBuf        = b64uToBuf(body.response.signature);
    const clientData = JSON.parse(clientDataBuf.toString('utf8'));
    if (clientData.type !== 'webauthn.get') return sendJson(res, 400, { error: 'bad clientData type' });
    if (clientData.challenge !== bufToB64u(ch.challenge)) return sendJson(res, 400, { error: 'challenge mismatch' });
    const reqOrigin = req.headers.origin;
    if (reqOrigin && clientData.origin !== reqOrigin) {
      console.warn('[webauthn] login origin mismatch:', clientData.origin, 'vs', reqOrigin);
      return sendJson(res, 400, { error: 'origin mismatch' });
    }
    if (!reqOrigin) console.warn('[webauthn] login: no Origin header on request, skipping origin check');

    const clientDataHash = crypto.createHash('sha256').update(clientDataBuf).digest();
    const signedData = Buffer.concat([authDataBuf, clientDataHash]);
    const publicKey = b64uToBuf(pk.publicKey);
    if (!verifyES256Signature(publicKey, sigBuf, signedData)) return sendJson(res, 400, { error: 'bad signature' });

    const parsed = parseAuthenticatorData(authDataBuf);
    if (parsed.signCount > pk.signCount) { pk.signCount = parsed.signCount; savePasskey(pk); }
    const token = newSession('passkey');
    setSessionCookie(req, res, token);
    return sendJson(res, 200, { success: true });
  }

  // Mint a one-time login link. Admin-only. Token is single-use and expires
  // after LOGIN_LINK_TTL. Returns the full URL so the admin can copy it to
  // another device (e.g. one that can't access the passkey).
  if (method === 'POST' && pathname === '/api/admin/login/link') {
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin only' });
    // A session created from a login link can't mint another link — otherwise
    // one leaked link would be a permanent foothold (redeem -> mint -> share
    // -> repeat). Only the passkey holder can issue new links.
    if (sessionOriginFor(req) !== 'passkey') {
      return sendJson(res, 403, { error: 'only passkey-authenticated sessions can generate login links' });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    loginLinks.set(token, { createdAt: Date.now() });
    const isSecure = req.headers['x-forwarded-proto'] === 'https' || (req.connection && req.connection.encrypted);
    const proto = isSecure ? 'https' : 'http';
    const host = req.headers.host || 'localhost';
    const link = `${proto}://${host}/#auth=${token}`;
    return sendJson(res, 200, { link, ttlSeconds: Math.floor(LOGIN_LINK_TTL / 1000) });
  }

  // Redeem a one-time login link. Body: { token }. On success, mints a
  // normal 24h session (replaces any existing session cookie). The link is
  // consumed on first successful redeem regardless of whether the caller was
  // previously signed in.
  if (method === 'POST' && pathname === '/api/admin/login/redeem') {
    let body; try { body = JSON.parse(await readBody(req, 4 * 1024)); } catch { return badRequest(res); }
    const t = body && typeof body.token === 'string' ? body.token : '';
    if (!t) return sendJson(res, 400, { error: 'missing token' });
    const entry = loginLinks.get(t);
    if (!entry) return sendJson(res, 400, { error: 'invalid or expired link' });
    if (Date.now() - entry.createdAt > LOGIN_LINK_TTL) {
      loginLinks.delete(t);
      return sendJson(res, 400, { error: 'invalid or expired link' });
    }
    loginLinks.delete(t);
    const token = newSession('link');
    setSessionCookie(req, res, token);
    return sendJson(res, 200, { ok: true });
  }

  return notFound(res);
}

// ---------- static file serving ----------
function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css':  return 'text/css; charset=utf-8';
    case '.js':   return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json';
    case '.svg':  return 'image/svg+xml';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.png':  return 'image/png';
    case '.gif':  return 'image/gif';
    case '.webp': return 'image/webp';
    case '.avif': return 'image/avif';
    default: return 'application/octet-stream';
  }
}
function serveStatic(req, res, rel) {
  if (rel.includes('..')) return notFound(res);
  return serveStaticFile(req, res, path.join(PUBLIC_DIR, rel));
}
// Cache policy is based on the on-disk filename, not the URL — so admin
// pages and gallery pageviews share the policy table.
function cacheControlFor(abs) {
  const base = path.basename(abs);
  // Per-image LoDs and sprite atlases are content-addressed: a rebuild
  // mints new filenames (sprite version bump, .h<N>.avif keyed by image
  // mtime via the build pipeline). Safe to cache forever.
  if (/\.h\d+\.avif$/.test(base)) return 'public, max-age=31536000, immutable';
  if (/^sprite(?:-h\d+)?-\d+\.(jpg|avif)$/.test(base)) return 'public, max-age=31536000, immutable';
  // Imagemap + sprite metadata don't change name but do change content.
  // Short cache + ETag for cheap revalidation.
  if (base === '_imagemap.bin' || base === '_sprite.json') return 'public, max-age=60, must-revalidate';
  // Other static assets (gallery.js, css, html, svg, favicon) — shortish
  // cache plus ETag. Cloudflare edge caches these per Browser Cache TTL.
  return 'public, max-age=300, must-revalidate';
}

function serveStaticFile(req, res, abs) {
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    // Weak ETag from size+mtime is cheap and sufficient for browser
    // conditional GETs. Rebuild produces a new mtime so cache invalidates.
    const etag = 'W/"' + st.size.toString(36) + '-' + Math.floor(st.mtimeMs).toString(36) + '"';
    const inm = req.headers['if-none-match'];
    const ims = req.headers['if-modified-since'];
    if (inm === etag || (ims && new Date(ims).getTime() >= Math.floor(st.mtimeMs))) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControlFor(abs) });
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': contentType(abs),
      'Content-Length': st.size,
      'Last-Modified': st.mtime.toUTCString(),
      'ETag': etag,
      'Cache-Control': cacheControlFor(abs),
    });
    fs.createReadStream(abs).pipe(res);
  });
}
// ---------- start ----------
// Every build step shells out to libvips, so refuse to start without it
// rather than failing on the first pageview.
function preflightVips() {
  for (const tool of ['vips', 'vipsthumbnail', 'vipsheader']) {
    const probe = spawnSync(tool, ['--version']);
    if (probe.error || probe.status !== 0) {
      console.error(`[fatal] '${tool}' is missing or not runnable. Install libvips (Debian: apt install libvips-tools).`);
      process.exit(1);
    }
  }
  const svgProbe = spawnSync('vipsheader', [BROKEN_SVG]);
  if (svgProbe.status !== 0) {
    console.warn('[warn] libvips cannot load SVG (missing librsvg support); broken-image placeholders will not be generated.');
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error('[handler error]', req.method, req.url, err);
    if (!res.headersSent) sendText(res, 500, 'internal error');
  });
});
(async () => {
  preflightVips();
  // Startup is O(1): LoDs and atlases build on first pageview. An interrupted
  // build leaves only an atlas_<hash>_building/ dir, which the next rebuild sweeps.
  brokenTilesReady();  // kick off placeholder tile generation (memoized)
  server.listen(PORT, HOST, () => {
    console.log(`Goodgallery listening on http://${HOST}:${PORT}`);
    console.log(`  galleries root: ${GALLERIES_ROOT}`);
    console.log(`  state dir:      ${STATE_DIR}`);
  });
})();
