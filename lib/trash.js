// Per-folder trash at <folder>/gg/trash/.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { isAdmin } from './auth.js';
import { GALLERIES_ROOT, GG_DIR, LOD_TIERS, STATE_DIR, isImage, lodPath } from './config.js';
import { badRequest, notFound, readBody, sendJson } from './http.js';
import { manifestCache } from './manifest.js';
import { isServableName, resolveGallery } from './paths.js';
import { rebuildFolderIfNeeded } from './rebuild.js';

// Per-folder trash: each folder owns its own bin at <folder>/gg/trash/.
function trashDirFor(folderAbs) {
  return path.join(folderAbs, GG_DIR, 'trash');
}
// Trash items carry the names the folder listing showed, so the listing's
// rule decides what can be trashed, restored and deleted.
function isValidTrashName(name) {
  return isServableName(name);
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

// Per-folder trash: <folder>/gg/trash/<filename>. LoDs at <folder>/gg/*.h*.avif
// stay where they are — restore is just renaming the image back. Trash-side
// name collisions get a .trashed-<stamp> suffix so trashing always succeeds.
export async function movetotrash(folderAbs, filename) {
  if (!isValidTrashName(filename) || !isImage(filename)) throw new Error('bad filename');
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
export async function deleteFolderToTrash(folderAbs) {
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

export async function handleTrashAPI(req, res, pathname, method, u) {
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
