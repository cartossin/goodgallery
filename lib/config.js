// Runtime configuration: environment, on-disk layout constants, LoD tiers.
// Imports nothing of ours; everything else imports from here.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Single-threaded vips per subprocess. We do our own parallelism via the
// BuildQueue worker pool — letting libvips spin internal threads on top
// only causes lock contention and thread-setup overhead (esp. on tiny h5/h10
// LoDs that finish in milliseconds).
process.env.VIPS_CONCURRENCY = process.env.VIPS_CONCURRENCY || "1";

export const PORT             = parseInt(process.env.PORT || '3000', 10);
export const HOST             = process.env.HOST || '0.0.0.0';
export const GALLERIES_ROOT   = path.resolve(process.env.GALLERIES_ROOT || '/var/lib/goodgallery/galleries');
export const STATE_DIR        = path.resolve(process.env.STATE_DIR     || '/var/lib/goodgallery');
export const PUBLIC_DIR       = path.join(APP_ROOT, 'public');
// The release this code is. package.json is the one place it is written.
export const VERSION          = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;
export const PASSKEY_FILE     = path.join(STATE_DIR, 'passkey.json');
export const SITE_TITLE       = process.env.SITE_TITLE || 'Goodgallery';
// Small tiers are lossless `.v` (raw, fast to decode for atlas packing);
// large tiers are AVIF Q=80.
export const LOD_TIERS = [
  { h: 5,   format: 'v',    quality: null },
  { h: 10,  format: 'v',    quality: null },
  { h: 50,  format: 'v',    quality: null },
  { h: 100, format: 'v',    quality: null },
  { h: 200, format: 'avif', quality: 80 },
  { h: 400, format: 'avif', quality: 80 },
  { h: 800,  format: 'avif', quality: 80 },
  { h: 1600, format: 'avif', quality: 80 },
];
export function lodPath(thumbDir, filename, height, format) {
  return path.join(thumbDir, filename + '.h' + height + '.' + format);
}

// Sprite size is capped by target file bytes. Translate bytes → pixel budget via
// an empirical bytes/pixel constant; tune BYTES_PER_PIXEL lower for flat-color
// content, higher for extreme detail.
const MAX_SPRITE_BYTES  = parseInt(process.env.MAX_SPRITE_BYTES || String(4 * 1024 * 1024), 10);
const BYTES_PER_PIXEL   = parseFloat(process.env.BYTES_PER_PIXEL || '0.30');
export const MAX_SPRITE_PIXELS = Math.max(1, Math.floor(MAX_SPRITE_BYTES / BYTES_PER_PIXEL));
// Recorded in each atlas's _sprite.json; bumped whenever the packing rule
// changes (cell shape, tier set). It is not part of the atlas hash: an
// atlas packed under an older rule still serves, and is re-packed under the
// current rule when its folder next changes.
export const SPRITE_LAYOUT_VERSION = 6;

export const LOGIN_LINK_TTL   = 10 * 60 * 1000;
export const RP_NAME          = SITE_TITLE;

// Each gallery folder owns a child dir named GG_DIR holding all derived state
// (manifest, per-image LoDs, atlases). RESERVED names are excluded from listings.
export const GG_DIR = 'gg';
export const RESERVED = new Set([GG_DIR]);
const SUPPORTED_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif']);

export function isImage(name) {
  return SUPPORTED_EXT.has(path.extname(name).toLowerCase());
}

// Concurrency = N CPUs (vips is single-threaded per process). Per-(folder,file)
// dedupe collapses repeated triggers. ensureBuilt is idempotent + atomic, so a
// process kill loses only in-memory progress counters, never on-disk integrity.
export const BUILD_CONCURRENCY = parseInt(process.env.BUILD_CONCURRENCY || '0', 10) || os.cpus().length;

// Pre-rendered red-X tiles substituted for images vips cannot read.
export const BROKEN_SVG = path.join(PUBLIC_DIR, 'broken.svg');
export const BROKEN_DIR = path.join(STATE_DIR, '_broken');

// Data directories must exist before any module touches them.
fs.mkdirSync(GALLERIES_ROOT, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });
