// Request routing and the per-folder query actions.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { handleAdminAPI } from './admin_api.js';
import { readSpriteMeta } from './atlas.js';
import { getPasskey, isAdmin } from './auth.js';
import { buildQueue } from './build_queue.js';
import { GG_DIR, PUBLIC_DIR, RESERVED, isImage } from './config.js';
import { badRequest, notFound, sendJson, sendText, serveStatic, serveStaticFile } from './http.js';
import {
  listFolder,
  loadManifest,
  manifestPathFor,
  readHiddenSentinels,
  toggleHiddenSentinel,
} from './manifest.js';
import { galleryHTML } from './page.js';
import { resolveGallery } from './paths.js';
import { clearcache, rebuildFolderIfNeeded } from './rebuild.js';
import { deleteFolderToTrash, handleTrashAPI, movetotrash } from './trash.js';
import { handleUploadAPI } from './upload.js';

// Browsers mark a request with where it came from. The session cookie is
// SameSite=Strict, but a "site" ignores the port and spans sibling
// subdomains, so a page on another port of the same LAN host, or on a
// sibling domain, could still post a form here with the cookie attached.
// Requests that carry neither header (curl, scripts) are allowed through.
function sameOriginRequest(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

export async function handle(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  const method = req.method;
  if (method !== 'GET' && method !== 'HEAD' && !sameOriginRequest(req)) {
    return sendText(res, 403, 'cross-site request refused');
  }
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
    // The panel has no inline script or style, so it can run under a strict policy.
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    return serveStaticFile(req, res, path.join(PUBLIC_DIR, 'admin.html'));
  }
  // The panel lived at /_admin2/ while it replaced the old one; keep bookmarks working.
  if (pathname === '/_admin2' || pathname === '/_admin2/') {
    res.writeHead(301, { Location: '/_admin/' + new URL(req.url, 'http://local').search });
    return res.end();
  }

  if (pathname.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
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
  // The admin page's image list. Reads the folder from disk, which on a
  // 60k-image folder is a quarter second of main-thread time per call, so
  // it is not open to anonymous callers (the gallery page never used it).
  if (q.get('api') === 'list') {
    if (!isAdmin(req)) return sendText(res, 403, 'admin only');
    const { folders, images } = await listFolder(abs);
    const ml = (await loadManifest(abs)) || {};
    const hiddenFolders = Array.isArray(ml.hiddenFolders) ? ml.hiddenFolders : [];
    return sendJson(res, 200, { folders, images, hiddenFolders });
  }
  if (q.has('mkdir') && method === 'POST') {
    if (!isAdmin(req)) return sendText(res, 403, 'admin only');
    const name = q.get('mkdir').trim();
    if (!name || /[\x00-\x1f\/\\]/.test(name) || name.startsWith('.') || RESERVED.has(name))
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
    if (!name || /[\x00-\x1f\/\\]/.test(name) || name.startsWith('.') || RESERVED.has(name))
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

async function adminAction(req, res, fn) {
  if (req.method !== 'POST') return sendText(res, 405, 'POST required');
  if (!isAdmin(req)) return sendText(res, 403, 'admin only');
  try { const out = await fn(); sendText(res, 200, out == null ? 'ok' : String(out)); }
  catch (e) { sendText(res, 500, 'error: ' + e.message); }
}
