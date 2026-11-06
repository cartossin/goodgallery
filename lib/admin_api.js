// /api/admin/*: passkey registration and login, login links, rescan.

import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import {
  SESSION_COOKIE,
  clearSessionCookie,
  getPasskey,
  isAdmin,
  loginLinks,
  newSession,
  pendingChallenges,
  savePasskey,
  saveSessions,
  sessionOriginFor,
  sessions,
  setSessionCookie,
} from './auth.js';
import { buildQueue } from './build_queue.js';
import { GALLERIES_ROOT, LOGIN_LINK_TTL, RESERVED, RP_NAME, isImage } from './config.js';
import { badRequest, notFound, parseCookies, readBody, sendJson } from './http.js';
import { rebuildFolderIfNeeded } from './rebuild.js';
import {
  b64uToBuf,
  bufToB64u,
  coseToPublicKey,
  decodeCBOR,
  parseAuthenticatorData,
  verifyES256Signature,
} from './webauthn.js';

let fullrescanInProgress = false;

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
  if (method === 'POST' && pathname === '/api/admin/fullrescan') {
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin only' });
    if (fullrescanInProgress) return sendJson(res, 409, { error: 'a full rescan is already running' });
    fullrescanInProgress = true;
    // Fire-and-forget. walkRebuild dispatches a rebuildFolderIfNeeded per
    // folder; the client polls ?build-status to track progress.
    (async () => {
      try {
        // Walk the gallery tree. For each folder with content, dispatch a
        // rebuildFolderIfNeeded (fire-and-forget). The drift check is cheap
        // for already-current folders; actual rebuilds run in the background.
        let rebuilt = 0;
        async function walkRebuild(dir) {
          let entries;
          try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
          let hasContent = false;
          const subs = [];
          for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            if (e.isDirectory()) {
              if (!RESERVED.has(e.name)) { subs.push(e.name); hasContent = true; }
            } else if (e.isFile() && isImage(e.name)) hasContent = true;
          }
          if (hasContent) {
            // Fire-and-forget per folder. rebuildFolderIfNeeded handles dedup
            // and per-folder atomicity internally; the walk just dispatches.
            rebuildFolderIfNeeded(dir).catch(e => console.warn('[fullrescan:rebuild]', dir, e.message));
            rebuilt++;
          }
          for (const sub of subs) await walkRebuild(path.join(dir, sub));
        }
        rebuildFolderIfNeeded(GALLERIES_ROOT).catch(()=>{}); rebuilt++;
        await walkRebuild(GALLERIES_ROOT);
        console.log('[fullrescan] folders=' + rebuilt);
      } catch (e) { console.warn('[fullrescan]', e.message); }
      finally { fullrescanInProgress = false; }
    })();
    return sendJson(res, 200, { ok: true, started: true });
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
  // normal 24h session (replaces any existing session cookie). The link is
  // consumed on first successful redeem regardless of whether the caller was
  // previously signed in.
  if (method === 'POST' && pathname === '/api/admin/login/redeem') {
    let body; try { body = JSON.parse(await readBody(req, 4 * 1024)); } catch { return badRequest(res); }
    const t = body && typeof body.token === 'string' ? body.token : '';
    if (!t) return sendJson(res, 400, { error: 'missing token' });
    const entry = loginLinks.get(t);
    if (!entry) return sendJson(res, 400, { error: 'invalid or expired link' });
    if (Date.now() - entry.createdAt > LOGIN_LINK_TTL) {
      loginLinks.delete(t);
      return sendJson(res, 400, { error: 'invalid or expired link' });
    }
    loginLinks.delete(t);
    const token = newSession('link');
    setSessionCookie(req, res, token);
    return sendJson(res, 200, { ok: true });
  }

  return notFound(res);
}
