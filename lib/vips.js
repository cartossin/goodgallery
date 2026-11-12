// libvips subprocess helpers.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { AVIF_MAX_DIM, BROKEN_SVG, MAX_SOURCE_MEGAPIXELS, VIPS_TIMEOUT_SECONDS } from './config.js';

// Per-image LoDs written via tmp+rename for atomicity. AVIF for displayable
// tiers; lossless .v for atlas-input tiers so packing is decode-free.
// libheif enforces a per-axis cap on AVIF saves (16384 on this build; HEIF
// spec ceiling). Passing this as the vips thumbnail max-width means extreme-
// wide panoramas land slightly under the nominal tier height — e.g. an
// h1600 of a 46592×3720 image becomes 1308×16384 instead of failing
// outright. The tier filename still says "h1600"; the renderer uses that as
// an identifier, not a literal dimension promise. (AVIF_MAX_DIM is a setting.)

// vipsthumbnail converts its -o argument from the locale's character set, so
// under LANG=C (the default for system services) or an uninstalled locale a
// file or folder name with any non-ASCII character fails to convert ("Invalid
// byte sequence in conversion input"). Every vips child therefore runs under
// C.UTF-8, whatever the server's own environment: glibc has it built in, so it
// exists on a stock Debian without the locales package.
const VIPS_ENV = { ...process.env, LC_ALL: 'C.UTF-8' };

// libvips picks a loader by sniffing the file, not by its extension, and its
// ImageMagick, Ghostscript/PDF and SVG loaders have a long exploit history.
// Originals come from anywhere (uploads, rsync), so those loaders are blocked
// while an original is read. Our own files are read without the block: the
// .v tile format itself counts as untrusted, and broken.svg needs SVG.
const UNTRUSTED_INPUT_ENV = { ...VIPS_ENV, VIPS_BLOCK_UNTRUSTED: '1' };
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

// Builds run below interactive priority so pageviews stay responsive while
// every core is busy encoding.
function lowerPriority(proc) {
  try { os.setPriority(proc.pid, 10); } catch {}
}

// No vips call may run forever: a hung child would hold a build slot, and
// with it its folder's rebuild, until the server restarts. The slowest real
// call measured is tens of seconds (a 60000x60000 PNG's h5 took 14 s; an atlas
// sheet encode on a loaded box under a minute), so ten minutes only ever
// catches a child that is stuck.
const VIPS_TIMEOUT_MS = VIPS_TIMEOUT_SECONDS * 1000;

// Photos above this many pixels get the placeholder instead of renditions.
// libvips decodes PNG, WebP, GIF and AVIF whole (only JPEG shrinks on load),
// so the cost follows the pixel count, not the file size: a 3.5 MB PNG of
// 60000x60000 took 2.8 GB in one vips process, and every build worker can be
// running one. 300 megapixels is three times the largest camera sensors
// (100-150 MP medium format) and covers stitched phone and drone panoramas;
// a 300 MP PNG measured about 0.7 GB per process (report 6).
export const MAX_SOURCE_PIXELS = MAX_SOURCE_MEGAPIXELS * 1e6;

// Why a vips call failed. 'exit' means vips ran and refused (it printed why);
// the others mean it never got to finish: it could not be started, it was
// killed (out of memory, a signal), or it ran past VIPS_TIMEOUT_MS.
export class VipsError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;  // 'not-started' | 'killed' | 'timed-out' | 'exit' | 'no-output'
  }
}

// Every vips process running in this thread, so a shutdown can stop them.
const runningVips = new Set();
let stopping = false;

// Kill every running vips process and start no more. The server exits right
// after; .__tmp files the killed processes leave are swept by the next build.
// A call cut short this way neither resolves nor rejects: a rejection would
// record the photo as a failed build.
export function stopVipsProcesses() {
  stopping = true;
  for (const proc of runningVips) proc.kill('SIGKILL');
}

// Run one vips command line. Resolves with its stdout (when captureStdout is
// set) or rejects with a VipsError.
function runVips(cmd, args, { untrustedInput = false, captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    if (stopping) return;
    const proc = spawn(cmd, args, {
      env: untrustedInput ? UNTRUSTED_INPUT_ENV : VIPS_ENV,
      stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'pipe'],
    });
    runningVips.add(proc);
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    // First, before anything can throw: a spawn that fails (EMFILE, EAGAIN,
    // ENOENT) has no stdout or stderr, and its 'error' event with no listener
    // would end the whole server.
    proc.on('error', e => { runningVips.delete(proc); settle(reject, new VipsError(`${cmd} ${args[0]} could not be started: ${e.message}`, 'not-started')); });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      settle(reject, new VipsError(`${cmd} ${args[0]} timed out after ${VIPS_TIMEOUT_MS / 1000} s`, 'timed-out'));
    }, VIPS_TIMEOUT_MS);
    lowerPriority(proc);
    let out = '', err = '';
    proc.stdout?.on('data', d => { out += d; });
    proc.stderr?.on('data', d => { err += d; });
    proc.on('close', (code, signal) => {
      runningVips.delete(proc);
      if (stopping) { clearTimeout(timer); return; }
      // Not logged here: the caller decides what one failure is worth saying.
      if (signal) return settle(reject, new VipsError(`${cmd} ${args[0]} was killed (${signal})`, 'killed'));
      if (code !== 0) return settle(reject, new VipsError(`${cmd} ${args[0]} failed (code=${code}): ${err.trim() || '(silent)'}`, 'exit'));
      settle(resolve, out);
    });
  });
}

// Run a vips subcommand and verify expectedOutput exists.
export async function runStep(cmd, args, expectedOutput, { untrustedInput = false } = {}) {
  await runVips(cmd, args, { untrustedInput });
  if (!fs.existsSync(expectedOutput)) {
    throw new VipsError(`${cmd} ${args[0]} produced no output`, 'no-output');
  }
}

// Width and height of a photo, from its header only (cheap: no pixels are
// decoded). Rejects with kind 'exit' when vips cannot read the file at all.
export async function readPhotoSize(srcAbs) {
  const out = await runVips('vipsheader', [srcAbs], { untrustedInput: true, captureStdout: true });
  // "<path>: 2560x1600 uchar, 3 bands, srgb, jpegload". The path may hold
  // anything, so read the size from the end of the line.
  const size = /: (\d+)x(\d+) [^:]*$/.exec(out.trim());
  if (!size) throw new VipsError('vipsheader printed no size: ' + out.trim().slice(0, 200), 'exit');
  return { width: Number(size[1]), height: Number(size[2]) };
}

// Every build step shells out to libvips, so refuse to start without it
// rather than failing on the first pageview. Being installed is not enough:
// the renditions are AVIF, and libvips saves AVIF through libheif, whose AV1
// encoder is a separate plugin. On Debian 13 that plugin is only a
// "Recommends" of libheif, so `apt install --no-install-recommends` and most
// container images leave it out, and without the probe below every gallery
// would sit at "Building…" for good.
export function preflightVips() {
  for (const tool of ['vips', 'vipsthumbnail', 'vipsheader']) {
    const probe = spawnSync(tool, ['--version'], { env: VIPS_ENV });
    if (probe.error || probe.status !== 0) {
      console.error(`[fatal] '${tool}' is missing or not runnable. Install libvips (Debian: apt install libvips-tools).`);
      process.exit(1);
    }
  }
  const version = vipsVersion();
  if (version && (version.major < 8 || (version.major === 8 && version.minor < MINIMUM_VIPS_MINOR))) {
    console.error(`[fatal] libvips ${version.text} is too old: Goodgallery needs 8.${MINIMUM_VIPS_MINOR} or newer, ` +
      'which can refuse its risky loaders (VIPS_BLOCK_UNTRUSTED) for photos from uploads.');
    process.exit(1);
  }
  const avifProblem = avifEncodeProblem();
  if (avifProblem) {
    console.error(`[fatal] libvips cannot save AVIF: ${avifProblem}`);
    console.error('[fatal] Install the AV1 encoder for libheif. Debian and Ubuntu: apt install libheif-plugin-aomenc. ' +
      'Rocky/RHEL with remi: dnf install vips-heif.');
    process.exit(1);
  }
  // The placeholder tile for a photo that cannot be read is made from an SVG.
  // Without it one unreadable photo would fail its whole folder's build.
  const svgProbe = spawnSync('vipsheader', [BROKEN_SVG], { env: VIPS_ENV });
  if (svgProbe.status !== 0) {
    console.error('[fatal] libvips cannot load SVG, which the placeholder for unreadable photos is made from. ' +
      'Install a libvips with librsvg support (the Debian, Ubuntu and remi packages have it).');
    process.exit(1);
  }
}

// VIPS_BLOCK_UNTRUSTED (see UNTRUSTED_INPUT_ENV) arrived in libvips 8.13;
// older versions ignore it and would open every original with every loader.
const MINIMUM_VIPS_MINOR = 13;
function vipsVersion() {
  const match = /vips-(\d+)\.(\d+)\.(\d+)/.exec(String(spawnSync('vips', ['--version']).stdout));
  if (!match) return null;  // an unknown format: let the AVIF probe below speak
  return { major: Number(match[1]), minor: Number(match[2]), text: `${match[1]}.${match[2]}.${match[3]}` };
}

// Encode a tiny image to AVIF in a temp directory, the way the renditions
// are saved (vips, Q=80). Returns null on success, else what vips said.
function avifEncodeProblem() {
  let dir;
  try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goodgallery-avif-probe-')); }
  catch (error) {
    console.error(`[fatal] cannot use the temp directory ${os.tmpdir()} (${error.code || error.message}). Check TMPDIR.`);
    process.exit(1);
  }
  try {
    const output = path.join(dir, 'probe.avif');
    const probe = spawnSync('vips', ['black', output + '[Q=80]', '16', '16']);
    if (probe.error) return probe.error.message;
    const saved = fs.existsSync(output) && fs.statSync(output).size > 0;
    if (probe.status === 0 && saved) return null;
    return String(probe.stderr).trim() || `vips exited with status ${probe.status} and wrote no file`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
