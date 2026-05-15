// Goodgallery 2.0 client. Vanilla JS, zero deps.
//
// State injected by the server-rendered page:
//   images = [null, "a.jpg", ...]  (1-indexed)
//   lastimagevalue, isadmin, hasPasskey, folderURL, spriteMeta, imagemapURL

(function () {
  'use strict';

  // One-time login-link redemption. If the URL fragment is #auth=<token>,
  // strip it, redeem via the API, then reload so the page re-fetches with the
  // new admin cookie. The link is supposed to "sign this browser in"; we don't
  // try to preserve any other hash content since the link format is
  // standalone (#auth=<token> only).
  (function redeemAuthHash() {
    var m = location.hash.match(/^#auth=([A-Za-z0-9_-]+)$/);
    if (!m) return;
    var token = m[1];
    history.replaceState(null, '', location.pathname + location.search);
    fetch('/api/admin/login/redeem', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token })
    }).then(function (r) {
      if (r.ok) location.reload();
      // On failure (expired / already used) we just stay on the page,
      // unauthenticated. No alert here — the gallery is still usable for
      // anyone, admin or not.
    }).catch(function () {});
  })();

  var CANONICAL_H = 200;
  var FOCUS_PREFETCH = 3;  // images on each side of focus to keep warm in the bitmap cache.

  // Binary imagemap format: 'GGMP' (4B) | version u16 LE | reserved u16 |
  // count u32 LE | widths (count × u16 LE) | NUL-terminated UTF-8 names.
  async function loadImagemap() {
    if (!window.imagemapURL) return false;
    var resp = await fetch(window.imagemapURL, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error('imagemap fetch failed: ' + resp.status);
    var buf = await resp.arrayBuffer();
    var dv = new DataView(buf);
    var bytes = new Uint8Array(buf);
    var magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic !== 'GGMP') throw new Error('imagemap bad magic: ' + magic);
    var count = dv.getUint32(8, true);
    var widthsBase = 12;
    var namesBase  = 12 + 2 * count;
    var widthsArr = new Uint16Array(buf, widthsBase, count);
    var dec = new TextDecoder();
    var newImages = new Array(count + 1);
    newImages[0] = null;
    var imageMap = {};
    var pos = namesBase;
    for (var i = 0; i < count; i++) {
      var end = pos;
      while (end < bytes.length && bytes[end] !== 0) end++;
      var name = dec.decode(bytes.subarray(pos, end));
      newImages[i + 1] = name;
      imageMap[name] = { idx: i, w: widthsArr[i] };
      pos = end + 1;
    }
    window.images = newImages;
    window.lastimagevalue = count;
    if (window.spriteMeta) spriteMeta.imageMap = imageMap;
    return true;
  }

  var GG_DIR = 'gg';
  var inum = 1;
  var focusedIdx = 0;       // 0 = grid view; 1..N = focused image
  var keyslocked = 0;
  var hashmirror = '';


  function $(id) { return document.getElementById(id); }
  function setText(id, t) { var e = $(id); if (e) e.textContent = t; }
  function setHTML(id, h) { var e = $(id); if (e) e.innerHTML = h; }

  // ---------- realtime monitor ----------
  function note(msg) {
    var rt = $('realtime');
    if (!rt) return;
    rt.textContent = msg || '';
  }
  function gghttp(method, qs, onText) {
    var url = folderURL + (qs ? '?' + qs : '');
    fetch(url, { method: method, credentials: 'same-origin', headers: adminHeader() })
      .then(function (r) { return r.text(); })
      .then(function (t) { onText(t); })
      .catch(function () { onText(''); });
  }
  // Auth is an HttpOnly cookie; no client-side token handling needed.
  function adminHeader() { return {}; }

  // The page just monitors server-side build state; mutations live in /_admin/.
  var statusTimer = null;
  function pollBuildStatus(opts) {
    opts = opts || {};
    var reloadOnComplete = !!opts.reloadOnComplete;
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    fetch(folderURL + '?build-status', { headers: adminHeader() })
      .then(function (r) { return r.json(); })
      .then(function (p) {
        var active = (p.pending || 0) + (p.inProgress || 0);
        if (active > 0) {
          note('Building LoD cache — ' + active + ' remaining (' + p.done + '/' + p.total + ' done)');
          statusTimer = setTimeout(function () { pollBuildStatus({ reloadOnComplete: reloadOnComplete }); }, 5000);
        } else if (reloadOnComplete && p.total > 0 && p.spriteUpToDate === false) {
          // Queue drained but sprite is still rebuilding (debounced).
          note('Build complete; finalizing…');
          statusTimer = setTimeout(function () { pollBuildStatus({ reloadOnComplete: reloadOnComplete }); }, 2000);
        } else if (reloadOnComplete && p.total > 0) {
          note('Build complete (' + p.done + '/' + p.total + '). Reloading…');
          setTimeout(function () { location.reload(); }, 800);
        } else {
          note('');
        }
      })
      .catch(function () {});
  }

  // ---------- nav helpers ----------

  function nextimage()    { shiftFocus(+1); }
  function previousimage(){ shiftFocus(-1); }

  function isThumbView() { return focusedIdx === 0; }
  function leftbutton()  { if (focusedIdx > 0) shiftFocus(-1); }
  function rightbutton() { if (focusedIdx > 0) shiftFocus(+1); }
  // commandedIdx is the most-recently-requested focus target. Fast successive
  // shifts accumulate against it so the chase animation tracks the final target.
  var commandedIdx = 0;
  function shiftFocus(delta) {
    if (lastimagevalue < 1) return;
    // Mid-animation → commandedIdx (ahead of focusedIdx). Settled → focusedIdx.
    var base = (focusInProgrammaticScroll && commandedIdx > 0) ? commandedIdx : focusedIdx;
    var next = base + delta;
    if (next < 1) next = lastimagevalue;
    if (next > lastimagevalue) next = 1;
    if (focusedIdx > 0 && canvasEl) {
      commandedIdx = next;
      startFocusChase();
    } else {
      location.hash = encodeURIComponent(images[next]);
    }
  }

  // ---------- keys ----------
  function unlockkeys() { keyslocked = 0; }
  function keycheck(e) {
    // Don't hijack typing in inputs / textareas / contenteditable.
    var tn = e.target && e.target.tagName;
    if (tn === 'INPUT' || tn === 'TEXTAREA' || tn === 'SELECT' ||
        (e.target && e.target.isContentEditable)) return;

    var k = e.which || e.keyCode;

    // Grid view: scroll keys move the thumbs viewport. The thumbs container
    // is a custom scroller (overflow:auto), so without explicit handling
    // these keys do nothing until the user clicks the scrollbar to give the
    // browser a focused scroll target. Don't lock — holding PageDown should
    // keep paging.
    if (focusedIdx === 0) {
      var thumbsEl = document.getElementById('thumbs');
      if (!thumbsEl) return;
      var pageDelta = thumbsEl.clientHeight * 0.85;  // 15% overlap for context
      var target = null;
      if (k === 33) target = Math.max(0, thumbsEl.scrollTop - pageDelta);                       // PageUp / Fn+Up
      else if (k === 34) target = thumbsEl.scrollTop + pageDelta;                               // PageDown / Fn+Down
      else if (k === 36) target = 0;                                                            // Home / Fn+Left
      else if (k === 35) target = thumbsEl.scrollHeight;                                        // End / Fn+Right
      else if (e.metaKey && k === 38) target = 0;                                               // Cmd+Up (Mac)
      else if (e.metaKey && k === 40) target = thumbsEl.scrollHeight;                           // Cmd+Down (Mac)
      if (target !== null) {
        e.preventDefault();
        thumbsEl.scrollTo({ top: target, behavior: 'smooth' });
        return;
      }
    }

    if (keyslocked) return;
    var isArrow = (k === 37 || k === 38 || k === 39 || k === 40);
    // Focus mode: arrow keys shift focus. preventDefault blocks the native
    // ~40px arrow-key scroll on the strip that would race with shiftFocus().
    if (focusedIdx > 0 && isArrow) {
      e.preventDefault();
      if (k === 37 || k === 38) leftbutton(); else rightbutton();
    } else if (k === 27 && focusedIdx > 0) {
      e.preventDefault();
      location.hash = '';
    } else {
      return;
    }
    keyslocked = 1;
  }

  // ---------- view ----------

  // rAF-throttled re-layout: collapses bursts of resize/zoom events into one render per frame.
  var rafPending = false;
  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () { rafPending = false; renderGallery(); });
  }

  function chromeHeight() {
    var top = document.getElementById('topbar');
    var foot = document.getElementById('bottomlink');
    return (top ? top.offsetHeight : 50) + (foot ? foot.offsetHeight : 50) + 24;
  }

  function avgThumbWidth() {
    if (!window.spriteMeta || !spriteMeta.imageMap) return 200;
    var sum = 0, n = 0;
    for (var k in spriteMeta.imageMap) { sum += spriteMeta.imageMap[k].w; n++; }
    return n ? sum / n : 200;
  }

  // Binary-search the largest target row height H such that the actual layout's total
  // height (with justification + gaps) is ≤ available viewport. The closed-form
  // approximation underestimates because justification can stretch rows taller than H.
  function fitAllHeight() {
    if (!window.spriteMeta || lastimagevalue < 1) return 100;
    // images[1..N] is populated by loadImagemap. Before that loads,
    // simulateLayoutHeight would crash on undefined entries.
    if (!images[1]) return 100;
    var W = layoutWidth();
    var H = layoutHeight();
    var lo = 2, hi = CANONICAL_H;
    for (var i = 0; i < 18; i++) {
      var mid = (lo + hi) / 2;
      var measured = simulateLayoutHeight(mid, W);
      if (measured > H) hi = mid; else lo = mid;
    }
    return Math.max(2, lo);
  }

  // Use bounding rects so chrome height is exact (no hardcoded estimates).
  function layoutWidth() {
    var el = document.getElementById('thumbs');
    return (el && el.clientWidth) || window.innerWidth;
  }
  function layoutHeight() {
    var el = document.getElementById('thumbs');
    var foot = document.getElementById('bottomlink');
    var top = el ? el.getBoundingClientRect().top : 100;
    var footH = foot ? foot.offsetHeight : 0;
    return Math.max(120, window.innerHeight - top - footH - 8);
  }

  // Total layout height for row-target H without rendering. Must mirror
  // layoutRows()/finalizeRow() so fit-all stays accurate.
  function rowGap(H) { return Math.max(0, Math.floor(H * 0.04)); }
  function simulateLayoutHeight(H, W) {
    if (!window.spriteMeta || !spriteMeta.imageMap) return 0;
    var rows = 0, totalH = 0;
    var natRowW = 0, count = 0;
    for (var i = 1; i <= lastimagevalue; i++) {
      var name = images[i];
      var loc = spriteMeta.imageMap[name];
      var natW = (loc ? loc.w : CANONICAL_H) * H / CANONICAL_H;
      if (count > 0 && (natRowW + rowGap(H) * count + natW) > W) {
        var rowScale = Math.min(1.5, (W - rowGap(H) * (count - 1)) / Math.max(1, natRowW));
        totalH += H * rowScale + rowGap(H);
        rows++; natRowW = 0; count = 0;
      }
      natRowW += natW; count++;
    }
    if (count > 0) totalH += H + rowGap(H);
    return totalH;
  }

  // Zoom ladder. h is in DEVICE pixels (target image-pixel height the user
  // wants painted). 'fit' resolves to fitAllHeight() (viewport-dependent, CSS px);
  // 'focus' enters single-image mode. Hash form: #fit, #size0..#sizeN, #imagename.
  var ZOOM_LEVELS = [
    { name: 'fit',   hash: 'fit',   h: null    },
    { name: 'size0', hash: 'size0', h: 5       },
    { name: 'size1', hash: 'size1', h: 10      },
    { name: 'size2', hash: 'size2', h: 50      },
    { name: 'size3', hash: 'size3', h: 100     },
    { name: 'size4', hash: 'size4', h: 200     },
    { name: 'size5', hash: 'size5', h: 400     },
    { name: 'size6', hash: 'size6', h: 800     },
    { name: 'focus', hash: null,    h: 'focus' },
  ];
  // lastGridLevelIdx is preserved so back-from-focus restores the prior zoom.
  var DEFAULT_LEVEL_NAME = 'size3';
  function defaultLevelIdx() {
    var levels = availableLevels();
    for (var i = 0; i < levels.length; i++) {
      if (levels[i].name === DEFAULT_LEVEL_NAME) return i;
    }
    // Default name missing → fall back to the largest non-focus level.
    var fallback = 0;
    for (var j = 0; j < levels.length; j++) {
      if (levels[j].h !== 'focus') fallback = j;
    }
    return fallback;
  }
  var currentLevelIdx = 0;
  // Default to size3; setLevel() / refreshfromhash() update this as the
  // user picks zooms during the session. The up-arrow in focus view reads it
  // back to restore zoom — initial value matters when the user enters via a
  // focus URL without having visited the grid first.
  var lastGridLevelIdx = defaultLevelIdx();
  var levelTargetH = null;
  function availableLevels() {
    // Returns ZOOM_LEVELS with raw h values: null for #fit, 'focus' sentinel
    // for the focus entry, device-px numbers for sized levels. Don't substitute
    // fitAllHeight() here — that value would propagate into levelTargetH and
    // get incorrectly divided by dpr in targetRowHeight(). Resolve fit's null
    // at the use site (targetRowHeight does it correctly).
    var out = [];
    for (var i = 0; i < ZOOM_LEVELS.length; i++) {
      var lv = ZOOM_LEVELS[i];
      out.push({ name: lv.name, hash: lv.hash, h: lv.h });
    }
    return out;
  }

  // Apply a zoom level. The 'focus' sentinel enters single-image mode on the
  // centered visible image; everything else updates hash + re-renders.
  function setLevel(idx) {
    var levels = availableLevels();
    if (idx < 0) idx = 0;
    if (idx > levels.length - 1) idx = levels.length - 1;
    currentLevelIdx = idx;
    var lv = levels[idx];
    if (lv.h === 'focus') {
      var name = findCenteredImageName();
      if (name == null && images[1]) name = images[1];
      if (name) location.hash = encodeURIComponent(name);
      return;
    }
    lastGridLevelIdx = idx;
    levelTargetH = lv.h;
    var newHash = '#' + lv.hash;
    if (focusedIdx > 0) {
      location.hash = newHash;
      return;
    }
    if (location.hash !== newHash) {
      try { history.replaceState(null, '', newHash); } catch (_) {}
      hashmirror = lv.hash;
    }
    scheduleRender();
    renderZoomControl();
  }

  // [-] Label [+] in grid mode; [↑] in focus mode.
  function renderZoomControl() {
    var el = document.getElementById('zoomControl');
    if (!el) return;
    if (focusedIdx > 0) {
      el.innerHTML = '<button class="zoom-back" title="Up to gallery" aria-label="Up to gallery">↑</button>';
      el.querySelector('button').addEventListener('click', function () {
        // Anchor the grid scroll on the image we were just viewing. renderGallery
        // reads cachedAnchorName during relayout and sets scrollTop to put that
        // image's row at the viewport top.
        if (focusedIdx > 0 && images[focusedIdx]) {
          cachedAnchorName = images[focusedIdx];
        }
        var lv = availableLevels()[lastGridLevelIdx];
        location.hash = lv && lv.hash ? '#' + lv.hash : '#fit';
      });
      return;
    }
    var levels = availableLevels();
    var idx = currentLevelIdx;
    if (idx < 0) idx = 0;
    if (idx > levels.length - 1) idx = levels.length - 1;
    var name = levels[idx].name;
    el.innerHTML =
      '<button class="zoom-minus" title="Zoom out"' + (idx === 0 ? ' disabled' : '') + '>−</button>' +
      '<span class="zoom-label">' + name + '</span>' +
      '<button class="zoom-plus" title="Zoom in">+</button>';
    var minus = el.querySelector('.zoom-minus');
    var plus = el.querySelector('.zoom-plus');
    if (minus) minus.addEventListener('click', function () { setLevel(currentLevelIdx - 1); });
    if (plus) plus.addEventListener('click', function () { setLevel(currentLevelIdx + 1); });
  }

  function targetRowHeight() {
    if (!window.spriteMeta) return 100;
    if (focusedIdx > 0) return Math.max(50, layoutHeight() * 0.7);
    // levelTargetH is in DEVICE px (from ZOOM_LEVELS); convert to CSS for layout.
    if (levelTargetH != null) return levelTargetH / devicePixelRatio();
    return fitAllHeight();
  }

  function layoutRows(H) {
    if (!window.spriteMeta || !spriteMeta.imageMap) return [];
    var W = layoutWidth();
    var rows = [];
    var current = [];
    var natRowW = 0;
    for (var i = 1; i <= lastimagevalue; i++) {
      var name = images[i];
      var loc = spriteMeta.imageMap[name];
      var natW = (loc ? loc.w : CANONICAL_H) * H / CANONICAL_H;
      var avail = W - rowGap(H) * Math.max(0, current.length - 1);
      if (current.length > 0 && (natRowW + natW + rowGap(H)) > W) {
        rows.push(finalizeRow(current, natRowW, H, W, false));
        current = []; natRowW = 0;
      }
      current.push({ index: i, natW: natW });
      natRowW += natW;
    }
    if (current.length) rows.push(finalizeRow(current, natRowW, H, W, true));
    return rows;
  }

  function finalizeRow(items, natRowW, H, W, isLast) {
    var contentW = W - rowGap(H) * Math.max(0, items.length - 1);
    var rowScale = isLast ? 1 : Math.min(1.5, contentW / Math.max(1, natRowW));
    var h = H * rowScale;
    // Float widths: rounding each tile to an integer drifts the row total down
    // by ~Math.round-error × tile-count, which at #fit on 100k images
    // underfills rows by 20-40 px. WebGL takes fractional dst rects fine; each
    // tile still starts exactly where the previous one ended, so seams are
    // pixel-perfect even with fractional widths.
    return {
      items: items.map(function (it) {
        return { index: it.index, w: Math.max(0.5, it.natW * rowScale), h: h };
      }),
      height: h,
    };
  }

  // ---- virtual-scroll single canvas -----------------------------------
  // The canvas is viewport-sized, position:sticky at the top of #thumbs.
  // A spacer sibling holds the full layout height. On scroll we redraw the
  // (small) canvas for the visible Y window — paint cost is bounded regardless
  // of N, so 60k+ image galleries are fine.
  // dpr cap at 2: higher densities multiply paint cost without visible gain.
  function devicePixelRatio() { return Math.min(window.devicePixelRatio || 1, 2); }

  // Coalesce hash mutations during fast scrubs. Chrome's IPC flooding guard
  // (crbug.com/1038223) trips around ~25 hash changes/sec sustained; once
  // tripped, queued ops burst at once -> freeze, RAM spike, repaint chaos.
  var pendingHashTimer = null;
  function scheduleHashUpdate(newHash) {
    if (pendingHashTimer) clearTimeout(pendingHashTimer);
    pendingHashTimer = setTimeout(function () {
      pendingHashTimer = null;
      try { history.replaceState(null, '', newHash); } catch (_) {}
    }, 200);
  }

  // Per-atlas-height ImageBitmap cache (h5/h10/h50, loaded lazily).
  var spriteBitmapsByHeight = {};      // { '50': Promise<[ImageBitmap, ...]>, ... }
  // Sync mirror so drag-paint can blit prev/next without a microtask hop.
  var atlasBitmapsSync = {};
  // DEBUG: expose for memory-leak repro harness. Counts non-null bitmap refs
  // per atlas height. Cheap, harmless to leave in production.
  window.__memdbg = {
    spriteRefCount: function (atlasH) {
      var arr = atlasBitmapsSync[String(atlasH)] || [];
      var n = 0;
      for (var i = 0; i < arr.length; i++) if (arr[i]) n++;
      return n;
    },
    atlasBitmapsSync: atlasBitmapsSync,
    perImageBitmapsSync: perImageBitmapsSync,
  };
  // Per-image bitmaps for high-zoom views. Keyed by `${name}|${tierH}`.
  var perImageBitmaps = new Map();
  // Sync mirror so paintMain can pick the best resolved tier without awaiting.
  var perImageBitmapsSync = new Map();
  // Names currently considered "warm" by the visible-buffer / focus-prefetch
  // logic. Updated by drawCanvasForScroll (grid) and prefetchFilmstripVisible
  // (focus); checked by _runPerImageJob so in-flight loads completing after
  // the scroll stops can be closed immediately instead of leaking ~24 × 3MB
  // bitmaps into perImageBitmapsSync with nothing to evict them.
  var warmPerImageNames = new Set();
  var currentRowHeight = 200;
  var renderFrame = 0;                 // bumped per render; async draws check it before painting
  var lastTileRects = [];              // [{x, y, w, h, name}] in layout coords
  var canvasEl = null;
  var spacerEl = null;
  var canvasClickAttached = false;
  var thumbsScrollAttached = false;

  // On-demand per-sprite loading avoids whole-atlas decode spikes that crash
  // iOS Safari on large galleries.
  var spritePromises = {};

  function loadSpriteAt(atlasH, spriteIdx) {
    var key = String(atlasH);
    if (!spritePromises[key]) spritePromises[key] = {};
    if (spritePromises[key][spriteIdx]) return spritePromises[key][spriteIdx];
    var atlas = window.spriteMeta && spriteMeta.atlases && spriteMeta.atlases[key];
    if (!atlas || !atlas.sprites[spriteIdx]) return Promise.resolve(null);
    if (!atlasBitmapsSync[key]) atlasBitmapsSync[key] = new Array(atlas.sprites.length).fill(null);
    var url = folderURL + GG_DIR + '/' + atlas.sprites[spriteIdx].file;
    spritePromises[key][spriteIdx] = fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.blob(); })
      .then(function (b) { return createImageBitmap(b); })
      .then(function (bm) {
        atlasBitmapsSync[key][spriteIdx] = bm;
        gridRenderer.uploadSprite(key + ':' + spriteIdx, bm);
        return bm;
      });
    return spritePromises[key][spriteIdx];
  }

  // Bulk-load every sprite for an atlas height. Safety helper; most callers
  // use loadSpriteAt for the specific sprite they need.
  function loadSpriteBitmapsForAtlas(atlasH) {
    var key = String(atlasH);
    if (spriteBitmapsByHeight[key]) return spriteBitmapsByHeight[key];
    var atlas = window.spriteMeta && spriteMeta.atlases && spriteMeta.atlases[key];
    if (!atlas) return Promise.resolve([]);
    if (!atlasBitmapsSync[key]) atlasBitmapsSync[key] = new Array(atlas.sprites.length).fill(null);
    var ps = [];
    for (var i = 0; i < atlas.sprites.length; i++) ps.push(loadSpriteAt(atlasH, i));
    spriteBitmapsByHeight[key] = Promise.all(ps);
    return spriteBitmapsByHeight[key];
  }

  // Atlas tier closest to targetH in log scale. The previous "smallest ≥
  // target" rule forced h50 at #fit (target ~14 device px), and on a 100k-
  // image gallery the buffer at #fit covers EVERY tile — meaning every
  // sprite of the chosen tier has to be loaded. h50 atlas at openimages-val
  // scale = ~30 sprites × 50 MB = 1.5 GB just to render thumbnails at ~14
  // device px. Log-distance picks h10 instead (1.4x upsample, imperceptible
  // at #fit's tile size; ~70 MB total). null → caller falls back to per-
  // image AVIF (target above the largest available atlas tier).
  function pickAtlasHeight(targetH) {
    if (!window.spriteMeta || !spriteMeta.atlases) return null;
    var heights = Object.keys(spriteMeta.atlases).map(Number).sort(function (a, b) { return a - b; });
    if (!heights.length) return null;
    if (targetH > heights[heights.length - 1]) return null;
    var best = heights[0], bestDist = Math.abs(Math.log(heights[0] / targetH));
    for (var i = 1; i < heights.length; i++) {
      var d = Math.abs(Math.log(heights[i] / targetH));
      if (d < bestDist) { bestDist = d; best = heights[i]; }
    }
    return best;
  }

  // Smallest per-image tier ≥ target, clamped to the top of the ladder.
  // h1600 is the ceiling — extra-large canvases get h1600 upscaled rather
  // than the (potentially huge) original. h100 lives in the sprite atlas
  // (ATLAS_TIERS on the server) so per-image tiers start at 200; while a
  // gallery is still building its atlas, size3 falls back to h200.avif.
  var PER_IMAGE_TIERS = [200, 400, 800, 1600];
  function pickPerImageTier(targetH) {
    for (var i = 0; i < PER_IMAGE_TIERS.length; i++) {
      if (PER_IMAGE_TIERS[i] >= targetH) return PER_IMAGE_TIERS[i];
    }
    return PER_IMAGE_TIERS[PER_IMAGE_TIERS.length - 1];
  }

  // Per-image AVIF loader. Capped in-flight + pending queue so a size3 grid
  // load (hundreds of tiles kicked off in one frame) doesn't trip Chrome's
  // ERR_INSUFFICIENT_RESOURCES at the renderer-level fetch cap. HTTP/2
  // multiplexes well — 64 concurrent streams is fast but stays clear of the
  // ~256-per-renderer ceiling. Each fetch has its own AbortController so a
  // scroll that moves past the target cancels the in-flight download AND
  // discards still-queued requests for it.
  var PER_IMAGE_MAX_INFLIGHT = 64;
  var perImageInflight = 0;
  var perImageQueue = [];               // [{key, url, ctrl, resolve}]
  var activeAborts = new Map();         // key -> AbortController (queued OR in-flight)
  function _runPerImageJob(job) {
    if (job.ctrl && job.ctrl.signal.aborted) {
      // Got cancelled while waiting in the queue — nothing to fetch.
      activeAborts.delete(job.key);
      perImageBitmaps.delete(job.key);
      job.resolve(null);
      return;
    }
    perImageInflight++;
    fetch(job.url, { credentials: 'same-origin', signal: job.ctrl ? job.ctrl.signal : undefined })
      .then(function (r) { return r.blob(); })
      .then(function (b) { return createImageBitmap(b); })
      .catch(function () { return null; })
      .then(function (bm) {
        perImageInflight--;
        activeAborts.delete(job.key);
        var name = job.key.slice(0, job.key.lastIndexOf('|'));
        if (bm && !warmPerImageNames.has(name)) {
          // User scrolled past during the load — drop right here so the bitmap
          // does not sit in perImageBitmapsSync until eviction runs.
          try { bm.close && bm.close(); } catch (_) {}
          perImageBitmaps.delete(job.key);
          bm = null;
        } else if (!bm) {
          // Aborted or failed — drop cached promise so a future call retries.
          perImageBitmaps.delete(job.key);
        }
        job.resolve(bm);
        if (bm) {
          perImageBitmapsSync.set(job.key, bm);
          gridRenderer.uploadSprite('img:' + job.key, bm);
        }
        _pumpPerImageQueue();
      });
  }
  function _pumpPerImageQueue() {
    while (perImageInflight < PER_IMAGE_MAX_INFLIGHT && perImageQueue.length) {
      _runPerImageJob(perImageQueue.shift());
    }
  }
  // Cancel both pending (queued) AND in-flight loads whose key isn't in
  // keepKeys. Walks the queue once so aborted entries don't sit consuming
  // capacity later.
  function cancelPerImageLoadsExcept(keepKeys) {
    var kept = [];
    for (var i = 0; i < perImageQueue.length; i++) {
      var job = perImageQueue[i];
      if (keepKeys.has(job.key)) { kept.push(job); continue; }
      if (job.ctrl) try { job.ctrl.abort(); } catch (_) {}
      activeAborts.delete(job.key);
      perImageBitmaps.delete(job.key);
      job.resolve(null);
    }
    perImageQueue = kept;
    activeAborts.forEach(function (ctrl, key) {
      if (!keepKeys.has(key)) try { ctrl.abort(); } catch (_) {}
    });
    _pumpPerImageQueue();
  }
  function loadPerImageBitmap(name, tierH) {
    var key = name + '|' + tierH;
    if (perImageBitmaps.has(key)) return perImageBitmaps.get(key);
    var url = folderURL + GG_DIR + '/' + encodeURIComponent(name) + '.h' + tierH + '.avif';
    var resolveFn;
    var prom = new Promise(function (res) { resolveFn = res; });
    perImageBitmaps.set(key, prom);
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    if (ctrl) activeAborts.set(key, ctrl);
    var job = { key: key, url: url, ctrl: ctrl, resolve: resolveFn };
    if (perImageInflight < PER_IMAGE_MAX_INFLIGHT) _runPerImageJob(job);
    else perImageQueue.push(job);
    return prom;
  }
  function getPerImageBitmapSync(name, tierH) {
    return perImageBitmapsSync.get(name + '|' + tierH) || null;
  }

  // Close + drop per-image bitmaps whose image name isn't in warmNames.
  // ImageBitmap pixel data lives in GPU/native memory; without close() it stays
  // pinned even after the JS Map entry is gone. Never close the bitmap that
  // mainDrawSrc currently references — paintMain can fire after eviction and
  // would crash with "image source is detached" on the closed handle.
  function evictPerImageBitmaps(warmNames) {
    var pinned = (mainDrawSrc && mainDrawSrc.bitmap) || null;
    var dead = [];
    perImageBitmapsSync.forEach(function (bm, key) {
      var name = key.slice(0, key.lastIndexOf('|'));
      if (warmNames.has(name)) return;
      if (pinned && bm === pinned) return;
      dead.push({ key: key, bm: bm });
    });
    for (var i = 0; i < dead.length; i++) {
      var k = dead[i].key, bm = dead[i].bm;
      try { if (bm && typeof bm.close === 'function') bm.close(); } catch (_) {}
      perImageBitmapsSync.delete(k);
      perImageBitmaps.delete(k);
      gridRenderer.deleteTexture('img:' + k);
    }
  }

  // ---- grid renderer (WebGL2) -----------------------------------------
  // Draws all visible thumbnail tiles as instanced textured quads. One
  // drawArraysInstanced call per loaded sprite; replaces ~N drawImage calls
  // (N=visible tiles) with ~S draw calls (S=visible sprite count). At #fit
  // on 100k images that turns 100k calls into <30.
  //
  // Public surface (used by drawCanvasForScroll and loadSpriteAt):
  //   gridRenderer.available()           — true if WebGL2 was acquired ok
  //   gridRenderer.attach(canvas)        — bind to (possibly new) canvas
  //   gridRenderer.uploadSprite(key, bm) — upload an ImageBitmap to a texture
  //   gridRenderer.releaseAll()          — drop all textures (mode swap, etc.)
  //   gridRenderer.render(opts)          — draw one frame
  //
  // The renderer is purely a draw layer; visibility, atlas selection, and
  // sprite-load orchestration stay in drawCanvasForScroll.
  var gridRenderer = (function () {
    var gl = null;
    var program = null;
    var quadVBO = null;
    var dynInstVBO = null;
    var locDstRect, locSrcRect, locQuadPos, locViewportPx, locTopOffset, locAtlasSampler;
    var attachedCanvas = null;
    var textures = new Map();        // textureKey -> { tex, w, h }
    var staticBuffers = new Map();   // instanceKey -> { buf, count }
    var failed = false;

    // aDstRect.y is the tile's WORLD y (layout coord). uTopOffset is the
    // world y of the canvas top; the shader subtracts to get canvas-local
    // pixels. This lets atlas mode pre-upload a single static instance
    // buffer per (atlasH, sprite) and re-draw with just one uniform update.
    var VS = '#version 300 es\n' +
      'in vec2 aQuadPos;\n' +
      'in vec4 aDstRect;\n' +
      'in vec4 aSrcRect;\n' +
      'uniform vec2 uViewportPx;\n' +
      'uniform float uTopOffset;\n' +
      'out vec2 vUV;\n' +
      'void main() {\n' +
      '  vec2 worldPos = aDstRect.xy + aQuadPos * aDstRect.zw;\n' +
      '  vec2 css = vec2(worldPos.x, worldPos.y - uTopOffset);\n' +
      '  vec2 ndc = (css / uViewportPx) * 2.0 - 1.0;\n' +
      '  ndc.y = -ndc.y;\n' +
      '  gl_Position = vec4(ndc, 0.0, 1.0);\n' +
      '  vUV = aSrcRect.xy + aQuadPos * aSrcRect.zw;\n' +
      '}\n';
    var FS = '#version 300 es\n' +
      'precision mediump float;\n' +
      'in vec2 vUV;\n' +
      'uniform sampler2D uAtlas;\n' +
      'out vec4 fragColor;\n' +
      'void main() { fragColor = texture(uAtlas, vUV); }\n';

    function compile(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        var log = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error('shader compile: ' + log);
      }
      return s;
    }
    function link(vs, fs) {
      var p = gl.createProgram();
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        var log = gl.getProgramInfoLog(p);
        gl.deleteProgram(p);
        throw new Error('program link: ' + log);
      }
      return p;
    }

    function init(canvas) {
      if (failed) return false;
      try {
        gl = canvas.getContext('webgl2', { alpha: false, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true });
        if (!gl) { console.warn('[gridRenderer] WebGL2 unavailable'); failed = true; return false; }
        var vs = compile(gl.VERTEX_SHADER, VS);
        var fs = compile(gl.FRAGMENT_SHADER, FS);
        program = link(vs, fs);
        gl.deleteShader(vs); gl.deleteShader(fs);

        locQuadPos = gl.getAttribLocation(program, 'aQuadPos');
        locDstRect = gl.getAttribLocation(program, 'aDstRect');
        locSrcRect = gl.getAttribLocation(program, 'aSrcRect');
        locViewportPx = gl.getUniformLocation(program, 'uViewportPx');
        locTopOffset = gl.getUniformLocation(program, 'uTopOffset');
        locAtlasSampler = gl.getUniformLocation(program, 'uAtlas');

        quadVBO = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0, 1,0, 0,1, 1,1]), gl.STATIC_DRAW);

        dynInstVBO = gl.createBuffer();

        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

        attachedCanvas = canvas;
        return true;
      } catch (e) {
        console.warn('[gridRenderer] init failed:', e.message);
        failed = true;
        return false;
      }
    }

    function attach(canvas) {
      if (failed) return false;
      if (gl && attachedCanvas === canvas) return true;
      releaseAll();
      releaseAllStatic();
      gl = null; program = null; quadVBO = null; dynInstVBO = null;
      attachedCanvas = null;
      return init(canvas);
    }

    function available() { return !failed && gl !== null; }

    function uploadSprite(key, bitmap) {
      if (!available() || !bitmap) return;
      var existing = textures.get(key);
      if (existing) return;
      window.__textureKeys = window.__textureKeys || new Set();
      window.__textureKeys.add(key);
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      textures.set(key, { tex: tex, w: bitmap.width, h: bitmap.height });
    }

    function releaseAll() {
      if (!gl) { textures.clear(); return; }
      textures.forEach(function (t) { gl.deleteTexture(t.tex); });
      textures.clear();
    }
    function deleteTexture(key) {
      if (!gl) return;
      var t = textures.get(key);
      if (!t) return;
      gl.deleteTexture(t.tex);
      textures.delete(key);
    }

    function uploadStatic(key, float32Array) {
      if (!available()) return;
      var existing = staticBuffers.get(key);
      if (existing) gl.deleteBuffer(existing.buf);
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, float32Array, gl.STATIC_DRAW);
      staticBuffers.set(key, { buf: buf, count: (float32Array.length / 8) | 0 });
    }
    function dropStatic(key) {
      if (!gl) return;
      var s = staticBuffers.get(key);
      if (!s) return;
      gl.deleteBuffer(s.buf);
      staticBuffers.delete(key);
    }
    function releaseAllStatic() {
      if (!gl) { staticBuffers.clear(); return; }
      staticBuffers.forEach(function (s) { gl.deleteBuffer(s.buf); });
      staticBuffers.clear();
    }
    function hasStatic(key) { return staticBuffers.has(key); }

    function bindCommonState(viewportW, viewportH, dpr, topOffset) {
      // Chrome caps the drawing buffer when canvas dims exceed an internal GPU
      // memory budget. canvas.width/height stay at what we requested, but the
      // actual fb is smaller — gl.drawingBufferWidth/Height reflect reality.
      // Always viewport to the actual fb so content lands inside it.
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.clearColor(0.04, 0.04, 0.04, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.uniform2f(locViewportPx, viewportW, viewportH);
      gl.uniform1f(locTopOffset, topOffset);
      gl.uniform1i(locAtlasSampler, 0);
      gl.activeTexture(gl.TEXTURE0);

      gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
      gl.enableVertexAttribArray(locQuadPos);
      gl.vertexAttribPointer(locQuadPos, 2, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(locQuadPos, 0);

      gl.enableVertexAttribArray(locDstRect);
      gl.enableVertexAttribArray(locSrcRect);
      gl.vertexAttribDivisor(locDstRect, 1);
      gl.vertexAttribDivisor(locSrcRect, 1);
    }

    // Dynamic batches: { textureKey, instances: Float32Array }. Used by
    // per-image mode where the per-tile texture varies and instances must
    // be rebuilt when the buffer window moves.
    function render(viewportW, viewportH, dpr, topOffset, batches) {
      if (!available()) return;
      window.__lastDrawTopOffset = topOffset;
      window.__lastDrawAt = performance.now();
      window.__lastBatches = batches.map(function (b) {
        return { textureKey: b.textureKey, n: (b.instances ? b.instances.length / 8 : 0) | 0,
                 first: b.instances ? Array.from(b.instances.slice(0, 8)) : null };
      });
      bindCommonState(viewportW, viewportH, dpr, topOffset);
      gl.bindBuffer(gl.ARRAY_BUFFER, dynInstVBO);
      gl.vertexAttribPointer(locDstRect, 4, gl.FLOAT, false, 32, 0);
      gl.vertexAttribPointer(locSrcRect, 4, gl.FLOAT, false, 32, 16);
      for (var b = 0; b < batches.length; b++) {
        var batch = batches[b];
        var t = textures.get(batch.textureKey);
        if (!t || !batch.instances || batch.instances.length === 0) continue;
        gl.bindTexture(gl.TEXTURE_2D, t.tex);
        gl.bindBuffer(gl.ARRAY_BUFFER, dynInstVBO);
        gl.bufferData(gl.ARRAY_BUFFER, batch.instances, gl.STREAM_DRAW);
        gl.vertexAttribPointer(locDstRect, 4, gl.FLOAT, false, 32, 0);
        gl.vertexAttribPointer(locSrcRect, 4, gl.FLOAT, false, 32, 16);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, (batch.instances.length / 8) | 0);
      }
    }

    // Static batches: { textureKey, instanceKey } — both pre-uploaded.
    // Per-frame work is one bind + one draw per batch; no JS-side per-tile
    // work. This is the hot path for atlas mode at #size0/#fit on big sets.
    function renderStatic(viewportW, viewportH, dpr, topOffset, batches) {
      if (!available()) return;
      window.__lastDrawTopOffset = topOffset;
      window.__lastDrawAt = performance.now();
      bindCommonState(viewportW, viewportH, dpr, topOffset);
      for (var b = 0; b < batches.length; b++) {
        var batch = batches[b];
        var t = textures.get(batch.textureKey);
        var s = staticBuffers.get(batch.instanceKey);
        if (!t || !s || !s.count) continue;
        gl.bindTexture(gl.TEXTURE_2D, t.tex);
        gl.bindBuffer(gl.ARRAY_BUFFER, s.buf);
        gl.vertexAttribPointer(locDstRect, 4, gl.FLOAT, false, 32, 0);
        gl.vertexAttribPointer(locSrcRect, 4, gl.FLOAT, false, 32, 16);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, s.count);
      }
    }

    function hasTexture(key) { return textures.has(key); }

    return {
      attach: attach, available: available, uploadSprite: uploadSprite,
      releaseAll: releaseAll, deleteTexture: deleteTexture,
      uploadStatic: uploadStatic, dropStatic: dropStatic,
      releaseAllStatic: releaseAllStatic, hasStatic: hasStatic,
      render: render, renderStatic: renderStatic,
      hasTexture: hasTexture,
    };
  })();

  // Best already-cached per-image tier for `name`. Prefers exact target,
  // falls back to any smaller cached tier. Keeps zoom transitions from
  // flashing black while the target tier loads.
  function bestCachedPerImage(name, targetTier) {
    if (targetTier === 0) {
      for (var i = PER_IMAGE_TIERS.length - 1; i >= 0; i--) {
        var bm = getPerImageBitmapSync(name, PER_IMAGE_TIERS[i]);
        if (bm) return bm;
      }
      return null;
    }
    var bm = getPerImageBitmapSync(name, targetTier);
    if (bm) return bm;
    for (var i = PER_IMAGE_TIERS.length - 1; i >= 0; i--) {
      if (PER_IMAGE_TIERS[i] >= targetTier) continue;
      var bm2 = getPerImageBitmapSync(name, PER_IMAGE_TIERS[i]);
      if (bm2) return bm2;
    }
    return null;
  }

  // Best already-loaded atlas source for `name` (h50 → h10 → h5).
  function bestCachedAtlasSrc(name) {
    if (!window.spriteMeta || !spriteMeta.atlases) return null;
    var loc = spriteMeta.imageMap && spriteMeta.imageMap[name];
    if (!loc) return null;
    var heights = ['50', '10', '5'];
    for (var hi = 0; hi < heights.length; hi++) {
      var key = heights[hi];
      var atlas = spriteMeta.atlases[key];
      if (!atlas) continue;
      var bitmaps = atlasBitmapsSync[key];
      if (!bitmaps) continue;
      var idx = loc.idx;
      var spriteIdx = Math.floor(idx / atlas.cellsPerSprite);
      var bitmap = bitmaps[spriteIdx];
      if (!bitmap) continue;
      var posInSprite = idx % atlas.cellsPerSprite;
      var row = Math.floor(posInSprite / atlas.across);
      var col = posInSprite % atlas.across;
      var canonicalH = 200;
      var srcW = Math.round(loc.w * (atlas.cellH / canonicalH));
      return { bitmap: bitmap, sx: col * atlas.cellW, sy: row * atlas.cellH, sw: srcW, sh: atlas.cellH };
    }
    return null;
  }

  // Overscan canvas: sized to ~3x viewport, position:absolute inside a
  // spacer that holds the full layout height. Native scroll moves the
  // spacer (and the canvas with it) — iOS scrubber and trackpad/wheel all
  // behave exactly as today. We only redraw + reposition the canvas when
  // the visible viewport approaches the canvas edge.
  var bufferTop = -1;        // world y of canvas top (-1 = uninitialized)
  var bufferH = 0;           // canvas CSS height
  var totalLayoutH = 0;      // full content height (spacer height)
  var atlasInstancesBuiltFor = null;  // String(atlasH) we built static buffers for
  var atlasInstancesLayoutH = -1;     // currentRowHeight when built
  var pendingReposition = false;
  var lastScrollTime = 0;             // performance.now() of last user scroll
  var deferredUpgradeTimer = null;
  var BUFFER_VIEWPORTS = 5;
  var EDGE_MARGIN_FRAC = 0.5;
  var SCROLL_IDLE_MS = 250;           // wait this long after scroll before per-image upgrade redraw

  // Schedule a redraw, but if the user is actively scrolling, defer until
  // they pause. Edge crossings still draw immediately (handled separately).
  // This prevents the visible per-image upgrade transition during scroll —
  // user sees a stable canvas (atlas-fallback) while scrolling, then a
  // one-shot upgrade after they stop.
  function scheduleUpgradeRedraw() {
    if (deferredUpgradeTimer) return;
    var since = performance.now() - lastScrollTime;
    if (since < SCROLL_IDLE_MS) {
      deferredUpgradeTimer = setTimeout(function () {
        deferredUpgradeTimer = null;
        scheduleUpgradeRedraw();
      }, SCROLL_IDLE_MS - since + 16);
      return;
    }
    if (pendingReposition) return;
    pendingReposition = true;
    requestAnimationFrame(function () {
      pendingReposition = false;
      drawCanvasForScroll();
    });
  }

  function ensureCanvasAndSpacer(thumbsEl) {
    if (canvasEl && spacerEl && spacerEl.parentNode === thumbsEl && canvasEl.parentNode === spacerEl) return;
    thumbsEl.innerHTML = '';
    spacerEl = document.createElement('div');
    spacerEl.style.cssText = 'position:relative; width:100%; height:0px;';
    canvasEl = document.createElement('canvas');
    canvasEl.style.cssText = 'cursor:pointer; display:block; position:absolute; left:0; top:0; z-index:1;';
    spacerEl.appendChild(canvasEl);
    thumbsEl.appendChild(spacerEl);
    canvasEl.addEventListener('click', onCanvasClick);
    if (!thumbsScrollAttached) {
      thumbsEl.addEventListener('scroll', onThumbsScroll, { passive: true });
      thumbsScrollAttached = true;
    }
    bufferTop = -1;
    atlasInstancesBuiltFor = null;
    // Mode swap creates a fresh canvas → fresh GL context → re-upload textures.
    // Cached loadPerImageBitmap promises resolve immediately and skip the
    // upload path in _runPerImageJob, so per-image textures must be re-pushed
    // here too. Static instance buffers are per-context too — drop them so
    // renderGallery rebuilds for the new context.
    if (gridRenderer.attach(canvasEl)) {
      Object.keys(atlasBitmapsSync).forEach(function (k) {
        var arr = atlasBitmapsSync[k];
        for (var i = 0; i < arr.length; i++) {
          if (arr[i]) gridRenderer.uploadSprite(k + ':' + i, arr[i]);
        }
      });
      perImageBitmapsSync.forEach(function (bm, key) {
        if (bm) gridRenderer.uploadSprite('img:' + key, bm);
      });
    }
  }

  // Sized to fit content (no overscan needed) or 3 viewports tall, whichever
  // is smaller. Called from renderGallery once layout is known.
  function applyGridLayout(thumbsEl, W, viewportH, totalH) {
    totalLayoutH = totalH;
    spacerEl.style.height = Math.max(1, Math.ceil(totalH)) + 'px';
    bufferH = Math.min(Math.ceil(totalH), Math.ceil(viewportH * BUFFER_VIEWPORTS));
    if (bufferH < viewportH) bufferH = viewportH;  // never smaller than viewport
    var dpr = devicePixelRatio();
    canvasEl.width = Math.round(W * dpr);
    canvasEl.height = Math.round(bufferH * dpr);
    canvasEl.style.width = W + 'px';
    canvasEl.style.height = bufferH + 'px';
    bufferTop = -1;  // force reposition on next draw
  }

  // Skip anchor capture once after a programmatic scrollTop set — the resulting
  // scroll event is a side effect of the anchor, not a fresh user input.
  var suppressNextAnchorCapture = false;
  function onThumbsScroll() {
    if (focusedIdx > 0) return;
    if (suppressNextAnchorCapture) { suppressNextAnchorCapture = false; }
    else { captureAnchorFromScroll(); hideControls(); }
    lastScrollTime = performance.now();
    var thumbsEl = $('thumbs');
    if (!thumbsEl || !canvasEl) return;
    var scrollY = thumbsEl.scrollTop;
    var viewportH = thumbsEl.clientHeight;
    if (!bufferNeedsReposition(scrollY, viewportH)) return;
    if (pendingReposition) return;
    pendingReposition = true;
    requestAnimationFrame(function () {
      pendingReposition = false;
      drawCanvasForScroll();
    });
  }

  // True if current scrollY is within EDGE_MARGIN_FRAC viewports of either
  // buffer edge (and there's content on the other side of that edge).
  function bufferNeedsReposition(scrollY, viewportH) {
    if (bufferTop < 0) return true;
    var topSlack = scrollY - bufferTop;
    var botSlack = (bufferTop + bufferH) - (scrollY + viewportH);
    var marginPx = viewportH * EDGE_MARGIN_FRAC;
    if (topSlack < marginPx && bufferTop > 0) return true;
    if (botSlack < marginPx && bufferTop + bufferH < totalLayoutH) return true;
    return false;
  }

  function recenterBuffer(scrollY, viewportH) {
    var maxBufferTop = Math.max(0, Math.ceil(totalLayoutH) - bufferH);
    bufferTop = Math.max(0, Math.min(maxBufferTop,
      Math.floor(scrollY - (bufferH - viewportH) / 2)));
    canvasEl.style.top = bufferTop + 'px';
    window.__bufferTop = bufferTop;
  }

  function onCanvasClick(e) {
    var thumbsEl = $('thumbs');
    if (!thumbsEl) return;
    var trect = thumbsEl.getBoundingClientRect();
    var cx = e.clientX - trect.left;
    var cy = e.clientY - trect.top + thumbsEl.scrollTop;
    // Binary search by y (rows are emitted top-down, so lastTileRects is
    // sorted by y). For 100k tiles this drops a click from ~5ms to <0.1ms.
    var n = lastTileRects.length;
    if (!n) return;
    var lo = 0, hi = n - 1, anchor = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lastTileRects[mid].y > cy) hi = mid - 1;
      else { anchor = mid; lo = mid + 1; }
    }
    // Walk back from anchor while still in the same row (y range overlaps cy).
    var i = anchor;
    while (i > 0 && lastTileRects[i - 1].y === lastTileRects[anchor].y) i--;
    var rowY = lastTileRects[i].y;
    while (i < n && lastTileRects[i].y === rowY) {
      var t = lastTileRects[i];
      if (cx >= t.x && cx < t.x + t.w && cy >= t.y && cy < t.y + t.h) {
        location.hash = encodeURIComponent(t.name);
        return;
      }
      i++;
    }
  }

  // Captured on user scroll. Used by re-layout (zoom change) to keep the
  // top-row image pinned, and persisted to sessionStorage so a page reload
  // (F5) restores the same scroll position. sessionStorage is keyed by
  // folderURL so each gallery has its own remembered position; lost on tab
  // close, which matches what people expect from refresh-vs-new-session.
  var cachedAnchorName = null;
  function scrollKey() { return 'gg.scroll.' + (window.folderURL || '/'); }
  function captureAnchorFromScroll() {
    var thumbsEl = document.getElementById('thumbs');
    if (!thumbsEl || !lastTileRects.length) { cachedAnchorName = null; persistAnchor(); return; }
    var scrollY = thumbsEl.scrollTop;
    if (scrollY <= 0) { cachedAnchorName = null; persistAnchor(); return; }
    // Row-major tile order → first tile whose y-range spans scrollY is the
    // leftmost image of the topmost visible row.
    for (var i = 0; i < lastTileRects.length; i++) {
      var t = lastTileRects[i];
      if (t.y <= scrollY && scrollY < t.y + t.h) { cachedAnchorName = t.name; persistAnchor(); return; }
    }
    // Past the last row → use the last row's leftmost tile.
    for (var j = lastTileRects.length - 1; j >= 0; j--) {
      if (lastTileRects[j].x === 0) { cachedAnchorName = lastTileRects[j].name; persistAnchor(); return; }
    }
    cachedAnchorName = null; persistAnchor();
  }
  function persistAnchor() {
    try {
      if (cachedAnchorName) sessionStorage.setItem(scrollKey(), cachedAnchorName);
      else sessionStorage.removeItem(scrollKey());
    } catch (_) {}  // private mode / quota — silently no-op
  }

  // Atlas-mode static buffers: one Float32Array per (atlasH, spriteIdx)
  // holding all tile instances using that sprite. Built once per layout,
  // resident on the GPU. Per-frame work is a single uniform + drawArraysInstanced
  // per batch — no JS-side per-tile work.
  function buildStaticAtlasBuffers(atlasH) {
    var key = String(atlasH);
    var atlas = spriteMeta && spriteMeta.atlases && spriteMeta.atlases[key];
    if (!atlas) return;
    var nSprites = atlas.sprites.length;
    var aPerSprite = atlas.cellsPerSprite;
    var aAcross = atlas.across;
    var cellW = atlas.cellW, cellH = atlas.cellH;
    // Per-sprite instance arrays. Array growth is amortized; we know
    // approximate counts per sprite (cellsPerSprite-ish).
    var perSprite = new Array(nSprites);
    for (var s = 0; s < nSprites; s++) perSprite[s] = [];
    for (var i = 0; i < lastTileRects.length; i++) {
      var t = lastTileRects[i];
      var loc = spriteMeta.imageMap[t.name];
      if (!loc) continue;
      var spIdx = Math.floor(loc.idx / aPerSprite);
      var posInSprite = loc.idx % aPerSprite;
      var row = Math.floor(posInSprite / aAcross);
      var col = posInSprite % aAcross;
      // src in cell pixels; texture dims unknown until upload, so store
      // pixel coords here and convert to UV at draw time? No — the sprite
      // image dim is deterministic from atlas metadata (across*cellW × ceil(count/across)*cellH).
      // We use that.
      var spriteCells = atlas.sprites[spIdx].count;
      var spriteRows = Math.ceil(spriteCells / aAcross);
      var spriteW = aAcross * cellW;
      var spriteH = spriteRows * cellH;
      // The atlas cell stores the tile fit-within (cellW, cellH) preserving
      // aspect (top-left, leftover area is zero). MUST match the server
      // formula in sprite_worker.js fitInCell() exactly — UV sampling reads
      // the stored bytes, mismatch = neighbor-cell bleed for wide tiles or
      // black-padding bleed for tiny tiles.
      var aspect = loc.w / 200;  // canonical aspect from imagemap
      var naturalW = aspect * cellH;
      var storedW, storedH;
      if (naturalW > cellW) {
        storedW = cellW;
        storedH = Math.max(1, Math.round(cellW / aspect));
      } else {
        storedW = Math.max(1, Math.round(naturalW));
        storedH = cellH;
      }
      var sx = col * cellW;
      var sy = row * cellH;
      var u0 = sx / spriteW, v0 = sy / spriteH;
      var du = storedW / spriteW, dv = storedH / spriteH;
      var arr = perSprite[spIdx];
      arr.push(t.x, t.y, t.w, t.h, u0, v0, du, dv);
    }
    // Drop any prior buffers for this atlas, then upload fresh.
    for (var s2 = 0; s2 < nSprites; s2++) {
      var ikey = key + ':' + s2;
      var arr2 = perSprite[s2];
      if (arr2.length === 0) {
        gridRenderer.dropStatic(ikey);
        continue;
      }
      gridRenderer.uploadStatic(ikey, new Float32Array(arr2));
    }
    atlasInstancesBuiltFor = key;
    atlasInstancesLayoutH = currentRowHeight;
  }

  // Drop a static buffer for an atlas sprite that's no longer needed (the
  // sprite texture itself is dropped separately by evictAtlasBitmaps).
  function dropStaticAtlasBuffer(atlasH, spriteIdx) {
    gridRenderer.dropStatic(String(atlasH) + ':' + spriteIdx);
  }

  // Indices of sprites that have at least one tile in the buffer y-range.
  function spritesNeededForBuffer(atlasH) {
    var key = String(atlasH);
    var atlas = spriteMeta && spriteMeta.atlases && spriteMeta.atlases[key];
    if (!atlas) return new Set();
    var aPerSprite = atlas.cellsPerSprite;
    var top = bufferTop, bot = bufferTop + bufferH;
    var needed = new Set();
    // Binary-search to first tile whose y ≥ top.
    var n = lastTileRects.length, lo = 0, hi = n - 1, start = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lastTileRects[mid].y < top) { start = mid + 1; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    // Step back one if start is past a tile that overlaps top.
    if (start > 0 && lastTileRects[start - 1].y + lastTileRects[start - 1].h > top) start--;
    for (var i = start; i < n; i++) {
      var t = lastTileRects[i];
      if (t.y > bot) break;
      var loc = spriteMeta.imageMap[t.name];
      if (loc) needed.add(Math.floor(loc.idx / aPerSprite));
    }
    return needed;
  }

  // Drop atlas sprites (texture + ImageBitmap + cached promise) that are
  // outside the buffer window. Bounded memory regardless of how far the user scrolls.
  function evictAtlasBitmaps(atlasH, neededIdxs) {
    var key = String(atlasH);
    var arr = atlasBitmapsSync[key];
    if (!arr) return;
    var promCache = spritePromises[key];
    for (var i = 0; i < arr.length; i++) {
      if (neededIdxs.has(i)) continue;
      var bm = arr[i];
      if (bm) {
        try { bm.close && bm.close(); } catch (_) {}
        arr[i] = null;
      }
      gridRenderer.deleteTexture(key + ':' + i);
      if (promCache) delete promCache[i];
    }
  }
  // Drop ALL bitmaps + textures from atlas tiers not in keepTiers. Switching
  // zoom level (e.g. size2 → size3) leaves the previous tier's sprites in
  // atlasBitmapsSync forever otherwise — evictAtlasBitmaps only runs for
  // the currently-active tier. Cycling through fit/size0..size6 with a buffer
  // covering many tiles otherwise accumulates GBs across tiers.
  function evictAtlasTiersOtherThan(keepTiers) {
    Object.keys(atlasBitmapsSync).forEach(function (key) {
      if (keepTiers.has(key)) return;
      evictAtlasBitmaps(parseInt(key, 10), new Set());
    });
  }

  function drawCanvasForScroll() {
    if (!canvasEl || !window.spriteMeta) return;
    var thumbsEl = $('thumbs');
    if (!thumbsEl) return;
    var scrollY = thumbsEl.scrollTop;
    var dpr = devicePixelRatio();
    var W = canvasEl.width / dpr;
    var viewportH = thumbsEl.clientHeight || (canvasEl.height / dpr);
    if (!viewportH) return;
    var atlasH = pickAtlasHeight(currentRowHeight * dpr);

    if (bufferTop < 0 || bufferNeedsReposition(scrollY, viewportH)) {
      recenterBuffer(scrollY, viewportH);
    }

    var bufTop = bufferTop, bufBot = bufferTop + bufferH;
    var myFrame = ++renderFrame;

    if (atlasH != null) {
      var aKey = String(atlasH);
      // Rebuild static instance buffers if layout/atlas changed.
      if (atlasInstancesBuiltFor !== aKey || atlasInstancesLayoutH !== currentRowHeight) {
        // Drop any stale buffers for the previous atlas.
        if (atlasInstancesBuiltFor && atlasInstancesBuiltFor !== aKey) {
          var oldAtlas = spriteMeta.atlases[atlasInstancesBuiltFor];
          if (oldAtlas) for (var oi = 0; oi < oldAtlas.sprites.length; oi++) {
            gridRenderer.dropStatic(atlasInstancesBuiltFor + ':' + oi);
          }
        }
        buildStaticAtlasBuffers(atlasH);
      }

      // Free any prior atlas tier's sprites (zoom-tier transition).
      evictAtlasTiersOtherThan(new Set([aKey]));
      // Lazy-load only sprites the buffer needs; evict the rest within this tier.
      var needed = spritesNeededForBuffer(atlasH);
      evictAtlasBitmaps(atlasH, needed);
      var atlas = spriteMeta.atlases[aKey];
      needed.forEach(function (spIdx) {
        var tk = aKey + ':' + spIdx;
        // Already on GPU? Nothing to wait on, nothing to redraw for.
        if (gridRenderer.hasTexture(tk)) return;
        loadSpriteAt(atlasH, spIdx).then(function () {
          if (!canvasEl) return;
          // Atlas arrival is FIRST content for those tiles — redraw immediately.
          if (!pendingReposition) {
            pendingReposition = true;
            requestAnimationFrame(function () {
              pendingReposition = false;
              drawCanvasForScroll();
            });
          }
        }, function () {});
      });

      // Build batch list: one per sprite. renderStatic skips sprites
      // whose texture isn't loaded yet.
      var batches = [];
      for (var b = 0; b < atlas.sprites.length; b++) {
        var bk = aKey + ':' + b;
        if (!gridRenderer.hasStatic(bk)) continue;
        batches.push({ textureKey: bk, instanceKey: bk });
      }
      gridRenderer.renderStatic(W, bufferH, dpr, bufferTop, batches);
      // Atlas mode doesn't use per-image bitmaps — release any leftovers.
      warmPerImageNames = new Set();
      evictPerImageBitmaps(new Set());
      return;
    }

    // Per-image path: dynamic batches scoped to the buffer region. Rebuilt
    // only on edge crossings or sprite arrivals (not per scroll event).
    var tierH = pickPerImageTier(currentRowHeight * dpr);
    var tiers = [tierH].concat(PER_IMAGE_TIERS.filter(function (h) { return h < tierH; }).reverse());

    // Visible-in-buffer tiles via binary search.
    var n = lastTileRects.length, lo = 0, hi = n - 1, start = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lastTileRects[mid].y < bufTop) { start = mid + 1; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    if (start > 0 && lastTileRects[start - 1].y + lastTileRects[start - 1].h > bufTop) start--;

    var batchAccum = new Map();
    function pushBatch(key, x, y, w, h, u0, v0, du, dv) {
      var arr = batchAccum.get(key);
      if (!arr) { arr = []; batchAccum.set(key, arr); }
      arr.push(x, y, w, h, u0, v0, du, dv);
    }
    function pushAtlasFallback(t) {
      var src = bestCachedAtlasSrc(t.name);
      if (!src) return false;
      var loc = spriteMeta.imageMap[t.name];
      if (!loc) return false;
      var heights = ['50', '10', '5'];
      for (var hi2 = 0; hi2 < heights.length; hi2++) {
        var hKey = heights[hi2];
        var atlasMeta = spriteMeta.atlases[hKey];
        if (!atlasMeta) continue;
        var arr = atlasBitmapsSync[hKey];
        if (!arr) continue;
        var spIdx = Math.floor(loc.idx / atlasMeta.cellsPerSprite);
        if (arr[spIdx] !== src.bitmap) continue;
        var bk = hKey + ':' + spIdx;
        if (!gridRenderer.hasTexture(bk)) return false;
        var w = arr[spIdx].width, h = arr[spIdx].height;
        pushBatch(bk, t.x, t.y, t.w, t.h, src.sx / w, src.sy / h, src.sw / w, src.sh / h);
        return true;
      }
      return false;
    }

    // Build keepKeys for queue trimming: every tile in the buffer at the
    // ideal tier is fair game to keep. Anything queued for a tile outside
    // this set is stale (user scrolled past it) and gets dropped.
    var keepKeys = new Set();
    var fallbackSpriteIdxs = new Set();
    var fallbackAtlas = spriteMeta.atlases['50'] || spriteMeta.atlases['10'] || spriteMeta.atlases['5'];
    var fallbackKey = fallbackAtlas ? (spriteMeta.atlases['50'] ? '50' : (spriteMeta.atlases['10'] ? '10' : '5')) : null;
    for (var ki = start; ki < n; ki++) {
      if (lastTileRects[ki].y > bufBot) break;
      keepKeys.add(lastTileRects[ki].name + '|' + tierH);
      if (fallbackAtlas) {
        var floc = spriteMeta.imageMap[lastTileRects[ki].name];
        if (floc) fallbackSpriteIdxs.add(Math.floor(floc.idx / fallbackAtlas.cellsPerSprite));
      }
    }
    cancelPerImageLoadsExcept(keepKeys);

    // Kick off atlas-fallback sprites for everything in the buffer. h50 (or
    // smaller) gives every tile a placeholder while per-image loads in. Big
    // sprite, single fetch, much faster than waiting on hundreds of per-image
    // bitmaps. evictAtlasBitmaps trims sprites that fall out of the buffer.
    if (fallbackKey) {
      var fbAtlasH = parseInt(fallbackKey, 10);
      fallbackSpriteIdxs.forEach(function (spIdx) {
        var tk = fallbackKey + ':' + spIdx;
        if (gridRenderer.hasTexture(tk)) return;
        loadSpriteAt(fbAtlasH, spIdx).then(function (bm) {
          if (!bm || !canvasEl) return;
          if (!pendingReposition) {
            pendingReposition = true;
            requestAnimationFrame(function () {
              pendingReposition = false;
              drawCanvasForScroll();
            });
          }
        }, function () {});
      });
      // Evict atlas sprites that aren't needed for the current buffer.
      evictAtlasBitmaps(fbAtlasH, fallbackSpriteIdxs);
      // And free every OTHER atlas tier's sprites — we're in per-image mode,
      // only the fallback tier is in use.
      evictAtlasTiersOtherThan(new Set([fallbackKey]));
    } else {
      // No fallback atlas at all (shouldn't happen for built galleries) —
      // free every atlas tier.
      evictAtlasTiersOtherThan(new Set());
    }

    var warmNames = new Set();
    for (var i = start; i < n; i++) {
      var t = lastTileRects[i];
      if (t.y > bufBot) break;
      warmNames.add(t.name);
      var keyFound = null;
      for (var ti = 0; ti < tiers.length; ti++) {
        var probe = 'img:' + t.name + '|' + tiers[ti];
        if (gridRenderer.hasTexture(probe)) { keyFound = probe; break; }
      }
      if (keyFound) pushBatch(keyFound, t.x, t.y, t.w, t.h, 0, 0, 1, 1);
      else pushAtlasFallback(t);
      // Only chain a redraw if the IDEAL tier isn't already on GPU. Without
      // this, every redraw re-chains and an already-cached promise triggers
      // another redraw — infinite loop.
      var idealKey = 'img:' + t.name + '|' + tierH;
      if (!gridRenderer.hasTexture(idealKey)) {
        loadPerImageBitmap(t.name, tierH).then(function (bm) {
          // bm===null means the load was canceled — no new content arrived,
          // so don't trigger a redraw (would just rebuild for nothing).
          if (!bm || !canvasEl) return;
          // Per-image arrival is an UPGRADE (atlas-fallback already shows
          // content). Defer until scroll idles so the user doesn't see
          // tiles refreshing as they scroll.
          scheduleUpgradeRedraw();
        }, function () {});
      }
    }
    warmPerImageNames = warmNames;
    evictPerImageBitmaps(warmNames);

    var batches2 = [];
    batchAccum.forEach(function (arr, key) {
      batches2.push({ textureKey: key, instances: new Float32Array(arr) });
    });
    gridRenderer.render(W, bufferH, dpr, bufferTop, batches2);
  }
  // ---- focus mode: main image + filmstrip ------------------------------
  // Layout: #thumbs (overflow:hidden, full viewport) holds #focus-main on top
  // and #focus-strip (the only scroll surface) below. Filmstrip tiles are
  // drawn from the h50 atlas at natural aspect; the centered tile drives
  // the main canvas, which is repainted from h50 first, then upgraded to the
  // best available per-image LoD asynchronously.
  var FILM_TILE_H = 30;
  var FILM_H = FILM_TILE_H + 8;
  var FILM_GAP = 3;
  var mainEl = null;      // main image canvas
  var filmstripEl = null; // filmstrip scroll container
  var filmCanvasEl = null;// canvas inside filmstrip
  var filmSpacerEl = null;
  // Swipe drag state. Focused image translates by dragDX; neighbors are painted
  // at ±viewportW. Release commits (snap to ±W + shift focus) or reverts.
  var dragActive = false;
  var dragDX = 0;
  var dragRaf = null;     // animation id for commit/revert
  // Sync source for the main canvas: { bitmap, sx, sy, sw, sh, forIdx } | null.
  // Updated by drawMainImage (atlas) then upgradeMainImage (high-LoD).
  var mainDrawSrc = null;
  var touchOnMain = false;
  // Filmstrip layout (rebuilt on filmstrip setup / resize).
  var filmTilePos = null;
  var filmTileW   = null;
  var filmTotalW  = 0;
  var filmPadL    = 0;    // pads so the first/last tile can sit at center
  var filmPadR    = 0;
  var filmScrollPending = false;
  var focusInProgrammaticScroll = false;

  function buildFilmstripLayout() {
    var n = lastimagevalue;
    filmTilePos = new Float64Array(n);
    filmTileW = new Float64Array(n);
    var x = 0;
    for (var i = 0; i < n; i++) {
      var name = images[i + 1];
      var loc = name && spriteMeta && spriteMeta.imageMap && spriteMeta.imageMap[name];
      // Aspect-preserving width at FILM_TILE_H, floored at 6px for tappability.
      var w = loc ? Math.max(6, Math.round(loc.w * FILM_TILE_H / CANONICAL_H)) : FILM_TILE_H;
      filmTilePos[i] = x;
      filmTileW[i] = w;
      x += w + FILM_GAP;
    }
    filmTotalW = x - FILM_GAP;
  }

  function filmCenteredIdx1(scrollLeft, viewportW) {
    if (!filmTilePos || !filmTilePos.length) return focusedIdx;
    var center = scrollLeft + viewportW / 2 - filmPadL;
    // Tile whose center is closest to the scroll center. Center-of-tile beats
    // end-of-tile because fractional scrollLeft at non-100% zoom would otherwise
    // skip narrow tiles to their wide neighbors.
    var lo = 0, hi = filmTilePos.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (filmTilePos[mid] + filmTileW[mid] / 2 < center) lo = mid + 1;
      else hi = mid;
    }
    var best = lo, bestDist = Infinity;
    for (var k = -1; k <= 1; k++) {
      var i = lo + k;
      if (i < 0 || i >= filmTilePos.length) continue;
      var d = Math.abs((filmTilePos[i] + filmTileW[i] / 2) - center);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best + 1;
  }

  function filmScrollForIdx1(idx1, viewportW) {
    if (!filmTilePos || idx1 < 1) return 0;
    var i = idx1 - 1;
    if (i >= filmTilePos.length) i = filmTilePos.length - 1;
    var tileCenter = filmPadL + filmTilePos[i] + filmTileW[i] / 2;
    return Math.max(0, tileCenter - viewportW / 2);
  }

  // rAF chase toward filmScrollForIdx1(commandedIdx). Reads commandedIdx live,
  // so successive shifts bump the target without restarting the chase.
  var focusChaseRaf = null;
  function startFocusChase() {
    focusInProgrammaticScroll = true;
    if (focusChaseRaf) return;
    focusChaseRaf = requestAnimationFrame(focusChaseTick);
  }
  function focusChaseTick() {
    focusChaseRaf = null;
    if (!filmstripEl || focusedIdx === 0 || commandedIdx <= 0) {
      focusInProgrammaticScroll = false;
      return;
    }
    var W = layoutWidth();
    var target = filmScrollForIdx1(commandedIdx, W);
    var cur = filmstripEl.scrollLeft;
    var diff = target - cur;
    // Exit when we are within a pixel. The prior threshold of 0.5 combined
    // with a min-step clamp of 1 ping-ponged forever on platforms where the
    // browser rounds scrollLeft to an integer: target=X.5, cur=X → step
    // clamped to +1 → cur=X+1 → step clamped to -1 → cur=X → ….
    if (Math.abs(diff) < 1) {
      filmstripEl.scrollLeft = target;
      // Authoritative settle: the commanded tile is the focus. drawFilmstrip
      // re-derives focusedIdx from scrollLeft, and a browser-rounded
      // scrollLeft + wide neighbor can flip it to the wrong tile; force the
      // right value here before that runs.
      focusedIdx = commandedIdx;
      focusInProgrammaticScroll = false;
      return;
    }
    // No step-magnitude clamp — modern browsers handle fractional scrollLeft,
    // and the 0.25*diff geometric progression converges fast enough on its own.
    filmstripEl.scrollLeft = cur + diff * 0.25;
    focusChaseRaf = requestAnimationFrame(focusChaseTick);
  }

  function setupFilmstripFocus(thumbsEl) {
    var W = layoutWidth(), H = layoutHeight();
    var mainH = Math.max(120, H - FILM_H);

    thumbsEl.style.position = 'relative';
    thumbsEl.style.height = H + 'px';
    thumbsEl.style.overflow = 'hidden';
    thumbsEl.innerHTML = '';
    canvasEl = null; spacerEl = null;

    mainEl = document.createElement('canvas');
    mainEl.id = 'focus-main';
    var dpr = devicePixelRatio();
    mainEl.width  = Math.round(W * dpr);
    mainEl.height = Math.round(mainH * dpr);
    mainEl.style.cssText = 'display:block; width:' + W + 'px; height:' + mainH + 'px; background:#000; touch-action:pan-y pinch-zoom;';
    thumbsEl.appendChild(mainEl);

    filmstripEl = document.createElement('div');
    filmstripEl.id = 'focus-strip';
    filmstripEl.style.cssText =
      'position:absolute; left:0; bottom:0; width:' + W + 'px; height:' + FILM_H + 'px;' +
      'overflow-x:auto; overflow-y:hidden; background:#0a0a0a;' +
      ' -ms-overflow-style:none; scrollbar-width:none;' +
      ' touch-action:pan-x;';
    thumbsEl.appendChild(filmstripEl);

    filmCanvasEl = document.createElement('canvas');
    filmCanvasEl.width  = Math.round(W * dpr);
    filmCanvasEl.height = Math.round(FILM_H * dpr);
    filmCanvasEl.style.cssText =
      'position:sticky; left:0; top:0; display:block; height:' + FILM_H + 'px; width:' + W + 'px; cursor:pointer;';
    filmstripEl.appendChild(filmCanvasEl);

    buildFilmstripLayout();
    filmPadL = filmPadR = Math.round(W / 2);

    filmSpacerEl = document.createElement('div');
    filmSpacerEl.style.cssText =
      'position:absolute; top:0; left:0; width:' + (filmPadL + filmTotalW + filmPadR) + 'px; height:1px;';
    filmstripEl.appendChild(filmSpacerEl);

    filmstripEl.addEventListener('scroll', onFilmstripScroll, { passive: true });
    filmCanvasEl.addEventListener('click', onFilmstripClick);
    // Manual gesture cancels the chase, otherwise scroll + chase fight and
    // the strip rubber-bands.
    function cancelChaseFromUser() {
      if (focusChaseRaf) {
        cancelAnimationFrame(focusChaseRaf);
        focusChaseRaf = null;
        focusInProgrammaticScroll = false;
        commandedIdx = focusedIdx;
      }
    }
    filmstripEl.addEventListener('wheel', cancelChaseFromUser, { passive: true });

    filmstripEl.addEventListener('touchstart', cancelChaseFromUser, { passive: true });
    filmstripEl.addEventListener('mousedown', cancelChaseFromUser);
    setupMainImageGestures();

    // Position the filmstrip; this is NOT a chase animation (just a sync seek
    // to the focused image). Don't set focusInProgrammaticScroll — doing so
    // without a chase to clear it leaves the flag stuck true, which makes
    // shiftFocus permanently use commandedIdx as the base instead of focusedIdx.
    // Result: arrow keys could only ever go to commandedIdx +/- 1.
    var target = filmScrollForIdx1(focusedIdx, W);
    filmstripEl.scrollLeft = target;
    commandedIdx = focusedIdx;
    renderZoomControl();

    drawFilmstrip();
    drawMainImage();
  }

  function onFilmstripScroll() {
    if (filmScrollPending) return;
    filmScrollPending = true;
    requestAnimationFrame(function () {
      filmScrollPending = false;
      drawFilmstrip();
      drawMainImage();
    });
  }

  // Used by sprite-arrival promise chains to redraw the filmstrip with the
  // CURRENT scroll position (not whatever was captured when the load was
  // queued). rAF-coalesced via the same flag as onFilmstripScroll.
  function scheduleFilmstripRedraw() {
    if (filmScrollPending) return;
    filmScrollPending = true;
    requestAnimationFrame(function () {
      filmScrollPending = false;
      drawFilmstrip();
      drawMainImage();
    });
  }

  function onFilmstripClick(e) {
    if (!filmstripEl || !filmTilePos) return;
    var rect = filmCanvasEl.getBoundingClientRect();
    var clickX = e.clientX - rect.left + filmstripEl.scrollLeft - filmPadL;
    var lo = 0, hi = filmTilePos.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (filmTilePos[mid] + filmTileW[mid] <= clickX) lo = mid + 1;
      else hi = mid;
    }
    commandedIdx = lo + 1;
    startFocusChase();
  }

  function drawFilmstrip() {
    if (!filmstripEl || !filmCanvasEl || !filmTilePos || !window.spriteMeta) return;
    var W = layoutWidth();
    var dpr = devicePixelRatio();
    var ctx = filmCanvasEl.getContext('2d', { alpha: false });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, W, FILM_H);

    var atlasH = 50;
    var atlas = spriteMeta.atlases && spriteMeta.atlases[String(atlasH)];
    if (!atlas) return;
    // Load only sprites covering visible tiles — bounds focus-entry memory.
    (function () {
      if (!filmTilePos || filmTilePos.length === 0) return;
      var atlasMeta = spriteMeta && spriteMeta.atlases && spriteMeta.atlases[String(atlasH)];
      if (!atlasMeta) return;
      var fsl = filmstripEl.scrollLeft;
      var leftE = fsl - filmPadL;
      var rightE = leftE + W;
      var fn = filmTilePos.length;
      var flo = 0, fhi = fn - 1;
      while (flo < fhi) {
        var fmid = (flo + fhi) >> 1;
        if (filmTilePos[fmid] + filmTileW[fmid] <= leftE) flo = fmid + 1; else fhi = fmid;
      }
      var ffirst = flo, flast = flo;
      for (var fi = flo; fi < fn; fi++) {
        if (filmTilePos[fi] > rightE) break;
        flast = fi;
      }
      var firstSp = Math.floor(ffirst / atlasMeta.cellsPerSprite);
      var lastSp = Math.floor(flast / atlasMeta.cellsPerSprite);
      // Mirror the grid path: load only sprites covering the visible range
      // (with a 1-sprite cushion so a small scrub doesn't thrash) and evict
      // the rest. Without this, a fast filmstrip scrub through a 100k gallery
      // accumulates every h50 sprite (~38 MB ImageBitmap each) because each
      // becomes warm in atlasBitmapsSync and nothing ever frees it.
      var BUF_SP = 1;
      var keepLo = Math.max(0, firstSp - BUF_SP);
      var keepHi = Math.min(atlasMeta.sprites.length - 1, lastSp + BUF_SP);
      // Also keep the sprite for the centered focus image — drawMainImage uses
      // the same h50 atlas as a fallback while per-image AVIF is still loading.
      var keep = new Set();
      for (var ks = keepLo; ks <= keepHi; ks++) keep.add(ks);
      if (focusedIdx > 0) {
        keep.add(Math.floor((focusedIdx - 1) / atlasMeta.cellsPerSprite));
      }
      evictAtlasBitmaps(atlasH, keep);
      var bitmapsArr = atlasBitmapsSync[String(atlasH)] || [];
      for (var fs = firstSp; fs <= lastSp; fs++) {
        // Skip already-loaded sprites; chaining .then on a resolved promise
        // would loop (resolves on microtask -> drawFilmstrip -> chain again).
        if (bitmapsArr[fs]) continue;
        loadSpriteAt(atlasH, fs).then(scheduleFilmstripRedraw, function () {});
      }
    })();
    // Paint sync from atlasBitmapsSync; the arrival waiter repaints incrementally.
    if (!filmCanvasEl) return;
    var paintFilmstripTiles = function () {
      if (!filmCanvasEl) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, W, FILM_H);
      var bitmaps = atlasBitmapsSync[String(atlasH)] || [];
      var n = filmTilePos.length;
      var lo2 = 0, hi2 = n - 1;
      while (lo2 < hi2) {
        var mid = (lo2 + hi2) >> 1;
        if (filmTilePos[mid] + filmTileW[mid] <= leftEdge) lo2 = mid + 1;
        else hi2 = mid;
      }
      var aCellW = atlas.cellW, aCellH = atlas.cellH;
      var aPerSprite = atlas.cellsPerSprite, aAcross = atlas.across;
      var srcScale = aCellH / FILM_TILE_H;
      for (var ti = lo2; ti < n; ti++) {
        var tx = filmTilePos[ti];
        var tw = filmTileW[ti];
        if (tx > rightEdge) break;
        var screenX = tx - leftEdge;
        var spriteIdx = Math.floor(ti / aPerSprite);
        var posInSprite = ti % aPerSprite;
        var row = Math.floor(posInSprite / aAcross);
        var col = posInSprite % aAcross;
        var bm = bitmaps[spriteIdx];
        if (!bm) continue;
        var srcW = Math.round(tw * srcScale);
        ctx.drawImage(bm, col * aCellW, row * aCellH, srcW, aCellH, screenX, yPad, tw, FILM_TILE_H);
        if (ti + 1 === focusedIdx) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(screenX + 0.5, yPad + 0.5, tw - 1, FILM_TILE_H - 1);
        }
      }
    };

    var scrollLeft = filmstripEl.scrollLeft;
    var leftEdge = scrollLeft - filmPadL;
    var rightEdge = leftEdge + W;
    var yPad = Math.round((FILM_H - FILM_TILE_H) / 2);

    // When the scroll position has settled at the commanded tile's exact
    // target (within ~1px), trust commandedIdx. filmCenteredIdx1 picks the
    // tile whose center is closest to viewport center, which with a wide
    // neighbor + browser-rounded scrollLeft can deterministically pick the
    // wrong tile by a few pixels — causing focusedIdx to flicker and the
    // main-image stable-focus timer to never fire.
    var newCenterIdx;
    if (commandedIdx > 0) {
      var commandedTarget = filmScrollForIdx1(commandedIdx, W);
      if (Math.abs(scrollLeft - commandedTarget) < 1.5) {
        newCenterIdx = commandedIdx;
      } else {
        newCenterIdx = filmCenteredIdx1(scrollLeft, W);
      }
    } else {
      newCenterIdx = filmCenteredIdx1(scrollLeft, W);
    }
    if (newCenterIdx !== focusedIdx) {
      focusedIdx = newCenterIdx;
      // Keep mainDrawSrc; drawMainImage installs the fresh source next.
      scheduleHashUpdate('#' + encodeURIComponent(images[focusedIdx]));
      hideControls();
    }

    paintFilmstripTiles();
  }

  // Where + how big to draw the main image.
  function mainImageGeom() {
    if (focusedIdx <= 0 || focusedIdx > lastimagevalue) return null;
    var name = images[focusedIdx];
    if (!spriteMeta || !spriteMeta.imageMap) return null;
    var loc = spriteMeta.imageMap[name];
    if (!loc) return null;
    var W = layoutWidth(), H = layoutHeight();
    var mainH = Math.max(120, H - FILM_H);
    var natW = loc.w, natH = CANONICAL_H;
    var scale = Math.min(W / natW, mainH / natH);
    var dw = Math.round(natW * scale), dh = Math.round(natH * scale);
    return {
      W: W, mainH: mainH, name: name, natW: natW, natH: natH,
      dw: dw, dh: dh,
      dx: Math.round((W - dw) / 2),
      dy: Math.round((mainH - dh) / 2),
    };
  }

  // Paint mainDrawSrc onto the main canvas, synchronously.
  function paintMain() {
    if (!mainEl) return;
    var g = mainImageGeom();
    if (!g) return;
    var dpr = devicePixelRatio();
    var ctx = mainEl.getContext('2d', { alpha: false });
    ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, g.W, g.mainH);
    if (mainDrawSrc && mainDrawSrc.bitmap) {
      try {
        ctx.drawImage(
          mainDrawSrc.bitmap,
          mainDrawSrc.sx, mainDrawSrc.sy, mainDrawSrc.sw, mainDrawSrc.sh,
          g.dx, g.dy, g.dw, g.dh
        );
      } catch (_) {
        // Bitmap was closed (eviction race). Drop and let the next paint install fresh.
        mainDrawSrc = null;
      }
    }
  }

  function drawMainImage() {
    if (!mainEl || !window.spriteMeta) return;
    var g = mainImageGeom();
    if (!g) return;

    var targetH = g.dh * devicePixelRatio();
    var tier = pickPerImageTier(targetH);

    // Best already-resolved source (target tier → smaller cached tier → atlas).
    var src = getBestSrcForFocus(focusedIdx, targetH);
    if (src) {
      mainDrawSrc = { bitmap: src.bitmap, sx: src.sx, sy: src.sy, sw: src.sw, sh: src.sh, forIdx: focusedIdx };
    } else if (mainDrawSrc && mainDrawSrc.forIdx !== focusedIdx) {
      // No source ready for the new image AND the placeholder is for a
      // different image. Drop it so paintMain shows black instead of the
      // previous focused image briefly. Preserves placeholder reuse for
      // same-image LoD upgrades (atlas → h800), where forIdx matches.
      mainDrawSrc = null;
    }
    paintMain();

    // Per-image upgrade (the actual fetch + repaint on resolve) is initiated
    // by prefetchFilmstripVisible's stable-focus timer; nothing to do here.
    var capturedIdx = focusedIdx;

    // If we didn't have any bitmap at all yet, kick off atlas load AND register
    // a per-sprite waiter so we paint the instant OUR sprite arrives — rather than
    // waiting for every sprite in the atlas to decode. With OI's 32 h50 sprites
    // that turns ~1s of black canvas into <100ms.
    if (!src) {
      var atlasH = 50;
      var atlas = spriteMeta.atlases && spriteMeta.atlases[String(atlasH)];
      if (atlas) {
        var neededSpriteIdx = Math.floor((capturedIdx - 1) / atlas.cellsPerSprite);
        loadSpriteAt(atlasH, neededSpriteIdx).then(function () {
          if (!mainEl || focusedIdx !== capturedIdx) return;
          var atlasSrc = getAtlasSrcSync(capturedIdx);
          if (!atlasSrc) return;
          if (!mainDrawSrc || mainDrawSrc.forIdx !== capturedIdx) {
            mainDrawSrc = { bitmap: atlasSrc.bitmap, sx: atlasSrc.sx, sy: atlasSrc.sy, sw: atlasSrc.sw, sh: atlasSrc.sh, forIdx: capturedIdx };
            paintMain();
          }
        }, function () {});
      }
    }

    prefetchFilmstripVisible(tier);
  }

  // Keep per-image bitmaps for focusedIdx ± FOCUS_PREFETCH at `tier`; evict the rest.
  // Bounds bitmap memory in focus mode regardless of how far the user has scrubbed.
  // Stable-focus debounce. During a fast scrub focusedIdx changes every frame;
  // we hold off starting any per-image fetch until focusedIdx has been still
  // for FOCUS_STABLE_MS. When the timer fires, fetch the centered image first;
  // once it resolves, fan out to the +-FOCUS_PREFETCH neighbors.
  var FOCUS_STABLE_MS = 50;
  var focusStableTimer = null;
  function prefetchFilmstripVisible(tier) {
    if (focusedIdx <= 0) return;
    // Build the keep set + warm names from the current ±FOCUS_PREFETCH window.
    var warmNames = new Set();
    var keepKeys = new Set();
    var R = FOCUS_PREFETCH;
    for (var k = -R; k <= R; k++) {
      var idx1 = focusedIdx + k;
      if (idx1 < 1 || idx1 > lastimagevalue) continue;
      var name = images[idx1];
      if (!name) continue;
      warmNames.add(name);
      keepKeys.add(name + '|' + tier);
    }
    // Abort any in-flight load that's no longer in the keep window — frees
    // sockets/decoder immediately for whatever's about to be requested next.
    cancelPerImageLoadsExcept(keepKeys);
    warmPerImageNames = warmNames;
    evictPerImageBitmaps(warmNames);

    // Restart the stable-focus timer. While the user is actively scrubbing,
    // each focusedIdx change resets this; nothing is fetched. When the user
    // settles for FOCUS_STABLE_MS, we fetch the center first, then neighbors.
    if (focusStableTimer) clearTimeout(focusStableTimer);
    var capturedIdx = focusedIdx;
    focusStableTimer = setTimeout(function () {
      focusStableTimer = null;
      if (focusedIdx !== capturedIdx) return;
      var centerName = images[capturedIdx];
      if (!centerName) return;
      loadPerImageBitmap(centerName, tier).then(function (bm) {
        if (focusedIdx !== capturedIdx) return;
        if (bm && mainEl) {
          mainDrawSrc = { bitmap: bm, sx: 0, sy: 0, sw: bm.width, sh: bm.height, forIdx: capturedIdx };
          paintMain();
        }
        // Fan out to neighbors only after center has resolved. They're fire-
        // and-forget; cancellation handles them if focusedIdx moves again.
        for (var dk = 1; dk <= R; dk++) {
          var prev = capturedIdx - dk;
          var next = capturedIdx + dk;
          if (prev >= 1 && images[prev]) loadPerImageBitmap(images[prev], tier);
          if (next <= lastimagevalue && images[next]) loadPerImageBitmap(images[next], tier);
        }
      });
    }, FOCUS_STABLE_MS);
  }

  var mainUpgradeTimer = null;
  function upgradeMainImage() { mainUpgradeTimer = null; }

  // Best already-cached source for `idx1` at `targetH`: walk per-image tiers
  // (target then smaller), then fall back to atlas h50.
  function getBestSrcForFocus(idx1, targetH) {
    if (idx1 < 1 || idx1 > lastimagevalue) return null;
    var name = images[idx1];
    if (!name) return null;
    var tier = pickPerImageTier(targetH);
    var ladder = [tier].concat(PER_IMAGE_TIERS.filter(function (h) { return h < tier || tier === 0; }).reverse());
    for (var i = 0; i < ladder.length; i++) {
      var t = ladder[i];
      var bm = getPerImageBitmapSync(name, t);
      if (bm) return { bitmap: bm, sx: 0, sy: 0, sw: bm.width, sh: bm.height };
    }
    return getAtlasSrcSync(idx1);
  }

  function getAtlasSrcSync(idx1) {
    if (!spriteMeta || !spriteMeta.atlases) return null;
    var atlas = spriteMeta.atlases['50'];
    if (!atlas) return null;
    var bitmaps = atlasBitmapsSync['50'];
    if (!bitmaps) return null;
    var idx0 = idx1 - 1;
    if (idx0 < 0 || idx0 >= lastimagevalue) return null;
    var name = images[idx1];
    if (!name) return null;
    var loc = spriteMeta.imageMap[name];
    if (!loc) return null;
    var spriteIdx = Math.floor(idx0 / atlas.cellsPerSprite);
    var bitmap = bitmaps[spriteIdx];
    if (!bitmap) return null;
    var posInSprite = idx0 % atlas.cellsPerSprite;
    var row = Math.floor(posInSprite / atlas.across);
    var col = posInSprite % atlas.across;
    var srcW = Math.round(loc.w * atlas.cellH / CANONICAL_H);
    return { bitmap: bitmap, sx: col * atlas.cellW, sy: row * atlas.cellH, sw: srcW, sh: atlas.cellH, natW: loc.w, natH: CANONICAL_H };
  }

  function destRectForLoc(natW, natH, areaW, areaH) {
    var scale = Math.min(areaW / natW, areaH / natH);
    var dw = Math.round(natW * scale), dh = Math.round(natH * scale);
    return { dw: dw, dh: dh, dx: Math.round((areaW - dw) / 2), dy: Math.round((areaH - dh) / 2) };
  }

  // Drag paint: current at dragDX, prev/next at dragDX∓W.
  function paintMainDragged(dx) {
    if (!mainEl) return;
    var W = layoutWidth(), H = layoutHeight();
    var mainH = Math.max(120, H - FILM_H);
    var dpr = devicePixelRatio();
    var ctx = mainEl.getContext('2d', { alpha: false });
    ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, mainH);

    function paintAt(idx1, offsetX) {
      if (idx1 < 1 || idx1 > lastimagevalue) return;
      var name = images[idx1];
      var loc = name && spriteMeta && spriteMeta.imageMap && spriteMeta.imageMap[name];
      if (!loc) return;
      var dest = destRectForLoc(loc.w, CANONICAL_H, W, mainH);
      // Center: live mainDrawSrc. Neighbors: best cached tier, atlas fallback.
      var src;
      if (idx1 === focusedIdx && mainDrawSrc && mainDrawSrc.forIdx === idx1) {
        src = mainDrawSrc;
      } else {
        src = getBestSrcForFocus(idx1, dest.dh * devicePixelRatio());
      }
      if (!src) return;
      ctx.drawImage(src.bitmap, src.sx, src.sy, src.sw, src.sh, dest.dx + offsetX, dest.dy, dest.dw, dest.dh);
    }
    paintAt(focusedIdx, dx);
    paintAt(focusedIdx - 1, dx - W);
    paintAt(focusedIdx + 1, dx + W);
  }

  // Proportional-step chase from dragDX → targetDX, painting each step.
  function animateDragTo(targetDX, done) {
    if (dragRaf) cancelAnimationFrame(dragRaf);
    function tick() {
      dragRaf = null;
      var diff = targetDX - dragDX;
      if (Math.abs(diff) < 1) {
        dragDX = targetDX;
        paintMainDragged(dragDX);
        if (done) done();
        return;
      }
      var step = diff * 0.3;
      if (Math.abs(step) < 1) step = (diff > 0 ? 1 : -1);
      dragDX += step;
      paintMainDragged(dragDX);
      dragRaf = requestAnimationFrame(tick);
    }
    dragRaf = requestAnimationFrame(tick);
  }

  // direction: -1 = went to previous, +1 = went to next.
  function commitDrag(direction) {
    var W = layoutWidth();
    var targetDx = -direction * W;
    animateDragTo(targetDx, function () {
      var newIdx = focusedIdx + direction;
      while (newIdx < 1) newIdx += lastimagevalue;
      while (newIdx > lastimagevalue) newIdx -= lastimagevalue;
      // Pre-populate mainDrawSrc with best cached source so the next paint
      // doesn't black-flash while drawMainImage resolves.
      var newSrc = getBestSrcForFocus(newIdx, mainImageGeom() && mainImageGeom().dh * devicePixelRatio());
      if (newSrc) {
        mainDrawSrc = { bitmap: newSrc.bitmap, sx: newSrc.sx, sy: newSrc.sy, sw: newSrc.sw, sh: newSrc.sh, forIdx: newIdx };
      }
      focusedIdx = newIdx;
      dragDX = 0;
      dragActive = false;
      hideControls();
      // Sync filmstrip without chase — visual commit already happened.
      if (filmstripEl) filmstripEl.scrollLeft = filmScrollForIdx1(focusedIdx, W);
      scheduleHashUpdate('#' + encodeURIComponent(images[focusedIdx]));
      paintMain();
      if (mainUpgradeTimer) clearTimeout(mainUpgradeTimer);
      mainUpgradeTimer = setTimeout(upgradeMainImage, 150);
    });
  }
  function revertDrag() {
    animateDragTo(0, function () {
      dragActive = false;
      dragDX = 0;
      paintMain();
    });
  }

  // 1-finger horizontal drag on the main image becomes a filmstrip scrub: we
  // adjust filmstripEl.scrollLeft directly, and the existing scroll handler
  // updates focusedIdx + repaints. On touchend we run a manual momentum decay
  // (programmatic scrollLeft doesn't get native scroll inertia). 2-finger
  // gestures are left alone so native pinch-zoom keeps working.
  // A tap (no/tiny movement, short duration) navigates to the original file.
  function setupMainImageGestures() {
    if (!mainEl) return;
    var startX = 0, startY = 0, startT = 0, startScrollLeft = 0;
    var dragging = false, multiTouch = false, decayRaf = null;
    var lastX = 0, lastT = 0, velX = 0;  // px/ms
    var lastDragEndAt = 0;

    function stopDecay() {
      if (decayRaf) { cancelAnimationFrame(decayRaf); decayRaf = null; }
    }
    function startDecay() {
      stopDecay();
      var v = velX;  // px/ms (negative means content moves left -> scrollLeft increases)
      var prevT = performance.now();
      function step(now) {
        var dt = Math.max(1, now - prevT);
        prevT = now;
        if (!filmstripEl) { decayRaf = null; return; }
        // Decay rate ~exp(-dt/180ms). Stop when below ~0.04 px/ms (~24 px/s).
        var decay = Math.exp(-dt / 180);
        v *= decay;
        if (Math.abs(v) < 0.04) { decayRaf = null; return; }
        filmstripEl.scrollLeft -= v * dt;
        decayRaf = requestAnimationFrame(step);
      }
      decayRaf = requestAnimationFrame(step);
    }

    mainEl.addEventListener('touchstart', function (e) {
      touchOnMain = true;
      stopDecay();
      multiTouch = e.touches.length > 1;
      if (multiTouch) { dragging = false; return; }
      var t = e.touches[0];
      startX = lastX = t.clientX;
      startY = t.clientY;
      startT = lastT = performance.now();
      startScrollLeft = filmstripEl ? filmstripEl.scrollLeft : 0;
      dragging = false;
      velX = 0;
    }, { passive: true });

    mainEl.addEventListener('touchmove', function (e) {
      if (multiTouch || e.touches.length > 1) { dragging = false; return; }
      if (!filmstripEl) return;
      var t = e.touches[0];
      var dx = t.clientX - startX;
      var dy = t.clientY - startY;
      if (!dragging) {
        // Lock into horizontal drag once we've moved enough horizontally and
        // it dominates vertical movement.
        if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) {
          dragging = true;
        } else if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) {
          // Vertical-dominant: bail out, let it be a no-op (no page to scroll
          // in focus mode).
          return;
        } else {
          return;
        }
      }
      e.preventDefault();
      filmstripEl.scrollLeft = startScrollLeft - dx;
      var now = performance.now();
      var dt = Math.max(1, now - lastT);
      // EMA-style velocity: blend instantaneous with previous.
      velX = velX * 0.4 + ((t.clientX - lastX) / dt) * 0.6;
      lastX = t.clientX; lastT = now;
    }, { passive: false });

    mainEl.addEventListener('touchend', function (e) {
      touchOnMain = false;
      if (multiTouch) { multiTouch = e.touches.length > 0; return; }
      if (dragging) {
        startDecay();
        dragging = false;
        lastDragEndAt = performance.now();
        return;
      }
      // Tap: no/tiny drag, short duration -> open original file.
      var dt = performance.now() - startT;
      if (dt < 350) {
        var name = images && images[focusedIdx];
        if (name) {
          var url = folderURL + encodeURIComponent(name);
          window.location.href = url;
        }
      }
    });

    mainEl.addEventListener('touchcancel', function () {
      touchOnMain = false;
      dragging = false;
      multiTouch = false;
    });

    // Desktop click (and synthesized click after a short tap on mobile).
    // Drag-end sets lastDragEndAt to suppress the synthetic click that some
    // browsers fire after a touchend even when movement was non-trivial.
    mainEl.addEventListener('click', function () {
      if (performance.now() - lastDragEndAt < 400) return;
      var name = images && images[focusedIdx];
      if (name) window.location.href = folderURL + encodeURIComponent(name);
    });
  }

  function renderGallery() {
    var thumbsEl = $('thumbs');
    if (!thumbsEl) return;
    if (lastimagevalue < 1) {
      thumbsEl.innerHTML = '<div style="padding:24px;text-align:center;color:#888">' +
        (window.isadmin ? 'No images yet — upload some via the admin panel.' : 'No images.') +
        '</div>';
      thumbsEl.style.cssText = '';
      canvasEl = null; spacerEl = null;
      return;
    }
    if (!window.spriteMeta) {
      thumbsEl.innerHTML = '<div style="padding:32px;text-align:center;color:#888">' +
        '<div style="font-size:16px;margin-bottom:8px">Building LoD cache…</div>' +
        '<div style="font-size:13px">' + lastimagevalue + ' images in this folder</div>' +
        '</div>';
      pollBuildStatus({ reloadOnComplete: true });
      thumbsEl.style.cssText = '';
      canvasEl = null; spacerEl = null;
      return;
    }

    var W = layoutWidth();
    var viewportH = layoutHeight();

    // ===== FOCUS MODE =====
    if (focusedIdx > 0) {
      setupFilmstripFocus(thumbsEl);
      return;
    }

    // ===== GRID MODE =====
    // Re-using the captured anchor (not re-capturing) keeps zoom-drag stable —
    // mid-drag column counts shift, which would drift "image at viewport top".
    // On a fresh page load (F5) cachedAnchorName is null; fall back to the
    // sessionStorage-persisted anchor so refresh stays at the same scroll.
    var anchorName = cachedAnchorName;
    if (!anchorName) {
      try { anchorName = sessionStorage.getItem(scrollKey()) || null; } catch (_) {}
      if (anchorName) cachedAnchorName = anchorName;  // seed in-memory so subsequent zoom-changes pin to it too
    }

    var H = targetRowHeight();
    currentRowHeight = H;
    var rows = layoutRows(H);
    var totalH = 0;
    var GAP = rowGap(H);
    for (var i = 0; i < rows.length; i++) totalH += rows[i].height + GAP;

    thumbsEl.style.position = 'relative';
    thumbsEl.style.overflowY = 'auto';
    thumbsEl.style.overflowX = 'hidden';
    thumbsEl.style.height = viewportH + 'px';
    // Chrome's scroll anchoring auto-adjusts scrollTop to keep visible content
    // stable when the layout changes. Our layout changes a lot (spacer height,
    // canvas reposition), and Chrome ends up shifting scrollTop away from 0,
    // so the top row appears cut off and unreachable. Safari doesn't do this.
    thumbsEl.style.overflowAnchor = 'none';

    ensureCanvasAndSpacer(thumbsEl);
    applyGridLayout(thumbsEl, W, viewportH, totalH);
    // Atlas instance buffers depend on tile rects; force rebuild on next draw.
    atlasInstancesBuiltFor = null;

    lastTileRects = [];
    var y = 0;
    for (var r = 0; r < rows.length; r++) {
      var x = 0;
      for (var j = 0; j < rows[r].items.length; j++) {
        var it = rows[r].items[j];
        lastTileRects.push({ x: x, y: y, w: it.w, h: it.h, idx: it.index, name: images[it.index] });
        x += it.w + GAP;
      }
      y += rows[r].height + GAP;
    }

    // Pin the previous top-left image so zoom doesn't snap back to the top.
    var maxScroll = Math.max(0, totalH - viewportH);
    if (anchorName) {
      for (var ki = 0; ki < lastTileRects.length; ki++) {
        if (lastTileRects[ki].name === anchorName) {
          var newTop = Math.max(0, Math.min(maxScroll, lastTileRects[ki].y));
          if (Math.abs(thumbsEl.scrollTop - newTop) > 0.5) {
            suppressNextAnchorCapture = true;
            thumbsEl.scrollTop = newTop;
          }
          break;
        }
      }
    } else {
      thumbsEl.scrollTop = 0;
    }

    window.__lastTileRects = lastTileRects;
    drawCanvasForScroll();
  }

  function displaythumbs() {
    showAdminBar();
    focusedIdx = 0;
    hashmirror = '';
    setText('counter', '');
    // Apply current grid level so the render matches the toolbar label.
    var levels = availableLevels();
    var idx = lastGridLevelIdx;
    if (idx > levels.length - 1) idx = levels.length - 1;
    currentLevelIdx = idx;
    var lv = levels[idx];
    if (lv && lv.h !== 'focus') levelTargetH = lv.h;
    document.body.classList.add('thumb-view');
    document.body.classList.remove('image-view');
    renderGallery();
    renderZoomControl();
  }

  // ---------- hash routing ----------
  function refreshfromhash() {
    hashmirror = location.hash.slice(1);
    var raw = decodeURIComponent(hashmirror || '');
    // #fit and #sizeN → ZOOM_LEVELS entries; bare names → focus.
    var levels = availableLevels();
    var matchedIdx = -1;
    for (var li = 0; li < levels.length; li++) {
      if (levels[li].hash && levels[li].hash === raw) { matchedIdx = li; break; }
    }
    if (matchedIdx >= 0) {
      currentLevelIdx = matchedIdx;
      lastGridLevelIdx = matchedIdx;
      var lv0 = levels[matchedIdx];
      if (lv0.h !== 'focus') levelTargetH = lv0.h;
      focusedIdx = 0;
      document.body.classList.add('thumb-view');
      document.body.classList.remove('image-view');
      renderGallery();
      renderZoomControl();
      return;
    }
    if (!raw || raw.charAt(0) === ':') {
      var didx = defaultLevelIdx();
      currentLevelIdx = didx;
      lastGridLevelIdx = didx;
      var dlv = levels[didx];
      if (dlv.h !== 'focus') levelTargetH = dlv.h;
      focusedIdx = 0;
      document.body.classList.add('thumb-view');
      document.body.classList.remove('image-view');
      renderGallery();
      renderZoomControl();
    } else {
      // #filename → focus on that image.
      for (var i = 1; i <= lastimagevalue; i++) {
        if (raw === images[i]) {
          focusedIdx = i;
          inum = i;
          document.body.classList.add('image-view');
          document.body.classList.remove('thumb-view');
          renderGallery();
          renderZoomControl();
          return;
        }
      }
      // Unknown name — fall through to grid.
      focusedIdx = 0;
      renderGallery();
      renderZoomControl();
    }
  }

  // ---------- admin bar ----------
  function showAdminBar() {
    var bar = $('adminnotify');
    if (!window.isadmin) { bar.classList.remove('on'); return; }
    bar.classList.add('on');
    var inImage = (decodeURIComponent(location.hash.slice(1)) || '').charAt(0) !== ':';
    bar.innerHTML = inImage
      ? '<button onclick="ggMoveToTrash()">Move to trash</button>'
      : '<button onclick="ggClearCache()">Clear cache</button>' +
        '<button onclick="ggExploreTrash()">Explore trash</button>' +
        '<a href="/_admin/" style="margin-left:auto">Admin panel →</a>';
  }
  function clearAdminBar() { var b = $('adminnotify'); if (b) b.classList.remove('on'); }

  // ---------- admin actions ----------
  function ggMoveToTrash() {
    // No confirm — trash is reversible via Explore Trash.
    note('Moving ' + images[inum] + ' to trash…');
    gghttp('POST', 'movetotrash=' + encodeURIComponent(images[inum]), function (t) {
      note(t || 'moved to trash');
      setTimeout(function () { location.reload(); }, 600);
    });
  }
  function ggClearCache() {
    if (!confirm('Delete all cached thumbs and previews?')) return;
    gghttp('POST', 'clearcache=1', function (t) { note(t); });
  }
  function ggExploreTrash() {
    fetch('/api/trash', { headers: adminHeader() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var place = $('thumbs');
        if (!data || !data.files || !data.files.length) {
          place.innerHTML = '<div style="padding:24px;text-align:center;color:#888">Trash is empty.</div>';
          return;
        }
        var rows = data.files.map(function (f) {
          var fromFolder = f.relPath.indexOf('/') >= 0 ? f.relPath.slice(0, f.relPath.lastIndexOf('/')) : '';
          var origin = fromFolder ? '/' + fromFolder : '/';
          return '<div style="display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid #222">' +
                 '<button onclick="ggRestoreFile(\'' + f.relPath.replace(/\'/g, "\\'") + '\')">Restore</button>' +
                 '<button onclick="ggDeleteFile(\''  + f.relPath.replace(/\'/g, "\\'") + '\')">Delete</button>' +
                 '<span>' + f.name + ' <small style="color:#888">from ' + origin + '</small></span></div>';
        }).join('');
        place.innerHTML = '<div style="display:flex;flex-direction:column;align-items:stretch;width:100%;max-width:720px;margin:0 auto">' +
          '<h3 style="text-align:center;color:#bbb">Trash (' + data.files.length + ')</h3>' +
          rows +
          '<div style="display:flex;gap:8px;justify-content:center;padding:12px"><button onclick="ggRestoreAll()">Restore all</button><button onclick="ggEmptyTrash()">Empty trash</button></div>' +
          '</div>';
      });
  }
  function trashApi(action, body) {
    return fetch('/api/trash/' + action, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, adminHeader()),
      body: body ? JSON.stringify(body) : undefined,
    }).then(r => r.json()).then(j => { note(j.message || j.error || 'ok'); });
  }
  function ggRestoreFile(p) { trashApi('restore', { path: p }).then(ggExploreTrash); }
  function ggDeleteFile(p)  { if (!confirm('Permanently delete ' + p + '?')) return; trashApi('delete', { path: p }).then(ggExploreTrash); }
  function ggRestoreAll()   { trashApi('restoreAll').then(ggExploreTrash); }
  function ggEmptyTrash()   { if (!confirm('Permanently delete ALL trashed files?')) return; trashApi('empty').then(ggExploreTrash); }

  // Image whose tile-center is closest to the viewport center.
  function findCenteredImageName() {
    var thumbsEl = $('thumbs');
    if (!thumbsEl || !lastTileRects.length) return null;
    var sy = thumbsEl.scrollTop;
    var cx = thumbsEl.clientWidth / 2;
    var cy = sy + thumbsEl.clientHeight / 2;
    var best = null, bestD = Infinity;
    for (var i = 0; i < lastTileRects.length; i++) {
      var t = lastTileRects[i];
      var dx = (t.x + t.w / 2) - cx;
      var dy = (t.y + t.h / 2) - cy;
      var d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = t; }
    }
    return best ? best.name : null;
  }

  // Focus mode: redirect vertical wheel → horizontal filmstrip scroll for
  // trackpad/mousewheel users without a horizontal axis.
  function setupTouch() {
    var thumbsEl = $('thumbs');
    if (!thumbsEl) return;
    thumbsEl.addEventListener('wheel', function (e) {
      if (focusedIdx <= 0) return;
      if (!filmstripEl) return;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        filmstripEl.scrollLeft += e.deltaY;
      }
    }, { passive: false });

  }

  // ---------- start ----------
  function startjs() {
    maybePromoteAdmin();

    setupTouch();
    renderZoomControl();

    window.addEventListener('resize', scheduleRender);

    // Initial route after the binary imagemap loads (or fails — renderGallery
    // has its own placeholder for spriteMeta=null).
    function runInitialRoute() {
      var raw = decodeURIComponent(location.hash.slice(1) || '');
      if (raw && (raw === 'fit' || raw.match(/^size\d+$/))) {
        refreshfromhash();
      } else if (!raw || raw.charAt(0) === ':') {
        refreshfromhash();
      } else if (lastimagevalue > 0) {
        var found = 0;
        for (var j = 1; j <= lastimagevalue; j++) if (raw === images[j]) { inum = j; found = 1; break; }
        if (found) refreshfromhash(); else displaythumbs();
      } else {
        displaythumbs();
      }
      // Re-render after two rAFs so layoutHeight measures with chrome settled.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { scheduleRender(); });
      });
    }

    if (window.imagemapURL && window.spriteMeta) {
      var thumbsEl = $('thumbs');
      if (thumbsEl) thumbsEl.innerHTML = '<div style="padding:32px;text-align:center;color:#888">Loading…</div>';
      loadImagemap().then(function () {
        runInitialRoute();
      }).catch(function (e) {
        console.warn('[imagemap] load failed:', e);
        runInitialRoute();
      });
    } else {
      runInitialRoute();
    }

    window.addEventListener('hashchange', refreshfromhash);
    // Programmatic key handlers; inline onkey* attributes hit a race with the
    // IIFE's window.* exports on Safari.
    window.addEventListener('keydown', keycheck);
    window.addEventListener('keyup', unlockkeys);
    pollBuildStatus();
  }

  // Cookie is HttpOnly; the probe is the only way to detect a valid session.
  function maybePromoteAdmin() {
    if (window.isadmin) return;
    fetch('/api/admin/probe', { credentials: 'same-origin' })
      .then(function (r) {
        if (r.ok) { window.isadmin = 1; showAdminBar(); }
      })
      .catch(function () {});
  }

  // Expose for inline handlers.
  window.startjs = startjs;
  window.keycheck = keycheck;
  window.unlockkeys = unlockkeys;
  window.leftbutton = leftbutton;
  window.rightbutton = rightbutton;
  window.displaythumbs = displaythumbs;
  window.ggMoveToTrash = ggMoveToTrash;
  window.ggClearCache = ggClearCache;
  window.ggExploreTrash = ggExploreTrash;
  window.ggRestoreFile = ggRestoreFile;
  window.ggDeleteFile = ggDeleteFile;
  window.ggRestoreAll = ggRestoreAll;
  window.ggEmptyTrash = ggEmptyTrash;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startjs);
  else startjs();
  // Replaced by setupAutoHide() once it initializes. Callable from anywhere
  // in the module — e.g., onThumbsScroll or focus-flip sites — to dismiss the
  // top controls the moment the user shows intent to engage with content.
  var hideControls = function () {};

  // ------------------------------------------------------------------------
  // Top controls drawer. Closed on load (for galleries with images); locked
  // open on empty galleries. Unified pill: tap/click toggles on both desktop
  // and touch. Desktop fades the pill in only when the cursor is within
  // REVEAL_RADIUS of the pill center. No timer-based auto-hide on either
  // platform. Module-level hideControls is still wired to intent signals
  // (grid scroll, focus change, filmstrip swipe) so the drawer gets out of
  // the way when the user starts interacting with content.
  // ------------------------------------------------------------------------
  (function setupAutoHide() {
    function init() {
      var wrap = document.getElementById('topcontrols');
      var pill = document.getElementById('topreveal');
      if (!wrap) return;

      // Measure native scrollbar width — keeps the scroll gutter reachable
      // when the drawer slides in. Mac overlay scrollbars measure 0 here.
      (function () {
        var probe = document.createElement('div');
        probe.style.cssText = 'overflow:scroll; width:100px; height:100px; position:absolute; visibility:hidden; top:-200px;';
        document.body.appendChild(probe);
        var w = probe.offsetWidth - probe.clientWidth;
        document.body.removeChild(probe);
        document.documentElement.style.setProperty('--scrollbar-w', w + 'px');
      })();

      var REVEAL_RADIUS = 150;
      var isTouchOnly = window.matchMedia('(hover: none)').matches;
      var isEmpty = !window.lastimagevalue;

      function show() { document.body.classList.add('controls-revealed'); }
      function hide() {
        // Empty galleries: drawer is locked open. Pill is hidden via CSS so
        // users can't accidentally collapse it, and intent-based
        // hideControls() calls become no-ops.
        if (isEmpty) return;
        document.body.classList.remove('controls-revealed');
      }
      function toggle() {
        if (document.body.classList.contains('controls-revealed')) hide();
        else show();
      }
      hideControls = hide;

      if (isEmpty) {
        document.body.classList.add('gallery-empty');
        show();
        return;
      }

      // Desktop: reveal the pill when the cursor enters a 150px radius
      // around its center. Pill rect is fixed at top-center; rect read on
      // every mousemove is cheap and avoids stale coords on viewport resize.
      if (!isTouchOnly && pill) {
        document.addEventListener('mousemove', function (e) {
          var r = pill.getBoundingClientRect();
          var cx = r.left + r.width / 2;
          var cy = r.top + r.height / 2;
          var d = Math.hypot(e.clientX - cx, e.clientY - cy);
          if (d < REVEAL_RADIUS) document.body.classList.add('pill-near');
          else document.body.classList.remove('pill-near');
        });
      }

      // Pill toggles drawer on tap/click — unified across desktop and touch.
      // Touch uses pointerdown for snap; suppress the synthetic click that
      // would otherwise toggle a second time.
      if (pill) {
        if (isTouchOnly) {
          pill.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            toggle();
          });
        } else {
          pill.addEventListener('click', toggle);
        }
      }
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  })();

})();
