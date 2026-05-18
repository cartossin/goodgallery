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
import { spawn } from 'child_process';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

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

// Atlas tiers are built smallest-first so the gallery is usable as soon as h5 lands.
const ATLAS_TIERS = [5, 10, 50, 100];
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
// Files that vips can't parse are tracked per-folder in manifest.unbuildableImages.
// Their tier requests are served from pre-rendered placeholder tiles so the gallery
// shows a visible "broken image" tile instead of going dark or stalling the sprite.
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
    this.inFlight = new Set();
    this.workers = 0;
    this.progress = new Map();
  }
  _key(g, f, phase) { return g + '\0' + f + '\0' + (phase || 'all'); }
  _bumpProgress(g, fn) {
    const p = this.progress.get(g) || { pending: 0, inProgress: 0, done: 0, total: 0, recent: [] };
    fn(p);
    this.progress.set(g, p);
  }
  enqueue(galleryAbs, filename, opts) {
    const phase = (opts && opts.phase) || 'all';
    const k = this._key(galleryAbs, filename, phase);
    if (this.inFlight.has(k)) return false;
    this.inFlight.add(k);
    this.queue.push({ galleryAbs, filename, phase });
    this._bumpProgress(galleryAbs, p => { p.pending++; p.total++; });
    this._kick();
    return true;
  }
  async enqueueFolder(galleryAbs, opts) {
    const phase = (opts && opts.phase) || 'all';
    const { images } = await listFolder(galleryAbs);
    const m = await loadManifest(galleryAbs).catch(() => ({}));
    const unbuildable = new Set(Array.isArray(m.unbuildableImages) ? m.unbuildableImages : []);
    let n = 0;
    for (const f of images) {
      if (unbuildable.has(f)) continue;
      if (!needsBuildForPhase(galleryAbs, f, phase)) continue;
      if (this.enqueue(galleryAbs, f, opts)) n++;
    }
    if (n > 0) markFolderDirty(galleryAbs).catch(()=>{});
    return n;
  }
  // Resolves once the queue is fully drained.
  drainPromise() {
    return new Promise((resolve) => {
      const tick = () => {
        if (this.queue.length === 0 && this.workers === 0) resolve();
        else setTimeout(tick, 500);
      };
      setTimeout(tick, 500);
    });
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
        const { galleryAbs, filename, phase } = this.queue.shift();
        const k = this._key(galleryAbs, filename, phase);
        this._bumpProgress(galleryAbs, p => { p.pending--; p.inProgress++; });
        try {
          await ensureBuilt(galleryAbs, filename, { phase });
          this._bumpProgress(galleryAbs, p => {
            p.done++;
            p.recent.unshift(filename);
            if (p.recent.length > 10) p.recent.length = 10;
          });
        } catch (e) {
          this._bumpProgress(galleryAbs, p => { p.lastError = filename + ': ' + e.message; });
          console.warn('[build]', filename, 'in', galleryAbs, '-', e.message);
          // Permanently bad source: mark unbuildable so sprite build skips it
          // and serving substitutes the placeholder. Full Rescan resets the list.
          manifestAddUnbuildable(galleryAbs, filename).catch(()=>{});
        } finally {
          this._bumpProgress(galleryAbs, p => { p.inProgress--; });
          this.inFlight.delete(k);
          // Debounced sprite rebuild on folder drain.
          const after = this.progress.get(galleryAbs);
          if (after && after.pending === 0 && after.inProgress === 0 && after.total > 0) {
            scheduleSpriteBuild(galleryAbs);
          }
          markFolderCleanIfIdle(galleryAbs).catch(()=>{});
        }
      }
    } finally { this.workers--; }
  }
  // Drop all queued (not-yet-started) work and clear inFlight markers for
  // them so a later enqueue can re-add. Workers currently inside _runOne keep
  // running — interrupting a half-written tile would orphan a .__tmp file.
  // Returns the count of queued items dropped.
  clear() {
    const dropped = this.queue.length;
    // Remove inFlight markers for items still in the queue (not yet picked up).
    for (const job of this.queue) {
      const k = this._key(job.galleryAbs, job.filename, job.phase);
      this.inFlight.delete(k);
    }
    // Bulk-decrement pending counts per gallery.
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
  progressFor(galleryAbs) {
    const p = this.progress.get(galleryAbs);
    if (!p) return { pending: 0, inProgress: 0, done: 0, total: 0, recent: [] };
    return { pending: p.pending, inProgress: p.inProgress, done: p.done, total: p.total, recent: p.recent.slice(), lastError: p.lastError };
  }
  async scanAll(root, opts) {
    let totalQueued = 0;
    const walk = async (dir) => {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') || RESERVED.has(e.name)) continue;
        if (e.isDirectory()) await walk(path.join(dir, e.name));
      }
      totalQueued += await this.enqueueFolder(dir, opts);
    };
    await walk(root);
    return totalQueued;
  }
}

// ---------- crash-recovery: per-folder dirty flag ----------
// Each manifest carries a 'building' flag set at start-of-build and cleared
// when the folder is fully idle. On read, building=true + not-currently-busy
// means a previous process died mid-build: sweep .__tmp files and re-enqueue.

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

function isFolderBusy(galleryAbs) {
  const p = buildQueue ? buildQueue.progressFor(galleryAbs) : null;
  if (p && (p.pending > 0 || p.inProgress > 0)) return true;
  if (spriteInFlight && spriteInFlight.has(galleryAbs)) return true;
  if (spriteDebounceTimers && spriteDebounceTimers.has(galleryAbs)) return true;
  return false;
}

async function markFolderDirty(galleryAbs) {
  const m = await loadManifest(galleryAbs);
  if (m.building) return;
  m.building = true;
  try { await writeManifest(galleryAbs, m); } catch (e) { console.warn('[markDirty]', galleryAbs, e.message); }
}

async function markFolderCleanIfIdle(galleryAbs) {
  if (isFolderBusy(galleryAbs)) return;
  const m = manifestCache.get(galleryAbs);
  if (!m || !m.building) return;
  m.building = false;
  try { await writeManifest(galleryAbs, m); } catch (e) { console.warn('[markClean]', galleryAbs, e.message); }
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
  if (cached) return cached;
  try {
    const raw = await fsp.readFile(manifestPathFor(galleryAbs), 'utf8');
    const m = JSON.parse(raw);
    if (m && m.version === MANIFEST_VERSION && Array.isArray(m.folders) && Array.isArray(m.images)) {
      manifestCache.set(galleryAbs, m);
      return m;
    }
  } catch {}
  // Cold gallery: readdir once, persist, cache.
  const m = await buildManifestFromDisk(galleryAbs);
  await writeManifest(galleryAbs, m);
  return m;
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

// Best-effort mutations: log + swallow on write failure. Drift is corrected
// by Full Rescan.
async function manifestAddImage(galleryAbs, name) {
  try {
    const m = await loadManifest(galleryAbs);
    let dirty = insortUnique(m.images, name);
    // Re-uploading a previously-broken file should let it retry.
    if (Array.isArray(m.unbuildableImages) && spliceName(m.unbuildableImages, name)) dirty = true;
    if (dirty) { m.builtAt = Date.now(); await writeManifest(galleryAbs, m); }
  } catch (e) { console.warn('[manifest:addImage]', galleryAbs, name, e.message); }
}
async function manifestAddUnbuildable(galleryAbs, name) {
  try {
    const m = await loadManifest(galleryAbs);
    if (!Array.isArray(m.unbuildableImages)) m.unbuildableImages = [];
    if (insortUnique(m.unbuildableImages, name)) { m.builtAt = Date.now(); await writeManifest(galleryAbs, m); }
  } catch (e) { console.warn('[manifest:addUnbuildable]', galleryAbs, name, e.message); }
}
async function manifestRemoveImage(galleryAbs, name) {
  try {
    const m = await loadManifest(galleryAbs);
    if (spliceName(m.images, name)) { m.builtAt = Date.now(); await writeManifest(galleryAbs, m); }
  } catch (e) { console.warn('[manifest:removeImage]', galleryAbs, name, e.message); }
}
async function manifestAddFolder(galleryAbs, name) {
  try {
    const m = await loadManifest(galleryAbs);
    if (insortUnique(m.folders, name)) { m.builtAt = Date.now(); await writeManifest(galleryAbs, m); }
  } catch (e) { console.warn('[manifest:addFolder]', galleryAbs, name, e.message); }
}
async function manifestRemoveFolder(galleryAbs, name) {
  try {
    const m = await loadManifest(galleryAbs);
    if (spliceName(m.folders, name)) { m.builtAt = Date.now(); await writeManifest(galleryAbs, m); }
  } catch (e) { console.warn('[manifest:removeFolder]', galleryAbs, name, e.message); }
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
async function manifestSetHidden(galleryAbs, name, hide) {
  const ggDir = path.join(galleryAbs, name, GG_DIR);
  const sentinel = path.join(ggDir, 'hidden');
  try {
    if (hide) {
      await fsp.mkdir(ggDir, { recursive: true });
      await fsp.writeFile(sentinel, '');
    } else {
      await fsp.unlink(sentinel).catch(() => {});
    }
  } catch (e) {
    console.warn('[manifest:setHidden:sentinel]', galleryAbs, name, e.message);
    return;
  }
  try {
    const m = await loadManifest(galleryAbs);
    if (!Array.isArray(m.hiddenFolders)) m.hiddenFolders = [];
    const idx = m.hiddenFolders.indexOf(name);
    if (hide && idx < 0) { m.hiddenFolders.push(name); m.hiddenFolders.sort(); }
    else if (!hide && idx >= 0) { m.hiddenFolders.splice(idx, 1); }
    else return; // no change
    m.builtAt = Date.now();
    await writeManifest(galleryAbs, m);
  } catch (e) { console.warn('[manifest:setHidden]', galleryAbs, name, e.message); }
}

// Rebuild from disk (drift correction). Used by Full Rescan.
async function rebuildManifest(galleryAbs) {
  // Preserve admin-set fields that aren't derivable from listFolder().
  const existing = await loadManifest(galleryAbs).catch(() => ({}));
  const m = await buildManifestFromDisk(galleryAbs);
  // Migration: any legacy hiddenFolders entry that still refers to a real
  // subfolder gets its sentinel stamped now. Stale names (folders that no
  // longer exist on disk) are dropped silently — don't materialize garbage
  // dirs for them. Run after buildManifestFromDisk so we know the live set.
  if (Array.isArray(existing.hiddenFolders) && existing.hiddenFolders.length > 0) {
    const live = new Set(m.folders);
    for (const name of existing.hiddenFolders) {
      if (!live.has(name)) continue;
      try {
        const ggDir = path.join(galleryAbs, name, GG_DIR);
        await fsp.mkdir(ggDir, { recursive: true });
        const sentinel = path.join(ggDir, 'hidden');
        try { await fsp.access(sentinel); }
        catch { await fsp.writeFile(sentinel, ''); }
      } catch (e) {
        console.warn('[manifest:rebuild:hidden-migrate]', galleryAbs, name, e.message);
      }
    }
  }
  m.hiddenFolders = await readHiddenSentinels(galleryAbs, m.folders);
  if (existing.building) m.building = existing.building;
  await writeManifest(galleryAbs, m);
  return m;
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

// Does `tier` match `phase`? phase is 'all' | 'v' | 'avif' | 'h<N>'.
function phaseAccepts(phase, tier) {
  if (!phase || phase === 'all') return true;
  if (phase === 'v') return tier.format === 'v';
  if (phase === 'avif') return tier.format === 'avif';
  if (phase.charCodeAt(0) === 104 /* 'h' */) {
    return tier.h === parseInt(phase.slice(1), 10);
  }
  return false;
}

function needsBuildForPhase(folderAbs, filename, phase) {
  const thumbDir = path.join(folderAbs, GG_DIR);
  for (const tier of LOD_TIERS) {
    if (!phaseAccepts(phase, tier)) continue;
    if (!fs.existsSync(lodPath(thumbDir, filename, tier.h, tier.format))) return true;
  }
  return false;
}

async function ensureBuilt(folderAbs, filename, opts) {
  if (!isImage(filename)) throw new Error('unsupported');
  const phase = (opts && opts.phase) || 'all';
  const src = path.join(folderAbs, filename);
  let st;
  try { st = await fsp.stat(src); } catch { throw new Error('missing original'); }
  if (process.env.GG_DEBUG_BUILDS) {
    console.log('[build]', filename, 'phase=' + phase, 'size=' + st.size);
  }
  const thumbDir = path.join(folderAbs, GG_DIR);
  await fsp.mkdir(thumbDir, { recursive: true });
  let did = 0;
  for (const tier of LOD_TIERS) {
    if (!phaseAccepts(phase, tier)) continue;
    const out = lodPath(thumbDir, filename, tier.h, tier.format);
    if (fs.existsSync(out)) continue;
    if (tier.format === 'v') {
      await vipsHeightThumbV(src, out, tier.h);
    } else if (tier.format === 'avif') {
      await vipsHeightThumbAVIF(src, out, tier.h, tier.quality);
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
    const raw = await fsp.readFile(path.join(galleryAbs, GG_DIR, '_sprite.json'), 'utf8');
    meta = JSON.parse(raw);
  } catch {}
  spriteMetaCache.set(galleryAbs, meta);
  return meta;
}

// Sprite matches the manifest AND is the current version. Used by both the
// pageview path (decide whether to ship sprite metadata to the client) and
// maybeBuildSprite (decide whether to re-run the worker).
function spriteIsCurrent(meta, images, galleryAbs) {
  if (!meta || meta.version !== 5 || !meta.atlases) return false;
  if (meta.imageCount !== images.length) return false;
  if (!fs.existsSync(path.join(galleryAbs, GG_DIR, '_imagemap.bin'))) return false;
  return true;
}

// Per-folder dedupe so concurrent triggers don't run two builds at once.
const spriteInFlight = new Set();
// Sprite atlas builds are CPU-heavy synchronous JS (pixel-copy 100k tiles at
// 100k-image scale takes minutes). Run them in a worker thread so pageview
// handling on the main thread stays responsive. We still gate concurrency to
// one worker at a time globally — a single 100k atlas build holds ~1GB; running
// several at once on a moderate-RAM host risks OOM.
let _spriteWorkerChain = Promise.resolve();
function _runSpriteWorker(galleryAbs) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./sprite_worker.js', import.meta.url), {
      workerData: {
        galleryAbs,
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
async function maybeBuildSprite(galleryAbs) {
  if (spriteInFlight.has(galleryAbs)) return;
  spriteInFlight.add(galleryAbs);
  try {
    // Cheap pre-check on the main thread: don't even spawn a worker if the
    // sprite is already current. readSpriteMeta hits the spriteMetaCache.
    const m = await loadManifest(galleryAbs);
    const existing = await readSpriteMeta(galleryAbs);
    if (spriteIsCurrent(existing, m.images, galleryAbs)) return;
    // Global serial chain — at most one sprite worker runs at a time.
    const next = _spriteWorkerChain.then(() => _runSpriteWorker(galleryAbs));
    _spriteWorkerChain = next.catch(() => {});
    const meta = await next;
    if (meta) spriteMetaCache.set(galleryAbs, meta);
    else spriteMetaCache.delete(galleryAbs);  // worker deferred (missing LoDs) — let next read pick up freshly
  } catch (e) { console.warn('[sprite]', galleryAbs, e.message); }
  finally {
    spriteInFlight.delete(galleryAbs);
    markFolderCleanIfIdle(galleryAbs).catch(()=>{});
  }
}

// Debounce so a burst of build-completes collapses into one sprite rebuild.
const SPRITE_DEBOUNCE_MS = parseInt(process.env.SPRITE_DEBOUNCE_MS || '1000', 10);
const spriteDebounceTimers = new Map();
function scheduleSpriteBuild(galleryAbs) {
  const existing = spriteDebounceTimers.get(galleryAbs);
  if (existing) clearTimeout(existing);
  markFolderDirty(galleryAbs).catch(()=>{});
  spriteDebounceTimers.set(galleryAbs, setTimeout(() => {
    spriteDebounceTimers.delete(galleryAbs);
    maybeBuildSprite(galleryAbs).finally(() => markFolderCleanIfIdle(galleryAbs).catch(()=>{}));
  }, SPRITE_DEBOUNCE_MS));
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

    // Awaited so an immediate refresh sees the new image.
    await manifestAddImage(targetAbs, info.filename);
    buildQueue.enqueue(targetAbs, info.filename);

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
  const imagemapURL = spriteMeta ? jsString(urlPath + GG_DIR + '/_imagemap.bin') : 'null';

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
  const u = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;
  const pathname = decodeURIComponent(u.pathname);

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

    // gg/_imagemap.bin and gg/sprite-h<H>-<N>.{jpg,avif} and gg/<image>.h<H>.avif
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
    if (dirOfFile === GG_DIR && /\.h\d+\.avif$/.test(fileName)) {
      const galleryAbs = resolveGallery(grandparent);
      if (!galleryAbs) return notFound(res);
      // Substitute the placeholder tier for unbuildable source images.
      const m = /^(.+)\.h(\d+)\.(avif)$/.exec(fileName);
      if (m) {
        const srcName = m[1], tierH = parseInt(m[2], 10);
        const mf = await loadManifest(galleryAbs).catch(() => ({}));
        if (Array.isArray(mf.unbuildableImages) && mf.unbuildableImages.includes(srcName)) {
          await brokenTilesReady();
          return serveStaticFile(req, res, brokenTilePath(tierH, 'avif'));
        }
      }
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
  if (q.has('deletefolder')) return adminAction(req, res, async () => {
    if (abs === GALLERIES_ROOT) throw new Error('cannot delete the gallery root');
    const n = await deleteFolderToTrash(abs);
    return `${path.basename(abs)} deleted (${n} image${n === 1 ? '' : 's'} moved to trash)`;
  });
  if (q.has('movetotrash')) return adminAction(req, res, () => movetotrash(abs, q.get('movetotrash')));
  if (q.has('build-status')) {
    // Pure read: in-memory queue progress + a stat on _sprite.json. Never
    // queues work — that's the page-render path's job (lazy-build / crash-
    // recovery). Polling this endpoint is cheap regardless of folder size.
    const status = buildQueue.progressFor(abs);
    let spriteOk = false;
    try {
      const sMeta = await readSpriteMeta(abs);
      const sMan = manifestCache.get(abs) || await loadManifest(abs).catch(() => ({ images: [] }));
      spriteOk = spriteIsCurrent(sMeta, sMan.images, abs);
    } catch {}
    status.spriteUpToDate = spriteOk;
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
    if (made) await manifestAddFolder(abs, name);
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
    // Ensure the parent manifest knows about the folder so the hidden flag has
    // something to filter against on render.
    const mh = await loadManifest(abs);
    if (!mh.folders.includes(name)) await manifestAddFolder(abs, name);
    const hide = q.get('hide') !== '0';
    await manifestSetHidden(abs, name, hide);
    return sendJson(res, 200, { ok: true, name, hidden: hide });
  }
  if (q.has('upload') && method === 'POST') {
    if (!isAdmin(req)) return sendText(res, 403, 'admin only');
    return handleUpload(req, res, abs, q);
  }

  // Two on-view triggers piggyback on the manifest read:
  //   1. Lazy-build  — no manifest yet → queue a full build.
  //   2. Crash-recovery — manifest.building=true but folder is idle → sweep
  //      .__tmp orphans and re-enqueue.
  const manifestExisted = fs.existsSync(manifestPathFor(abs));
  const m = await loadManifest(abs);
  const folders = m.folders, images = m.images;
  if (!manifestExisted && images.length > 0) {
    buildQueue.enqueueFolder(abs).then(n => {
      if (n) console.log('[lazy-build]', abs, 'queued', n, 'job(s)');
      // Only kick sprite directly if no LoD work was queued (folder was already
      // built). Otherwise the drain-finally trigger fires it once the queue
      // finishes — kicking it now would race the LoD builds and produce a
      // mostly-placeholder sprite.
      else scheduleSpriteBuild(abs);
    }).catch(e => console.warn('[lazy-build]', abs, e.message));
  } else if (m.building && !isFolderBusy(abs)) {
    (async () => {
      const removed = await sweepFolderTmps(path.join(abs, GG_DIR));
      const queued = await buildQueue.enqueueFolder(abs);
      console.log('[crash-recover]', abs, 'queued:', queued, 'swept:', removed);
      if (queued === 0) {
        m.building = false; await writeManifest(abs, m);
        scheduleSpriteBuild(abs);
      }
    })().catch(e => console.warn('[crash-recover]', abs, e.message));
  }
  let spriteMeta = await readSpriteMeta(abs);
  if (!spriteIsCurrent(spriteMeta, images, abs)) spriteMeta = null;
  const html = galleryHTML({
    urlPath: pathname,
    folders,
    hiddenFolders: Array.isArray(m.hiddenFolders) ? m.hiddenFolders : [],
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
  if (!isAdmin(req)) return sendText(res, 403, 'admin only');
  try { const out = await fn(); sendText(res, 200, out == null ? 'ok' : String(out)); }
  catch (e) { sendText(res, 500, 'error: ' + e.message); }
}
async function clearcache(abs) {
  for (const sub of [GG_DIR]) {
    const dir = path.join(abs, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
  }
  return 'caches cleared';
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
  await manifestRemoveImage(folderAbs, filename);
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
  if (st.isDirectory()) await manifestAddFolder(folderAbs, name);
  else if (isImage(name)) await manifestAddImage(folderAbs, name);
  try { await fsp.rmdir(trashDirFor(folderAbs)); } catch {}
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
  await manifestRemoveFolder(parentAbs, name);
  manifestCache.delete(folderAbs);
  for (const k of Array.from(manifestCache.keys())) {
    if (k.startsWith(folderAbs + path.sep)) manifestCache.delete(k);
  }
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

// ---------- upload (admin) ----------
// Single-shot multipart/form-data upload. The chunked upload API above is the
// preferred path for large files.
async function handleUpload(req, res, abs, q) {
  const ct = req.headers['content-type'] || '';
  const m = ct.match(/^multipart\/form-data;\s*boundary=(.+)$/i);
  if (!m) return badRequest(res, 'expected multipart/form-data');
  const boundary = '--' + m[1];
  const body = await readBody(req, 1024 * 1024 * 1024);

  const parts = splitMultipart(body, boundary);
  const filePart = parts.find(p => /filename="([^"]+)"/.test(p.headers['content-disposition'] || ''));
  if (!filePart) return badRequest(res, 'no file');
  const fnMatch = (filePart.headers['content-disposition'] || '').match(/filename="([^"]+)"/);
  const filename = path.basename(fnMatch[1]);
  if (!isImage(filename)) return badRequest(res, 'unsupported file type');
  if (filename.startsWith('.') || RESERVED.has(filename)) return badRequest(res, 'invalid filename');
  const dst = path.join(abs, filename);
  if (fs.existsSync(dst)) return sendText(res, 409, 'already exists');
  const tmp = dst + '.__tmp' + path.extname(dst);
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmp);
    ws.on('error', reject);
    ws.on('finish', resolve);
    ws.end(filePart.body);
  });
  await fsp.rename(tmp, dst);
  // Fire-and-forget pre-build.
  ensureBuilt(abs, filename).catch(()=>{});
  return sendJson(res, 200, { ok: true, filename });
}

function splitMultipart(buf, boundary) {
  const sep = Buffer.from('\r\n' + boundary);
  // First boundary has no leading CRLF.
  const firstSep = Buffer.from(boundary);
  const out = [];
  let start = buf.indexOf(firstSep);
  if (start < 0) return out;
  start += firstSep.length;
  while (start < buf.length) {
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break; // -- = end
    // skip optional CRLF
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    const end = buf.indexOf(sep, start);
    if (end < 0) break;
    const partBuf = buf.slice(start, end);
    const headerEnd = partBuf.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd < 0) break;
    const hdrText = partBuf.slice(0, headerEnd).toString('utf8');
    const headers = {};
    for (const line of hdrText.split('\r\n')) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
    }
    const body = partBuf.slice(headerEnd + 4);
    out.push({ headers, body });
    start = end + sep.length;
  }
  return out;
}

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
    // Fire-and-forget. scanAll walks the tree once per phase and enqueues
    // missing tiers; the client polls ?build-status to track progress.
    (async () => {
      try {
        // Manifest pass first — picks up files dropped outside the uploader.
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
          if (hasContent) { try { await rebuildManifest(dir); rebuilt++; } catch (e) { console.warn('[fullrescan:manifest]', dir, e.message); } }
          for (const sub of subs) await walkRebuild(path.join(dir, sub));
        }
        try { await rebuildManifest(GALLERIES_ROOT); rebuilt++; } catch {}
        await walkRebuild(GALLERIES_ROOT);
        // Sprite pass FIRST, before any LoD queueing. Fire-and-forget so the
        // overall rescan doesn't block on a single slow gallery's atlas
        // rebuild. maybeBuildSprite serializes via _spriteWorkerChain anyway —
        // we just don't want forceWalk awaiting that chain, because a 100k-
        // image atlas can take ~10 min and we want LoD enqueueing to start
        // immediately so vips/vipsthumbnail workers can spin up in parallel.
        // A gallery whose phase-1 isn't complete will defer in the worker
        // (returns null), then re-trigger via the queue's drain-debounce
        // once its h100.v + earlier tiers finish.
        let spriteKicked = 0;
        async function forceWalk(dir) {
          let entries;
          try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
          let hasImages = false;
          const subs = [];
          for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            if (e.isDirectory()) {
              if (!RESERVED.has(e.name)) subs.push(e.name);
            } else if (e.isFile() && isImage(e.name)) hasImages = true;
          }
          if (hasImages) {
            // No await — schedule into the worker chain and move on.
            maybeBuildSprite(dir).catch(e => console.warn('[fullrescan:sprite]', dir, e.message));
            spriteKicked++;
          }
          for (const sub of subs) await forceWalk(path.join(dir, sub));
        }
        await forceWalk(GALLERIES_ROOT);
        // Now queue the missing LoDs; the queue runs in the background, and
        // its per-folder drain trigger reruns the sprite build as folders
        // complete. No await on drainPromise — fullrescan returns once work
        // is queued, not when work finishes.
        let queuedV = 0;
        for (const tierH of ATLAS_TIERS) {
          queuedV += await buildQueue.scanAll(GALLERIES_ROOT, { phase: 'h' + tierH });
        }
        const b = await buildQueue.scanAll(GALLERIES_ROOT, { phase: 'avif' });
        console.log('[fullrescan] manifests=' + rebuilt + ' sprites-kicked=' + spriteKicked + ' v-queued=' + queuedV + ' avif-queued=' + b);
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
const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error('[handler error]', req.method, req.url, err);
    if (!res.headersSent) sendText(res, 500, 'internal error');
  });
});
(async () => {
  // Startup is O(1): LoDs and atlases build on first pageview; crashed-mid-build
  // folders are recovered via the 'building' manifest flag on first read.
  brokenTilesReady();  // kick off placeholder tile generation (memoized)
  server.listen(PORT, HOST, () => {
    console.log(`Goodgallery listening on http://${HOST}:${PORT}`);
    console.log(`  galleries root: ${GALLERIES_ROOT}`);
    console.log(`  state dir:      ${STATE_DIR}`);
  });
})();
