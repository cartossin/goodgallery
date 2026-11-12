// libvips subprocess helpers.

import fs from 'fs';
import os from 'os';
import { spawn, spawnSync } from 'child_process';
import { AVIF_MAX_DIM, BROKEN_SVG } from './config.js';

// Per-image LoDs written via tmp+rename for atomicity. AVIF for displayable
// tiers; lossless .v for atlas-input tiers so packing is decode-free.
// libheif enforces a per-axis cap on AVIF saves (16384 on this build; HEIF
// spec ceiling). Passing this as the vips thumbnail max-width means extreme-
// wide panoramas land slightly under the nominal tier height — e.g. an
// h1600 of a 46592×3720 image becomes 1308×16384 instead of failing
// outright. The tier filename still says "h1600"; the renderer uses that as
// an identifier, not a literal dimension promise. (AVIF_MAX_DIM is a setting.)

// libvips picks a loader by sniffing the file, not by its extension, and its
// ImageMagick, Ghostscript/PDF and SVG loaders have a long exploit history.
// Originals come from anywhere (uploads, rsync), so those loaders are blocked
// while an original is read. Our own files are read without the block: the
// .v tile format itself counts as untrusted, and broken.svg needs SVG.
const UNTRUSTED_INPUT_ENV = { ...process.env, VIPS_BLOCK_UNTRUSTED: '1' };
export function vipsHeightThumbAVIF(srcAbs, dstAbs, height, quality) {
  return new Promise((resolve, reject) => {
    const tmp = dstAbs + '.__tmp.avif';
    const args = [
      'thumbnail', srcAbs, tmp + '[Q=' + quality + ']', String(AVIF_MAX_DIM),
      '--height', String(height),
      '--size', 'down',
    ];
    runStep('vips', args, tmp, { untrustedInput: true }).then(() =>
      fs.promises.rename(tmp, dstAbs).then(resolve, reject)
    ).catch(reject);
  });
}

// Build a .v thumb in a single vipsthumbnail call. Three wins over the prior
// three-spawn (thumbnail → colourspace srgb → extract_band) pipeline:
//   1. One process spawn instead of three. vips startup is ~65 ms; saving two
//      spawns is ~130 ms per build at the cheapest tiers (h5..h100).
//   2. vipsthumbnail uses libjpeg shrink-on-load, decoding JPEGs at 1/2, 1/4,
//      or 1/8 native resolution without fully decompressing. h100 from a 5000-
//      wide JPEG decodes ~8x faster.
//   3. No intermediate .v files on disk between steps. Less ZFS write traffic.
//
// Band normalization (forcing exactly 3 bands) used to be done via extract_band.
// We drop that step entirely: the sprite atlas packer (`packAtlasBuffer` in
// sprite_worker.js) already handles 1, 3, and 4-band raw .v inputs and copies
// them into a 3-band RGB atlas on the fly. The on-disk .v can be whatever vips
// produced; the consumer normalizes at pack time.
export function vipsHeightThumbV(srcAbs, dstAbs, height) {
  return new Promise((resolve, reject) => {
    const tmp = dstAbs + '.__tmp.v';
    runStep('vipsthumbnail', [
      srcAbs,
      '--size', '99999x' + height,
      '--export-profile', 'srgb',
      '-o', tmp,
    ], tmp, { untrustedInput: true }).then(() =>
      fs.promises.rename(tmp, dstAbs).then(resolve, reject)
    ).catch(reject);
  });
}

// Run a vips subcommand and verify expectedOutput exists.
// Builds run below interactive priority so pageviews stay responsive while
// every core is busy encoding.
function lowerPriority(proc) {
  try { os.setPriority(proc.pid, 10); } catch {}
}

export function runStep(cmd, args, expectedOutput, { untrustedInput = false } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { env: untrustedInput ? UNTRUSTED_INPUT_ENV : process.env });
    lowerPriority(proc);
    let err = '', out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('error', reject);
    proc.on('close', code => {
      const exists = fs.existsSync(expectedOutput);
      if (code !== 0 || !exists) {
        // Not logged here: the caller decides what one failure is worth saying.
        return reject(new Error(`${cmd} ${args[0]} produced no output (code=${code}): ${err.trim() || '(silent)'}`));
      }
      resolve();
    });
  });
}

// Every build step shells out to libvips, so refuse to start without it
// rather than failing on the first pageview.
export function preflightVips() {
  for (const tool of ['vips', 'vipsthumbnail', 'vipsheader']) {
    const probe = spawnSync(tool, ['--version']);
    if (probe.error || probe.status !== 0) {
      console.error(`[fatal] '${tool}' is missing or not runnable. Install libvips (Debian: apt install libvips-tools).`);
      process.exit(1);
    }
  }
  const svgProbe = spawnSync('vipsheader', [BROKEN_SVG]);
  if (svgProbe.status !== 0) {
    console.warn('[warn] libvips cannot load SVG (missing librsvg support); broken-image placeholders will not be generated.');
  }
}
