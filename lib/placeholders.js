// Which photos are shown as the red-X placeholder, and why.
//
// A size vips could not make gets a copy of the pre-rendered placeholder tile
// (build.js). Why matters, because only some causes go away:
//   unreadable  vips cannot read the file at all (not an image, truncated
//               header, a format the build refuses). It stays until the file
//               changes.
//   too-large   above MAX_SOURCE_MEGAPIXELS (vips.js). Retried once the limit
//               is raised.
//   failed      the photo's header was read, but making a size failed: vips
//               was killed (out of memory), timed out, could not start, or
//               refused to encode (a missing AVIF encoder, a locale problem).
//               Retried.
//   unknown     a placeholder found on disk with no reason recorded: folders
//               built before reasons were recorded (rc.2 recorded none, and
//               turned every failure into a placeholder). Retried.
// Retries happen when an admin rescans the folder, never at startup or on a
// page view, so a cause that persists costs nothing until someone asks.
//
// gg/_placeholders.json: { "<photo>": { reason, detail, tiers: ["h5.v", ...],
// pixels? } }. A missing file means "not known yet", and the next build of the
// folder looks at the renditions themselves.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { BROKEN_DIR, GG_DIR, LOD_TIERS, lodPath } from './config.js';
import { MAX_SOURCE_PIXELS } from './vips.js';

export const tierKey = tier => 'h' + tier.h + '.' + tier.format;
const tierByKey = new Map(LOD_TIERS.map(tier => [tierKey(tier), tier]));
export const tiersFromKeys = keys => keys.map(key => tierByKey.get(key)).filter(Boolean);

function recordPath(galleryAbs) {
  return path.join(galleryAbs, GG_DIR, '_placeholders.json');
}

export async function readPlaceholderRecord(galleryAbs) {
  try {
    const record = JSON.parse(await fsp.readFile(recordPath(galleryAbs), 'utf8'));
    return isPlaceholderRecord(record) ? record : null;
  } catch { return null; }
}

// A record with an entry of the wrong shape (edited by hand, damaged) is
// treated as no record at all: the next build then looks at the renditions
// themselves and writes a fresh one, instead of failing on it every time.
function isPlaceholderRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  return Object.values(record).every(entry =>
    entry && typeof entry === 'object' && typeof entry.reason === 'string' &&
    Array.isArray(entry.tiers) && entry.tiers.every(key => typeof key === 'string'));
}

export async function writePlaceholderRecord(galleryAbs, record) {
  const file = recordPath(galleryAbs);
  await fsp.writeFile(file + '.tmp', JSON.stringify(record));
  await fsp.rename(file + '.tmp', file);
}

// Would trying this photo again possibly give it real renditions?
export function isRetryable(entry) {
  if (entry.reason === 'failed' || entry.reason === 'unknown') return true;
  if (entry.reason === 'too-large') return Number(entry.pixels) <= MAX_SOURCE_PIXELS;
  return false;
}

export function placeholderTilePath(tier) {
  return path.join(BROKEN_DIR, 'broken.h' + tier.h + '.' + tier.format);
}

// Is this file a byte-for-byte copy of the placeholder tile for its size?
export async function isPlaceholderCopy(file, tier) {
  try {
    const [copy, placeholder] = await Promise.all([fsp.stat(file), fsp.stat(placeholderTilePath(tier))]);
    if (copy.size !== placeholder.size) return false;
    const [a, b] = await Promise.all([fsp.readFile(file), fsp.readFile(placeholderTilePath(tier))]);
    return a.equals(b);
  } catch { return false; }
}

// For a folder with no record: which existing renditions are placeholder
// copies. A size check first, so a real rendition costs one stat.
export async function findUnrecordedPlaceholders(galleryAbs, images, present) {
  if (!LOD_TIERS.every(tier => fs.existsSync(placeholderTilePath(tier)))) return null;  // cannot tell yet
  const thumbDir = path.join(galleryAbs, GG_DIR);
  const found = {};
  for (const name of images) {
    const tiers = [];
    for (const [index, tier] of LOD_TIERS.entries()) {
      if (!(present.get(name) & (1 << index))) continue;
      if (await isPlaceholderCopy(lodPath(thumbDir, name, tier.h, tier.format), tier)) tiers.push(tierKey(tier));
    }
    if (tiers.length) found[name] = { reason: 'unknown', detail: 'made before reasons were recorded', tiers };
  }
  return found;
}

// The record after a build: what each photo's placeholder sizes are now.
// outcomes: the jobs that ran, with their buildRenditions results.
export function updatedPlaceholderRecord(previous, images, outcomes) {
  const outcomeByName = new Map(outcomes.map(outcome => [outcome.name, outcome]));
  const record = {};
  for (const name of images) {
    const before = previous[name];
    const outcome = outcomeByName.get(name);
    if (!outcome) { if (before) record[name] = before; continue; }
    const { built, placeholders, failure } = outcome.result;
    const remade = new Set(built.map(tierKey));
    const tiers = new Set((before ? before.tiers : []).filter(key => !remade.has(key)));
    for (const tier of placeholders) tiers.add(tierKey(tier));
    if (tiers.size === 0) continue;
    record[name] = failure ? { ...failure, tiers: [...tiers] } : { ...before, tiers: [...tiers] };
  }
  return record;
}

// Did this job change what one size of the photo shows? A real rendition
// always does; a placeholder only where there was none before.
export function tierChanged(outcome, tier, previousEntry) {
  if (outcome.result.built.includes(tier)) return true;
  if (!outcome.result.placeholders.includes(tier)) return false;
  return !(previousEntry && previousEntry.tiers.includes(tierKey(tier)));
}
