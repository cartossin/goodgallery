// /api/admin/*: passkey registration and login, login links, rescan,
// and the read/act endpoints behind the /_admin/ panel (folder status,
// build queue, per-folder rescan, session list and revocation).

import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import {
  SESSION_COOKIE,
  clearSessionCookie,
  getPasskey,
  isAdmin,
  loginLinks,
  takeLoginLink,
  newSession,
  pendingChallenges,
  savePasskey,
  saveSessions,
  sessionOriginFor,
  sessions,
  setSessionCookie,
} from './auth.js';
import { buildQueue } from './build_queue.js';
import { GALLERIES_ROOT, GG_DIR, LOGIN_LINK_TTL, RP_NAME } from './config.js';
import { badRequest, notFound, parseCookies, readBody, sendJson } from './http.js';
import { listFolder, loadManifest, readHiddenSentinels } from './manifest.js';
import { resolveGallery } from './paths.js';
import { rebuildFolderIfNeeded, rebuildTreeIfNeeded } from './rebuild.js';
import {
  b64uToBuf,
  bufToB64u,
  coseToPublicKey,
  decodeCBOR,
  parseAuthenticatorData,
  verifyES256Signature,
} from './webauthn.js';

// Tree walks in progress, keyed by folder relative to the galleries root
// ('' is the whole tree). One walk per folder at a time; the panel shows
// them in its header.
const treeRescans = new Set();

// Fire-and-forget; the client polls /api/admin/queue to track progress.
function startTreeRescan(res, folderAbs) {
  const key = path.relative(GALLERIES_ROOT, folderAbs);
  if (treeRescans.has(key)) return sendJson(res, 409, { error: 'that rescan is already running' });
  treeRescans.add(key);
  rebuildTreeIfNeeded(folderAbs)
    .then(n => console.log('[rescan] ' + (key || '(root)') + ' folders=' + n))
    .catch(e => console.warn('[rescan]', key || '(root)', e.message))
    .finally(() => treeRescans.delete(key));
  return sendJson(res, 200, { ok: true, started: true });
}

export async function handleAdminAPI(req, res, pathname, method) {
  if (method === 'POST' && pathname === '/api/admin/logout') {
    const cookies = parseCookies(req.headers.cookie);
    const tok = cookies[SESSION_COOKIE];
    if (tok && sessions.delete(tok)) saveSessions();
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }
  if (method === 'GET' && pathname === '/api/admin/probe') {
    const admin = isAdmin(req);
    // Every admin page load renews the cookie's lifetime.
    if (admin) setSessionCookie(req, res, currentSessionToken(req));
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
  // Enrolling the passkey needs a session first. Before any passkey exists
  // that session can only come from a link made on the server, so a fresh
  // install is never an open admin slot waiting for its first visitor.
  if (method === 'POST' && pathname === '/api/admin/register/start') {
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'sign in with a login link from the server first' });
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
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'sign in with a login link from the server first' });
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
    rememberSessionDevice(token, req);
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
    rememberSessionDevice(token, req);
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
  // session (replaces any existing session cookie). The link is
  // consumed on first successful redeem regardless of whether the caller was
  // previously signed in.
  if (method === 'POST' && pathname === '/api/admin/login/redeem') {
    let body; try { body = JSON.parse(await readBody(req, 4 * 1024)); } catch { return badRequest(res); }
    const t = body && typeof body.token === 'string' ? body.token : '';
    if (!t) return sendJson(res, 400, { error: 'missing token' });
    if (!takeLoginLink(t)) return sendJson(res, 400, { error: 'invalid or expired link' });
    const token = newSession('link');
    rememberSessionDevice(token, req);
    setSessionCookie(req, res, token);
    return sendJson(res, 200, { ok: true });
  }

  // ---------- Endpoints for the admin panel ----------

  // Build queue + which tree rescans are still walking. Cheap: the panel
  // polls it every few seconds for its status bar.
  if (method === 'GET' && pathname === '/api/admin/queue') {
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin only' });
    const progress = buildQueue.globalProgress();
    return sendJson(res, 200, {
      remaining: progress.remaining,
      etaSeconds: progress.etaSeconds,
      rescanning: [...treeRescans],
    });
  }

  // One folder's state plus a line per subfolder. ?path=a/b (relative to the
  // gallery root, empty for the root). Lists the folder itself from disk so
  // the panel can say when files changed outside the uploader; subfolders
  // are described from their cached manifests only.
  if (method === 'GET' && pathname === '/api/admin/folder') {
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin only' });
    const folderAbs = folderFromRelativePath(new URL(req.url, 'http://local').searchParams.get('path'));
    if (!folderAbs) return sendJson(res, 400, { error: 'invalid folder' });
    if (!(await isDirectory(folderAbs))) return sendJson(res, 404, { error: 'no such folder' });
    return sendJson(res, 200, await describeFolder(folderAbs));
  }

  // Rescan one folder: the same drift check the full rescan runs. Body:
  // { folder: "a/b", recursive?: true }; recursive walks its subfolders too.
  if (method === 'POST' && pathname === '/api/admin/rescanfolder') {
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin only' });
    const body = await readJsonBody(req, res);
    if (!body) return;
    const folderAbs = folderFromRelativePath(body.folder);
    if (!folderAbs) return sendJson(res, 400, { error: 'invalid folder' });
    if (!(await isDirectory(folderAbs))) return sendJson(res, 404, { error: 'no such folder' });
    if (body.recursive) return startTreeRescan(res, folderAbs);
    rebuildFolderIfNeeded(folderAbs).catch(e => console.warn('[rescanfolder]', folderAbs, e.message));
    return sendJson(res, 200, { ok: true, started: true });
  }

  // Signed-in sessions. Tokens never leave the server; each session is
  // named by a short hash of its token.
  if (method === 'GET' && pathname === '/api/admin/sessions') {
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin only' });
    return sendJson(res, 200, { sessions: listSessions(currentSessionToken(req)) });
  }

  // Revoking needs the passkey, same rule as minting login links: a session
  // that came from a link must not be able to lock the passkey holder out.
  if (method === 'POST' && pathname === '/api/admin/sessions/revoke-others') {
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin only' });
    if (sessionOriginFor(req) !== 'passkey') return sendJson(res, 403, { error: 'only passkey-authenticated sessions can revoke sessions' });
    const keep = currentSessionToken(req);
    let revoked = 0;
    for (const token of Array.from(sessions.keys())) {
      if (token === keep) continue;
      sessions.delete(token);
      revoked++;
    }
    saveSessions();
    return sendJson(res, 200, { ok: true, revoked });
  }

  return notFound(res);
}

// ---------- Helpers for the admin panel endpoints ----------

// "a/b" (or "/a/b/") -> absolute folder under GALLERIES_ROOT, or null.
function folderFromRelativePath(relativePath) {
  const segments = typeof relativePath === 'string' ? relativePath.split('/').filter(Boolean) : [];
  return resolveGallery(segments);
}

async function isDirectory(absolutePath) {
  try { return (await fsp.stat(absolutePath)).isDirectory(); }
  catch { return false; }
}

// Parses a JSON request body. On failure it has already answered the
// request and returns null.
async function readJsonBody(req, res) {
  if ((req.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') {
    sendJson(res, 415, { error: 'expected application/json' });
    return null;
  }
  try {
    const body = JSON.parse(await readBody(req, 64 * 1024));
    if (body && typeof body === 'object') return body;
  } catch {}
  badRequest(res);
  return null;
}

// How a name list on disk differs from the one in the last committed build.
function countDifferences(builtNames, diskNames) {
  const built = new Set(builtNames);
  const disk = new Set(diskNames);
  let added = 0, removed = 0;
  for (const name of disk) if (!built.has(name)) added++;
  for (const name of built) if (!disk.has(name)) removed++;
  return { added, removed };
}

// Build state from the committed manifest and the in-memory queue counters.
// built: a manifest exists, so the folder serves. queued: images of this
// folder waiting for or inside a build worker.
function buildStateFor(folderAbs, manifest) {
  const progress = buildQueue.progressFor(folderAbs);
  return {
    built: !!manifest,
    builtAt: manifest ? manifest.builtAt || null : null,
    queued: progress.pending + progress.inProgress,
    lastError: progress.lastError || null,
  };
}

async function countTrashItems(folderAbs) {
  try {
    const names = await fsp.readdir(path.join(folderAbs, GG_DIR, 'trash'));
    return names.filter(name => !name.startsWith('.')).length;
  } catch { return 0; }
}

async function describeSubfolder(parentAbs, name, hidden) {
  const folderAbs = path.join(parentAbs, name);
  const manifest = await loadManifest(folderAbs);
  return {
    name,
    hidden,
    imageCount: manifest ? manifest.images.length : null,
    folderCount: manifest ? manifest.folders.length : null,
    build: buildStateFor(folderAbs, manifest),
  };
}

async function describeFolder(folderAbs) {
  const onDisk = await listFolder(folderAbs);
  const manifest = await loadManifest(folderAbs);
  const hiddenNames = new Set(await readHiddenSentinels(folderAbs, onDisk.folders));
  const subfolders = [];
  for (const name of onDisk.folders) {
    subfolders.push(await describeSubfolder(folderAbs, name, hiddenNames.has(name)));
  }
  // What the gallery does not show yet: changes still being built, or files
  // added/removed outside the uploader (rsync, mv) that need a rescan.
  const notYetBuilt = manifest
    ? { images: countDifferences(manifest.images, onDisk.images), folders: countDifferences(manifest.folders, onDisk.folders) }
    : null;
  return {
    isRoot: folderAbs === GALLERIES_ROOT,
    imageCount: onDisk.images.length,
    hidden: await isHiddenFolder(folderAbs),
    notYetBuilt,
    build: buildStateFor(folderAbs, manifest),
    trashCount: await countTrashItems(folderAbs),
    subfolders,
  };
}

async function isHiddenFolder(folderAbs) {
  try { await fsp.access(path.join(folderAbs, GG_DIR, 'hidden')); return true; }
  catch { return false; }
}

function currentSessionToken(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
}

function sessionIdFor(token) {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function listSessions(currentToken) {
  const out = [];
  for (const [token, session] of sessions) {
    out.push({
      id: sessionIdFor(token),
      origin: session.origin || 'passkey',
      createdAt: session.createdAt,
      userAgent: session.userAgent || null,
      current: token === currentToken,
    });
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

// Store the signing-in browser's user agent with the session so the session
// list can tell devices apart. Sessions minted before this have none.
function rememberSessionDevice(token, req) {
  const session = sessions.get(token);
  if (!session) return;
  session.userAgent = String(req.headers['user-agent'] || '').slice(0, 300);
  saveSessions();
}
