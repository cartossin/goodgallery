// `node server.js login-link`: mint a one-time admin login link and print it.
//
// It is the first way in on a new install, and the only way without HTTPS,
// where browsers refuse passkeys. It runs in its own process and hands the
// token to the server through a file in STATE_DIR (see lib/auth.js), so it
// must write that file where the service looks, as a file the service can
// read. It loads only lib/config.js and lib/auth.js: nothing that creates
// server directories.

import fs from 'fs';
import os from 'os';
import { mintCliLoginLink } from './auth.js';
import { LOGIN_LINK_TTL, PORT, STATE_DIR } from './config.js';
import { envFilePath } from './env_file.js';

// settingsFile: the settings file that was read (lib/env_file.js), or null.
export function runLoginLinkCommand(settingsFile) {
  const settingsSource = settingsFile ? `settings from ${settingsFile}` : 'settings from the environment only (no settings file)';
  requireStateDir(settingsSource);
  let token;
  try {
    token = mintCliLoginLink(stateDirOwnerIfRoot());
  } catch (error) {
    fail(`cannot write the link into ${STATE_DIR} (${error.code || error.message}). ` +
      `Run the command as root, or as the user that owns ${STATE_DIR}.`);
  }
  printLink(token);
  console.log(`(${settingsSource}; state dir ${STATE_DIR})`);
  process.exit(0);
}

function fail(message) {
  console.error('login-link: ' + message);
  process.exit(1);
}

// The service creates STATE_DIR when it first starts. A missing one almost
// always means the command is not using the service's settings, and creating
// it here would only hide that.
function requireStateDir(settingsSource) {
  let stats;
  try {
    stats = fs.statSync(STATE_DIR);
  } catch (error) {
    fail(`the state dir ${STATE_DIR} ${error.code === 'ENOENT' ? 'does not exist' : 'cannot be read (' + error.code + ')'}. ` +
      `This command used ${settingsSource}. If the service runs with other settings, put them in ${envFilePath()} ` +
      '(see "Configuration" in the README); if it has never started, start it once.');
  }
  if (!stats.isDirectory()) fail(`the state dir ${STATE_DIR} is not a directory.`);
}

// Run as root, the command hands its file to the owner of the state dir (the
// service user). Root's own file would be root-owned and 0600, and the
// service would refuse every link in it. (The command cannot simply become
// that user: Node refuses process.setuid() while libuv may use io_uring,
// CVE-2024-22017.)
function stateDirOwnerIfRoot() {
  if (process.getuid() !== 0) return null;
  const { uid, gid } = fs.statSync(STATE_DIR);
  return uid === 0 ? null : { uid, gid };  // null: a service that runs as root
}

function printLink(token) {
  console.log(`One-time admin login link, good for ${Math.round(LOGIN_LINK_TTL / 60000)} minutes:`);
  console.log(`  http://${os.hostname()}:${PORT}/#auth=${token}`);
  console.log('Use the address you normally open the gallery at if it differs.');
  console.log('The browser that opens it stays signed in until it signs out or is signed out from the admin page.');
}
