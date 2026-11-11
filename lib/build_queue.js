// Concurrency = N CPUs (vips is single-threaded per process). Per-(folder,file)
// dedupe collapses repeated triggers. ensureBuilt is idempotent + atomic, so a
// process kill loses only in-memory progress counters, never on-disk integrity.

import { ensureBuilt } from './build.js';
import { BUILD_CONCURRENCY } from './config.js';

class BuildQueue {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.queue = [];
    this.inFlight = new Map();
    this.workers = 0;
    this.progress = new Map();
    this.doneAt = [];  // timestamps of completed jobs (trimmed to last 60s on read)
  }
  _key(g, f) { return g + '\0' + f; }
  _bumpProgress(g, fn) {
    const p = this.progress.get(g) || { pending: 0, inProgress: 0, done: 0, total: 0 };
    fn(p);
    this.progress.set(g, p);
  }
  // Enqueue a single image build. Returns a Promise that resolves once
  // ensureBuilt completes (success OR failure — failures are logged and
  // resolved; rebuildFolder's atlas step handles missing LoDs by retrying
  // on the next call). Per-(folder,file) dedupe: a second concurrent
  // enqueue for the same image returns the existing in-flight promise.
  // force: rebuild every size even if one exists (the source was replaced).
  // A forced request that finds an ordinary build of the same image already
  // running waits for it and then builds again, so the replacement is not
  // lost to the dedupe.
  enqueueImage(galleryAbs, filename, force = false) {
    const k = this._key(galleryAbs, filename);
    if (this.inFlight.has(k)) {
      const running = this.inFlight.get(k);
      return force ? running.then(() => this.enqueueImage(galleryAbs, filename, true)) : running;
    }
    const p = new Promise((resolve, reject) => {
      this.queue.push({ galleryAbs, filename, force, resolve, reject });
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
        const { galleryAbs, filename, force, resolve } = this.queue.shift();
        const k = this._key(galleryAbs, filename);
        this._bumpProgress(galleryAbs, p => { p.pending--; p.inProgress++; });
        try {
          await ensureBuilt(galleryAbs, filename, force);
          this._bumpProgress(galleryAbs, p => { p.done++; });
          this.doneAt.push(Date.now());
        } catch (e) {
          // ensureBuilt substitutes broken.svg on vips errors (commit 1),
          // so we only end up here for missing-source / unsupported-type
          // failures. Resolve the promise anyway so Promise.all in
          // rebuildFolder doesn't hang; the atlas bake will read whatever's
          // on disk (and re-enqueue happens on the next rebuild trigger).
          this._bumpProgress(galleryAbs, p => { p.lastError = filename + ': ' + e.message; });
          console.warn('[build]', filename, 'in', galleryAbs, '-', e.message);
        } finally {
          this._bumpProgress(galleryAbs, p => { p.inProgress--; });
          this.inFlight.delete(k);
          resolve();
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
      // don't hang. Treat clear() as "all queued jobs finished" (no-op build).
      job.resolve();
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
  progressFor(galleryAbs) {
    const p = this.progress.get(galleryAbs);
    if (!p) return { pending: 0, inProgress: 0, done: 0, total: 0 };
    return { pending: p.pending, inProgress: p.inProgress, done: p.done, total: p.total, lastError: p.lastError };
  }
}

export const buildQueue = new BuildQueue(BUILD_CONCURRENCY);
