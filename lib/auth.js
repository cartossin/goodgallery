// Admin sessions, the session cookie, login links, passkey challenges and
// the stored passkey.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { LOGIN_LINK_TTL, PASSKEY_FILE, STATE_DIR } from './config.js';
import { parseCookies } from './http.js';

// ---------- State files ----------

// A state file that exists but cannot be used. It is never read as "absent":
// a damaged passkey.json must not reopen enrolment, and a damaged
// sessions.json must not be replaced by an empty one on the next save.
// The message names the file only, so it can be shown in the panel.
export class StateFileError extends Error {
  constructor(file, problem, advice) {
    super(`${path.basename(file)} ${problem}. ${advice}`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Reads and parses a JSON state file. Returns undefined when it does not exist.
function readStateFile(file, advice) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new StateFileError(file, `cannot be read (${error.code || error.message})`, advice);
  }
  try { return JSON.parse(text); }
  catch { throw new StateFileError(file, 'is not valid JSON', advice); }
}

// Temp file + rename, so a reader never sees half a file.
function writeStateFile(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Writes are synchronous and take microseconds, so a temp file older than
// this belongs to a process that died between write and rename. The age
// test keeps `node server.js login-link`, which loads this module too, from
// removing a temp file the running server is about to rename.
const ORPHAN_TEMP_FILE_AGE_MS = 10 * 1000;
function sweepOrphanTempFiles() {
  for (const file of [SESSIONS_FILE + '.tmp', PASSKEY_FILE + '.tmp']) {
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > ORPHAN_TEMP_FILE_AGE_MS) fs.unlinkSync(file);
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[auth] could not remove leftover', path.basename(file) + ':', error.code || error.message);
    }
  }
}

// ---------- Sessions ----------

// origin: 'passkey' or 'link' (signed in with a login link).
const SESSION_ORIGINS = new Set(['passkey', 'link']);
export const sessions = new Map();  // token -> { createdAt, origin, userAgent }

const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
const SESSIONS_ADVICE = 'Fix it, or remove it to sign every browser out';
// Tokens we mint are 43 characters; anything this long from the same
// alphabet is accepted, so hand-made test sessions keep working. Short keys
// such as "0" (an array saved as an object) are not tokens.
const STORED_TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,}$/;

// One stored session, checked and copied; null when it is not a session.
function sessionFromDisk(token, entry) {
  if (!STORED_TOKEN_SHAPE.test(token) || !isPlainObject(entry)) return null;
  if (!Number.isFinite(entry.createdAt)) return null;
  // Sessions saved before origins were recorded were all passkey sign-ins.
  const origin = entry.origin === undefined ? 'passkey' : entry.origin;
  if (!SESSION_ORIGINS.has(origin)) return null;
  const session = { createdAt: entry.createdAt, origin };
  if (typeof entry.userAgent === 'string') session.userAgent = entry.userAgent;
  return session;
}

function loadSessions() {
  const stored = readStateFile(SESSIONS_FILE, SESSIONS_ADVICE);
  if (stored === undefined) return;
  if (!isPlainObject(stored)) throw new StateFileError(SESSIONS_FILE, 'must be a JSON object of sessions', SESSIONS_ADVICE);
  let skipped = 0;
  for (const [token, entry] of Object.entries(stored)) {
    const session = sessionFromDisk(token, entry);
    if (session) sessions.set(token, session);
    else skipped++;
  }
  if (sessions.size) console.log(`Restored ${sessions.size} admin session(s) from disk.`);
  if (skipped) console.warn(`[auth] skipped ${skipped} damaged entr${skipped === 1 ? 'y' : 'ies'} in sessions.json.`);
}

// Throws when the file cannot be written. Callers report that: a sign-out
// that is not saved comes back after a restart.
export function saveSessions() {
  writeStateFile(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions)));
}

// Signs a browser in. Nothing changes in memory unless the save succeeds.
export function newSession(origin, userAgent) {
  if (!SESSION_ORIGINS.has(origin)) throw new Error('newSession: unknown origin ' + origin);
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { createdAt: Date.now(), origin, userAgent: String(userAgent || '').slice(0, 300) });
  try {
    saveSessions();
  } catch (error) {
    sessions.delete(token);
    throw error;
  }
  return token;
}

export function currentSessionToken(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
}
// Returns 'passkey' | 'link' | null.
export function sessionOriginFor(req) {
  const session = sessions.get(currentSessionToken(req));
  return session ? session.origin : null;
}
export function isAdmin(req) {
  const token = currentSessionToken(req);
  return !!token && sessions.has(token);
}

// ---------- Login links ----------

// Panel-made links live in memory. Links made on the server with
// `node server.js login-link` come from another process, so they are handed
// over in a file the server consumes on redeem. Before any passkey exists a
// server-made link is the only way in, which keeps a fresh install from
// being claimed by whoever reaches the admin URL first.
export const loginLinks = new Map(); // token -> { createdAt }; single use, LOGIN_LINK_TTL
const CLI_LINKS_FILE = path.join(STATE_DIR, 'cli-login-links.json');
// Every token we mint is 32 random bytes as base64url: 43 characters.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
// The file is a JSON object keyed by token. Read it into a Map so a lookup
// can only ever match a token we wrote, never a property every object
// inherits (a token of "constructor" must not redeem).
function liveCliLinks() {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(CLI_LINKS_FILE, 'utf8')); } catch { parsed = {}; }
  const links = new Map();
  const now = Date.now();
  for (const [token, entry] of Object.entries(parsed)) {
    if (!TOKEN_SHAPE.test(token)) continue;
    if (!entry || typeof entry.createdAt !== 'number') continue;
    if (now - entry.createdAt > LOGIN_LINK_TTL) continue;
    links.set(token, entry);
  }
  return links;
}
function writeCliLinks(links) {
  const tmp = CLI_LINKS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(links)), { mode: 0o600 });
  fs.renameSync(tmp, CLI_LINKS_FILE);
}
export function mintCliLoginLink() {
  const token = crypto.randomBytes(32).toString('base64url');
  const links = liveCliLinks();
  links.set(token, { createdAt: Date.now() });
  writeCliLinks(links);
  return token;
}
// Consume a login link, panel-minted or server-minted. True at most once
// per token. If the CLI file cannot be rewritten the redeem fails rather
// than letting the token work again after a restart.
export function takeLoginLink(token) {
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return false;
  const inMemory = loginLinks.get(token);
  if (inMemory) {
    loginLinks.delete(token);
    return Date.now() - inMemory.createdAt <= LOGIN_LINK_TTL;
  }
  const links = liveCliLinks();
  if (!links.has(token)) return false;
  links.delete(token);
  writeCliLinks(links);
  return true;
}
// ---------- Passkey challenges ----------

// A challenge carries its own proof that this server issued it, so nothing
// is stored per ceremony and anonymous login/start calls cannot crowd out
// the owner's. Layout: issuedAt (8 bytes, ms) | nonce (16) | HMAC (32) over
// the purpose ('login' or 'register'), what it is bound to (the enrolling
// session for 'register'), issuedAt and nonce.
//
// The key is made fresh for each server process. Challenges issued before a
// restart are therefore void after it, as they were when the server kept a
// table of them, and a captured sign-in cannot be replayed into a new
// process whose list of spent challenges is empty.
const CHALLENGE_KEY = crypto.randomBytes(32);
const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
const CHALLENGE_BODY_BYTES = 24;
const CHALLENGE_BYTES = CHALLENGE_BODY_BYTES + 32;

function challengeMac(purpose, binding, body) {
  return crypto.createHmac('sha256', CHALLENGE_KEY).update(purpose + '\0' + binding + '\0').update(body).digest();
}

export function issueChallenge(purpose, binding = '') {
  const body = Buffer.alloc(CHALLENGE_BODY_BYTES);
  body.writeBigUInt64BE(BigInt(Date.now()), 0);
  crypto.randomFillSync(body, 8, 16);
  return Buffer.concat([body, challengeMac(purpose, binding, body)]).toString('base64url');
}

// The challenge as echoed in clientDataJSON. Returns an id for
// spendChallenge, or null if this server did not issue it for this purpose
// and binding within CHALLENGE_LIFETIME_MS.
export function checkChallenge(text, purpose, binding = '') {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.length !== CHALLENGE_BYTES) return null;
  const body = bytes.subarray(0, CHALLENGE_BODY_BYTES);
  if (!crypto.timingSafeEqual(bytes.subarray(CHALLENGE_BODY_BYTES), challengeMac(purpose, binding, body))) return null;
  const age = Date.now() - Number(body.readBigUInt64BE(0));
  if (age < 0 || age > CHALLENGE_LIFETIME_MS) return null;
  return body.toString('base64url');
}

// Challenges that already completed a ceremony, until they expire. Only a
// verified passkey signature (or enrolment) adds one, so this cannot be
// flooded the way a table of every issued challenge could.
const spentChallenges = new Map(); // id -> expiresAt
// True the first time, false if the challenge was already used.
export function spendChallenge(id) {
  if (spentChallenges.has(id)) return false;
  spentChallenges.set(id, Date.now() + CHALLENGE_LIFETIME_MS);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, expiresAt] of spentChallenges) if (now > expiresAt) spentChallenges.delete(id);
  for (const [token, link] of loginLinks) if (now - link.createdAt > LOGIN_LINK_TTL) loginLinks.delete(token);
}, 60 * 1000).unref();

// ---------- Passkey ----------

const PASSKEY_ADVICE = 'Restore it from a backup, or remove it and enrol a new passkey from a server-made login link (node server.js login-link)';
const BASE64URL_TEXT = /^[A-Za-z0-9_-]+$/;

// What is wrong with a parsed passkey.json, or null if nothing is.
function passkeyProblem(passkey) {
  if (!isPlainObject(passkey)) return 'must be a JSON object';
  if (typeof passkey.credentialId !== 'string' || !BASE64URL_TEXT.test(passkey.credentialId)) return 'has no valid credentialId';
  // An uncompressed P-256 point: 0x04, then 32 bytes each of x and y.
  const key = typeof passkey.publicKey === 'string' && BASE64URL_TEXT.test(passkey.publicKey) ? Buffer.from(passkey.publicKey, 'base64url') : null;
  if (!key || key.length !== 65 || key[0] !== 0x04) return 'has no valid publicKey';
  if (passkey.algorithm !== 'ES256') return 'has an unsupported algorithm';
  if (!Number.isInteger(passkey.signCount) || passkey.signCount < 0) return 'has no valid signCount';
  try { new URL(passkey.origin); } catch { return 'has no valid origin'; }
  return null;
}

// The enrolled passkey, or null when none is enrolled (no passkey.json).
// Throws StateFileError when the file exists but is unusable, so a damaged
// file never reads as "no passkey, enrolment open".
export function getPasskey() {
  const passkey = readStateFile(PASSKEY_FILE, PASSKEY_ADVICE);
  if (passkey === undefined) return null;
  const problem = passkeyProblem(passkey);
  if (problem) throw new StateFileError(PASSKEY_FILE, problem, PASSKEY_ADVICE);
  return passkey;
}
// Whether a passkey is enrolled, for pages and the panel. A damaged file
// counts as enrolled: it keeps enrolment shut, and sign-in reports it.
export function passkeyExists() {
  return fs.existsSync(PASSKEY_FILE);
}
export function savePasskey(passkey) {
  writeStateFile(PASSKEY_FILE, JSON.stringify(passkey, null, 2));
}

// ---------- Session cookie ----------

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

// ---------- Start-up ----------

// A state file that cannot be used stops the server with a message, before
// it serves anything.
try {
  sweepOrphanTempFiles();
  loadSessions();
  getPasskey();
} catch (error) {
  if (!(error instanceof StateFileError)) throw error;
  console.error(`[fatal] ${error.message}. State dir: ${STATE_DIR}`);
  process.exit(1);
}
