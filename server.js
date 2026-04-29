// Goodgallery 2.0 — Node.js rewrite of the 2014 PHP build.
// Zero runtime npm dependencies. Image resizing via vipsthumbnail (libvips).
//
// Preserves the 2014 URL/data layout:
//   GALLERIES_ROOT/<path...>/<image>            originals
//   GALLERIES_ROOT/<path...>/thumbcache/<image>.resized.jpg
//   GALLERIES_ROOT/<path...>/previewcache/<image>.resized.jpg
//   GALLERIES_ROOT/<path...>/ggTrash/<image>    soft-deleted
//
// New: folder hierarchy. Each folder is its own gallery; subfolders appear
// as cards in the parent. Folder URL = the path itself, ending with `/`.

import http from 'http';
import https from 'https';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
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
const THUMBS_PER_PAGE  = parseInt(process.env.THUMBS_PER_PAGE || '50', 10);
// Thumbs are now cover-cropped to fixed square cells so they tile cleanly into a sprite
// atlas. THUMB_CELL is the physical pixel size; CSS displays at half that for 2x retina.
const THUMB_CELL       = parseInt(process.env.THUMB_CELL || '200', 10);
const THUMB_DIM        = THUMB_CELL;  // alias for clarity in build path
const SPRITE_ACROSS      = parseInt(process.env.SPRITE_ACROSS || '20', 10);   // cells per row (target)
// Cap each sprite atlas by **target file size**, not cell count or pixel area. With
// variable-width cells the cell-count axis is meaningless, and pixel area is too far from
// the user's mental model ("I want sprites under 4MB so a tab loading the gallery is
// snappy"). We translate target bytes -> pixel cap with an empirical bytes/pixel constant
// measured at our JPEG quality on typical photo content. Tweak BYTES_PER_PIXEL_Q92 if
// your galleries are mostly flat-color (lower) or extreme detail (higher).
const MAX_SPRITE_BYTES   = parseInt(process.env.MAX_SPRITE_BYTES || String(4 * 1024 * 1024), 10);
const BYTES_PER_PIXEL_Q92 = parseFloat(process.env.BYTES_PER_PIXEL_Q92 || '0.30');
const MAX_SPRITE_PIXELS   = Math.max(1, Math.floor(MAX_SPRITE_BYTES / BYTES_PER_PIXEL_Q92));
const PREVIEW_DIM      = parseInt(process.env.PREVIEW_DIM || '2000', 10); // generous; only used for big originals
const THUMB_QUALITY    = parseInt(process.env.THUMB_QUALITY || '82', 10);
const PREVIEW_QUALITY  = parseInt(process.env.PREVIEW_QUALITY || '85', 10);
// Originals smaller than this skip preview generation — the client uses the original directly.
// Browsers scale well now; the only point of a "preview" is to shrink huge files.
const PREVIEW_SIZE_THRESHOLD = parseInt(process.env.PREVIEW_SIZE_THRESHOLD || String(500 * 1024), 10);
const SESSION_DURATION = 24 * 60 * 60 * 1000;
const RP_NAME          = SITE_TITLE;

// reserved on-disk names that are NOT user content
const RESERVED = new Set(['thumbcache', 'previewcache', 'ggTrash']);
const SUPPORTED_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif']);

// ---------- bootstrap ----------
fs.mkdirSync(GALLERIES_ROOT, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });


// Recognize tmp files left behind by killed write paths. Sweep these on startup and on
// maintenance ops. Keep this function in one place so every writer pays the same tax.
function isOrphanTmp(name) {
  // Any '.__tmp.<format>' (jpg, v, etc.) or legacy '.tmp' are sweep-eligible orphans.
  return /\.__tmp\.[^/]+$/.test(name) || name.endsWith('.tmp');
}

async function sweepOrphanTmps(rootDir) {
  let removed = 0;
  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (e.isFile() && isOrphanTmp(e.name)) {
        try { await fsp.unlink(full); removed++; } catch {}
      }
    }
  }
  await walk(rootDir);
  // Also sweep stale state-dir tmps (passkey.json.tmp etc.)
  try {
    for (const e of await fsp.readdir(STATE_DIR)) {
      if (isOrphanTmp(e)) { try { await fsp.unlink(path.join(STATE_DIR, e)); removed++; } catch {} }
    }
  } catch {}
  return removed;
}


// ---------- build queue ----------
// Server-side build orchestration. Replaces the 2014 PHP-era pattern where the browser
// looped against ?buildall=1 to babysit a per-request executor. Node is a long-running
// process: it can own the queue, watch the filesystem, and just *do* the work.
//
// Design rules:
//   - Bounded concurrency (default min(4, CPU)) — never fork-bomb on a 60k mass upload.
//   - Per (folder,file) dedupe — repeated triggers for the same file collapse into one job.
//   - Idempotent — if the thumb already exists ensureBuilt is a no-op.
//   - Crash-safe — atomicity is enforced inside ensureBuilt; the queue itself is in-memory
//     and is rebuilt from disk state on the next startup scan, so a process kill loses
//     only the in-memory progress counters, never on-disk integrity.
import os from 'os';
const BUILD_CONCURRENCY = Math.max(1, Math.min(4, os.cpus().length));

class BuildQueue {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.queue = [];
    this.inFlight = new Set();
    this.workers = 0;
    this.progress = new Map();
  }
  _key(g, f) { return g + '\0' + f; }
  _bumpProgress(g, fn) {
    const p = this.progress.get(g) || { pending: 0, inProgress: 0, done: 0, total: 0, recent: [] };
    fn(p);
    this.progress.set(g, p);
  }
  enqueue(galleryAbs, filename) {
    const k = this._key(galleryAbs, filename);
    if (this.inFlight.has(k)) return false;
    this.inFlight.add(k);
    this.queue.push({ galleryAbs, filename });
    this._bumpProgress(galleryAbs, p => { p.pending++; p.total++; });
    this._kick();
    return true;
  }
  async enqueueFolder(galleryAbs) {
    const { images } = await listFolder(galleryAbs);
    let n = 0;
    for (const f of images) if (this.enqueue(galleryAbs, f)) n++;
    return n;
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
        const { galleryAbs, filename } = this.queue.shift();
        const k = this._key(galleryAbs, filename);
        this._bumpProgress(galleryAbs, p => { p.pending--; p.inProgress++; });
        try {
          await ensureBuilt(galleryAbs, filename);
          this._bumpProgress(galleryAbs, p => {
            p.done++;
            p.recent.unshift(filename);
            if (p.recent.length > 10) p.recent.length = 10;
          });
        } catch (e) {
          this._bumpProgress(galleryAbs, p => { p.lastError = filename + ': ' + e.message; });
          console.warn('[build]', filename, 'in', galleryAbs, '-', e.message);
        } finally {
          this._bumpProgress(galleryAbs, p => { p.inProgress--; });
          this.inFlight.delete(k);
          // When the folder's queue drains, schedule (debounced) a sprite rebuild.
          // Multiple drains in quick succession collapse into one rebuild after quiet.
          const after = this.progress.get(galleryAbs);
          if (after && after.pending === 0 && after.inProgress === 0 && after.total > 0) {
            scheduleSpriteBuild(galleryAbs);
          }
        }
      }
    } finally { this.workers--; }
  }
  progressFor(galleryAbs) {
    const p = this.progress.get(galleryAbs);
    if (!p) return { pending: 0, inProgress: 0, done: 0, total: 0, recent: [] };
    return { pending: p.pending, inProgress: p.inProgress, done: p.done, total: p.total, recent: p.recent.slice(), lastError: p.lastError };
  }
  async scanAll(root) {
    let totalQueued = 0;
    const walk = async (dir) => {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') || RESERVED.has(e.name)) continue;
        if (e.isDirectory()) await walk(path.join(dir, e.name));
      }
      totalQueued += await this.enqueueFolder(dir);
    };
    await walk(root);
    return totalQueued;
  }
}

const buildQueue = new BuildQueue(BUILD_CONCURRENCY);

// ---------- filesystem watcher ----------
// Detect new images dropped via scp/rsync/mv and queue them. fs.watch supports recursive
// on Linux as of Node 20.11+ (this CT runs 20.19).
function startWatcher() {
  try {
    fs.watch(GALLERIES_ROOT, { recursive: true }, (eventType, rel) => {
      if (!rel) return;
      if (rel.split('/').some(seg => seg.startsWith('.') || RESERVED.has(seg))) return;
      if (isOrphanTmp(rel)) return;
      const full = path.join(GALLERIES_ROOT, rel);
      const dir = path.dirname(full);
      // Any change in the directory makes the sprite metadata potentially stale; drop the
      // cached entry so the next pageview rechecks (sprite rebuild also invalidates by
      // refreshing the cached value).
      spriteMetaCache.delete(dir);
      fs.stat(full, (err, st) => {
        if (err || !st.isFile()) return;
        const base = path.basename(full);
        if (!isImage(base) || isOrphanTmp(base)) return;
        buildQueue.enqueue(dir, base);
      });
    });
    console.log('Watching', GALLERIES_ROOT, 'recursively for new images.');
  } catch (e) {
    console.warn('fs.watch failed:', e.message, '— file additions will only be picked up on next startup scan.');
  }
}

// ---------- in-memory state ----------
const sessions         = new Map();  // token -> { createdAt }
const pendingChallenges = new Map(); // chalId -> { challenge, timestamp }

// Persist sessions across server restarts. Without this, every restart silently
// invalidates every admin's localStorage token, leaving the UI in a confused state
// where the client believes it's logged in but every admin call returns 401.
const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
function loadSessions() {
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
    const obj = JSON.parse(raw);
    const now = Date.now();
    for (const [tok, data] of Object.entries(obj)) {
      if (now - data.createdAt < SESSION_DURATION) sessions.set(tok, data);
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
}, 60 * 1000);

// ---------- helpers ----------
function hxEscape(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function jsString(s) {
  // safe to drop into a JS double-quoted string literal
  return JSON.stringify(String(s));
}
function parseCookies(h) {
  const out = {};
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
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

// safely resolve a URL path (already URL-decoded segments) to an absolute path under GALLERIES_ROOT.
// returns null if the path escapes the root or contains reserved/hidden segments.
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
async function listFolder(absDir, { withSizes = false } = {}) {
  let entries;
  try { entries = await fsp.readdir(absDir, { withFileTypes: true }); }
  catch { return { folders: [], images: [], sizes: [] }; }

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
  let sizes = [];
  if (withSizes) {
    sizes = await Promise.all(images.map(async n => {
      try { const st = await fsp.stat(path.join(absDir, n)); return st.size; }
      catch { return 0; }
    }));
  }
  return { folders, images, sizes };
}

// ---------- image build via vipsthumbnail ----------
// vipsthumbnail handles sizing + orientation + JPEG output. Atomic via .tmp rename.
// Preserve-aspect thumb (used for previews of large originals).
function vipsThumb(srcAbs, dstAbs, dim, quality) {
  return new Promise((resolve, reject) => {
    const tmp = dstAbs + '.__tmp.jpg';
    const args = [
      srcAbs,
      '--size', `${dim}x${dim}>`,
      '--output', `${tmp}[Q=${quality},strip,optimize_coding,interlace]`,
    ];
    runVips('vipsthumbnail', args, tmp, dstAbs).then(resolve, reject);
  });
}

// Fixed-height, variable-width thumb (preserve aspect ratio). Matches the user's
// preferred 2014/testgallery look — rows of thumbs at uniform height, no cropping.
// Sprite atlas was tried but disabled because uniform-cell tiling required cover-cropping
// every thumb to a square, which loses information at the edges of every image.
// HTTP/2 multiplexing + 50/page pagination makes per-thumb requests fast enough.
// Lossless .v intermediate (libvips raw native format, gd2 analog). Resizing is the
// expensive operation — we want each per-image resize to be its own atomic, idempotent,
// LOSSLESS unit. Sprite assembly memmaps these with ~zero decode cost. Note: the
// op-style 'vips thumbnail' is reliable; 'vipsthumbnail --output X.v' silently no-ops.
function vipsHeightThumbV(srcAbs, dstAbs, height) {
  return new Promise((resolve, reject) => {
    const tmp = dstAbs + '.__tmp.v';
    const args = [
      'thumbnail', srcAbs, tmp, '99999',
      '--height', String(height),
      '--size', 'down',
    ];
    runStep('vips', args, tmp).then(() =>
      fs.promises.rename(tmp, dstAbs).then(resolve, reject)
    ).catch(reject);
  });
}

// Run a vips subcommand; verify the named output file exists; bubble useful diagnostics.
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

function runVips(cmd, args, tmp, finalPath) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => {
      if (code !== 0) { fs.promises.unlink(tmp).catch(()=>{}); reject(new Error(`${cmd} failed: ` + err.trim())); return; }
      fs.promises.rename(tmp, finalPath).then(resolve, reject);
    });
  });
}

async function ensureBuilt(folderAbs, filename) {
  if (!isImage(filename)) throw new Error('unsupported');
  const src = path.join(folderAbs, filename);
  let st;
  try { st = await fsp.stat(src); } catch { throw new Error('missing original'); }
  // (debug: log when we touch a file so the user can see preview-vs-original decisions)
  if (process.env.GG_DEBUG_BUILDS) {
    console.log('[build]', filename, 'size=' + st.size, 'preview=' + (st.size >= PREVIEW_SIZE_THRESHOLD));
  }
  const thumbDir = path.join(folderAbs, 'thumbcache');
  await fsp.mkdir(thumbDir, { recursive: true });
  // Lossless .v intermediate (gd2 analog) — sprite atlas is the only lossy step.
  const thumbOut = path.join(thumbDir, filename + '.resized.v');
  let did = 0;
  if (!fs.existsSync(thumbOut)) { await vipsHeightThumbV(src, thumbOut, THUMB_CELL); did++; }
  // Preview only for large originals — for small ones the client uses the original directly.
  if (st.size >= PREVIEW_SIZE_THRESHOLD) {
    const previewDir = path.join(folderAbs, 'previewcache');
    await fsp.mkdir(previewDir, { recursive: true });
    const previewOut = path.join(previewDir, filename + '.resized.jpg');
    if (!fs.existsSync(previewOut)) { await vipsThumb(src, previewOut, PREVIEW_DIM, PREVIEW_QUALITY); did++; }
  }
  return did;
}



// Parse libvips .v file header. Layout (little-endian after a 4-byte magic):
//   offset 4: uint32 width, offset 8: uint32 height
function readVipsHeader(absPath) {
  let fd;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(16);
    const n = fs.readSync(fd, buf, 0, 16, 0);
    if (n < 16) return null;
    const w = buf.readUInt32LE(4);
    const h = buf.readUInt32LE(8);
    if (w <= 0 || h <= 0 || w > 100000 || h > 100000) return null;
    return { w, h };
  } catch { return null; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

// Read JPEG width/height by parsing the SOF marker. Avoids spawning a subprocess per
// thumbnail to discover its dims (which we need at sprite-build time for variable-width
// cell layout).
function readJpegDims(absPath) {
  let buf;
  try { buf = fs.readFileSync(absPath); } catch { return null; }
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xFF) return null;
    while (buf[i] === 0xFF) i++;
    const marker = buf[i++];
    if (marker === 0xD8 || marker === 0xD9) continue;
    const sof = (marker >= 0xC0 && marker <= 0xCF) && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
    if (sof) {
      const h = buf.readUInt16BE(i + 3);
      const w = buf.readUInt16BE(i + 5);
      return { w, h };
    }
    const len = buf.readUInt16BE(i);
    i += len;
  }
  return null;
}

// ---------- sprite atlas ----------
// In-memory cache: spriteMeta lives in RAM after first read. Per-page-view cost drops
// from one syscall + JSON.parse to a Map.get(). On write we proactively update the cache
// so the next pageview is hot. Process restart loses the cache; the first request rebuilds.
const spriteMetaCache = new Map(); // galleryAbs -> meta (or null if file is missing)

async function readSpriteMeta(galleryAbs) {
  if (spriteMetaCache.has(galleryAbs)) return spriteMetaCache.get(galleryAbs);
  let meta = null;
  try {
    const raw = await fsp.readFile(path.join(galleryAbs, 'thumbcache', '_sprite.json'), 'utf8');
    meta = JSON.parse(raw);
  } catch {}
  spriteMetaCache.set(galleryAbs, meta);
  return meta;
}

function spriteIsCurrent(meta, images) {
  if (!meta || !meta.imageMap) return false;
  if (meta.imageCount !== images.length) return false;
  // every image must be in the map
  for (const f of images) if (!meta.imageMap[f]) return false;
  // and the map shouldn't have stale entries
  if (Object.keys(meta.imageMap).length !== images.length) return false;
  return true;
}

async function buildSpriteForFolder(galleryAbs) {
  const { images } = await listFolder(galleryAbs);
  if (images.length === 0) return null;
  const thumbDir = path.join(galleryAbs, 'thumbcache');
  // require every thumb to exist; bail (the queue will retry) if any are missing.
  for (const f of images) {
    if (!fs.existsSync(path.join(thumbDir, f + '.resized.v'))) return null;
  }

  // Each thumb is fixed-height (THUMB_CELL px) but variable-width — read each one's
  // actual width so the client can slice the atlas at the correct column boundary.
  // Cell height is uniform (THUMB_CELL); cell width is the widest thumb in the gallery,
  // capped to a sane upper bound so a single panorama doesn't bloat the atlas.
  const SPRITE_CELL_W_MAX = parseInt(process.env.SPRITE_CELL_W_MAX || '600', 10);
  const widths = images.map(f => {
    const d = readVipsHeader(path.join(thumbDir, f + '.resized.v'));
    return d ? d.w : THUMB_CELL;
  });
  const cellW = Math.min(SPRITE_CELL_W_MAX, Math.max(THUMB_CELL, ...widths));
  const cellH = THUMB_CELL;
  // Dynamic capacity: never let a sprite exceed MAX_SPRITE_PIXELS in area, never let it
  // exceed SPRITE_ACROSS² in cell count. For wallpaper galleries (366px cells) this is
  // ~225/sprite; for square thumb galleries (200px) it's the full 400/sprite.
  const cellArea = cellW * cellH;
  const cellsPerSprite = Math.max(1, Math.min(
    SPRITE_ACROSS * SPRITE_ACROSS,
    Math.floor(MAX_SPRITE_PIXELS / cellArea)
  ));

  const stagingDir = path.join(thumbDir, '_sprite_staging');
  await fsp.rm(stagingDir, { recursive: true, force: true });
  await fsp.mkdir(stagingDir, { recursive: true });

  const numChunks = Math.ceil(images.length / cellsPerSprite);
  const sprites = [];
  const imageMap = {};

  try {
    for (let c = 0; c < numChunks; c++) {
      const chunk = images.slice(c * cellsPerSprite, (c + 1) * cellsPerSprite);
      const inputPaths = [];
      for (let i = 0; i < chunk.length; i++) {
        const link = path.join(stagingDir, `${c}_${i}.v`);
        try { await fsp.unlink(link); } catch {}
        await fsp.link(path.join(thumbDir, chunk[i] + '.resized.v'), link);
        inputPaths.push(link);
      }
      const spriteFile = `sprite-${c}.jpg`;
      const spriteAbs = path.join(thumbDir, spriteFile);
      const tmp = spriteAbs + '.__tmp.jpg';
      // vips arrayjoin: hspacing/vspacing letterbox each input into a uniform cell of that
      // size, top-left aligned, padded with --background. So a 320x200 thumb in a 600x200
      // cell becomes 320 wide of image + 280 wide of black padding to its right — and the
      // CSS slice on the client only reveals the leftmost \`actualW\` pixels.
      // Two-stage build: arrayjoin → .v intermediate (vips' raw format), then jpegsave →
      // final .jpg. Splitting the steps is more robust than the bracket-options trick on
      // the output path (which appears to silently no-op in some spawn contexts).
      const vTmp = tmp + '.v';
      console.log(`[sprite] building ${spriteFile}: ${chunk.length} thumbs (cell ${cellW}x${cellH})`);
      await runStep('vips', [
        'arrayjoin', inputPaths.join(' '), vTmp,
        '--across', String(SPRITE_ACROSS),
        '--hspacing', String(cellW),
        '--vspacing', String(cellH),
        // Single-element background broadcasts to any channel count. PNGs become 4-channel
        // RGBA .v intermediates and reject a 3-element RGB background ("vector must have 1
        // or 4 elements"). 1-element black works for both 3-channel and 4-channel inputs.
        '--background', '0',
      ], vTmp);
      await runStep('vips', [
        'jpegsave', vTmp, tmp,
        '--Q', '92',
        '--strip',
        '--optimize-coding',
        '--interlace',
      ], tmp);
      await fsp.unlink(vTmp).catch(()=>{});
      await fsp.rename(tmp, spriteAbs);
      sprites.push({ file: spriteFile, count: chunk.length });
      const baseOffset = c * cellsPerSprite;
      chunk.forEach((name, i) => {
        imageMap[name] = {
          sprite: c,
          row: Math.floor(i / SPRITE_ACROSS),
          col: i % SPRITE_ACROSS,
          w: Math.min(widths[baseOffset + i], cellW),
        };
      });
    }
  } finally {
    // Clean up staging on success and failure. The next run rms it anyway, but this
    // keeps thumbcache/ tidy for casual inspection.
    await fsp.rm(stagingDir, { recursive: true, force: true });
  }

  const meta = {
    cellW, cellH,
    across: SPRITE_ACROSS,
    cellsPerSprite,
    sprites,
    imageMap,
    imageCount: images.length,
    builtAt: Date.now(),
  };
  const metaPath = path.join(thumbDir, '_sprite.json');
  await fsp.writeFile(metaPath + '.tmp', JSON.stringify(meta));
  await fsp.rename(metaPath + '.tmp', metaPath);
  spriteMetaCache.set(galleryAbs, meta);  // hot the cache so the next pageview is zero-I/O

  // GC old sprite files no longer referenced.
  const referenced = new Set(sprites.map(s => s.file));
  for (const e of await fsp.readdir(thumbDir)) {
    if (/^sprite-\d+\.jpg$/.test(e) && !referenced.has(e)) {
      try { await fsp.unlink(path.join(thumbDir, e)); } catch {}
    }
  }
  return meta;
}

// Per-folder dedupe so we don't fire two arrayjoins concurrently for the same folder.
const spriteInFlight = new Set();
async function maybeBuildSprite(galleryAbs) {
  if (spriteInFlight.has(galleryAbs)) return;
  spriteInFlight.add(galleryAbs);
  try { await buildSpriteForFolder(galleryAbs); }
  catch (e) { console.warn('[sprite]', galleryAbs, e.message); }
  finally { spriteInFlight.delete(galleryAbs); }
}

// Debounce sprite rebuilds. Without this, dropping 1000 files into a folder triggers
// 1000 sprite rebuilds (one per fs.watch + queue-drain). With this, we wait for the
// dust to settle (5s of quiet) and rebuild once. Safe because the sprite is just a
// derived cache — never being current for a few seconds isn't a correctness problem.
const SPRITE_DEBOUNCE_MS = parseInt(process.env.SPRITE_DEBOUNCE_MS || '5000', 10);
const spriteDebounceTimers = new Map();
function scheduleSpriteBuild(galleryAbs) {
  const existing = spriteDebounceTimers.get(galleryAbs);
  if (existing) clearTimeout(existing);
  spriteDebounceTimers.set(galleryAbs, setTimeout(() => {
    spriteDebounceTimers.delete(galleryAbs);
    maybeBuildSprite(galleryAbs);
  }, SPRITE_DEBOUNCE_MS));
}


// ---------- chunked upload (ported from sendinator) ----------
// Per-file flow:
//   create  -> server allocates id + state dir, returns chunk size
//   chunk   -> client sends each chunk with SHA-256 in x-chunk-hash; server writes via
//              tmp+rename so a kill mid-write can never corrupt a chunk file
//   status  -> client asks which chunk indexes are present (for resume)
//   finalize-> server concatenates chunks into <gallery>/<filename>.__tmp.<ext>, renames
//              atomically to final, deletes chunk dir, kicks the build queue.
//
// Crash-safe properties:
//   - Each chunk is tmp+rename: only complete chunks are visible on disk.
//   - _meta.json is tmp+rename: never partially written.
//   - State persists across restarts: meta is reloaded from disk on boot, so an interrupted
//     upload can resume by replaying only missing chunks.
//   - Final file is tmp+rename: a kill mid-assemble leaves the destination unchanged.
//   - Stale uploads (older than UPLOAD_TTL) are GC'd on startup and hourly.
const UPLOAD_DIR = path.join(STATE_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || String(16 * 1024 * 1024), 10);
const UPLOAD_TTL = 24 * 60 * 60 * 1000;

// In-memory mirror of upload state (loaded from disk at startup).
const uploads = new Map();

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
    let body;
    try { body = JSON.parse(await readBody(req, 1024 * 1024)); } catch { return badRequest(res); }
    const { filename, size, targetFolder } = body;
    if (!filename || typeof filename !== 'string' || filename.length > 255) return sendJson(res, 400, { error: 'invalid filename' });
    const baseName = path.basename(filename);
    if (baseName.startsWith('.') || RESERVED.has(baseName) || isOrphanTmp(baseName)) return sendJson(res, 400, { error: 'invalid filename' });
    if (!isImage(baseName)) return sendJson(res, 400, { error: 'unsupported file type' });
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) return sendJson(res, 400, { error: 'invalid size' });
    // Server derives totalChunks from size + CHUNK_SIZE so the client doesn't need to
    // know the chunk size up front. This avoids a config round-trip and a class of
    // off-by-one errors when client and server disagree on the math.
    const totalChunks = Math.ceil(size / CHUNK_SIZE) || 1;

    // Resolve and validate target folder
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

  // GET /api/upload/status/:id  — used by the client to resume (which chunks exist)
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

    // Cleanup the upload state dir
    try { await fsp.rm(path.join(UPLOAD_DIR, id), { recursive: true, force: true }); } catch {}
    uploads.delete(id);

    // Trigger build (fs.watch may also fire — buildQueue dedupe handles it)
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
function newSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { createdAt: Date.now() });
  saveSessions();
  return token;
}
function isAdmin(req) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) return false;
  const tok = auth.slice(7).trim();
  const s = sessions.get(tok);
  if (!s) return false;
  if (Date.now() - s.createdAt > SESSION_DURATION) { sessions.delete(tok); return false; }
  return true;
}

// ---------- WebAuthn primitives (lifted from sendinator) ----------
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
function galleryHTML({ urlPath, folders, images, spriteMeta, isAdminFlag, hasPasskey }) {
  // urlPath has leading and trailing /, e.g. "/" or "/vacation/2024/"
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

  const folderCards = folders.map(name => {
    const href = encodeURIComponent(name) + '/';
    return `<a class="folder" href="${hxEscape(href)}"><span class="folder-icon">📁</span><span class="folder-name">${hxEscape(name)}</span></a>`;
  }).join('');

  // images[] is 1-indexed in the original; we keep the same convention to preserve old JS
  const imagesJsArray = 'var images = [null,' + images.map(n => jsString(n)).join(',') + '];';
  const lastImageValue = images.length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${hxEscape(SITE_TITLE)} — ${hxEscape(urlPath)}</title>
<link rel="stylesheet" href="/_static/goodgallery.css" />
<link rel="icon" type="image/svg+xml" href="/_static/favicon.svg" />
</head>
<body onkeydown="keycheck(event)" onkeyup="unlockkeys(event)">

<header id="topbar">
  <nav id="breadcrumb">${breadcrumbs}</nav>
  <a id="adminlink" href="/_admin/" title="Admin">⚙</a>
</header>

<div id="adminnotify"></div>

${folders.length ? `<section id="folders">${folderCards}</section>` : ''}

<div id="prevnext">
  <button onclick="leftbutton()">‹ Prev</button>
  <a href="#:" onclick="displaythumbs();return false;"> Thumbnails </a>
  <button onclick="rightbutton()">Next ›</button>
</div>

<div id="counter"></div>
<div id="realtime"></div>
<div id="thumbs"></div>

<div id="preloader"><a id="preimages">·</a></div>

<div id="photodiv">
  <a id="photospot" onclick="togglefullres()"></a>
</div>

<div id="login"></div>

<footer id="bottomlink">
  <a href="https://lagbag.com/goodgallery">GoodGallery</a> · ${images.length} image${images.length===1?'':'s'}${folders.length?` · ${folders.length} folder${folders.length===1?'':'s'}`:''}
</footer>

<script>
${imagesJsArray}
var lastimagevalue   = ${lastImageValue};
var thumbsperpage    = ${THUMBS_PER_PAGE};
var xhrpush          = 4;
var isadmin          = ${isAdminFlag ? 1 : 0};
var hasPasskey       = ${hasPasskey ? 'true' : 'false'};
var folderURL        = ${jsString(urlPath)};
var spriteMeta       = ${spriteMeta ? JSON.stringify(spriteMeta) : 'null'};
</script>
<script src="/_static/gallery.js"></script>

</body>
</html>`;
}

// ---------- request handler ----------
async function handle(req, res) {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;
  const pathname = decodeURIComponent(u.pathname);

  // --- static files (no caching restriction during dev)
  if (pathname.startsWith('/_static/')) {
    return serveStatic(req, res, pathname.slice('/_static/'.length));
  }
  if (pathname === '/favicon.ico' || pathname === '/favicon.svg') {
    return serveStaticFile(req, res, path.join(PUBLIC_DIR, 'favicon.svg'));
  }
  if (pathname === '/_admin' || pathname === '/_admin/') {
    return serveStaticFile(req, res, path.join(PUBLIC_DIR, 'admin.html'));
  }

  // --- API
  if (pathname.startsWith('/api/admin/')) return handleAdminAPI(req, res, pathname, method);
  if (pathname.startsWith('/api/upload/')) return handleUploadAPI(req, res, pathname, method);

  // --- gallery view (any other path is treated as a folder under GALLERIES_ROOT)
  // Normalize: must end with /, otherwise 301-redirect (but only if it's a real directory)
  const segs = pathname.split('/').filter(Boolean);
  const abs = resolveGallery(segs, { allowReserved: true });
  if (abs === null) return notFound(res, 'invalid path');

  // image / cache file?
  if (!pathname.endsWith('/')) {
    // file (or dir-needs-redirect) under a gallery folder.
    const fileName  = segs[segs.length - 1];
    const dirOfFile = segs[segs.length - 2];
    const grandparent = segs.slice(0, -2);

    // 1) cache file: /<gallery>/.../{thumbcache,previewcache}/<file>.resized.jpg
    if (dirOfFile === 'previewcache' && fileName.endsWith('.resized.jpg')) {
      const galleryAbs = resolveGallery(grandparent);
      if (!galleryAbs) return notFound(res);
      const cacheFile = path.join(galleryAbs, 'previewcache', fileName);
      const originalName = fileName.slice(0, -'.resized.jpg'.length);
      if (fs.existsSync(cacheFile)) return serveStaticFile(req, res, cacheFile);
      // Cache miss → trigger build (idempotent; skips preview gen for files <500KB).
      try { await ensureBuilt(galleryAbs, originalName); } catch {}
      if (fs.existsSync(cacheFile)) return serveStaticFile(req, res, cacheFile);
      // For small originals there's no preview; serve the original. Browsers scale fine.
      const original = path.join(galleryAbs, originalName);
      if (fs.existsSync(original)) return serveStaticFile(req, res, original);
      return notFound(res);
    }
    // sprite atlas files: /<gallery>/.../thumbcache/sprite-N.jpg
    if (dirOfFile === 'thumbcache' && /^sprite-\d+\.jpg$/.test(fileName)) {
      const galleryAbs = resolveGallery(grandparent);
      if (!galleryAbs) return notFound(res);
      return serveStaticFile(req, res, path.join(galleryAbs, 'thumbcache', fileName));
    }

    // 2) trash file: /<gallery>/.../ggTrash/<file>
    if (dirOfFile === 'ggTrash') {
      if (!isAdmin(req)) return sendText(res, 403, 'admin only');
      const galleryAbs = resolveGallery(grandparent);
      if (!galleryAbs) return notFound(res);
      return serveStaticFile(req, res, path.join(galleryAbs, 'ggTrash', fileName));
    }

    // 3) anything else needs the parent to be a real (non-reserved) gallery folder
    const parentAbs = resolveGallery(segs.slice(0, -1));
    if (parentAbs === null) return notFound(res);

    if (isImage(fileName)) {
      return serveStaticFile(req, res, path.join(parentAbs, fileName));
    }

    try {
      const st = fs.statSync(abs);
      if (st.isDirectory()) { res.writeHead(301, { Location: pathname + '/' }); return res.end(); }
    } catch {}
    return notFound(res);
  }

  // Reject gallery views into reserved/internal directories.
  if (segs.some(s => RESERVED.has(s))) return notFound(res, 'reserved');
  // Verify gallery dir exists
  let st;
  try { st = fs.statSync(abs); } catch { return notFound(res, 'no such gallery'); }
  if (!st.isDirectory()) return notFound(res, 'not a folder');

  // gallery action queries (?build=, ?buildall=1, etc.) — POST or GET.
  const q = u.searchParams;
  // ?build= retired (sprite-only architecture; no per-client thumb requests)
  if (q.get('buildall') === '1') return handleBuildAll(req, res, abs);
  if (q.has('clearcache'))  return adminAction(req, res, () => clearcache(abs));
  if (q.has('exploretrash')) return adminAction(req, res, () => exploretrash(abs));
  if (q.has('movetotrash')) return adminAction(req, res, () => movetotrash(abs, q.get('movetotrash')));
  if (q.has('restorefile')) return adminAction(req, res, () => restorefile(abs, q.get('restorefile')));
  if (q.has('deletefile'))  return adminAction(req, res, () => deletefile(abs, q.get('deletefile')));
  if (q.has('restoreall'))  return adminAction(req, res, () => restoreall(abs));
  if (q.has('emptytrash'))  return adminAction(req, res, () => emptytrash(abs));
  if (q.has('build-status')) {
    return sendJson(res, 200, buildQueue.progressFor(abs));
  }
  if (q.get('api') === 'list') {
    const { folders, images } = await listFolder(abs);
    return sendJson(res, 200, { folders, images });
  }
  if (q.has('mkdir') && method === 'POST') {
    if (!isAdmin(req)) return sendText(res, 403, 'admin only');
    const name = q.get('mkdir').trim();
    if (!name || /[\/\\\x00]/.test(name) || name.startsWith('.') || RESERVED.has(name))
      return badRequest(res, 'invalid name');
    await fsp.mkdir(path.join(abs, name), { recursive: false }).catch(() => {});
    return sendJson(res, 200, { ok: true });
  }
  if (q.has('upload') && method === 'POST') {
    if (!isAdmin(req)) return sendText(res, 403, 'admin only');
    return handleUpload(req, res, abs, q);
  }

  // Render gallery page
  const { folders, images, sizes } = await listFolder(abs, { withSizes: true });
  let spriteMeta = await readSpriteMeta(abs);
  if (!spriteIsCurrent(spriteMeta, images)) spriteMeta = null;
  const html = galleryHTML({
    urlPath: pathname,
    folders,
    images,
    sizes,
    spriteMeta,
    isAdminFlag: isAdmin(req),
    hasPasskey: !!getPasskey(),
  });
  return sendText(res, 200, html, 'text/html; charset=utf-8');
}

// ---------- build endpoints ----------
async function handleBuild(req, res, abs, q) {
  const filename = q.get('build');
  const inum = parseInt(q.get('inum') || '0', 10);
  if (!filename || !isImage(filename)) return badRequest(res, 'bad filename');
  try {
    await ensureBuilt(abs, filename);
    return sendText(res, 200, String(inum));
  } catch (e) {
    return sendText(res, 200, 'build failed: ' + e.message);
  }
}

async function handleBuildAll(req, res, abs) {
  // Fire-and-forget: enqueue + sweep orphans, return '1' so legacy clients consider it
  // validated. Workers do the actual building in the background; clients can poll
  // ?build-status for live progress instead of looping this endpoint.
  const { images } = await listFolder(abs);
  const queued = await buildQueue.enqueueFolder(abs);
  // .v thumbnails and .resized.jpg previews stay as long as the original exists in the
  // gallery OR in trash. Resize is the expensive op; we never throw the result away while
  // the source is recoverable. Only after a hard-delete (or after the orphan sweep notices
  // a file genuinely gone) do we reclaim the cache.
  const presence = new Set(images);
  const trashDir = path.join(abs, 'ggTrash');
  if (fs.existsSync(trashDir)) {
    for (const f of fs.readdirSync(trashDir)) presence.add(f);
  }
  for (const sub of ['thumbcache', 'previewcache']) {
    const dir = path.join(abs, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (isOrphanTmp(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch {} continue; }
      // Recognize both intermediate (.resized.v) and preview (.resized.jpg) suffixes.
      let original = null;
      if (f.endsWith('.resized.v'))         original = f.slice(0, -'.resized.v'.length);
      else if (f.endsWith('.resized.jpg'))  original = f.slice(0, -'.resized.jpg'.length);
      if (!original) continue;
      if (!presence.has(original)) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
    }
  }
  return sendText(res, 200, `queued ${queued} job(s)\n1`);
}

// ---------- admin actions on a folder ----------
async function adminAction(req, res, fn) {
  if (!isAdmin(req)) return sendText(res, 403, 'admin only');
  try { const out = await fn(); sendText(res, 200, out == null ? 'ok' : String(out)); }
  catch (e) { sendText(res, 500, 'error: ' + e.message); }
}
async function clearcache(abs) {
  for (const sub of ['thumbcache', 'previewcache']) {
    const dir = path.join(abs, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
  }
  return 'caches cleared';
}
async function movetotrash(abs, filename) {
  if (!filename || !isImage(filename)) throw new Error('bad filename');
  const trash = path.join(abs, 'ggTrash');
  await fsp.mkdir(trash, { recursive: true });
  const src = path.join(abs, filename);
  const dst = path.join(trash, filename);
  if (fs.existsSync(dst)) throw new Error('file with same name already in trash');
  await fsp.rename(src, dst);
  // Intentionally KEEP the cached .v thumbnail (and preview JPEG, if any). Restore is
  // then instant — no need to re-resize a recoverable original. Hard delete cleans them.
  return `${filename} moved to trash`;
}
async function exploretrash(abs) {
  const trash = path.join(abs, 'ggTrash');
  if (!fs.existsSync(trash)) return 'empty';
  const files = (await fsp.readdir(trash)).filter(f => isImage(f));
  return JSON.stringify({ files });
}
async function restorefile(abs, filename) {
  if (!filename || !isImage(filename)) throw new Error('bad filename');
  const src = path.join(abs, 'ggTrash', filename);
  const dst = path.join(abs, filename);
  if (!fs.existsSync(src)) throw new Error('not in trash');
  if (fs.existsSync(dst)) throw new Error('file with same name in gallery');
  await fsp.rename(src, dst);
  return `${filename} restored`;
}
async function deletefile(abs, filename) {
  if (!filename || !isImage(filename)) throw new Error('bad filename');
  const src = path.join(abs, 'ggTrash', filename);
  if (!fs.existsSync(src)) throw new Error('not in trash');
  await fsp.unlink(src);
  // Permanent delete: reclaim the cached intermediate + preview.
  for (const cf of [
    path.join(abs, 'thumbcache',   filename + '.resized.v'),
    path.join(abs, 'previewcache', filename + '.resized.jpg'),
  ]) { try { await fsp.unlink(cf); } catch {} }
  return `${filename} deleted`;
}
async function restoreall(abs) {
  const trash = path.join(abs, 'ggTrash');
  if (!fs.existsSync(trash)) return 'nothing to restore';
  let n = 0;
  for (const f of await fsp.readdir(trash)) {
    if (!isImage(f)) continue;
    const dst = path.join(abs, f);
    if (fs.existsSync(dst)) continue;
    await fsp.rename(path.join(trash, f), dst); n++;
  }
  return `${n} restored`;
}
async function emptytrash(abs) {
  const trash = path.join(abs, 'ggTrash');
  if (!fs.existsSync(trash)) return 'already empty';
  let n = 0;
  for (const f of await fsp.readdir(trash)) { await fsp.unlink(path.join(trash, f)); n++; }
  return `${n} permanently deleted`;
}

// ---------- upload (admin) ----------
// Phase-1 upload: a single file in a multipart/form-data POST. Will be replaced by
// sendinator-style chunked uploads in a later iteration.
async function handleUpload(req, res, abs, q) {
  const ct = req.headers['content-type'] || '';
  const m = ct.match(/^multipart\/form-data;\s*boundary=(.+)$/i);
  if (!m) return badRequest(res, 'expected multipart/form-data');
  const boundary = '--' + m[1];
  const body = await readBody(req, 1024 * 1024 * 1024);

  // Find first part with filename=
  const parts = splitMultipart(body, boundary);
  const filePart = parts.find(p => /filename="([^"]+)"/.test(p.headers['content-disposition'] || ''));
  if (!filePart) return badRequest(res, 'no file');
  const fnMatch = (filePart.headers['content-disposition'] || '').match(/filename="([^"]+)"/);
  const filename = path.basename(fnMatch[1]);
  if (!isImage(filename)) return badRequest(res, 'unsupported file type');
  if (filename.startsWith('.') || RESERVED.has(filename)) return badRequest(res, 'invalid filename');
  const dst = path.join(abs, filename);
  if (fs.existsSync(dst)) return sendText(res, 409, 'already exists');
  // Write through a tmp suffix that preserves the canonical extension, then rename.
  const tmp = dst + '.__tmp' + path.extname(dst);
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmp);
    ws.on('error', reject);
    ws.on('finish', resolve);
    ws.end(filePart.body);
  });
  await fsp.rename(tmp, dst);
  // pre-build asynchronously; don't block the response
  ensureBuilt(abs, filename).catch(()=>{});
  return sendJson(res, 200, { ok: true, filename });
}

function splitMultipart(buf, boundary) {
  const sep = Buffer.from('\r\n' + boundary);
  // First boundary may not have leading CRLF
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
async function handleAdminAPI(req, res, pathname, method) {
  if (method === 'GET' && pathname === '/api/admin/probe') {
    return sendJson(res, isAdmin(req) ? 200 : 401, { admin: isAdmin(req) });
  }
  if (method === 'GET' && pathname === '/api/admin/status') {
    return sendJson(res, 200, { passkeyExists: !!getPasskey() });
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
    const token = newSession();
    console.log('Admin passkey registered. Origin:', clientData.origin);
    return sendJson(res, 200, { success: true, token });
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

    const clientDataHash = crypto.createHash('sha256').update(clientDataBuf).digest();
    const signedData = Buffer.concat([authDataBuf, clientDataHash]);
    const publicKey = b64uToBuf(pk.publicKey);
    if (!verifyES256Signature(publicKey, sigBuf, signedData)) return sendJson(res, 400, { error: 'bad signature' });

    const parsed = parseAuthenticatorData(authDataBuf);
    if (parsed.signCount > pk.signCount) { pk.signCount = parsed.signCount; savePasskey(pk); }
    return sendJson(res, 200, { success: true, token: newSession() });
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
function serveStaticFile(req, res, abs) {
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    const headers = {
      'Content-Type': contentType(abs),
      'Content-Length': st.size,
      'Last-Modified': st.mtime.toUTCString(),
    };
    if (req.headers['if-modified-since'] && new Date(req.headers['if-modified-since']).getTime() >= st.mtime.getTime()) {
      res.writeHead(304); return res.end();
    }
    res.writeHead(200, headers);
    fs.createReadStream(abs).pipe(res);
  });
}
async function serveFileWithFallback(req, res, abs, recover) {
  if (fs.existsSync(abs)) return serveStaticFile(req, res, abs);
  const recovered = await recover();
  if (recovered && fs.existsSync(recovered)) return serveStaticFile(req, res, recovered);
  return notFound(res);
}

// ---------- start ----------
const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error('[handler error]', req.method, req.url, err);
    if (!res.headersSent) sendText(res, 500, 'internal error');
  });
});
(async () => {
  const swept = await sweepOrphanTmps(GALLERIES_ROOT);
  if (swept) console.log(`Swept ${swept} orphan tmp file(s) at startup.`);
  startWatcher();
  buildQueue.scanAll(GALLERIES_ROOT).then(n => {
    if (n) console.log(`Startup scan queued ${n} build job(s) (concurrency=${BUILD_CONCURRENCY}).`);
  }).catch(e => console.warn('Startup scan error:', e.message));
  server.listen(PORT, HOST, () => {
    console.log(`Goodgallery listening on http://${HOST}:${PORT}`);
    console.log(`  galleries root: ${GALLERIES_ROOT}`);
    console.log(`  state dir:      ${STATE_DIR}`);
  });
})();
