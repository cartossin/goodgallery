// Putting a file under a name without ever replacing what is there.
//
// rename() silently replaces an existing file. An upload that checked "is the
// name free?" and then assembled for seconds would rename over a photo that a
// trash restore, or the operator, put there meanwhile, and that original was
// gone. A hard link instead fails with EEXIST if the name exists, atomically,
// so whoever comes second is refused and nobody's file is lost.

import fs from 'fs';
import fsp from 'fs/promises';

// Link errors meaning "this filesystem (or this file) cannot be hard-linked":
// FAT/exFAT and some network mounts, or Linux protected_hardlinks refusing a
// file the service user does not own (a photo the operator copied in as root).
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS']);

// Move `from` to `to`; throws an error with code EEXIST if `to` exists.
export async function placeWithoutReplacing(from, to) {
  const st = await fsp.lstat(from);
  if (st.isDirectory()) return placeDirectory(from, to);
  try {
    await fsp.link(from, to);
  } catch (err) {
    if (!LINK_UNSUPPORTED.has(err.code)) throw err;
    await copyWithoutReplacing(from, to, st);
  }
  // The file is in place under its new name. Failing to remove the old name
  // only leaves a second name for the same bytes (a temp file the sweeps
  // remove, or a trash entry), so it is logged, not reported as a failure.
  try { await fsp.unlink(from); }
  catch (err) { console.warn('[place] could not remove', JSON.stringify(from), err.code || err.message); }
}

// Fallback where links are not possible: an exclusive copy also refuses an
// existing name. The copy keeps the file's times, so the build sees the same
// photo, not a changed one.
async function copyWithoutReplacing(from, to, st) {
  try {
    await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    await fsp.utimes(to, st.atime, st.mtime);
  } catch (err) {
    // A half-written copy is ours to remove; an existing file never is.
    if (err.code !== 'EEXIST') await fsp.rm(to, { force: true }).catch(() => {});
    throw err;
  }
}

// Directories cannot be hard-linked. rename() onto an existing non-empty
// directory or onto a file fails by itself; the check before it refuses an
// existing empty directory too, except in the instant between the two, where
// all that can be replaced is an empty directory.
async function placeDirectory(from, to) {
  if (await exists(to)) throw Object.assign(new Error(`'${to}' already exists`), { code: 'EEXIST' });
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err.code === 'ENOTEMPTY' || err.code === 'ENOTDIR' || err.code === 'EISDIR') err.code = 'EEXIST';
    throw err;
  }
}

async function exists(p) {
  try { await fsp.lstat(p); return true; }
  catch { return false; }
}
