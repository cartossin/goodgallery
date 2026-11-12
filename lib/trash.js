// Per-folder trash at <folder>/gg/trash/.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { isAdmin } from './auth.js';
import { GALLERIES_ROOT, GG_DIR, LOD_TIERS, STATE_DIR, isImage, lodPath } from './config.js';
import { errorTextForClient, notFound, readJsonObject, sendJson } from './http.js';
import { manifestCache } from './manifest.js';
import { isServableName, resolveFolderField } from './paths.js';
import { placeWithoutReplacing } from './place.js';
import { rebuildFolderIfNeeded } from './rebuild.js';

// Per-folder trash: each folder owns its own bin at <folder>/gg/trash/.
function trashDirFor(folderAbs) {
  return path.join(folderAbs, GG_DIR, 'trash');
}
// What may be trashed is what the folder listing shows (isServableName).
// What may be deleted from the trash is anything that is in it: a trash made
// by an earlier version can hold names the listing no longer shows (a tab or
// another control character), and those must still be removable. So an item
// already in the trash only has to be a plain name inside the trash folder.
function isValidTrashName(name) {
  if (typeof name !== 'string' || name === '') return false;
  if (name.includes('\0') || name.includes('/') || name.includes('\\')) return false;
  return !name.startsWith('.');
}

// Trashing onto a name the trash already holds inserts .trashed-<stamp>
// before the extension (a.jpg -> a.trashed-2026-11-12T00-09-20-453Z.jpg;
// a folder gets it at the end). The stamp is the moment it was trashed, an
// ISO time with ':' and '.' written as '-'.
const TRASH_STAMP = /\.trashed-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(\.[^.]*)?$/;

// The name the item had before it was trashed.
function originalNameOf(trashName) {
  const m = trashName.match(TRASH_STAMP);
  return m ? trashName.slice(0, m.index) + (m[6] || '') : trashName;
}

// When the item was trashed. A stamped name says so exactly. Otherwise the
// inode's change time: the rename into the trash set it, while the
// modification time is still the photo's own date.
function trashedAtOf(trashName, st) {
  const m = trashName.match(TRASH_STAMP);
  if (m) return Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return st.ctimeMs;
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
      trashedAt: trashedAtOf(e.name, st),
    });
  }
  out.sort((a, b) => b.trashedAt - a.trashedAt);
  return out;
}

// Per-folder trash: <folder>/gg/trash/<filename>. LoDs at <folder>/gg/*.h*.avif
// stay where they are — restore is just renaming the image back. Trash-side
// name collisions get a .trashed-<stamp> suffix so trashing always succeeds.
export async function movetotrash(folderAbs, filename) {
  if (!isServableName(filename) || !isImage(filename)) throw new Error('bad filename');
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
  await moveIntoTrash(src, dst, filename);
  rebuildFolderIfNeeded(folderAbs).catch(()=>{});
  return renamed
    ? `${filename} moved to trash (renamed to avoid collision)`
    : `${filename} moved to trash`;
}

// The time stamp a second copy of a name gets in the trash makes the name 33
// bytes longer, which a name near the filesystem's 255-byte limit has no
// room for.
async function moveIntoTrash(src, dst, name) {
  try {
    await fsp.rename(src, dst);
  } catch (e) {
    if (e.code !== 'ENAMETOOLONG') throw e;
    throw new Error(`'${name}' is already in the trash, and the name is too long to keep a second copy there; delete the one in the trash first`);
  }
}

// Restore from <folder>/gg/trash/<name> back to <folder> under the name it
// had before it was trashed (the stamp of a collision copy is internal and
// never becomes a photo's name). Handles both single images and whole
// folders. Refuses on destination collision.
async function restoreFromTrash(folderAbs, name) {
  if (!isValidTrashName(name)) throw new Error('invalid trash item name');
  const src = path.join(trashDirFor(folderAbs), name);
  let st;
  try { st = await fsp.stat(src); } catch { throw new Error('not in trash'); }
  const restoredName = originalNameOf(name);
  if (!isServableName(restoredName)) {
    throw new Error(`'${restoredName}' is not a name the gallery can show, so it cannot be restored; rename the file in gg/trash on the server first`);
  }
  const dst = path.join(folderAbs, restoredName);
  const taken = new Error(`'${restoredName}' already exists; rename or remove it first, then retry`);
  if (fs.existsSync(dst)) throw taken;
  // Never rename over a file that appears after the check (an upload
  // finishing, the operator copying one in).
  try { await placeWithoutReplacing(src, dst); }
  catch (e) { throw e.code === 'EEXIST' ? taken : e; }
  try { await fsp.rmdir(trashDirFor(folderAbs)); } catch {}
  rebuildFolderIfNeeded(folderAbs).catch(()=>{});
  return `restored ${restoredName}`;
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
  await moveIntoTrash(folderAbs, dst, name);
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
// movetotrash left behind in the source folder's gg/, unless a live photo
// now has that name: the LoDs are named after the photo, so they are its
// LoDs. Folder-trashed items carry their own gg/ inside so no extra LoD
// cleanup needed.
async function deleteFromTrash(folderAbs, name) {
  if (!isValidTrashName(name)) throw new Error('invalid trash item name');
  const src = path.join(trashDirFor(folderAbs), name);
  let st;
  try { st = await fsp.stat(src); } catch { throw new Error('not in trash'); }
  if (st.isDirectory()) {
    await fsp.rm(src, { recursive: true, force: true });
  } else {
    await fsp.unlink(src);
    const orig = originalNameOf(name);
    if (isImage(name) && !(await exists(path.join(folderAbs, orig)))) {
      const thumbDirAbs = path.join(folderAbs, GG_DIR);
      for (const tier of LOD_TIERS) {
        try { await fsp.unlink(lodPath(thumbDirAbs, orig, tier.h, tier.format)); } catch {}
      }
    }
  }
  try { await fsp.rmdir(trashDirFor(folderAbs)); } catch {}
  return `deleted ${name}`;
}

async function exists(p) {
  try { await fsp.lstat(p); return true; }
  catch { return false; }
}

async function restoreAllInFolder(folderAbs) {
  const items = await listFolderTrash(folderAbs);
  return applyToEach(items.map(it => it.name), name => restoreFromTrash(folderAbs, name), 'restored');
}

// Permanently delete just these items: the ones the admin saw listed when
// confirming "Empty trash". Anything trashed since stays.
async function deleteNamedFromTrash(folderAbs, names) {
  return applyToEach(names, name => deleteFromTrash(folderAbs, name), 'deleted');
}

// Run action on each name in turn; one failure does not stop the rest.
// Returns e.g. "restored 3 (1 failed; a.jpg: 'a.jpg' already exists; ...)".
async function applyToEach(names, action, verb) {
  let ok = 0;
  const errs = [];
  for (const name of names) {
    try { await action(name); ok++; }
    catch (e) { errs.push(`${name}: ${errorTextForClient(e)}`); }
  }
  let msg = `${verb} ${ok}`;
  if (errs.length) {
    msg += ` (${errs.length} failed; ` + errs.slice(0, 3).join('; ');
    if (errs.length > 3) msg += '; ...';
    msg += ')';
  }
  return msg;
}

function isListOfTrashNames(names) {
  return Array.isArray(names) && names.every(isValidTrashName);
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
  if (method === 'GET' && pathname === '/api/trash') {
    const folderAbs = resolveFolderField(u.searchParams.get('folder'));
    if (!folderAbs) return sendJson(res, 400, { error: 'invalid folder' });
    return sendJson(res, 200, { items: await listFolderTrash(folderAbs) });
  }
  if (method === 'POST') {
    // "Empty trash" sends the name of every item it showed, and a bin can
    // hold a whole folder's photos: 100,000 names of 200 bytes are 20 MB.
    const body = await readJsonObject(req, res, 32 * 1024 * 1024);
    if (!body) return;
    const folderAbs = resolveFolderField(body.folder);
    if (!folderAbs) return sendJson(res, 400, { error: 'invalid folder' });
    if (pathname === '/api/trash/restore') {
      try { return sendJson(res, 200, { ok: true, message: await restoreFromTrash(folderAbs, body.name) }); }
      catch (e) { return sendJson(res, 400, { error: errorTextForClient(e) }); }
    }
    if (pathname === '/api/trash/delete') {
      try { return sendJson(res, 200, { ok: true, message: await deleteFromTrash(folderAbs, body.name) }); }
      catch (e) { return sendJson(res, 400, { error: errorTextForClient(e) }); }
    }
    if (pathname === '/api/trash/restoreAll') {
      try { return sendJson(res, 200, { ok: true, message: await restoreAllInFolder(folderAbs) }); }
      catch (e) { return sendJson(res, 400, { error: errorTextForClient(e) }); }
    }
    // Body: { folder, names?: [...] }. With names, only those items are
    // deleted; without, the whole bin.
    if (pathname === '/api/trash/empty') {
      if (body.names !== undefined && !isListOfTrashNames(body.names)) {
        return sendJson(res, 400, { error: 'names must be a list of trash item names' });
      }
      try {
        const message = body.names !== undefined
          ? await deleteNamedFromTrash(folderAbs, body.names)
          : await emptyFolderTrash(folderAbs);
        return sendJson(res, 200, { ok: true, message });
      }
      catch (e) { return sendJson(res, 400, { error: errorTextForClient(e) }); }
    }
  }
  return notFound(res);
}
