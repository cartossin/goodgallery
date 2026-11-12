// Flow: create → chunk (per-chunk SHA-256, tmp+rename per chunk) → status (for
// resume) → finalize (concat into a dot-named temp file in the target folder,
// place it under its name without replacing anything, kick build queue).
// Every write is tmp+rename; meta and final file are atomic; meta reloaded on
// boot so interrupted uploads resume by replaying only missing chunks. Stale
// uploads (>UPLOAD_TTL) are GC'd on startup and hourly, with their temp files.
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { isAdmin } from './auth.js';
import { LOD_TIERS, STATE_DIR, isImage } from './config.js';
import { notFound, readJsonObject, sendJson } from './http.js';
import { isOrphanTmp, isServableName, resolveFolderField, resolveGallery } from './paths.js';
import { placeWithoutReplacing } from './place.js';
import { rebuildFolderIfNeeded } from './rebuild.js';

const UPLOAD_DIR = path.join(STATE_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || String(16 * 1024 * 1024), 10);
const UPLOAD_TTL = 24 * 60 * 60 * 1000;
// Per-file ceiling. The chunk table is sized from the declared size, so an
// unbounded size could make create allocate without end.
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || String(64 * 1024 * 1024 * 1024), 10);

// Renditions are written next to the photo, in its gg/, as
// <name>.h<height>.<format>, through a temp name with one more suffix (build.js
// and vips.js; ".__tmp.step1.v" is the longest). The photo's name must leave
// room for both within the filesystem's 255-byte limit on a name, or none of
// its renditions can be written.
const MAX_NAME_BYTES = 255;
const RENDITION_TEMP_SUFFIX_BYTES = Buffer.byteLength('.__tmp.step1.v');
const LONGEST_RENDITION_SUFFIX_BYTES =
  Math.max(...LOD_TIERS.map(tier => Buffer.byteLength(`.h${tier.h}.${tier.format}`))) + RENDITION_TEMP_SUFFIX_BYTES;
const MAX_PHOTO_NAME_BYTES = MAX_NAME_BYTES - LONGEST_RENDITION_SUFFIX_BYTES;

const uploads = new Map();  // in-memory mirror of on-disk upload state

// Upload id -> destination path, for the finalizes running right now.
// Two uploads of one name can both pass the "already exists" check before
// either file is on disk; the first to finalize owns the name and the other is
// told it is taken. The sweeps below leave these uploads' files alone.
const finalizing = new Map();

// Finalize assembles the file under this name in the target folder: a dot-name
// (never listed or served), short whatever the photo's name, and tied to the
// upload id so the sweeps know whose it is.
function assemblyPathFor(targetAbs, id) {
  return path.join(targetAbs, '.__tmp.upload-' + id);
}
function targetFolderOf(info) {
  return resolveGallery(info.targetFolderRel.split('/').filter(Boolean));
}
// Remove the half-assembled file a killed or failed finalize left behind.
function removeAssemblyTemp(id, info) {
  const targetAbs = targetFolderOf(info);
  if (targetAbs) fs.rmSync(assemblyPathFor(targetAbs, id), { force: true });
}

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
      // Nothing is finalizing yet at startup: any assembly file is a leftover.
      removeAssemblyTemp(id, obj);
    } catch {}
  }
  if (restored) console.log(`Restored ${restored} in-progress upload(s) from disk.`);
  gcStaleUploads();
}
function gcStaleUploads() {
  const now = Date.now();
  let n = 0;
  for (const [id, info] of uploads) {
    if (now - info.createdAt > UPLOAD_TTL && !finalizing.has(id)) {
      uploads.delete(id);
      try {
        removeAssemblyTemp(id, info);
        fs.rmSync(path.join(UPLOAD_DIR, id), { recursive: true, force: true });
        n++;
      } catch {}
    }
  }
  if (n) console.log(`Garbage-collected ${n} stale upload(s).`);
}
loadAllUploadMeta();
setInterval(gcStaleUploads, 60 * 60 * 1000);

export async function handleUploadAPI(req, res, pathname, method) {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin only' });

  if (method === 'POST' && pathname === '/api/upload/create') {
    const body = await readJsonObject(req, res, 1024 * 1024);
    if (!body) return;
    const { filename, size, targetFolder } = body;
    if (!filename || typeof filename !== 'string') return sendJson(res, 400, { error: 'invalid filename' });
    const baseName = path.basename(filename);
    if (!isServableName(baseName) || isOrphanTmp(baseName)) return sendJson(res, 400, { error: 'invalid filename' });
    const nameBytes = Buffer.byteLength(baseName);
    if (nameBytes > MAX_PHOTO_NAME_BYTES) {
      return sendJson(res, 400, { error: `file name too long: ${nameBytes} bytes, at most ${MAX_PHOTO_NAME_BYTES} (UTF-8) so its thumbnails fit the filesystem's 255-byte limit` });
    }
    if (!isImage(baseName)) return sendJson(res, 400, { error: 'unsupported file type' });
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) return sendJson(res, 400, { error: 'invalid size' });
    if (size > MAX_UPLOAD_BYTES) return sendJson(res, 400, { error: 'file larger than MAX_UPLOAD_BYTES (' + MAX_UPLOAD_BYTES + ')' });
    const totalChunks = Math.ceil(size / CHUNK_SIZE) || 1;

    const targetAbs = resolveFolderField(targetFolder);
    if (!targetAbs) return sendJson(res, 400, { error: 'invalid targetFolder' });
    const tfSegs = targetFolder.split('/').filter(Boolean);
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
  if (method === 'POST' && fm) return finalizeUpload(res, fm[1]);

  // DELETE /api/upload/:id  — cancel
  const dm = pathname.match(/^\/api\/upload\/([a-f0-9]+)$/);
  if (method === 'DELETE' && dm) {
    const id = dm[1];
    const info = uploads.get(id);
    if (!info) return sendJson(res, 404, { error: 'unknown' });
    if (finalizing.has(id)) return sendJson(res, 409, { error: 'this upload is being finalized' });
    uploads.delete(id);
    try {
      removeAssemblyTemp(id, info);
      fs.rmSync(path.join(UPLOAD_DIR, id), { recursive: true, force: true });
    } catch {}
    return sendJson(res, 200, { ok: true });
  }

  return notFound(res);
}

async function finalizeUpload(res, id) {
  const info = uploads.get(id);
  if (!info) return sendJson(res, 404, { error: 'unknown upload' });
  if (finalizing.has(id)) return sendJson(res, 409, { error: 'this upload is already being finalized' });
  if (info.chunksReceived.size !== info.totalChunks) {
    return sendJson(res, 400, { error: 'not all chunks received', missing: info.totalChunks - info.chunksReceived.size });
  }
  const targetAbs = targetFolderOf(info);
  if (!targetAbs) return sendJson(res, 400, { error: 'targetFolder no longer valid' });
  if (!(await isDirectory(targetAbs))) return sendJson(res, 404, { error: 'the target folder no longer exists' });
  const destPath = path.join(targetAbs, info.filename);
  const taken = { error: `a file named "${info.filename}" already exists in the folder; nothing was replaced` };
  if (fs.existsSync(destPath) || [...finalizing.values()].includes(destPath)) return sendJson(res, 409, taken);

  finalizing.set(id, destPath);
  const tmpPath = assemblyPathFor(targetAbs, id);
  try {
    await assembleChunks(id, info.totalChunks, tmpPath);
    // The name was free when checked, but a restore from trash or the
    // operator may have put a file there during the assembly: never replace it.
    await placeWithoutReplacing(tmpPath, destPath);
  } catch (e) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    // The upload's chunks stay, so it can be finalized again once the name is free.
    if (e.code === 'EEXIST') return sendJson(res, 409, taken);
    return sendJson(res, 500, { error: 'assemble failed: ' + e.message });
  } finally {
    finalizing.delete(id);
  }

  try { await fsp.rm(path.join(UPLOAD_DIR, id), { recursive: true, force: true }); } catch {}
  uploads.delete(id);

  // Trigger a folder rebuild — when it completes, the manifest will
  // include the new image and the page will render normally.
  rebuildFolderIfNeeded(targetAbs).catch(()=>{});

  return sendJson(res, 200, { ok: true, path: info.targetFolderRel + info.filename });
}

// Concatenate the chunk files into tmpPath. pipeline closes the file and
// reports the error if anything fails: an open refused (folder gone or
// unwritable), a full disk, a missing chunk.
async function assembleChunks(id, totalChunks, tmpPath) {
  async function* chunkContents() {
    for (let i = 0; i < totalChunks; i++) {
      yield await fsp.readFile(path.join(UPLOAD_DIR, id, `chunk_${i}`));
    }
  }
  await pipeline(chunkContents, fs.createWriteStream(tmpPath));
}

async function isDirectory(abs) {
  try { return (await fsp.stat(abs)).isDirectory(); }
  catch { return false; }
}
