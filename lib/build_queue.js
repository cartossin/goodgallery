// Concurrency = N CPUs (vips is single-threaded per process). One job per
// (folder, file) at a time. buildRenditions writes atomically, so a process
// kill loses only in-memory progress counters, never on-disk integrity.

import { buildRenditions } from './build.js';
import { BUILD_CONCURRENCY } from './config.js';
import { logText } from './http.js';

class BuildQueue {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.queue = [];
    this.inFlight = new Map();
    this.workers = 0;
    this.progress = new Map();
    this.doneAt = [];  // timestamps of completed jobs (trimmed to last 60s on read)
    this.folderProblems = new Map();  // galleryAbs -> what is wrong with its build (rebuild.js)
  }
  _key(g, f) { return g + '\0' + f; }
  _bumpProgress(g, fn) {
    const p = this.progress.get(g) || { pending: 0, inProgress: 0, done: 0, total: 0 };
    fn(p);
    this.progress.set(g, p);
  }
  // Enqueue the build of some sizes of one photo (tiers: LOD_TIERS entries).
  // Resolves with buildRenditions' result, or { error } if it threw; never
  // rejects, so the caller's Promise.all always settles. A second request
  // for a photo already queued or building waits for that job and then runs
  // its own: the two may ask for different sizes, and the second may come
  // from a replacement the first did not see.
  enqueueImage(galleryAbs, filename, tiers) {
    const k = this._key(galleryAbs, filename);
    if (this.inFlight.has(k)) {
      return this.inFlight.get(k).then(() => this.enqueueImage(galleryAbs, filename, tiers));
    }
    const p = new Promise(resolve => {
      this.queue.push({ galleryAbs, filename, tiers, resolve });
    });
    this.inFlight.set(k, p);
    this._bumpProgress(galleryAbs, x => { x.pending++; x.total++; });
    this._kick();
    return p;
  }
  _kick() {
    while (this.workers < this.concurrency && this.queue.length) {
      this.workers++;
      this._runOne();
    }
  }
  async _runOne() {
    try {
      while (this.queue.length) {
        const { galleryAbs, filename, tiers, resolve } = this.queue.shift();
        const k = this._key(galleryAbs, filename);
        this._bumpProgress(galleryAbs, p => { p.pending--; p.inProgress++; });
        let result;
        try {
          result = await buildRenditions(galleryAbs, filename, tiers);
          this._bumpProgress(galleryAbs, p => { p.done++; });
          this.doneAt.push(Date.now());
        } catch (e) {
          // Not a photo problem (those get the placeholder): the folder
          // cannot be written, or the placeholder tiles are missing.
          result = { error: filename + ': ' + e.message };
          console.warn('[build]', logText(filename), 'in', logText(galleryAbs), '-', e.message);
        } finally {
          this._bumpProgress(galleryAbs, p => { p.inProgress--; });
          this.inFlight.delete(k);
          resolve(result);
        }
      }
    } finally { this.workers--; }
  }
  // Drop all queued (not-yet-started) work. Workers currently inside
  // _runOne keep running — interrupting a half-written tile would orphan a
  // .__tmp file. Returns the count of queued items dropped.
  clear() {
    const dropped = this.queue.length;
    for (const job of this.queue) {
      const k = this._key(job.galleryAbs, job.filename);
      this.inFlight.delete(k);
      // Awaiting rebuildFolder coroutines need their promises resolved so they
      // don't hang; they see the job was dropped and do not commit.
      job.resolve({ cancelled: true });
    }
    const perGallery = new Map();
    for (const job of this.queue) {
      perGallery.set(job.galleryAbs, (perGallery.get(job.galleryAbs) || 0) + 1);
    }
    for (const [g, n] of perGallery) {
      this._bumpProgress(g, p => { p.pending -= n; p.total -= n; if (p.pending < 0) p.pending = 0; if (p.total < 0) p.total = 0; });
    }
    this.queue.length = 0;
    return dropped;
  }
  // Rolling ETA across all galleries. Rate is files completed in the last
  // ~60s; if we don't have enough history yet, etaSeconds is null.
  globalProgress() {
    let remaining = 0;
    for (const p of this.progress.values()) remaining += p.pending + p.inProgress;
    const now = Date.now();
    while (this.doneAt.length && now - this.doneAt[0] > 60000) this.doneAt.shift();
    let etaSeconds = null;
    if (remaining > 0 && this.doneAt.length >= 5) {
      const spanSec = (now - this.doneAt[0]) / 1000;
      if (spanSec > 0) {
        const rate = this.doneAt.length / spanSec;
        if (rate > 0) etaSeconds = Math.round(remaining / rate);
      }
    }
    return { remaining, etaSeconds };
  }
  // What is wrong with a folder's build as of its last build or check, in
  // words for the admin, or null when nothing is. Set by rebuild.js; shown
  // by the admin panel as the folder's lastError.
  setFolderProblem(galleryAbs, problem) {
    if (problem) this.folderProblems.set(galleryAbs, problem);
    else this.folderProblems.delete(galleryAbs);
  }
  progressFor(galleryAbs) {
    const p = this.progress.get(galleryAbs) || { pending: 0, inProgress: 0, done: 0, total: 0 };
    return { pending: p.pending, inProgress: p.inProgress, done: p.done, total: p.total,
             lastError: this.folderProblems.get(galleryAbs) || null };
  }
}

export const buildQueue = new BuildQueue(BUILD_CONCURRENCY);
