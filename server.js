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
// Modules live in lib/; this file only wires up the HTTP server and the
// `login-link` command. Our modules are loaded with import() rather than at
// the top of this file because the order matters: the command must read the
// settings file before lib/config.js reads the settings, and the server must
// check its directories before the modules that create directories inside
// them load (the command loads none of those).

import http from 'http';
import { loadEnvFile } from './lib/env_file.js';

const command = process.argv[2];
if (command === 'login-link') {
  const settingsFile = loadEnvFile();
  const { runLoginLinkCommand } = await import('./lib/login_link.js');
  runLoginLinkCommand(settingsFile);
} else if (command) {
  console.error(`unknown command "${command}". Usage: node server.js [login-link]`);
  process.exit(2);
} else {
  await startServer();
}

async function startServer() {
  const config = await import('./lib/config.js');  // exits on an invalid setting
  config.prepareDataDirectories();
  const { preflightVips, stopVipsProcesses } = await import('./lib/vips.js');
  preflightVips();
  const { stopAtlasWorker } = await import('./lib/atlas.js');
  const { getPasskey, sessions } = await import('./lib/auth.js');
  const { brokenTilesReady } = await import('./lib/build.js');
  const { sendText } = await import('./lib/http.js');
  const { rebuildTreeIfNeeded } = await import('./lib/rebuild.js');
  const { handle } = await import('./lib/router.js');

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      console.error('[handler error]', req.method, req.url, err);
      if (!res.headersSent) sendText(res, 500, 'internal error');
    });
  });
  server.on('error', error => {
    console.error(`[fatal] cannot listen on ${config.HOST} port ${config.PORT}: ${listenErrorText(error)}`);
    process.exit(1);
  });

  // Startup is O(1): LoDs and atlases build on first pageview. An interrupted
  // build leaves only an atlas_<hash>_building/ dir, which the next rebuild sweeps.
  brokenTilesReady();  // kick off placeholder tile generation (memoized)
  // Folders whose atlas predates the current packing rule, or whose sources
  // changed while we were down, re-bake in the background. Pageviews keep
  // serving the previous atlas until each new one is committed.
  rebuildTreeIfNeeded(config.GALLERIES_ROOT)
    .then(n => console.log('[startup rescan] folders=' + n))
    .catch(e => console.warn('[startup rescan]', e.message));
  server.listen(config.PORT, config.HOST, () => {
    printStartupLines(config, !getPasskey() && sessions.size === 0);
  });

  // A plain `kill` (SIGTERM) or Ctrl-C (SIGINT) must not leave vips processes
  // behind, still writing into gg/ after the server is gone. Under systemd
  // the unit's cgroup is killed anyway; a server run by hand has no such net.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, async () => {
      console.log(`[shutdown] ${signal}: stopping image builds`);
      stopVipsProcesses();
      await stopAtlasWorker();
      // End the way the signal would have, so systemd and shells see the
      // usual status for it.
      process.kill(process.pid, signal);
    });
  }
}

function listenErrorText(error) {
  if (error.code === 'EADDRINUSE') return 'the port is in use by another program. Set PORT to a free port.';
  if (error.code === 'EACCES') return 'permission denied (ports below 1024 need privileges). Set PORT to 1024 or above.';
  if (error.code === 'EADDRNOTAVAIL') return 'this machine has no such address. Set HOST to one of its addresses, or 0.0.0.0 for all.';
  if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') return 'HOST is not an address or a name that resolves. Set HOST to an IP address, or 0.0.0.0 for all.';
  return error.message;
}

function printStartupLines(config, noAdminYet) {
  const addresses = config.addressesToOpen();
  console.log(`Goodgallery ${config.VERSION} listening on ${config.HOST} port ${config.PORT}`);
  if (addresses.fromElsewhere) console.log(`  open:           ${addresses.fromElsewhere} (or the address your proxy serves)`);
  if (addresses.onThisMachine) console.log(`  on this machine: ${addresses.onThisMachine}`);
  console.log(`  galleries root: ${config.GALLERIES_ROOT}`);
  console.log(`  state dir:      ${config.STATE_DIR}`);
  if (noAdminYet) {
    console.log(`  no admin yet: on this machine run \`node ${process.argv[1]} login-link\` (as root or as this server's user) and open the link it prints.`);
    console.log('  Passkeys work only over HTTPS or on localhost; at any other address, an IP address included, sign in with such links.');
  }
}
