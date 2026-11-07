// Goodgallery 2.0 — Node.js. Zero runtime npm deps. libvips for image work.
//
// On-disk layout:
//   GALLERIES_ROOT/<path...>/<image>                    originals
//   GALLERIES_ROOT/<path...>/gg/<image>.h<H>.<format>   per-image LoDs (avif/v)
//   GALLERIES_ROOT/<path...>/gg/atlas_<hash>/           sprite atlases + imagemap
//   GALLERIES_ROOT/<path...>/gg/_manifest.json          per-gallery manifest
//   GALLERIES_ROOT/<path...>/gg/trash/<image>           soft-deleted (per-folder)
//   GALLERIES_ROOT/<path...>/gg/hidden                  sentinel: folder hidden from listings
//
// Each folder is its own gallery; subfolders appear as cards in the parent.
//
// Modules live in lib/; this file only wires up the HTTP server.

import http from 'http';
import os from 'os';
import { getPasskey, mintCliLoginLink, sessions } from './lib/auth.js';
import { brokenTilesReady } from './lib/build.js';
import { GALLERIES_ROOT, HOST, LOGIN_LINK_TTL, PORT, STATE_DIR } from './lib/config.js';
import { sendText } from './lib/http.js';
import { rebuildTreeIfNeeded } from './lib/rebuild.js';
import { handle } from './lib/router.js';
import { preflightVips } from './lib/vips.js';

// `node server.js login-link` mints a one-time admin login link and exits.
// It is the first way in on a new install, and the only way without HTTPS,
// where browsers refuse passkeys.
const command = process.argv[2];
if (command === 'login-link') {
  const token = mintCliLoginLink();
  console.log(`One-time admin login link, good for ${Math.round(LOGIN_LINK_TTL / 60000)} minutes:`);
  console.log(`  http://${os.hostname()}:${PORT}/#auth=${token}`);
  console.log('Use the address you normally open the gallery at if it differs.');
  console.log('The browser that opens it stays signed in until it signs out or is signed out from the admin page.');
  process.exit(0);
} else if (command) {
  console.error(`unknown command "${command}". Usage: node server.js [login-link]`);
  process.exit(2);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error('[handler error]', req.method, req.url, err);
    if (!res.headersSent) sendText(res, 500, 'internal error');
  });
});
(async () => {
  preflightVips();
  // Startup is O(1): LoDs and atlases build on first pageview. An interrupted
  // build leaves only an atlas_<hash>_building/ dir, which the next rebuild sweeps.
  brokenTilesReady();  // kick off placeholder tile generation (memoized)
  // Folders whose atlas predates the current packing rule, or whose sources
  // changed while we were down, re-bake in the background. Pageviews keep
  // serving the previous atlas until each new one is committed.
  rebuildTreeIfNeeded(GALLERIES_ROOT)
    .then(n => console.log('[startup rescan] folders=' + n))
    .catch(e => console.warn('[startup rescan]', e.message));
  server.listen(PORT, HOST, () => {
    console.log(`Goodgallery listening on http://${HOST}:${PORT}`);
    console.log(`  galleries root: ${GALLERIES_ROOT}`);
    console.log(`  state dir:      ${STATE_DIR}`);
    if (!getPasskey() && sessions.size === 0) {
      console.log('  no admin yet: run `node server.js login-link` and open the link it prints');
    }
  });
})();
