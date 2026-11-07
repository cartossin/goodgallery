// Admin sessions, the session cookie and the stored passkey.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { LOGIN_LINK_TTL, PASSKEY_FILE, STATE_DIR } from './config.js';
import { parseCookies } from './http.js';

export const sessions         = new Map();  // token -> { createdAt }
export const pendingChallenges = new Map(); // chalId -> { challenge, timestamp }
export const loginLinks       = new Map(); // token -> { createdAt } — single-use, 10min TTL

// Persist sessions so a restart doesn't 401 everyone whose cookie is still valid.
const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
function loadSessions() {
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
    const obj = JSON.parse(raw);
    for (const [tok, data] of Object.entries(obj)) {
      if (!data.origin) data.origin = 'passkey';
      sessions.set(tok, data);
    }
    if (sessions.size) console.log(`Restored ${sessions.size} admin session(s) from disk.`);
  } catch {}
}
export function saveSessions() {
  const obj = Object.fromEntries(sessions);
  const tmp = SESSIONS_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, SESSIONS_FILE);
  } catch (e) { console.warn('saveSessions failed:', e.message); }
}
loadSessions();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingChallenges) if (now - v.timestamp > 5 * 60 * 1000) pendingChallenges.delete(k);
  for (const [k, v] of loginLinks)       if (now - v.createdAt  > LOGIN_LINK_TTL)   loginLinks.delete(k);
}, 60 * 1000);

// Login links made on the server with `node server.js login-link`. That
// command runs in its own process, so it hands the token to the server
// through a file that the server consumes on redeem. Panel-minted links
// stay in memory (loginLinks above). Before any passkey exists this is the
// only way in, which keeps a fresh install from being claimed by whoever
// reaches the admin URL first.
const CLI_LINKS_FILE = path.join(STATE_DIR, 'cli-login-links.json');
function liveCliLinks() {
  let links;
  try { links = JSON.parse(fs.readFileSync(CLI_LINKS_FILE, 'utf8')); } catch { links = {}; }
  const now = Date.now();
  for (const [token, entry] of Object.entries(links)) {
    if (now - entry.createdAt > LOGIN_LINK_TTL) delete links[token];
  }
  return links;
}
function writeCliLinks(links) {
  const tmp = CLI_LINKS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(links));
  fs.renameSync(tmp, CLI_LINKS_FILE);
}
export function mintCliLoginLink() {
  const token = crypto.randomBytes(32).toString('base64url');
  const links = liveCliLinks();
  links[token] = { createdAt: Date.now() };
  writeCliLinks(links);
  return token;
}
// Consume a login link, panel-minted or server-minted. True at most once
// per token. If the CLI file cannot be rewritten the redeem fails rather
// than letting the token work again after a restart.
export function takeLoginLink(token) {
  const inMemory = loginLinks.get(token);
  if (inMemory) {
    loginLinks.delete(token);
    return Date.now() - inMemory.createdAt <= LOGIN_LINK_TTL;
  }
  const links = liveCliLinks();
  if (!links[token]) return false;
  delete links[token];
  writeCliLinks(links);
  return true;
}

export function getPasskey() {
  try { return JSON.parse(fs.readFileSync(PASSKEY_FILE, 'utf8')); }
  catch { return null; }
}
export function savePasskey(pk) {
  fs.writeFileSync(PASSKEY_FILE + '.tmp', JSON.stringify(pk, null, 2));
  fs.renameSync(PASSKEY_FILE + '.tmp', PASSKEY_FILE);
}

// HttpOnly session cookie: sent automatically, not readable by JS.
// Sessions do not expire on the server: one ends when it is signed out or
// revoked, or when the browser loses the cookie. 400 days is the longest
// lifetime browsers honor, and every admin page load sets the cookie again,
// so a browser that keeps coming back keeps its session.
export const SESSION_COOKIE = 'ggSession';
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
export function setSessionCookie(req, res, token) {
  const isSecure = req.headers['x-forwarded-proto'] === 'https' || (req.connection && req.connection.encrypted);
  const flags = ['HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${COOKIE_MAX_AGE_SECONDS}`];
  if (isSecure) flags.push('Secure');
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; ${flags.join('; ')}`);
}
export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

export function newSession(origin) {
  if (origin !== 'passkey' && origin !== 'link') {
    throw new Error('newSession: origin must be "passkey" or "link"');
  }
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { createdAt: Date.now(), origin: origin });
  saveSessions();
  return token;
}
// Returns 'passkey' | 'link' | null. Used by endpoints that need to make
// origin-aware decisions (e.g. only passkey sessions can mint login links).
export function sessionOriginFor(req) {
  const cookies = parseCookies(req.headers.cookie);
  const tok = cookies[SESSION_COOKIE];
  if (!tok) return null;
  const s = sessions.get(tok);
  if (!s) return null;
  return s.origin || 'passkey';
}
export function isAdmin(req) {
  const cookies = parseCookies(req.headers.cookie);
  const tok = cookies[SESSION_COOKIE];
  if (!tok) return false;
  return sessions.has(tok);
}
