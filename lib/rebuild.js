// No filesystem watcher: recursive fs.watch re-walks the tree on every event,
// which costs an entire core's worth of getdents64 once gg/ gets large.
// The uploader writes files we already know about; rsync drops are picked up
// via the admin "Full rescan" button.

import fsp from 'fs/promises';
import path from 'path';
import {
  bakeAtlasSerialized,
  readSpriteMeta,
  legacyAtlasHash,
  loadSpriteMetaFile,
  newAtlasDirName,
  spriteMetaCache,
  sweepFolderTmps,
  sweepLegacyAtlasFiles,
  sweepOrphanLoDs,
  sweepStaleAtlases,
} from './atlas.js';
import { allRenditionsPresent, isAtlasTier, scanRenditions, tiersToBuild } from './build_plan.js';
import { buildQueue } from './build_queue.js';
import {
  findUnrecordedPlaceholders,
  isRetryable,
  readPlaceholderRecord,
  tierChanged,
  tiersFromKeys,
  updatedPlaceholderRecord,
  writePlaceholderRecord,
} from './placeholders.js';
import { GG_DIR, LOD_TIERS, isImage } from './config.js';
import { logText } from './http.js';
import { isServableName } from './paths.js';
import {
  currentSignatures,
  readRecordedSignatures,
  signaturesMatch,
  trustOf,
  writeRecordedSignatures,
} from './sources.js';
import {
  MANIFEST_VERSION,
  listFolder,
  loadManifest,
  manifestCache,
  readHiddenSentinels,
  writeManifest,
} from './manifest.js';

// rebuildFolder is the single entry point for putting a folder into a
// committed state. The contract: when this resolves successfully, a
// _manifest.json exists on disk and every file it references is fully
// built (LoDs + sprite + imagemap).
//
// Flow:
//   1. listFolder → target image+folder set from disk
//   2. per photo, which sizes need making (build_plan.js) → build queue
//   3. a new atlas if the atlas inputs changed — serialized globally
//   4. atomic write of _manifest.json, then the signature record

const rebuildInFlight = new Map();  // galleryAbs -> Promise<void>
const manifestWrites = new Map();   // galleryAbs -> tail of its chain of manifest writes
const failedBuilds = new Map();     // galleryAbs -> why its last build failed (cleared by a success)
const rebuildAgain = new Map();     // galleryAbs -> options, asked for again while in flight

function _arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function photoRemoved(previousImages, images) {
  const current = new Set(images);
  return previousImages.some(name => !current.has(name));
}

// Legacy manifests (pre-2b.2, no atlasDir) lack a stored content hash.
// Detect source drift the only way we can: compare each source's mtime
// against the manifest builtAt. Any source newer than the build → drift.
async function legacyManifestFresh(galleryAbs, images, builtAt) {
  if (!builtAt) return false;
  for (const name of images) {
    const stat = await fsp.stat(path.join(galleryAbs, name)).catch(() => null);
    if (stat && stat.mtimeMs > builtAt) return false;
  }
  return true;
}

// Was this manifest, written before signatures were recorded, built from the
// photos as they are now (by the only test those builds allow)?
async function builtBeforeSignatures(galleryAbs, manifest, images) {
  if (!manifest || !_arraysEqual(manifest.images, images)) return false;
  if (manifest.atlasDir) return manifest.atlasDir === 'atlas_' + await legacyAtlasHash(galleryAbs, images);
  return legacyManifestFresh(galleryAbs, images, manifest.builtAt);
}

// The signature record to judge the photos by, or null if there is none to
// trust. A folder built before records existed (rc.1, or rc.2 before its
// first check) gets one now if its build still matches its photos, so an
// upgrade does not rebuild it.
async function signatureRecord(galleryAbs, manifest, images, signatures) {
  const recorded = await readRecordedSignatures(galleryAbs);
  if (recorded !== null) return recorded;
  if (!(await builtBeforeSignatures(galleryAbs, manifest, images))) return null;
  await writeRecordedSignatures(galleryAbs, signatures);
  return signatures;
}

// Does the committed build still show this folder as it is on disk? Checks
// the listing, every photo's signature, that the atlas can be read and that
// every rendition exists, so a photo changed in any way the signature sees
// and anything deleted from gg/ by hand both count as changes. With
// retryPlaceholders (an admin's rescan), placeholders worth another try, or
// not known yet, count too.
async function folderIsCurrent(galleryAbs, { folders, images }, hiddenFolders, { retryPlaceholders }) {
  const manifest = await loadManifest(galleryAbs);
  if (!manifest ||
      !_arraysEqual(manifest.images, images) ||
      !_arraysEqual(manifest.folders, folders) ||
      !_arraysEqual(manifest.hiddenFolders, hiddenFolders)) return false;
  const signatures = await currentSignatures(galleryAbs, images);
  const recorded = await signatureRecord(galleryAbs, manifest, images, signatures);
  if (!recorded || !signaturesMatch(recorded, signatures)) return false;
  if (images.length === 0) return true;
  if (!(await loadSpriteMetaFile(galleryAbs, manifest.atlasDir || ''))) return false;
  if (!allRenditionsPresent(await scanRenditions(path.join(galleryAbs, GG_DIR), images))) return false;
  if (retryPlaceholders) {
    const placeholders = await readPlaceholderRecord(galleryAbs);
    if (placeholders === null || Object.values(placeholders).some(isRetryable)) return false;
  }
  return true;
}

// rebuildFolderIfNeeded is the public entry point: a cheap check first, and
// a rebuild only when the folder changed. retryPlaceholders: also try again
// the photos whose placeholders may go away (see placeholders.js); only an
// admin's rescan asks for that (rescanFolder, rescanTree).
// beforeListing (rebuild from scratch): runs inside the rebuild, before the
// folder is looked at, so that deleting the old build and making the new one
// are one rebuild that nothing else can start a build in the middle of.
export function rebuildFolderIfNeeded(galleryAbs, { retryPlaceholders = false, beforeListing = null } = {}) {
  if (rebuildInFlight.has(galleryAbs)) {
    // The running rebuild listed the folder when it started, so a file that
    // landed since (upload, rsync drop) is not in it. Check once more after
    // it finishes instead of leaving that file invisible until the next rescan.
    const again = rebuildAgain.get(galleryAbs);
    rebuildAgain.set(galleryAbs, { retryPlaceholders: retryPlaceholders || !!(again && again.retryPlaceholders) });
    return rebuildInFlight.get(galleryAbs);
  }
  const options = { retryPlaceholders };
  const p = (async () => {
    try {
      if (beforeListing) await beforeListing();
      const listing = await listFolder(galleryAbs);
      const hiddenFolders = await readHiddenSentinels(galleryAbs, listing.folders);
      if (!(await folderIsCurrent(galleryAbs, listing, hiddenFolders, options))) {
        await rebuildFolder(galleryAbs, listing, options);
      }
      await recordBuildSuccess(galleryAbs);
    } catch (e) {
      console.warn('[rebuild]', logText(galleryAbs), e.message);
      await recordBuildFailure(galleryAbs, e);
      throw e;
    }
    finally {
      rebuildInFlight.delete(galleryAbs);
      const again = rebuildAgain.get(galleryAbs);
      if (again) {
        rebuildAgain.delete(galleryAbs);
        rebuildFolderIfNeeded(galleryAbs, again).catch(() => {});
      }
    }
  })();
  rebuildInFlight.set(galleryAbs, p);
  return p;
}

// ---------- build state, for the admin panel and the visitor's page ----------

// A failed build is remembered until the next one succeeds. The admin panel
// shows the reason (the queue's lastError for the folder); visitors are told
// only that the folder could not be built.
async function recordBuildFailure(galleryAbs, error) {
  failedBuilds.set(galleryAbs, error.message);
  const stillServing = await loadManifest(galleryAbs);
  buildQueue.setFolderProblem(galleryAbs, stillServing
    ? 'the last build failed, and the gallery still shows the one before it: ' + error.message
    : error.message);
}

async function recordBuildSuccess(galleryAbs) {
  failedBuilds.delete(galleryAbs);
  buildQueue.setFolderProblem(galleryAbs, describePlaceholders(await readPlaceholderRecord(galleryAbs)));
}

// The admin's summary of a folder's placeholder photos, or null for none.
const PLACEHOLDER_REASON_TEXT = {
  failed: 'could not be converted (rescan the folder to try again)',
  unknown: 'were made by an earlier version without a reason (rescan the folder to try again)',
  'too-large': 'are above the pixel limit, MAX_SOURCE_MEGAPIXELS',
  unreadable: 'cannot be read as images',
};
function describePlaceholders(record) {
  const entries = Object.entries(record || {});
  if (entries.length === 0) return null;
  const parts = [];
  for (const [reason, text] of Object.entries(PLACEHOLDER_REASON_TEXT)) {
    const names = entries.filter(([, entry]) => entry.reason === reason).map(([name]) => name);
    if (names.length) parts.push(names.length + ' ' + text + ': ' + names.slice(0, 3).join(', ') + (names.length > 3 ? ', …' : ''));
  }
  const [firstName, first] = entries[0];
  return entries.length + (entries.length === 1 ? ' photo is shown as a placeholder. ' : ' photos are shown as placeholders. ') +
    parts.join('; ') + '. ' + firstName + ': ' + first.detail;
}

// What the visitor's page polls (?build-status): this folder's state only.
//   building  a build of this folder is running or queued; remaining is its
//             photos still to make, etaSeconds when the queue (shared by all
//             folders, first come first served) will have reached them
//   failed    its last build failed; error says why, for the admin only
//   built     its committed build is complete and can be shown
// A folder whose committed build cannot be shown (its atlas was deleted) is
// rebuilt, and reported as building meanwhile.
export async function buildStatusFor(galleryAbs, forAdmin) {
  const progress = buildQueue.progressFor(galleryAbs);
  const remaining = progress.pending + progress.inProgress;
  let state;
  if (rebuildInFlight.has(galleryAbs) || remaining > 0) {
    state = 'building';
  } else if (failedBuilds.has(galleryAbs)) {
    state = 'failed';
  } else if (await committedBuildIsShowable(galleryAbs)) {
    state = 'built';
  } else {
    rebuildFolderIfNeeded(galleryAbs).catch(() => {});
    state = 'building';
  }
  return {
    state,
    remaining,
    etaSeconds: remaining > 0 ? buildQueue.globalProgress().etaSeconds : null,
    spriteUpToDate: state === 'built',
    error: state === 'failed' && forAdmin ? failedBuilds.get(galleryAbs) : null,
  };
}

async function committedBuildIsShowable(galleryAbs) {
  const manifest = await loadManifest(galleryAbs);
  if (!manifest) return false;
  return manifest.images.length === 0 || (await readSpriteMeta(galleryAbs)) !== null;
}

// Walk a gallery tree and run visitFolder for every folder with content,
// one folder at a time, top-level galleries before their subfolders. A
// folder with a gg/ counts: it was built, and may have been emptied since.
// Sequential on purpose: a tree of thousands of small folders would
// otherwise flood the LoD queue and the sprite worker chain in readdir
// order, and the galleries people look at would be last to come current.
// Resolves with the count.
async function walkGalleryTree(rootAbs, visitFolder) {
  let checked = 0;
  const pending = [rootAbs];
  while (pending.length) {
    const dir = pending.shift();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    let hasContent = false;
    const subs = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        if (e.name === GG_DIR) hasContent = true;
        // The listing's rule (paths.js): a folder it does not show is not built.
        else if (isServableName(e.name)) { subs.push(e.name); hasContent = true; }
      } else if (e.isFile() && isImage(e.name)) hasContent = true;
    }
    if (hasContent) {
      await visitFolder(dir).catch(e => console.warn('[tree walk]', logText(dir), e.message));
      checked++;
    }
    subs.sort();
    for (const sub of subs) pending.push(path.join(dir, sub));
  }
  return checked;
}

// Manifest writes of one folder take turns: a rebuild's commit and a change
// of hidden subfolders both read the hidden sentinels and write the
// manifest, and neither may undo the other.
function withManifestWriteTurn(galleryAbs, write) {
  const previous = manifestWrites.get(galleryAbs) || Promise.resolve();
  const turn = previous.then(write);
  const tail = turn.catch(() => {});
  manifestWrites.set(galleryAbs, tail);
  tail.then(() => { if (manifestWrites.get(galleryAbs) === tail) manifestWrites.delete(galleryAbs); });
  return turn;
}

// Hiding or showing a subfolder changes only which cards the parent lists,
// so it is written into the parent's committed manifest at once, without
// waiting for the build queue (a hidden folder must not stay listed for as
// long as other folders take to build). A parent with no manifest yet reads
// the sentinels from disk on every view, and its first build reads them too.
export function applyHiddenFolders(galleryAbs) {
  return withManifestWriteTurn(galleryAbs, async () => {
    const manifest = await loadManifest(galleryAbs);
    if (!manifest) return;
    const hiddenFolders = await readHiddenSentinels(galleryAbs, manifest.folders);
    if (_arraysEqual(manifest.hiddenFolders, hiddenFolders)) return;
    await writeManifest(galleryAbs, { ...manifest, hiddenFolders });
  });
}

// Make what the folder's photos need, then commit. Only the sizes that are
// missing or out of date are made, and the atlas is baked again only when
// what it is made from changed.
async function rebuildFolder(galleryAbs, listing, { retryPlaceholders }) {
  const { folders } = listing;
  const thumbDir = path.join(galleryAbs, GG_DIR);
  try { await fsp.mkdir(thumbDir, { recursive: true }); }
  catch (e) { throw new Error(`cannot create ${thumbDir} (${e.code || e.message}); the server needs write access to the folder`); }
  await sweepFolderTmps(thumbDir);
  const previousManifest = await loadManifest(galleryAbs);

  const signatures = await currentSignatures(galleryAbs, listing.images);
  const recorded = await signatureRecord(galleryAbs, previousManifest, listing.images, signatures);
  // A photo gone since the listing is not in this build.
  const listed = listing.images.filter(name => signatures[name] !== undefined);
  const replacedNames = new Set(listed.filter(name => trustOf(recorded, signatures, name) === 'replaced'));

  // Phase 1: the sizes each photo needs, through the global build queue.
  const present = await scanRenditions(thumbDir, listed);
  // Which photos are placeholders, and why. A folder with no record (built
  // before reasons were recorded, or the record was deleted) is looked at:
  // its placeholder copies are found by their bytes.
  const recordedPlaceholders = await readPlaceholderRecord(galleryAbs);
  const knownPlaceholders = recordedPlaceholders || await findUnrecordedPlaceholders(galleryAbs, listed, present);
  const placeholders = knownPlaceholders || {};
  const jobs = [];
  for (const name of listed) {
    const tiers = await tiersToBuild(galleryAbs, name, trustOf(recorded, signatures, name), present.get(name));
    const entry = placeholders[name];
    if (retryPlaceholders && entry && isRetryable(entry)) {
      for (const tier of tiersFromKeys(entry.tiers)) if (!tiers.includes(tier)) tiers.push(tier);
    }
    if (tiers.length) jobs.push({ name, tiers });
  }
  const outcomes = await Promise.all(jobs.map(job =>
    buildQueue.enqueueImage(galleryAbs, job.name, job.tiers).then(result => ({ ...job, result }))));
  for (const { name, result } of outcomes) {
    if (result.cancelled) throw new Error('the build queue was cleared before ' + name + ' was built');
    if (result.error) throw new Error(result.error);
  }
  const vanished = new Set(outcomes.filter(outcome => outcome.result.missing).map(outcome => outcome.name));
  const images = listed.filter(name => !vanished.has(name));
  const built = outcomes.filter(outcome => !outcome.result.missing);
  // A size whose content this build changed (a placeholder made again over
  // itself did not).
  const changedTiers = outcome => outcome.tiers.filter(tier => tierChanged(outcome, tier, placeholders[outcome.name]));
  const tileVersion = nextTileVersion(previousManifest, images, replacedNames, built, changedTiers, present);

  // Phase 2: the atlas, made from the h5-h100 renditions of the listed photos.
  // It stays as it is when neither the list nor any of those renditions
  // changed (a subfolder added, a hidden flag, a large size made again).
  const atlasInputsChanged = !previousManifest ||
    !_arraysEqual(previousManifest.images, images) ||
    built.some(outcome => changedTiers(outcome).some(isAtlasTier)) ||
    !(await loadSpriteMetaFile(galleryAbs, previousManifest.atlasDir || ''));
  let atlasDir = null;
  if (images.length > 0) {
    atlasDir = atlasInputsChanged ? await bakeNewAtlas(galleryAbs, thumbDir, images) : previousManifest.atlasDir;
  }

  // Phase 3: commit manifest. The hidden subfolders are read now, not when
  // the build started, so a folder hidden meanwhile stays hidden.
  await withManifestWriteTurn(galleryAbs, async () => {
    const manifest = {
      version: MANIFEST_VERSION,
      builtAt: Date.now(),
      folders,
      images,
      hiddenFolders: await readHiddenSentinels(galleryAbs, folders),
      atlasDir,
      tileVersion,
    };
    if (!sameBuild(await loadManifest(galleryAbs), manifest)) await writeManifest(galleryAbs, manifest);
  });
  // Unless the placeholders could not be looked at (no placeholder tiles to
  // compare with yet), the record is complete from now on.
  if (knownPlaceholders) await writePlaceholderRecord(galleryAbs, updatedPlaceholderRecord(placeholders, images, built));
  const committedSignatures = {};
  for (const name of images) committedSignatures[name] = signatures[name];
  await writeRecordedSignatures(galleryAbs, committedSignatures);

  // Phase 4: cleanup stale atlas_* dirs + legacy flat-layout sprite files.
  // The previous atlas is kept so a page opened before this build can still
  // zoom, unless it shows a photo that is gone: the atlas is public, so
  // keeping it would keep that photo (and its name) public after a trash or
  // a delete. (A replaced photo's old pixels stay in it for this one rebuild,
  // as in rc.2, so an open page keeps zooming.)
  const keepPreviousAtlas = previousManifest && !photoRemoved(previousManifest.images, images);
  await sweepStaleAtlases(thumbDir, [atlasDir, keepPreviousAtlas ? previousManifest.atlasDir : null]);
  if (atlasDir) await sweepLegacyAtlasFiles(thumbDir);
  await sweepOrphanLoDs(thumbDir, new Set(images));
}

// Browsers and CDNs keep per-photo tiles for a year, keyed by URL, and the
// URL is the photo's name plus ?v=<tileVersion>. So the version must change
// whenever a name may now show other pixels than a cache holds for it, and
// must never take a value an earlier build of this folder path handed out:
//   - no previous build: the folder is new, was recreated under the same
//     name, or its gg/ was deleted ("Rebuild from scratch", by hand), so an
//     earlier build of this path may have used any version;
//   - a photo was removed (its name can come back as another file) or
//     replaced;
//   - a tile that existed now shows something else (its photo had no record
//     to trust, or a placeholder became the real photo).
// The version is the time of that change, so it never repeats. Adding
// photos keeps it, so caches survive uploads.
function nextTileVersion(previousManifest, images, replacedNames, built, changedTiers, present) {
  const previous = previousManifest ? Number(previousManifest.tileVersion) || 0 : 0;
  const current = new Set(images);
  const tilesMayHaveChanged = !previousManifest ||
    replacedNames.size > 0 ||
    previousManifest.images.some(name => !current.has(name)) ||
    built.some(outcome => changedTiers(outcome).some(tier => tileExisted(present.get(outcome.name), tier)));
  return tilesMayHaveChanged ? Math.max(Date.now(), previous + 1) : previous;
}

function tileExisted(presentMask, tier) {
  return !!(presentMask & (1 << LOD_TIERS.indexOf(tier)));
}

async function bakeNewAtlas(galleryAbs, thumbDir, images) {
  const atlasDir = newAtlasDirName();
  const buildingDir = atlasDir + '_building';
  const buildingAbs = path.join(thumbDir, buildingDir);
  await fsp.mkdir(buildingAbs, { recursive: true });
  try { await bakeAtlasSerialized(galleryAbs, images, buildingDir); }
  catch (e) { throw new Error('the atlas could not be made: ' + e.message); }
  await fsp.rename(buildingAbs, path.join(thumbDir, atlasDir));
  return atlasDir;
}

// Would writing this manifest change what is served? builtAt aside, an
// identical manifest is left alone, so a check that repairs nothing rewrites
// nothing.
function sameBuild(previous, next) {
  if (!previous) return false;
  const { builtAt: _previousBuiltAt, ...previousContent } = previous;
  const { builtAt: _nextBuiltAt, ...nextContent } = next;
  return JSON.stringify(previousContent) === JSON.stringify(nextContent);
}

// Drop every derived artifact in <folder>/gg/ so the next visit rebuilds
// from scratch. trash/ and the hidden sentinel are durable state that
// happens to live in gg/, not cache — leave them alone.
// Returns how many entries were removed, or null if the folder has no gg/.
async function deleteDerivedFiles(folderAbs) {
  const thumbDir = path.join(folderAbs, GG_DIR);
  let entries;
  try { entries = await fsp.readdir(thumbDir, { withFileTypes: true }); }
  catch { return null; }
  let removed = 0;
  for (const entry of entries) {
    if (entry.name === 'trash' || entry.name === 'hidden') continue;
    try {
      await fsp.rm(path.join(thumbDir, entry.name), { recursive: true, force: true });
      removed++;
    } catch {}
  }
  manifestCache.delete(folderAbs);
  spriteMetaCache.delete(folderAbs);
  return removed;
}

// Stop the build of this folder that is running, if there is one, and wait
// for it to end: its queued photos are dropped (it then ends without
// committing), the few being converted finish, and an atlas being baked is
// waited for.
async function stopRunningBuild(galleryAbs) {
  while (rebuildInFlight.has(galleryAbs)) {
    rebuildAgain.delete(galleryAbs);
    buildQueue.cancelFolder(galleryAbs);
    await rebuildInFlight.get(galleryAbs).catch(() => {});
  }
}

// Delete a folder's build and make it again, as one rebuild. A build already
// running is stopped first: deleting gg/ under it would have it commit a
// gallery with renditions missing and good photos recorded as failed.
// Returns two promises: `removed` (how many entries were deleted, null if
// there was no gg/) and `built`.
function startRebuildFromScratch(galleryAbs) {
  let reportRemoved;
  const removed = new Promise(resolve => { reportRemoved = resolve; });
  const built = (async () => {
    await stopRunningBuild(galleryAbs);
    // No await between the loop above ending and this call, so no other
    // build of the folder can have started in between.
    await rebuildFolderIfNeeded(galleryAbs, {
      beforeListing: async () => reportRemoved(await deleteDerivedFiles(galleryAbs)),
    });
  })();
  built.catch(() => reportRemoved(null));
  return { removed, built };
}

// "Rebuild from scratch" for one folder: answers as soon as the old build
// is gone, the new one runs in the background. If a build of the folder is
// running, it answers at once and the rest follows when that build has
// stopped.
export async function clearcache(folderAbs) {
  const wasBuilding = rebuildInFlight.has(folderAbs);
  const { removed, built } = startRebuildFromScratch(folderAbs);
  built.catch(() => {});
  if (wasBuilding) return 'the build that was running is being stopped; then the folder is rebuilt from scratch';
  const count = await removed;
  return count === null ? 'cache cleared (nothing was built yet); rebuilding' : `cache cleared (${count} entries removed); rebuilding`;
}

// The drift check is cheap for folders that are current.
export function rebuildTreeIfNeeded(rootAbs) {
  return walkGalleryTree(rootAbs, folderAbs => rebuildFolderIfNeeded(folderAbs));
}

// An admin's rescan, of one folder or a tree: what changed is built, and the
// placeholders that may go away are tried again (placeholders.js).
export function rescanFolder(folderAbs) {
  return rebuildFolderIfNeeded(folderAbs, { retryPlaceholders: true });
}
export function rescanTree(rootAbs) {
  return walkGalleryTree(rootAbs, rescanFolder);
}

// "Rebuild from scratch" for a folder and everything below it. A folder's
// old build is deleted only when the walk reaches it, and the walk waits
// for its new build before moving on, so the rest of the tree keeps
// serving what it has until its turn comes.
export function rebuildTreeFromScratch(rootAbs) {
  return walkGalleryTree(rootAbs, folderAbs => startRebuildFromScratch(folderAbs).built);
}
