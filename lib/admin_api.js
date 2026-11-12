// /api/admin/*: passkey registration and login, login links, rescan,
// and the read/act endpoints behind the /_admin/ panel (folder status,
// build queue, per-folder rescan, session list and revocation).

import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import {
  InvalidPasskeyError,
  StateFileError,
  cancelAllLoginLinks,
  checkChallenge,
  clearSessionCookie,
  createPasskey,
  currentSessionToken,
  getPasskey,
  isAdmin,
  issueChallenge,
  loginLinks,
  mayEnrolPasskey,
  mayManageSessions,
  newSession,
  passkeyExists,
  savePasskey,
  saveSessions,
  sessionOriginFor,
  sessions,
  setSessionCookie,
  spendChallenge,
  takeLoginLink,
} from './auth.js';
import { buildQueue } from './build_queue.js';
import { GALLERIES_ROOT, GG_DIR, LOGIN_LINK_TTL, RP_NAME, VERSION } from './config.js';
import { badRequest, logText, notFound, readBody, sendJson } from './http.js';
import { listFolder, loadManifest, readHiddenSentinels } from './manifest.js';
import { resolveFolderField } from './paths.js';
import { rebuildTreeFromScratch, rescanFolder, rescanTree } from './rebuild.js';
import {
  b64uToBuf,
  bufToB64u,
  coseToPublicKey,
  decodeCBOR,
  parseAuthenticatorData,
  verifyES256Signature,
} from './webauthn.js';

// Tree walks in progress, keyed by folder relative to the galleries root
// ('' is the whole tree). A rescan builds what changed; a rebuild deletes
// every folder's build and makes it again. One walk per folder at a time;
// the panel shows them in its header.
const treeRescans = new Set();
const treeRebuilds = new Set();

// Fire-and-forget; the client polls /api/admin/queue to track progress.
// kind is 'rescan' or 'rebuild'.
function startTreeWalk(res, folderAbs, kind) {
  const key = path.relative(GALLERIES_ROOT, folderAbs);
  if (treeRescans.has(key) || treeRebuilds.has(key)) {
    return sendJson(res, 409, { error: 'a rescan or rebuild of that folder is already running' });
  }
  const running = kind === 'rebuild' ? treeRebuilds : treeRescans;
  const walk = kind === 'rebuild' ? rebuildTreeFromScratch : rescanTree;
  const label = key ? logText(key) : '(root)';
  running.add(key);
  walk(folderAbs)
    .then(n => console.log('[' + kind + '] ' + label + ' folders=' + n))
    .catch(e => console.warn('[' + kind + ']', label, e.message))
    .finally(() => running.delete(key));
  return sendJson(res, 200, { ok: true, started: true });
}

export async function handleAdminAPI(req, res, pathname, method) {
  try {
    return await routeAdminAPI(req, res, pathname, method);
  } catch (error) {
    // A damaged passkey.json: say which file and what to do, and refuse.
    if (error instanceof StateFileError) return sendJson(res, 500, { error: error.message });
    throw error;
  }
}

async function routeAdminAPI(req, res, pathname, method) {
  if (method === 'POST' && pathname === '/api/admin/logout') {
    const token = currentSessionToken(req);
    clearSessionCookie(res);
    if (token && sessions.delete(token)) {
      try { saveSessions(); }
      catch (error) { return sessionsNotSaved(res, error, 'Signed out of this browser, but the server could not save that, so the session comes back after a restart'); }
    }
    return sendJson(res, 200, { ok: true });
  }
  if (method === 'GET' && pathname === '/api/admin/probe') {
    const admin = isAdmin(req);
    // Every admin page load renews the cookie's lifetime.
    if (admin) setSessionCookie(req, res, currentSessionToken(req));
    const origin = admin ? sessionOriginFor(req) : null;
    // The version is for the admin only: anonymous callers get no fingerprint.
    // Always 200: every gallery page asks this, and "not signed in" is an
    // answer, not an error to show in each visitor's console.
    return sendJson(res, 200, {
      admin: admin,
      origin: origin,
      canCreatePasskey: admin && mayEnrolPasskey(origin) && !passkeyExists(),
      version: admin ? VERSION : null,
    });
  }
  if (method === 'GET' && pathname === '/api/admin/status') {
    return sendJson(res, 200, { passkeyExists: passkeyExists() });
  }
  if (method === 'POST' && pathname === '/api/admin/clearqueue') {
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin only' });
    const n = buildQueue.clear();
    console.log('[clearqueue] dropped=' + n + ' (workers still draining in-flight tiles)');
    return sendJson(res, 200, { ok: true, dropped: n });
  }
  // Enrolling the passkey takes a session made from a link made on the
  // server, so whoever enrols has the server: a fresh install is never an
  // open admin slot, and after the README's lost-passkey recovery (delete
  // passkey.json) a guest holding a panel-made link cannot take the site.
  if (method === 'POST' && pathname === '/api/admin/register/start') {
    const refusal = enrolmentRefusal(req);
    if (refusal) return sendJson(res, refusal.status, { error: refusal.error });
    return sendJson(res, 200, {
      challenge: issueChallenge('register', sessionIdFor(currentSessionToken(req))),
      rp: { name: RP_NAME },
      user: { id: bufToB64u(crypto.randomBytes(16)), name: 'admin', displayName: 'Goodgallery Admin' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      timeout: 60000,
      attestation: 'none'
    });
  }
  if (method === 'POST' && pathname === '/api/admin/register/finish') {
    let refusal = enrolmentRefusal(req);
    if (refusal) return sendJson(res, refusal.status, { error: refusal.error });
    if ((req.headers['content-type']||'').split(';')[0].trim() !== 'application/json') return sendJson(res, 415, { error: 'expected application/json' });
    let body;
    try { body = JSON.parse(await readBody(req, 1024 * 1024)); } catch { return badRequest(res); }
    const enrollingToken = currentSessionToken(req);

    const fields = passkeyResponseFields(body, ['attestationObject', 'clientDataJSON']);
    const clientData = fields && parseClientData(fields.clientDataJSON);
    if (!clientData) return sendJson(res, 400, { error: 'malformed passkey response' });
    if (clientData.type !== 'webauthn.create') return sendJson(res, 400, { error: 'bad clientData type' });
    const challengeId = checkChallenge(clientData.challenge, 'register', sessionIdFor(enrollingToken));
    if (!challengeId) return sendJson(res, 400, { error: 'challenge expired or invalid' });
    // clientData.origin is authenticator-signed; must match the Origin header.
    const reqOrigin = req.headers.origin;
    if (reqOrigin && clientData.origin !== reqOrigin) {
      console.warn('[webauthn] register origin mismatch:', logText(clientData.origin), 'vs', logText(reqOrigin));
      return sendJson(res, 400, { error: 'origin mismatch' });
    }
    if (!reqOrigin) console.warn('[webauthn] register: no Origin header on request, skipping origin check');
    // The attestation is binary from the client. Whatever the decoders
    // object to (truncated CBOR, no credential data, a key that is not
    // P-256), it is a bad request.
    let authData, algorithm, publicKey;
    try {
      const attestation = decodeCBOR(fields.attestationObject);
      authData = parseAuthenticatorData(attestation.authData);
      ({ algorithm, publicKey } = coseToPublicKey(decodeCBOR(authData.publicKeyBytes)));
    } catch {
      return sendJson(res, 400, { error: 'malformed attestation' });
    }
    const flagError = checkAuthenticatorData(authData, clientData.origin);
    if (flagError) return sendJson(res, 400, { error: flagError });

    // From here to the reply nothing waits, so no other request runs in
    // between. The body took as long as the client liked to arrive, so the
    // session is checked again (it may have been signed out meanwhile), and
    // the passkey is written only if none exists by now.
    refusal = enrolmentRefusal(req);
    if (refusal) return sendJson(res, refusal.status, { error: refusal.error });
    if (!spendChallenge(challengeId)) return sendJson(res, 400, { error: 'challenge already used' });
    let created;
    try {
      created = createPasskey({
        credentialId: bufToB64u(authData.credentialId),
        publicKey: bufToB64u(publicKey),
        algorithm,
        signCount: authData.signCount,
        origin: clientData.origin,
        createdAt: Date.now(),
      });
    } catch (error) {
      if (error instanceof InvalidPasskeyError) return sendJson(res, 400, { error: error.message });
      throw error;
    }
    if (!created) return sendJson(res, 400, { error: 'passkey already registered' });
    console.log('[webauthn] Admin passkey registered. Origin:', logText(clientData.origin));
    // The browser continues on a passkey session; the server-link session
    // it enrolled with is signed out, so it cannot enrol again later.
    let token;
    try { token = newSession('passkey', req.headers['user-agent'], enrollingToken); }
    catch (error) { return sessionsNotSaved(res, error, 'The passkey was created, but this sign-in could not be saved. Sign in with the passkey'); }
    setSessionCookie(req, res, token);
    return sendJson(res, 200, { success: true });
  }
  if (method === 'POST' && pathname === '/api/admin/login/start') {
    const pk = getPasskey();
    if (!pk) return sendJson(res, 400, { error: 'no passkey registered' });
    return sendJson(res, 200, {
      challenge: issueChallenge('login'),
      timeout: 60000,
      userVerification: 'required',
      allowCredentials: [{ type: 'public-key', id: pk.credentialId }],
    });
  }
  if (method === 'POST' && pathname === '/api/admin/login/finish') {
    if (!getPasskey()) return sendJson(res, 400, { error: 'no passkey' });
    if ((req.headers['content-type']||'').split(';')[0].trim() !== 'application/json') return sendJson(res, 415, { error: 'expected application/json' });
    let body;
    try { body = JSON.parse(await readBody(req, 1024 * 1024)); } catch { return badRequest(res); }
    // Read again after the body: the passkey may have been replaced meanwhile.
    const pk = getPasskey();
    if (!pk) return sendJson(res, 400, { error: 'no passkey' });

    const fields = passkeyResponseFields(body, ['clientDataJSON', 'authenticatorData', 'signature']);
    const clientData = fields && parseClientData(fields.clientDataJSON);
    if (!clientData) return sendJson(res, 400, { error: 'malformed passkey response' });
    if (body.id !== pk.credentialId) return sendJson(res, 400, { error: 'unknown credential' });
    if (clientData.type !== 'webauthn.get') return sendJson(res, 400, { error: 'bad clientData type' });
    const challengeId = checkChallenge(clientData.challenge, 'login');
    if (!challengeId) return sendJson(res, 400, { error: 'challenge expired or invalid' });

    const clientDataHash = crypto.createHash('sha256').update(fields.clientDataJSON).digest();
    const signedData = Buffer.concat([fields.authenticatorData, clientDataHash]);
    const publicKey = b64uToBuf(pk.publicKey);
    // Signature and authenticator data are binary from the client; a
    // decoder that throws on them means a bad request, same as a mismatch.
    let parsed;
    try {
      if (!verifyES256Signature(publicKey, fields.signature, signedData)) return sendJson(res, 400, { error: 'bad signature' });
      parsed = parseAuthenticatorData(fields.authenticatorData);
    } catch {
      return sendJson(res, 400, { error: 'malformed assertion' });
    }
    // The passkey was enrolled from one origin; an assertion for any other
    // origin is not for this site, whatever the request's own headers say.
    // Checked after the signature, so only the passkey itself can put a
    // line in the log here.
    if (clientData.origin !== pk.origin) {
      console.warn('[webauthn] login origin mismatch:', logText(clientData.origin), 'vs enrolled', logText(pk.origin));
      return sendJson(res, 400, { error: 'origin mismatch' });
    }
    const flagError = checkAuthenticatorData(parsed, pk.origin);
    if (flagError) return sendJson(res, 400, { error: flagError });
    if (!spendChallenge(challengeId)) return sendJson(res, 400, { error: 'challenge already used' });
    recordSignatureCounter(pk, parsed.signCount);
    let token;
    try { token = newSession('passkey', req.headers['user-agent']); }
    catch (error) { return sessionsNotSaved(res, error, 'Sign-in could not be saved'); }
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
    if (!mayManageSessions(sessionOriginFor(req))) {
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
  // previously signed in. The session records whether the link was made in
  // the panel or on the server.
  if (method === 'POST' && pathname === '/api/admin/login/redeem') {
    let body; try { body = JSON.parse(await readBody(req, 4 * 1024)); } catch { return badRequest(res); }
    const t = body && typeof body.token === 'string' ? body.token : '';
    if (!t) return sendJson(res, 400, { error: 'missing token' });
    const origin = takeLoginLink(t);
    if (!origin) return sendJson(res, 400, { error: 'invalid or expired link' });
    let token;
    try { token = newSession(origin, req.headers['user-agent']); }
    catch (error) { return sessionsNotSaved(res, error, 'The link was used, but the sign-in could not be saved. Make a new link'); }
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
      rebuilding: [...treeRebuilds],
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
    if (body.recursive) return startTreeWalk(res, folderAbs, 'rescan');
    rescanFolder(folderAbs).catch(e => console.warn('[rescanfolder]', logText(folderAbs), e.message));
    return sendJson(res, 200, { ok: true, started: true });
  }

  // Rebuild a folder and everything below it from scratch: the recursive
  // form of ?clearcache. Body: { folder: "a/b" }, empty for the whole tree.
  if (method === 'POST' && pathname === '/api/admin/rebuildtree') {
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin only' });
    const body = await readJsonBody(req, res);
    if (!body) return;
    const folderAbs = folderFromRelativePath(body.folder);
    if (!folderAbs) return sendJson(res, 400, { error: 'invalid folder' });
    if (!(await isDirectory(folderAbs))) return sendJson(res, 404, { error: 'no such folder' });
    return startTreeWalk(res, folderAbs, 'rebuild');
  }

  // Signed-in sessions. Tokens never leave the server; each session is
  // named by a short hash of its token.
  if (method === 'GET' && pathname === '/api/admin/sessions') {
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin only' });
    return sendJson(res, 200, { sessions: listSessions(currentSessionToken(req)) });
  }

  // Revoking needs the passkey, same rule as minting login links: a session
  // that came from a link must not be able to lock the passkey holder out.
  // Login links not yet redeemed are voided too, or a leaked one would sign
  // a browser straight back in.
  if (method === 'POST' && pathname === '/api/admin/sessions/revoke-others') {
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin only' });
    if (!mayManageSessions(sessionOriginFor(req))) return sendJson(res, 403, { error: 'only passkey-authenticated sessions can revoke sessions' });
    let cancelledLinks;
    try {
      cancelledLinks = cancelAllLoginLinks();
    } catch (error) {
      console.warn('[sessions] could not cancel server-made login links:', error.message);
      return sendJson(res, 500, { error: 'Login links made on the server could not be cancelled (' + (error.code || 'write failed') + '), so no session was signed out. Try again.' });
    }
    const keep = currentSessionToken(req);
    let revoked = 0;
    for (const token of Array.from(sessions.keys())) {
      if (token === keep) continue;
      sessions.delete(token);
      revoked++;
    }
    try { saveSessions(); }
    catch (error) { return sessionsNotSaved(res, error, 'Signed out ' + revoked + ' other session(s) for now, but the server could not save that, so they come back after a restart'); }
    return sendJson(res, 200, { ok: true, revoked, cancelledLinks });
  }

  return notFound(res);
}

// WebAuthn steps the signature alone does not cover: the authenticator data
// must name this site (rpIdHash is SHA-256 of the origin's host, which is
// the RP ID when none is configured), and the user must have been present
// and verified. The passkey is the only factor here, so verification is
// required rather than preferred.
function checkAuthenticatorData(parsed, origin) {
  let host;
  try { host = new URL(origin).hostname; } catch { return 'bad origin'; }
  const expected = crypto.createHash('sha256').update(host).digest();
  if (!parsed.rpIdHash || !expected.equals(parsed.rpIdHash)) return 'rpId mismatch';
  if (!(parsed.flags & 0x01)) return 'user presence required';
  if (!(parsed.flags & 0x04)) return 'user verification required';
  return null;
}

// Why this request may not enrol the passkey, or null if it may.
function enrolmentRefusal(req) {
  if (!isAdmin(req)) return { status: 401, error: 'sign in with a login link from the server first' };
  if (passkeyExists()) return { status: 400, error: 'passkey already registered' };
  if (!mayEnrolPasskey(sessionOriginFor(req))) {
    return { status: 403, error: 'only a browser signed in with a link made on the server (node server.js login-link) can create the passkey' };
  }
  return null;
}

// WebAuthn's clone check: a passkey that keeps a counter must report a
// higher one each time. Passkeys synced between devices always report 0.
// A counter that does not move up is logged, not refused: the owner would
// otherwise be locked out by an authenticator quirk, with no password to
// fall back on.
function recordSignatureCounter(passkey, reported) {
  if (reported > passkey.signCount) {
    passkey.signCount = reported;
    try { savePasskey(passkey); }
    catch (error) { console.warn('[webauthn] could not save the passkey signature counter:', error.message); }
    return;
  }
  if (reported !== 0 || passkey.signCount !== 0) {
    console.warn('[webauthn] passkey signature counter went backwards or did not move (' + reported + ', stored ' +
      passkey.signCount + '). The passkey may have been copied. Sign-in allowed.');
  }
}

// sessions.json could not be written. The reply says what that means for
// the user; the log gets the full error, the panel only its code (no paths).
function sessionsNotSaved(res, error, consequence) {
  console.warn('[sessions] could not save sessions.json:', error.message);
  return sendJson(res, 500, { error: consequence + ' (sessions.json: ' + (error.code || 'write failed') + ').' });
}

// ---------- Parsers for the passkey ceremony bodies ----------

// Binary fields arrive as unpadded base64url text, the way admin.js sends them.
const BASE64URL = /^[A-Za-z0-9_-]+$/;

// The body of register/finish and login/finish is
// { id, response: { <field>: base64url, ... } }. Returns the named fields
// decoded to Buffers, or null if the body is not that shape.
function passkeyResponseFields(body, fieldNames) {
  const response = body && typeof body === 'object' ? body.response : null;
  if (!response || typeof response !== 'object') return null;
  const fields = {};
  for (const name of fieldNames) {
    const value = response[name];
    if (typeof value !== 'string' || !BASE64URL.test(value)) return null;
    fields[name] = b64uToBuf(value);
  }
  return fields;
}

// clientDataJSON is JSON text written by the browser. Returns the object,
// or null if it is not JSON or not an object.
function parseClientData(buffer) {
  try {
    const clientData = JSON.parse(buffer.toString('utf8'));
    return clientData && typeof clientData === 'object' ? clientData : null;
  } catch {
    return null;
  }
}

// ---------- Helpers for the admin panel endpoints ----------

// "a/b" (or "/a/b/") -> absolute folder under GALLERIES_ROOT, or null.
function folderFromRelativePath(relativePath) {
  return resolveFolderField(relativePath);
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

