// Flow: create → chunk (per-chunk SHA-256, tmp+rename per chunk) → status (for
// resume) → finalize (concat to .__tmp.<ext>, rename, kick build queue).
// Every write is tmp+rename; meta and final file are atomic; meta reloaded on
// boot so interrupted uploads resume by replaying only missing chunks. Stale
// uploads (>UPLOAD_TTL) are GC'd on startup and hourly.
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { isAdmin } from './auth.js';
import { RESERVED, STATE_DIR, isImage } from './config.js';
import { badRequest, notFound, readBody, sendJson } from './http.js';
import { isOrphanTmp, resolveGallery } from './paths.js';
import { rebuildFolderIfNeeded } from './rebuild.js';

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

export async function handleUploadAPI(req, res, pathname, method) {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin only' });

  if (method === 'POST' && pathname === '/api/upload/create') {
    if ((req.headers['content-type']||'').split(';')[0].trim() !== 'application/json') return sendJson(res, 415, { error: 'expected application/json' });
    let body;
    try { body = JSON.parse(await readBody(req, 1024 * 1024)); } catch { return badRequest(res); }
    const { filename, size, targetFolder } = body;
    if (!filename || typeof filename !== 'string' || filename.length > 255) return sendJson(res, 400, { error: 'invalid filename' });
    const baseName = path.basename(filename);
    if (/[\x00-\x1f\\]/.test(baseName) || baseName.startsWith('.') || RESERVED.has(baseName) || isOrphanTmp(baseName)) return sendJson(res, 400, { error: 'invalid filename' });
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
