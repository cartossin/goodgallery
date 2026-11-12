// HTTP plumbing: responses, cookies, request bodies, static files.

import fsp from 'fs/promises';
import path from 'path';
import { pipeline } from 'stream';
import { PUBLIC_DIR } from './config.js';

export function hxEscape(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
// JSON for use inside an inline <script>. JSON.stringify leaves "<" alone,
// so a value containing "</script>" would end the script element; folder
// names reach this. Those characters, and the two line terminators JSON
// allows but JavaScript did not, are written as \uXXXX escapes.
export function jsLiteral(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,
    c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
export function jsString(s) {
  return jsLiteral(String(s));
}
export function parseCookies(h) {
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
export function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': body.length });
  res.end(body);
}
export function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text);
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': body.length });
  res.end(body);
}
export function notFound(res, msg = 'not found') { sendText(res, 404, msg); }
export function badRequest(res, msg = 'bad request') { sendText(res, 400, msg); }

export function readBody(req, limit = 32 * 1024 * 1024) {
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

// Reads a JSON request body that must be an object ({...}): anything else
// (null, an array, a number) has no fields to read. On failure it has
// already answered the request and returns null.
export async function readJsonObject(req, res, limit) {
  if ((req.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') {
    sendJson(res, 415, { error: 'expected application/json' });
    return null;
  }
  let body;
  try { body = JSON.parse(await readBody(req, limit)); }
  catch { badRequest(res); return null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { error: 'expected a JSON object' });
    return null;
  }
  return body;
}

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
export function serveStatic(req, res, rel) {
  if (rel.includes('..') || /[\x00-\x1f]/.test(rel)) return notFound(res);
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

// The file is opened before anything is answered, and the size and dates
// come from the open file, so a file that is unreadable or deleted in the
// meantime fails this request only. The body is sent with stream.pipeline,
// which closes the file when the client goes away or a read fails.
export async function serveStaticFile(req, res, abs) {
  let file;
  try {
    file = await fsp.open(abs, 'r');
  } catch (err) {
    return answerOpenFailure(res, abs, err);
  }
  let st;
  try {
    st = await file.stat();
  } catch (err) {
    await file.close();
    return answerOpenFailure(res, abs, err);
  }
  if (!st.isFile()) {
    await file.close();
    return notFound(res);
  }
  // Weak ETag from size+mtime is cheap and sufficient for browser
  // conditional GETs. Rebuild produces a new mtime so cache invalidates.
  const etag = 'W/"' + st.size.toString(36) + '-' + Math.floor(st.mtimeMs).toString(36) + '"';
  if (isNotModified(req, etag, st.mtimeMs)) {
    await file.close();
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
  if (req.method === 'HEAD' || st.size === 0) {
    await file.close();
    return res.end();
  }
  // Exactly the stat'ed length, so the body matches Content-Length even
  // if the file grows while it is sent.
  const body = file.createReadStream({ start: 0, end: st.size - 1 });
  pipeline(body, res, err => {
    // A client hanging up mid-download is normal. A read error after the
    // headers went out can only be signalled by cutting the connection,
    // which pipeline has already done.
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      console.warn('[serve] read failed', JSON.stringify(abs), err.code || err.message);
    }
  });
}

// RFC 9110 13.1.3: when If-None-Match is sent it alone decides, and
// If-Modified-Since is ignored. A file replaced by an older one (cp -p,
// rsync -t) has a new ETag but an older date, and must not get a 304.
function isNotModified(req, etag, mtimeMs) {
  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch !== undefined) return etagListMatches(ifNoneMatch, etag);
  const ifModifiedSince = Date.parse(req.headers['if-modified-since'] || '');
  if (Number.isNaN(ifModifiedSince)) return false;
  // HTTP dates carry whole seconds; Last-Modified is the mtime rounded down.
  return Math.floor(mtimeMs / 1000) * 1000 <= ifModifiedSince;
}
// If-None-Match is "*" or a comma-separated list of ETags, compared weakly
// (W/ prefixes ignored), as the RFC asks for GET and HEAD.
function etagListMatches(header, etag) {
  if (header.trim() === '*') return true;
  const opaque = tag => tag.trim().replace(/^W\//, '');
  return header.split(',').some(tag => opaque(tag) === opaque(etag));
}

// Missing files are a 404. Anything else (permissions, out of descriptors)
// is the server's problem: a 500 for this request, and a line for the operator.
function answerOpenFailure(res, abs, err) {
  if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EISDIR') return notFound(res);
  console.warn('[serve] cannot open', JSON.stringify(abs), err.code || err.message);
  return sendText(res, 500, 'cannot read this file');
}
