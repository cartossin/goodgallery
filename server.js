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
import { brokenTilesReady } from './lib/build.js';
import { GALLERIES_ROOT, HOST, PORT, STATE_DIR } from './lib/config.js';
import { sendText } from './lib/http.js';
import { handle } from './lib/router.js';
import { preflightVips } from './lib/vips.js';

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
  server.listen(PORT, HOST, () => {
    console.log(`Goodgallery listening on http://${HOST}:${PORT}`);
    console.log(`  galleries root: ${GALLERIES_ROOT}`);
    console.log(`  state dir:      ${STATE_DIR}`);
  });
})();
