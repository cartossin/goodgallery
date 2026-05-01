// Goodgallery 2.0 client. Vanilla JS, no third-party libraries.
// Preserves the 2014 logic: images[], thumbs[], hash navigation,
// 1-indexed nav (inum), per-page thumb rendering, on-demand build via onerror.

// State injected by the server-rendered page:
//   var images = [null, "a.jpg", "b.jpg", ...];   // 1-indexed
//   var lastimagevalue = N;
//   var thumbsperpage = 50;
//   var xhrpush = 4;
//   var isadmin = 0|1;
//   var hasPasskey = true|false;
//   var folderURL = "/path/with/trailing/slash/";

(function () {
  'use strict';

  var CANONICAL_H = 200;
  var FOCUS_PREFETCH = 3;  // images on each side of focus to keep warm in the bitmap cache.

  // Compact binary imagemap loader. The HTML page no longer ships an inline imageMap;
  // client fetches a binary blob (.bin) and parses it via DataView for ~10x smaller
  // bytes-on-the-wire and ~10x faster parse than equivalent JSON.
  //   Format: 'GGMP' (4B) | version u16 LE | reserved u16 | count u32 LE
  //           widths: count × u16 LE
  //           names:  count NUL-terminated UTF-8 strings
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

  var thumbs        = [null];
  // Per-gallery reserved subdir for all derived state (matches server.js GG_DIR).
  var GG_DIR = 'gg';
  var inum = 1;             // legacy alias for focusedIdx — keep for any old refs
  var focusedIdx = 0;       // 0 = no focus (grid view); 1..N = focused image index (1-based)
  var isfullres = 0;        // unused after viewer removal; kept to satisfy any leftover refs
  var keyslocked = 0;
  var hashmirror = '';
  var monitortimerid = null;

  // Original-image URL for a name. Per-image LoDs and atlases are built separately
  // (see getBestSrcForFocus / loadPerImageBitmap / sprite atlas). Originals are only
  // fetched when a focused image needs more pixels than h800 provides.
  function originalURL(name)      { return folderURL + encodeURIComponent(name); }

  function $(id) { return document.getElementById(id); }
  function setText(id, t) { var e = $(id); if (e) e.textContent = t; }
  function setHTML(id, h) { var e = $(id); if (e) e.innerHTML = h; }

  // ---------- realtime monitor ----------
  function note(msg) {
    var rt = $('realtime');
    if (!rt) return;
    rt.textContent = msg || '';
  }
  // ---------- ajax (fetch wrapper that mirrors XHConn semantics) ----------
  function gghttp(method, qs, onText) {
    var url = folderURL + (qs ? '?' + qs : '');
    fetch(url, { method: method, credentials: 'same-origin', headers: adminHeader() })
      .then(function (r) { return r.text(); })
      .then(function (t) { onText(t); })
      .catch(function () { onText(''); });
  }
  // (Auth is now an HttpOnly cookie — no client-side token handling needed.)
  function adminHeader() { return {}; }

  // Per-folder build was retired; the admin Full Rescan button (in /_admin/) covers
  // everything site-wide. The page just monitors whatever the server is doing.
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
          statusTimer = setTimeout(function () { pollBuildStatus({ reloadOnComplete: reloadOnComplete }); }, 700);
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
  function nextIndex(i) { return i === lastimagevalue ? 1 : i + 1; }
  function prevIndex(i) { return i === 1 ? lastimagevalue : i - 1; }

  function nextimage()    { shiftFocus(+1); }
  function previousimage(){ shiftFocus(-1); }

  function isThumbView() { return focusedIdx === 0; }
  function leftbutton()  { if (focusedIdx > 0) shiftFocus(-1); }
  function rightbutton() { if (focusedIdx > 0) shiftFocus(+1); }
  // commandedIdx tracks the most recently requested focus target. If a smooth-scroll
  // animation is still playing when the user fires another shiftFocus (e.g. by mashing
  // ArrowRight three times), each press accumulates against commandedIdx instead of
  // the slowly-updating focusedIdx — so 3 fast presses jump 3 images and the animation
  // chases the final target rather than gating the input.
  var commandedIdx = 0;
  function shiftFocus(delta) {
    if (lastimagevalue < 1) return;
    // Use commandedIdx if we're mid-animation (it's ahead of focusedIdx); otherwise
    // use focusedIdx (canonical when scroll has settled).
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
    if (keyslocked) return;
    var k = e.which || e.keyCode;
    var isArrow = (k === 37 || k === 38 || k === 39 || k === 40);
    // In focus mode arrow keys shift focus — Up/Left = prev, Down/Right = next.
    // We only consume the key (preventDefault) when we actually act on it; otherwise
    // native page scroll continues to work in grid mode where #thumbs has focus.
    if (focusedIdx > 0 && isArrow) {
      e.preventDefault();  // stop the browser's native ~40px arrow-key scroll on the
                           // focus strip, which would otherwise race with shiftFocus()
                           // and produce the "slowly sliding" jitter when #thumbs has
                           // keyboard focus (e.g. after the user clicked into it).
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

  // rAF-throttled re-layout. Slider input + window resize fire many events; this
  // collapses them to one renderGallery per frame.
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

  // Width available for thumbs (the #thumbs box) and height available below it. We use
  // bounding rects so chrome (header + prev/next + footer + adminnotify) is accounted
  // for exactly, without hardcoded estimates.
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

  // Compute total layout height for a given row-height target without rendering. Mirrors
  // layoutRows()/finalizeRow() exactly so fit-all is accurate.
  // Proportional grid gap: 2.5% of the target row height. Floors to 0 at very small
  // tile sizes so e.g. h5 atlas tiles butt up against each other (no visible gap).
  function rowGap(H) { return Math.max(0, Math.floor(H * 0.04)); }
  function simulateLayoutHeight(H, W) {
    if (!window.spriteMeta) return 0;
    var rows = 0, totalH = 0;
    var natRowW = 0, count = 0;
    for (var i = 1; i <= lastimagevalue; i++) {
      var name = images[i];
      var loc = spriteMeta.imageMap[name];
      var natW = (loc ? loc.w : CANONICAL_H) * H / CANONICAL_H;
      if (count > 0 && (natRowW + rowGap(H) * count + natW) > W) {
        // close row
        var rowScale = Math.min(1.5, (W - rowGap(H) * (count - 1)) / Math.max(1, natRowW));
        totalH += H * rowScale + rowGap(H);
        rows++; natRowW = 0; count = 0;
      }
      natRowW += natW; count++;
    }
    if (count > 0) totalH += H + rowGap(H);  // last row at natural height
    return totalH;
  }

  // Zoom is in-memory only — every fresh page load starts at fit-all (0). Dragging
  // the slider updates this value but it never persists; reload resets the view.
  var currentZoom = 0;
  function getZoom() { return currentZoom; }
  function setZoom(t) {
    if (isNaN(t) || t < 0) t = 0;
    if (t > 100) t = 100;
    currentZoom = t;
  }

  function targetRowHeight(t) {
    if (!window.spriteMeta) return 100;
    if (focusedIdx > 0) {
      return Math.max(50, layoutHeight() * 0.7);
    }
    var Hmin = fitAllHeight();
    var Hmax = CANONICAL_H;
    if (Hmax <= Hmin) return Hmax;
    return Hmin * Math.pow(Hmax / Hmin, t / 100);
  }

  function layoutRows(H) {
    if (!window.spriteMeta) return [];
    var W = layoutWidth();
    var rows = [];
    var current = [];
    var natRowW = 0;
    for (var i = 1; i <= lastimagevalue; i++) {
      var name = images[i];
      var loc = spriteMeta.imageMap[name];
      var natW = (loc ? loc.w : CANONICAL_H) * H / CANONICAL_H;
      // Available content width = W minus inter-thumb gaps for items already in row.
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
    return {
      items: items.map(function (it) {
        return { index: it.index, w: Math.max(1, Math.round(it.natW * rowScale)), h: Math.max(1, Math.round(H * rowScale)) };
      }),
      height: H * rowScale,
    };
  }

  // ---- virtual-scroll single canvas (option C, scaled) -----------------
  // The canvas stays the size of the viewport — never grows with the gallery. The
  // scroll container is sized to the full layout height via a spacer; as the user
  // scrolls, we redraw the (small) canvas with whichever rows are currently visible.
  // Memory and paint cost are bounded regardless of N (works for 60k+ images).
  //
  // Layout:
  //   #thumbs (scroll container, overflow-y: auto, height = available viewport)
  //     <canvas> (position: sticky; top: 0; height = viewport)
  //     <div class="spacer" style="height = totalLayoutHeight - viewport">
  //
  // The canvas is the FIRST child + sticky top, the spacer comes AFTER. Scrolling pushes
  // the spacer up; the canvas stays at the top of the viewport. On scroll we redraw with
  // the appropriate Y window of the layout.
  // Render at device-pixel density on retina — browser then displays 1:1 from the
  // backing store rather than upsampling a CSS-px-density canvas. Capped at 2 since
  // higher densities don't visibly help and just multiply paint cost.
  function devicePixelRatio() { return Math.min(window.devicePixelRatio || 1, 2); }

  // Per-atlas-height ImageBitmap cache. Each atlas height (5/10/50) is loaded once,
  // lazily, and reused across renders.
  var spriteBitmapsByHeight = {};      // { '50': Promise<[ImageBitmap, ...]>, ... }
  // Cache the raw AVIF Blob bytes so we can re-decode without re-fetching from the
  // server. Each atlas blob is small (~150 KB); keeping all of them costs ~5 MB total
  // for the OI 41k case. ImageBitmaps (which are the ~1.5 GB monsters) get evicted
  // on tier transitions; blobs stay around so the re-decode is local + fast.
  var spriteBlobs = {};                // { '50': [Blob, Blob, ...] }
  // True while the user is actively dragging the zoom slider. While true,
  // pickAtlasHeight pins to the smallest available atlas tier.
  var isSliderDragging = false;
  // Sync mirror of the resolved atlas bitmap arrays — populated by the .then() below.
  // Used by drag-paint where we need to draw prev/next images mid-gesture without an
  // async hop (a microtask on every drag frame would visibly stutter).
  var atlasBitmapsSync = {};           // { '50': [ImageBitmap, ...] | undefined }
  // Per-image bitmap cache for high-zoom views. Keyed by `${name}|${tierH}`. At
  // tierH=100/200/400/800 we fetch each visible image as its own AVIF; the canvas
  // composites them. Only viewport-visible images are fetched, so memory is bounded.
  var perImageBitmaps = new Map();
  // Sync mirror — populated by loadPerImageBitmap.then. Lets paintMain pick the
  // best already-resolved tier without going through a Promise microtask.
  var perImageBitmapsSync = new Map();   // key -> ImageBitmap
  var currentRowHeight = 200;          // current target row height in CSS px
  var renderFrame = 0;                 // increments per renderGallery; async draws check this
  var lastTileRects = [];              // [{x, y, w, h, name}] in LAYOUT coords (not screen)
  var lastTotalH = 0;                  // total layout height
  var canvasEl = null;
  var spacerEl = null;
  var canvasClickAttached = false;
  var thumbsScrollAttached = false;
  var pendingScrollDraw = false;

  // Per-atlas-height per-sprite-index callbacks: { '50': [fn, fn, ...] } where
  // fn(bitmap, spriteIdx) fires when that particular sprite finishes decoding.
  // Used by drawMainImage / drawCanvasForScroll to repaint the moment the sprite
  // they need becomes available, instead of waiting for the whole-atlas Promise.all.
  var spriteBitmapWaiters = {};

  function onSpriteBitmapReady(atlasH, fn) {
    var key = String(atlasH);
    if (!spriteBitmapWaiters[key]) spriteBitmapWaiters[key] = [];
    spriteBitmapWaiters[key].push(fn);
  }

  function loadSpriteBitmapsForAtlas(atlasH) {
    var key = String(atlasH);
    if (spriteBitmapsByHeight[key]) return spriteBitmapsByHeight[key];
    var atlas = window.spriteMeta && spriteMeta.atlases && spriteMeta.atlases[key];
    if (!atlas) return Promise.resolve([]);
    atlasBitmapsSync[key] = new Array(atlas.sprites.length).fill(null);
    if (!spriteBlobs[key]) spriteBlobs[key] = new Array(atlas.sprites.length).fill(null);
    // If we have all the blobs already (post-eviction case), skip the network and
    // re-decode locally — much faster than refetching from the server.
    var allBlobsCached = spriteBlobs[key].every(function (b) { return b != null; });

    spriteBitmapsByHeight[key] = Promise.all(atlas.sprites.map(function (sp, i) {
      var blobP;
      if (allBlobsCached) {
        blobP = Promise.resolve(spriteBlobs[key][i]);
      } else {
        var url = folderURL + GG_DIR + '/' + sp.file;
        blobP = fetch(url, { credentials: 'same-origin' })
          .then(function (r) { return r.blob(); })
          .then(function (b) { spriteBlobs[key][i] = b; return b; });
      }
      return blobP
        .then(function (b) { return createImageBitmap(b); })
        .then(function (bm) {
          atlasBitmapsSync[key][i] = bm;
          var ws = spriteBitmapWaiters[key];
          if (ws) for (var w = 0; w < ws.length; w++) {
            try { ws[w](bm, i); } catch (_) {}
          }
          return bm;
        });
    }));
    return spriteBitmapsByHeight[key];
  }

  function evictAtlasBitmaps(atlasH) {
    var key = String(atlasH);
    var bitmaps = atlasBitmapsSync[key];
    if (bitmaps) {
      for (var i = 0; i < bitmaps.length; i++) {
        var bm = bitmaps[i];
        if (bm && typeof bm.close === 'function') {
          try { bm.close(); } catch (_) {}
        }
      }
    }
    delete atlasBitmapsSync[key];
    delete spriteBitmapsByHeight[key];
    delete spriteBitmapWaiters[key];
    // spriteBlobs[key] kept for cheap re-decode without refetching.
  }

  // Drop ImageBitmaps for every atlas tier we don't currently need. Always keep
  // h5 around as a permanent low-cost fallback for bestCachedAtlasSrc.
  function evictUnusedAtlases(activeAtlasH) {
    var keep = { '5': true };
    if (activeAtlasH != null) keep[String(activeAtlasH)] = true;
    var keys = Object.keys(atlasBitmapsSync);
    for (var i = 0; i < keys.length; i++) {
      if (!keep[keys[i]]) evictAtlasBitmaps(keys[i]);
    }
  }

  // Atlas pick: smallest atlas height >= target. Returns null if target exceeds the
  // largest atlas (caller should switch to per-image rendering).
  function pickAtlasHeight(targetH) {
    if (!window.spriteMeta || !spriteMeta.atlases) return null;
    var heights = Object.keys(spriteMeta.atlases).map(Number).sort(function (a, b) { return a - b; });
    // While the slider is being dragged, pin to the smallest atlas tier already
    // in memory. Dragging stays smooth (we never trigger an h50 fetch+decode of
    // ~30 sprites mid-drag) and we never balloon memory for tiers the user is
    // just scrubbing past.
    if (isSliderDragging) {
      for (var j = 0; j < heights.length; j++) {
        if (atlasBitmapsSync[String(heights[j])]) return heights[j];
      }
      return heights[0];
    }
    for (var i = 0; i < heights.length; i++) {
      if (heights[i] >= targetH) return heights[i];
    }
    return null;
  }

  // Per-image LoD: pick the smallest available tier height >= target. Tier 0 is a
  // sentinel meaning "the original file" — used when the canvas needs more pixels than
  // h800 provides (high-DPI focus on a 1080p+ display). Available pre-built tiers match
  // the server's LOD_TIERS list.
  var PER_IMAGE_TIERS = [100, 200, 400, 800];
  function pickPerImageTier(targetH) {
    for (var i = 0; i < PER_IMAGE_TIERS.length; i++) {
      if (PER_IMAGE_TIERS[i] >= targetH) return PER_IMAGE_TIERS[i];
    }
    return 0;  // request the original
  }

  function loadPerImageBitmap(name, tierH) {
    var key = name + '|' + tierH;
    if (perImageBitmaps.has(key)) return perImageBitmaps.get(key);
    var url = tierH === 0
      ? folderURL + encodeURIComponent(name)
      : folderURL + GG_DIR + '/' + encodeURIComponent(name) + '.h' + tierH + '.avif';
    var prom = fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.blob(); })
      .then(function (b) { return createImageBitmap(b); })
      .catch(function () { return null; });
    prom.then(function (bm) { if (bm) perImageBitmapsSync.set(key, bm); });
    perImageBitmaps.set(key, prom);
    return prom;
  }
  function getPerImageBitmapSync(name, tierH) {
    return perImageBitmapsSync.get(name + '|' + tierH) || null;
  }

  // Returns the best per-image bitmap that's already in the sync cache, preferring
  // the requested tier, then any smaller cached tier. Returns null if nothing is
  // cached — caller should fall back to the atlas. This is what stops the canvas
  // from going black during a zoom slide: we paint whatever resolution we already
  // have, then upgrade in-place when the target tier finishes loading.
  function bestCachedPerImage(name, targetTier) {
    if (targetTier === 0) {
      // 'original' requested; any cached tier is acceptable as a placeholder.
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

  // Atlas-source lookup by image name. Returns the best-loaded atlas tier (h50 if
  // available, else h10, else h5). Used as the deepest fallback for the no-black
  // ladder.
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

  function ensureCanvasAndSpacer(thumbsEl) {
    if (canvasEl && canvasEl.parentNode === thumbsEl) return;
    thumbsEl.innerHTML = '';
    canvasEl = document.createElement('canvas');
    canvasEl.style.cursor = 'pointer';
    canvasEl.style.display = 'block';
    canvasEl.style.position = 'sticky';
    canvasEl.style.top = '0';
    canvasEl.style.zIndex = '1';
    spacerEl = document.createElement('div');
    spacerEl.style.width = '1px';  // collapsed; height is what makes the container scrollable
    thumbsEl.appendChild(canvasEl);
    thumbsEl.appendChild(spacerEl);
    // Click listener is per-canvas: a fresh canvas (after a focus<->grid round trip)
    // needs its own listener. The old global canvasClickAttached flag short-circuited
    // the second attach, leaving the new canvas inert to clicks.
    canvasEl.addEventListener('click', onCanvasClick);
    if (!thumbsScrollAttached) {
      thumbsEl.addEventListener('scroll', onThumbsScroll, { passive: true });
      thumbsScrollAttached = true;
    }
  }

  // Suppress anchor capture for one scroll event after we set scrollTop programmatically
  // inside renderGallery — those are the *result* of an anchor, not a user-initiated scroll.
  var suppressNextAnchorCapture = false;
  function onThumbsScroll() {
    // In filmstrip focus mode #thumbs has overflow:hidden — this won't fire. Grid only.
    if (focusedIdx > 0) return;
    if (suppressNextAnchorCapture) { suppressNextAnchorCapture = false; }
    else { captureAnchorFromScroll(); }
    if (pendingScrollDraw) return;
    pendingScrollDraw = true;
    requestAnimationFrame(function () {
      pendingScrollDraw = false;
      drawCanvasForScroll();
    });
  }

  function onCanvasClick(e) {
    var rect = canvasEl.getBoundingClientRect();
    var thumbsEl = $('thumbs');
    var cx = e.clientX - rect.left;
    var cy = e.clientY - rect.top + (thumbsEl ? thumbsEl.scrollTop : 0);  // canvas y -> layout y
    for (var i = 0; i < lastTileRects.length; i++) {
      var t = lastTileRects[i];
      if (cx >= t.x && cx < t.x + t.w && cy >= t.y && cy < t.y + t.h) {
        location.hash = encodeURIComponent(t.name);
        return;
      }
    }
  }

  // Anchor state for zoom: captured on user scroll, NOT on re-layout. Each renderGallery
  // (e.g. during a zoom-slider drag) reuses this anchor unchanged so the row at the top
  // of the viewport stays at the top of the viewport across zoom changes. Re-capturing
  // on every render would drift, because the first-column image of the visible top row
  // changes when the column count changes with zoom.
  var cachedAnchorName = null;
  function captureAnchorFromScroll() {
    var thumbsEl = document.getElementById('thumbs');
    if (!thumbsEl || !lastTileRects.length) { cachedAnchorName = null; return; }
    var scrollY = thumbsEl.scrollTop;
    if (scrollY <= 0) { cachedAnchorName = null; return; }
    // The tile array is built row-major, so the first tile whose y-range spans scrollY
    // is the leftmost (x=0) image of the topmost visible row — i.e. the row anchor.
    for (var i = 0; i < lastTileRects.length; i++) {
      var t = lastTileRects[i];
      if (t.y <= scrollY && scrollY < t.y + t.h) { cachedAnchorName = t.name; return; }
    }
    // Fell into a gap below all rows; use the last row's leftmost tile.
    for (var j = lastTileRects.length - 1; j >= 0; j--) {
      if (lastTileRects[j].x === 0) { cachedAnchorName = lastTileRects[j].name; return; }
    }
    cachedAnchorName = null;
  }

  function drawCanvasForScroll() {
    if (!canvasEl || !window.spriteMeta) return;
    var thumbsEl = $('thumbs');
    if (!thumbsEl) return;
    var scrollY = thumbsEl.scrollTop;
    var dpr = devicePixelRatio();
    var viewportH = canvasEl.height / dpr;
    var viewportW = canvasEl.width / dpr;
    if (!viewportH) return;
    var ctx = canvasEl.getContext('2d', { alpha: false });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, viewportW, viewportH);

    // Find visible tiles
    var top = scrollY, bot = scrollY + viewportH;
    var visible = [];
    for (var k = 0; k < lastTileRects.length; k++) {
      var t = lastTileRects[k];
      if (t.y + t.h < top) continue;
      if (t.y > bot) break;
      visible.push(t);
    }

    // Frame counter: every drawCanvasForScroll bumps it. Async .then() callbacks check
    // it before drawing so stale draws (from a previous mode/zoom) don't paint on top of
    // the current canvas state. Without this guard, transitioning from atlas to per-image
    // mode leaves old atlas content showing in the gaps between per-image tiles.
    var myFrame = ++renderFrame;
    var atlasH = pickAtlasHeight(currentRowHeight);

    if (atlasH != null) {
      // ATLAS PATH: target row height is small enough that a sprite atlas at H<=50
      // covers it. One atlas image, many tiles drawn from offsets within it.
      var atlas = spriteMeta.atlases[String(atlasH)];
      // Paint each visible tile from the BEST currently-cached atlas tier.
      // bestCachedAtlasSrc walks h50 -> h10 -> h5 and returns whichever is
      // loaded for this image. So if the user just dragged the slider into
      // h50 territory but h50 isn't loaded yet, tiles render from h10 or h5
      // (blurrier, scaled up) instead of leaving the dark canvas background
      // visible. The picked atlas's per-sprite-arrival callback then upgrades
      // each tile in place when the higher-res sprite lands.
      var aCellW = atlas.cellW, aCellH = atlas.cellH;
      var aPerSprite = atlas.cellsPerSprite, aAcross = atlas.across;
      var canonicalH = 200;
      function paintTileFromBitmap(t, bitmap, atlasMeta) {
        var loc = spriteMeta.imageMap[t.name];
        if (!loc) return;
        var idx = loc.idx;
        var spriteIdx = Math.floor(idx / atlasMeta.cellsPerSprite);
        var posInSprite = idx % atlasMeta.cellsPerSprite;
        var row = Math.floor(posInSprite / atlasMeta.across);
        var col = posInSprite % atlasMeta.across;
        var srcW = Math.round(loc.w * (atlasMeta.cellH / canonicalH));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.drawImage(bitmap, col * atlasMeta.cellW, row * atlasMeta.cellH, srcW, atlasMeta.cellH, t.x, t.y - scrollY, t.w, t.h);
      }
      // First pass: paint each tile from the best cached atlas (any height).
      // bestCachedAtlasSrc returns { bitmap, sx, sy, sw, sh } so we can blit
      // directly without recomputing per-atlas geometry.
      for (var k = 0; k < visible.length; k++) {
        var t = visible[k];
        var as = bestCachedAtlasSrc(t.name);
        if (as) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.drawImage(as.bitmap, as.sx, as.sy, as.sw, as.sh, t.x, t.y - scrollY, t.w, t.h);
        }
      }
      // Kick off the picked atlas's load + register a per-sprite waiter that
      // upgrades just the affected tiles when each higher-res sprite lands.
      loadSpriteBitmapsForAtlas(atlasH);
      var visibleSnapshot = visible;
      onSpriteBitmapReady(atlasH, function (bm, spriteIdx) {
        if (!canvasEl || renderFrame !== myFrame) return;
        for (var k = 0; k < visibleSnapshot.length; k++) {
          var t = visibleSnapshot[k];
          var loc = spriteMeta.imageMap[t.name];
          if (!loc) continue;
          if (Math.floor(loc.idx / aPerSprite) === spriteIdx) {
            paintTileFromBitmap(t, bm, atlas);
          }
        }
      });
    } else {
      // PER-IMAGE PATH: target row height too big for the atlas. Each tile fetches its
      // own AVIF at the appropriate LoD tier. Decodes happen in parallel and the canvas
      // fills in progressively as bitmaps resolve.
      var tierH = pickPerImageTier(currentRowHeight);
      visible.forEach(function (t) {
        // Paint whatever's already in cache so the tile never goes black during a
        // zoom slide. Prefer the picked tier; fall back to any smaller cached tier;
        // ultimately fall back to the atlas. Then upgrade asynchronously.
        var cached = bestCachedPerImage(t.name, tierH);
        if (cached) {
          ctx.drawImage(cached, 0, 0, cached.width, cached.height, t.x, t.y - scrollY, t.w, t.h);
        } else {
          var as = bestCachedAtlasSrc(t.name);
          if (as) ctx.drawImage(as.bitmap, as.sx, as.sy, as.sw, as.sh, t.x, t.y - scrollY, t.w, t.h);
        }
        loadPerImageBitmap(t.name, tierH).then(function (bitmap) {
          if (!canvasEl || !bitmap || renderFrame !== myFrame) return;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, t.x, t.y - scrollY, t.w, t.h);
        });
      });

      // Prefetch one viewport ABOVE and one BELOW the current visible window so that
      // scrolling into them feels instant. fire-and-forget: loadPerImageBitmap caches by
      // (name, tier), so subsequent demand-loads find a resolved bitmap immediately.
      var prefetchTop = top - viewportH;
      var prefetchBot = bot + viewportH;
      for (var k = 0; k < lastTileRects.length; k++) {
        var t = lastTileRects[k];
        if (t.y > prefetchBot) break;
        if (t.y + t.h < prefetchTop) continue;
        // Skip already-visible tiles — they're being fetched in the .forEach above.
        if (t.y + t.h >= top && t.y <= bot) continue;
        loadPerImageBitmap(t.name, tierH);
      }
    }
  }

  // ============================================================================
  // FOCUS MODE — main image + filmstrip (iCloud Photos style)
  // ============================================================================
  // Layout in focus mode:
  //   #thumbs (overflow: hidden, full viewport)
  //     #focus-main   — main image canvas, fills (viewport - filmstrip)
  //     #focus-strip  — native horizontal-scroll container at the bottom
  //       <canvas (sticky left:0)>
  //       <div spacer (absolute, width = total filmstrip length + edge padding)>
  //
  // The filmstrip is the only scroll surface. Each tile is rendered from the h50
  // atlas at its natural-aspect width (loc.w * 50 / CANONICAL_H). As the
  // filmstrip scrolls, the centered tile becomes the focused image; the main
  // canvas is repainted with that image's bitmap. During scrubbing we paint the
  // main image from the same h50 atlas (instant, low-res); on idle Stage 2 will
  // upgrade to the highest available LoD.
  // Filmstrip thumbs are drawn from the h50 atlas but displayed at 60% size (30 CSS px).
  // Browser downscales 50→30 cleanly; no separate atlas tier needed. Total filmstrip
  // strip height = display size + 4px top/bottom padding so the white "centered" outline
  // doesn't clip against the viewport edge.
  var FILM_TILE_H = 30;
  var FILM_H = FILM_TILE_H + 8;
  var FILM_GAP = 3;
  var mainEl = null;      // main image canvas
  var filmstripEl = null; // filmstrip scroll container
  var filmCanvasEl = null;// canvas inside filmstrip
  var filmSpacerEl = null;
  // Transform state for the focused image (pinch-zoom). Scale anchored at the image
  // center; reset on every focusedIdx change so each photo opens at 1x.
  var mainScale = 1;
  var imgTx = 0, imgTy = 0;  // pan offset applied AFTER scale, so a finger drag of N px moves the image N px in screen space (independent of zoom level).
  // Drag state for iCloud-style swipe: while dragging, the focused image translates
  // by dragDX and prev/next images are painted at offset ±viewportW from center, so
  // they peek in from the side as the finger moves. On release we either commit
  // (snap to ±W and shift focus) or revert (snap back to 0).
  var dragActive = false;
  var dragDX = 0;
  var dragRaf = null;     // animation id for commit/revert
  // Pan state (single-finger drag while mainScale > 1).
  var panActive = false;
  var panStart = null;    // { sx, sy, tx0, ty0 }
  // The source we should draw into the main canvas: bitmap + sub-rect. Updated by
  // drawMainImage (atlas low-res) and upgradeMainImage (high-LoD). Held synchronously
  // so pinch can redraw without the microtask gap that was causing a black flicker
  // between canvas-clear and the async drawImage on the atlas-load promise.
  var mainDrawSrc = null;  // { bitmap, sx, sy, sw, sh, forIdx } | null
  // touchOnMain is set while a touch is active on the main canvas, so the document-
  // level pinch handler can skip those events (we want pinch on the main image to
  // zoom the image, not the slider).
  var touchOnMain = false;
  // Cached layout metrics (recomputed when filmstrip is built / on resize)
  var filmTilePos = null; // Float64Array of cumulative x positions, length = lastimagevalue
  var filmTileW   = null; // Float64Array of widths
  var filmTotalW  = 0;
  var filmPadL    = 0;    // leading/trailing padding so the first/last tile can sit at center
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
      // Display width = aspect-preserving width at FILM_TILE_H. Floor at 6px so
      // ultra-narrow images are still tappable.
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
    var lo = 0, hi = filmTilePos.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      var midEnd = filmTilePos[mid] + filmTileW[mid];
      if (midEnd <= center) lo = mid + 1;
      else hi = mid;
    }
    if (lo < 0) lo = 0;
    if (lo >= filmTilePos.length) lo = filmTilePos.length - 1;
    return lo + 1;
  }

  function filmScrollForIdx1(idx1, viewportW) {
    if (!filmTilePos || idx1 < 1) return 0;
    var i = idx1 - 1;
    if (i >= filmTilePos.length) i = filmTilePos.length - 1;
    var tileCenter = filmPadL + filmTilePos[i] + filmTileW[i] / 2;
    return Math.max(0, tileCenter - viewportW / 2);
  }

  // Continuous rAF chase toward filmScrollForIdx1(commandedIdx). Each tick reads
  // commandedIdx live, so additional shiftFocus calls (more arrow presses) bump
  // the target ahead and the chase keeps running toward the new target. Step is
  // proportional to remaining distance, so the strip naturally accelerates.
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
    if (Math.abs(diff) < 0.5) {
      filmstripEl.scrollLeft = target;
      focusInProgrammaticScroll = false;
      return;
    }
    var step = diff * 0.25;
    if (Math.abs(step) < 1) step = (diff > 0 ? 1 : -1);
    filmstripEl.scrollLeft = cur + step;
    focusChaseRaf = requestAnimationFrame(focusChaseTick);
  }

  function setupFilmstripFocus(thumbsEl) {
    var W = layoutWidth(), H = layoutHeight();
    var mainH = Math.max(120, H - FILM_H);

    thumbsEl.style.position = 'relative';
    thumbsEl.style.height = H + 'px';
    thumbsEl.style.overflow = 'hidden';
    thumbsEl.innerHTML = '';
    // Reset grid-mode references so they don't leak across mode switches.
    canvasEl = null; spacerEl = null;

    mainEl = document.createElement('canvas');
    mainEl.id = 'focus-main';
    var dpr = devicePixelRatio();
    mainEl.width  = Math.round(W * dpr);
    mainEl.height = Math.round(mainH * dpr);
    mainEl.style.cssText = 'display:block; width:' + W + 'px; height:' + mainH + 'px; background:#000; touch-action:none;';
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
    // User gesture on the filmstrip cancels any in-flight chase animation. Without
    // this, click-then-scroll fights the chase: the user scrolls, the chase keeps
    // pulling back toward the click target, and the strip rubber-bands. Touchstart
    // catches both desktop+mobile mouse-drags (browsers fire touch events on touch
    // surfaces); wheel covers desktop trackpad/mousewheel.
    function cancelChaseFromUser() {
      if (focusChaseRaf) {
        cancelAnimationFrame(focusChaseRaf);
        focusChaseRaf = null;
        focusInProgrammaticScroll = false;
        commandedIdx = focusedIdx;  // resync so next shiftFocus reads from focusedIdx
      }
    }
    filmstripEl.addEventListener('wheel', cancelChaseFromUser, { passive: true });
    filmstripEl.addEventListener('touchstart', cancelChaseFromUser, { passive: true });
    filmstripEl.addEventListener('mousedown', cancelChaseFromUser);
    setupMainImageGestures();

    var target = filmScrollForIdx1(focusedIdx, W);
    focusInProgrammaticScroll = true;
    filmstripEl.scrollLeft = target;
    var sl = $('zoomSlider'); if (sl) sl.value = '100';

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
    var bitmapsPromise = loadSpriteBitmapsForAtlas(atlasH);

    var scrollLeft = filmstripEl.scrollLeft;
    var leftEdge = scrollLeft - filmPadL;
    var rightEdge = leftEdge + W;
    var yPad = Math.round((FILM_H - FILM_TILE_H) / 2);

    var newCenterIdx = filmCenteredIdx1(scrollLeft, W);
    if (newCenterIdx !== focusedIdx) {
      focusedIdx = newCenterIdx;
      mainScale = 1;
      imgTx = 0; imgTy = 0;
      // Don't null mainDrawSrc — keep it as a placeholder so the next paintMain
      // shows SOMETHING (last good frame) instead of black. drawMainImage will be
      // called next from onFilmstripScroll and will install a fresh source
      // immediately (atlas h50 falls out of getBestSrcForFocus).
      try { history.replaceState(null, '', '#' + encodeURIComponent(images[focusedIdx])); } catch (_) {}
    }

    bitmapsPromise.then(function (bitmaps) {
      if (!filmCanvasEl) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, W, FILM_H);
      var n = filmTilePos.length;
      var lo = 0, hi = n - 1;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (filmTilePos[mid] + filmTileW[mid] <= leftEdge) lo = mid + 1;
        else hi = mid;
      }
      var aCellW = atlas.cellW, aCellH = atlas.cellH;
      var aPerSprite = atlas.cellsPerSprite, aAcross = atlas.across;
      // Source from the atlas at its full h50 cell size; drawImage downscales to
      // FILM_TILE_H (=30) for the displayed thumb. srcW = atlas-cell width for
      // this image (loc.w * 50/CANONICAL_H == filmTileW * 50/FILM_TILE_H).
      var srcScale = aCellH / FILM_TILE_H;
      for (var i = lo; i < n; i++) {
        var tx = filmTilePos[i];
        var tw = filmTileW[i];
        if (tx > rightEdge) break;
        var screenX = tx - leftEdge;
        var spriteIdx = Math.floor(i / aPerSprite);
        var posInSprite = i % aPerSprite;
        var row = Math.floor(posInSprite / aAcross);
        var col = posInSprite % aAcross;
        var bitmap = bitmaps[spriteIdx];
        if (!bitmap) continue;
        var srcW = Math.round(tw * srcScale);
        ctx.drawImage(bitmap, col * aCellW, row * aCellH, srcW, aCellH, screenX, yPad, tw, FILM_TILE_H);
        if (i + 1 === focusedIdx) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(screenX + 0.5, yPad + 0.5, tw - 1, FILM_TILE_H - 1);
        }
      }
    });
  }

  // Geometry helper: where + how big to draw the main image. Shared by drawMainImage
  // (low-res preview) and upgradeMainImage (high-LoD overlay).
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

  // Low-res paint from the h50 atlas. Always instant (atlas is in memory for
  // the filmstrip), so the main image follows scrubbing without ever blanking.
  // Synchronously paint the main canvas: clear + apply transform + drawImage from
  // mainDrawSrc. Used by pinch redraws (no async, no flicker) and by the load-resolved
  // callbacks below (after they update mainDrawSrc).
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
    if (imgTx !== 0 || imgTy !== 0) ctx.translate(imgTx, imgTy);
    if (mainScale !== 1) {
      var cx = g.W / 2, cy = g.mainH / 2;
      ctx.translate(cx, cy);
      ctx.scale(mainScale, mainScale);
      ctx.translate(-cx, -cy);
    }
    if (mainDrawSrc && mainDrawSrc.bitmap) {
      ctx.drawImage(
        mainDrawSrc.bitmap,
        mainDrawSrc.sx, mainDrawSrc.sy, mainDrawSrc.sw, mainDrawSrc.sh,
        g.dx, g.dy, g.dw, g.dh
      );
    }
  }

  function drawMainImage() {
    if (!mainEl || !window.spriteMeta) return;
    var g = mainImageGeom();
    if (!g) return;

    var targetH = g.dh;  // displayed pixel height of the focused image
    var tier = pickPerImageTier(targetH);

    // Pick the best already-resolved source NOW (target tier > any cached lower
    // tier > atlas). Set it into mainDrawSrc and paint synchronously.
    var src = getBestSrcForFocus(focusedIdx, targetH);
    if (src) {
      mainDrawSrc = { bitmap: src.bitmap, sx: src.sx, sy: src.sy, sw: src.sw, sh: src.sh, forIdx: focusedIdx };
    }
    // If src is null (atlas not loaded yet), keep the previous mainDrawSrc so
    // paintMain still shows the last good frame instead of a black flash.
    paintMain();

    // Kick off the target-tier load if not already in flight; when it resolves we
    // upgrade mainDrawSrc and repaint. No debounce — we want the highest-res tier
    // as soon as it's available, including DURING scrubbing.
    var capturedIdx = focusedIdx;
    var name = images[capturedIdx];
    if (name) {
      loadPerImageBitmap(name, tier).then(function (bm) {
        if (!mainEl || !bm || focusedIdx !== capturedIdx) return;
        mainDrawSrc = { bitmap: bm, sx: 0, sy: 0, sw: bm.width, sh: bm.height, forIdx: capturedIdx };
        paintMain();
      });
    }

    // If we didn't have any bitmap at all yet, kick off atlas load AND register
    // a per-sprite waiter so we paint the instant OUR sprite arrives — rather than
    // waiting for every sprite in the atlas to decode. With OI's 32 h50 sprites
    // that turns ~1s of black canvas into <100ms.
    if (!src) {
      var atlasH = 50;
      var atlas = spriteMeta.atlases && spriteMeta.atlases[String(atlasH)];
      if (atlas) {
        var neededSpriteIdx = Math.floor((capturedIdx - 1) / atlas.cellsPerSprite);
        loadSpriteBitmapsForAtlas(atlasH);  // kicks off all sprite fetches
        onSpriteBitmapReady(atlasH, function (bm, spriteIdx) {
          if (spriteIdx !== neededSpriteIdx) return;
          if (!mainEl || focusedIdx !== capturedIdx) return;
          var atlasSrc = getAtlasSrcSync(capturedIdx);
          if (!atlasSrc) return;
          if (!mainDrawSrc || mainDrawSrc.forIdx !== capturedIdx) {
            mainDrawSrc = { bitmap: atlasSrc.bitmap, sx: atlasSrc.sx, sy: atlasSrc.sy, sw: atlasSrc.sw, sh: atlasSrc.sh, forIdx: capturedIdx };
            paintMain();
          }
        });
      }
    }

    // Prefetch all images currently visible in the filmstrip at the same target tier.
    prefetchFilmstripVisible(tier);
  }

  // Walks the filmstrip's currently-visible range (plus a small look-ahead) and fires
  // loadPerImageBitmap at the requested tier. Caches dedupe so this is cheap on a
  // continuous scrub — just a Map.has() per tile.
  function prefetchFilmstripVisible(tier) {
    if (!filmstripEl || !filmTilePos) return;
    var W = layoutWidth();
    var leftEdge = filmstripEl.scrollLeft - filmPadL;
    var rightEdge = leftEdge + W;
    // Look ~half a viewport ahead in either direction so a fast scrub stays warm.
    var lookahead = W * 0.5;
    var lo = leftEdge - lookahead;
    var hi = rightEdge + lookahead;
    var n = filmTilePos.length;
    // Binary-search start
    var i = 0, j = n - 1;
    while (i < j) {
      var mid = (i + j) >> 1;
      if (filmTilePos[mid] + filmTileW[mid] <= lo) i = mid + 1;
      else j = mid;
    }
    for (; i < n; i++) {
      if (filmTilePos[i] > hi) break;
      var name = images[i + 1];
      if (name) loadPerImageBitmap(name, tier);
    }
  }

  // Legacy timer slot — drawMainImage now upgrades synchronously and prefetches
  // the filmstrip-visible window, so this is a no-op kept only to satisfy the
  // mainUpgradeTimer references that were left in for safety.
  var mainUpgradeTimer = null;
  function upgradeMainImage() { mainUpgradeTimer = null; }

  // Sync source-rect lookup for an arbitrary image index out of the h50 atlas.
  // Returns null if the atlas isn't loaded yet (caller should fall back to skipping
  // that side of the drag rather than blocking).
  // Try tiers in descending order until one is cached. If none, fall back to the
  // atlas (always-fastest). Returns { bitmap, sx, sy, sw, sh } or null.
  function getBestSrcForFocus(idx1, targetH) {
    if (idx1 < 1 || idx1 > lastimagevalue) return null;
    var name = images[idx1];
    if (!name) return null;
    var tier = pickPerImageTier(targetH);
    // Try the picked tier and any smaller pre-built tier we already have cached.
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

  // Paint the main canvas during a drag: clear, then draw current at offset dragDX,
  // prev at dragDX-W, next at dragDX+W. Uses mainDrawSrc (high-LoD if available) for
  // the centered image and atlas-sync sources for the neighbors.
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
    // No transform when dragging (we only enter the drag path at mainScale === 1).
    // imgTx/Ty are reset to 0 on focus change, so they don't need to be applied here.

    function paintAt(idx1, offsetX) {
      if (idx1 < 1 || idx1 > lastimagevalue) return;
      var name = images[idx1];
      var loc = name && spriteMeta && spriteMeta.imageMap && spriteMeta.imageMap[name];
      if (!loc) return;
      var dest = destRectForLoc(loc.w, CANONICAL_H, W, mainH);
      // For the centered image the live mainDrawSrc is already the best choice.
      // For the neighbors that peek in during a swipe, ask getBestSrcForFocus so
      // we use any cached high-res tier we have for them too, falling back to atlas.
      var src;
      if (idx1 === focusedIdx && mainDrawSrc && mainDrawSrc.forIdx === idx1) {
        src = mainDrawSrc;
      } else {
        src = getBestSrcForFocus(idx1, dest.dh);
      }
      if (!src) return;
      ctx.drawImage(src.bitmap, src.sx, src.sy, src.sw, src.sh, dest.dx + offsetX, dest.dy, dest.dw, dest.dh);
    }
    paintAt(focusedIdx, dx);
    paintAt(focusedIdx - 1, dx - W);
    paintAt(focusedIdx + 1, dx + W);
  }

  // Animate dragDX toward targetDX via the same proportional-step chase we use
  // elsewhere, then run done(). Each step paints the 3-image drag layout.
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

  // Commit a drag: animate to ±W then shift focus + reset state.
  // direction: -1 = went to previous (user dragged right), +1 = went to next (dragged left).
  function commitDrag(direction) {
    var W = layoutWidth();
    var targetDx = -direction * W;  // dragDX ended at +W means current image fully right; prev is centered
    animateDragTo(targetDx, function () {
      var newIdx = focusedIdx + direction;
      while (newIdx < 1) newIdx += lastimagevalue;
      while (newIdx > lastimagevalue) newIdx -= lastimagevalue;
      // Pre-populate the new mainDrawSrc from the atlas if available, so the next paint
      // doesn't black-flicker while the atlas .then() resolves on a microtask.
      // Pre-populate with best cached source for the new image. If nothing's
      // cached, keep the previous mainDrawSrc as a placeholder so paintMain doesn't
      // black-flash; drawMainImage's load callback will overwrite when ready.
      var newSrc = getBestSrcForFocus(newIdx, mainImageGeom() && mainImageGeom().dh);
      if (newSrc) {
        mainDrawSrc = { bitmap: newSrc.bitmap, sx: newSrc.sx, sy: newSrc.sy, sw: newSrc.sw, sh: newSrc.sh, forIdx: newIdx };
      }
      focusedIdx = newIdx;
      mainScale = 1;
      dragDX = 0;
      dragActive = false;
      // Sync the filmstrip to the new image (no chase animation needed — visual
      // commit already happened via the drag).
      if (filmstripEl) filmstripEl.scrollLeft = filmScrollForIdx1(focusedIdx, W);
      try { history.replaceState(null, '', '#' + encodeURIComponent(images[focusedIdx])); } catch (_) {}
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

  // Touch gestures on the main image: 1-finger horizontal swipe → prev/next via
  // shiftFocus (which animates through the chase loop). 2-finger pinch → scale the
  // current image around its center; release back to ≈1 snaps to identity.
  // touchOnMain is set so the document-level pinch handler (which drives the slider)
  // skips events that started here.
  function setupMainImageGestures() {
    if (!mainEl) return;
    var swipeStart = null;
    var pinchStart = null;
    function tdist(t1, t2) {
      var dx = t1.clientX - t2.clientX, dy = t1.clientY - t2.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }
    mainEl.addEventListener('touchstart', function (e) {
      touchOnMain = true;
      if (e.touches.length === 1) {
        swipeStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
        pinchStart = null;
      } else if (e.touches.length === 2) {
        pinchStart = { d: tdist(e.touches[0], e.touches[1]), scale: mainScale };
        swipeStart = null;
        e.preventDefault();
        e.stopPropagation();
      }
    }, { passive: false });
    mainEl.addEventListener('touchmove', function (e) {
      if (pinchStart && e.touches.length === 2) {
        e.preventDefault();
        e.stopPropagation();
        var d = tdist(e.touches[0], e.touches[1]);
        if (d < 1 || pinchStart.d < 1) return;
        var newScale = pinchStart.scale * (d / pinchStart.d);
        if (newScale < 1) newScale = 1;
        if (newScale > 6) newScale = 6;
        mainScale = newScale;
        paintMain();
        return;
      }
      // Single-finger drag.
      if (swipeStart && e.touches.length === 1) {
        e.preventDefault();  // unconditionally — touch-action:none on the main canvas
                             // already kills native scroll, but defensive in case the
                             // browser ignores touch-action for synthesized events.
        if (mainScale > 1) {
          // Pan the zoomed image. Initialize panStart on first move past the deadzone.
          if (!panActive) {
            var dxp = e.touches[0].clientX - swipeStart.x;
            var dyp = e.touches[0].clientY - swipeStart.y;
            if (Math.abs(dxp) < 6 && Math.abs(dyp) < 6) return;
            panActive = true;
            panStart = { sx: e.touches[0].clientX, sy: e.touches[0].clientY, tx0: imgTx, ty0: imgTy };
          }
          imgTx = panStart.tx0 + (e.touches[0].clientX - panStart.sx);
          imgTy = panStart.ty0 + (e.touches[0].clientY - panStart.sy);
          paintMain();
          return;
        }
        // Not zoomed: iCloud-style horizontal commit/revert swipe.
        var dx = e.touches[0].clientX - swipeStart.x;
        var dy = e.touches[0].clientY - swipeStart.y;
        if (!dragActive && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) return;
        if (dragActive || Math.abs(dx) > 6) {
          dragActive = true;
          dragDX = dx;
          paintMainDragged(dragDX);
        }
      }
    }, { passive: false });
    mainEl.addEventListener('touchend', function (e) {
      // Pinch end: snap back to 1x if user released near identity.
      if (pinchStart && e.touches.length < 2) {
        if (mainScale < 1.05) {
          mainScale = 1;
          imgTx = 0; imgTy = 0;
          paintMain();
        }
        pinchStart = null;
      }
      // Pan end: just settle. (No snap behavior — leave the image where the user left it.)
      if (panActive) {
        panActive = false;
        panStart = null;
        swipeStart = null;
      }
      // Drag end: commit if dragged > 30% of viewport OR flicked fast. Otherwise revert.
      if (dragActive) {
        var W = layoutWidth();
        var dt = Math.max(1, Date.now() - swipeStart.t);
        var velocity = dragDX / dt;  // px/ms
        var commit = (Math.abs(dragDX) > W * 0.30) || (Math.abs(velocity) > 0.5 && Math.abs(dragDX) > 30);
        if (commit) {
          // dragDX > 0 means user dragged right → previous image. direction = -1.
          commitDrag(dragDX > 0 ? -1 : +1);
        } else {
          revertDrag();
        }
        swipeStart = null;
      } else if (swipeStart) {
        swipeStart = null;
      }
      if (e.touches.length === 0) touchOnMain = false;
    });
    mainEl.addEventListener('touchcancel', function () {
      pinchStart = null; swipeStart = null; touchOnMain = false;
      panActive = false; panStart = null;
      if (dragActive) revertDrag();
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

    // ===== FOCUS MODE: main image + filmstrip =====
    if (focusedIdx > 0) {
      setupFilmstripFocus(thumbsEl);
      return;
    }

    // ===== GRID MODE: justified rows + virtual scroll =====
    // Use the row-stable anchor captured on the last user scroll (see captureAnchorFromScroll).
    // We do NOT re-capture here, because mid-zoom-drag the column count is changing and the
    // "image at viewport top" identity flickers — re-capturing would drift the gallery.
    var anchorName = cachedAnchorName;

    // Compute layout
    var H = targetRowHeight(getZoom());
    currentRowHeight = H;  // drawCanvasForScroll uses this to pick the atlas
    var rows = layoutRows(H);
    var totalH = 0;
    var GAP = rowGap(H);
    for (var i = 0; i < rows.length; i++) totalH += rows[i].height + GAP;
    lastTotalH = totalH;

    // Configure #thumbs as the scroll container
    thumbsEl.style.position = 'relative';
    thumbsEl.style.overflowY = 'auto';
    thumbsEl.style.height = viewportH + 'px';

    // Canvas + spacer. Backing store at device-pixel density (dpr×); CSS size at
    // logical (W). drawCanvasForScroll() applies setTransform(dpr) so all drawImage
    // calls keep using CSS coordinates.
    ensureCanvasAndSpacer(thumbsEl);
    var dpr = devicePixelRatio();
    var canvasH = Math.min(viewportH, Math.ceil(totalH));
    canvasEl.width = Math.round(W * dpr);
    canvasEl.height = Math.round(canvasH * dpr);
    canvasEl.style.width = W + 'px';
    canvasEl.style.height = canvasH + 'px';
    // Reset spacer to in-flow block (focus mode flips it to absolute).
    spacerEl.style.position = 'static';
    spacerEl.style.width = '1px';
    spacerEl.style.height = Math.max(0, Math.ceil(totalH) - canvasH) + 'px';
    // Reset thumbs to vertical-only scroll.
    thumbsEl.style.overflowX = 'hidden';

    // Compute tile rects in LAYOUT coords (independent of scroll)
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

    // Restore scroll position: anchor on the previously-top-left image so zoom doesn't
    // yank the user back to the top of the gallery.
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
    // Slider always mirrors the current zoom in grid mode.
    var slGrid = $('zoomSlider'); if (slGrid) slGrid.value = String(Math.round(getZoom()));
    // Trigger initial paint. drawCanvasForScroll picks the right atlas + lazy-loads it.
    drawCanvasForScroll();
  }

  function buildthumbpages() { /* legacy stub — layout is now incremental via renderGallery */ }

  function displaythumbs() {
    showAdminBar();
    focusedIdx = 0;
    if (location.hash) location.hash = '';
    hashmirror = '';
    setText('counter', '');
    document.body.classList.add('thumb-view');
    document.body.classList.remove('image-view');
    renderGallery();
  }

  // ---------- hash routing ----------
  function refreshfromhash() {
    hashmirror = location.hash.slice(1);
    var raw = decodeURIComponent(hashmirror || '');
    if (!raw || raw.charAt(0) === ':') {
      // Empty hash (or legacy ':N') = grid view. Clear any focus and re-render.
      focusedIdx = 0;
      document.body.classList.add('thumb-view');
      document.body.classList.remove('image-view');
      renderGallery();
    } else {
      // #filename = focus on that image. Find by canonical name lookup.
      for (var i = 1; i <= lastimagevalue; i++) {
        if (raw === images[i]) {
          focusedIdx = i;
          inum = i;  // keep legacy alias in sync
          document.body.classList.add('image-view');
          document.body.classList.remove('thumb-view');
          renderGallery();
          return;
        }
      }
      // Unknown name — fall through to grid
      focusedIdx = 0;
      renderGallery();
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

  // ---------- admin actions (delegated to globals) ----------
  function ggMoveToTrash() {
    // No confirm — trash is reversible (see Explore Trash). Show a quick note for feedback.
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

  // ---------- touch swipe ----------
  function setupZoomSlider() {
    var sl = $('zoomSlider');
    if (!sl) return;
    sl.value = String(getZoom());
    sl.addEventListener('input', function () {
      isSliderDragging = true;
      handleZoomChange(parseInt(sl.value, 10));
    });
    // 'change' fires on release (mouse up / touch end). Clear the drag flag,
    // re-render at the now-settled tier, and evict bitmaps for tiers we no
    // longer need.
    sl.addEventListener('change', function () {
      isSliderDragging = false;
      handleZoomChange(parseInt(sl.value, 10));
      // Defer eviction by a frame so the new render gets a chance to populate
      // atlasBitmapsSync for the active tier first (otherwise we'd evict it).
      requestAnimationFrame(function () {
        var H = (typeof currentRowHeight !== 'undefined' && currentRowHeight) || targetRowHeight(getZoom());
        var activeAtlasH = pickAtlasHeight(H);
        evictUnusedAtlases(activeAtlasH);
      });
    });
  }

  // Single source of truth for zoom changes. Boundary at 100:
  //   grid + v>=100 → enter focus on centered image
  //   focus + v<100 from the SLIDER → exit focus to grid at v
  //   focus + v<100 from PINCH → no-op (pinch in focus is reserved for image
  //     zoom; for now we just refuse to exit so the user doesn't get yanked
  //     out unexpectedly. ESC + slider drag remain as exit paths.)
  function handleZoomChange(v, fromPinch) {
    if (isNaN(v)) v = 0;
    if (v < 0) v = 0; if (v > 100) v = 100;
    if (focusedIdx === 0 && v >= 100) {
      var name = findCenteredImageName();
      if (name) {
        setZoom(100);
        var sl = $('zoomSlider'); if (sl) sl.value = '100';
        location.hash = encodeURIComponent(name);
        return;
      }
    }
    if (focusedIdx > 0 && v < 100) {
      if (fromPinch) {
        var slKeep = $('zoomSlider'); if (slKeep) slKeep.value = '100';
        return;
      }
      setZoom(v);
      var sl2 = $('zoomSlider'); if (sl2) sl2.value = String(v);
      location.hash = '';
      return;
    }
    setZoom(v);
    var sl3 = $('zoomSlider'); if (sl3) sl3.value = String(Math.round(v));
    if (focusedIdx === 0) scheduleRender();
  }

  // Picks the image whose tile center is closest to viewport center. Used when the
  // slider is dragged to 100% in grid mode to choose what image to focus on.
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

  // No custom wheel/touch handlers in focus mode any more — the strip is a real
  // native-scroll surface, so the browser drives prev/next via inertial scroll and
  // the filmstrip is the scroll surface and free-scrolls (no snap).
  // In landscape we redirect vertical wheel to horizontal scroll so trackpad/mousewheel
  // users without a horizontal axis can still navigate. Touch on iOS already gives both
  // axes natively, so no touch handler is needed.
  function setupTouch() {
    var thumbsEl = $('thumbs');
    if (!thumbsEl) return;
    thumbsEl.addEventListener('wheel', function (e) {
      if (focusedIdx <= 0) return;
      if (!filmstripEl) return;
      // In focus mode, vertical wheel scrubs the filmstrip horizontally.
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        filmstripEl.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    // Pinch-to-zoom drives the slider regardless of where the gesture starts on
    // the page. The handlers are bound at the document level for two reasons:
    //   1. iOS Safari deliberately ignores user-scalable=no — the only reliable way
    //      to block native pinch-zoom is preventDefault on every 2-finger touchmove
    //      AND on Safari's gesture* events. Binding to #thumbs only would let a pinch
    //      that started in the topbar/footer fall through to native browser zoom.
    //   2. The user expects to pinch anywhere; a thumbs-bound handler felt arbitrary.
    // Mapping is logarithmic: a doubling of finger distance moves the slider +25.
    var pinch = null;
    function dist(t1, t2) {
      var dx = t1.clientX - t2.clientX, dy = t1.clientY - t2.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }
    // Safari-only "gesture*" events represent the pinch directly. Blocking them is
    // the most reliable suppressor of browser pinch-zoom on iOS / desktop Safari.
    function blockGesture(e) { e.preventDefault(); }
    document.addEventListener('gesturestart',  blockGesture, { passive: false });
    document.addEventListener('gesturechange', blockGesture, { passive: false });
    document.addEventListener('gestureend',    blockGesture, { passive: false });

    document.addEventListener('touchstart', function (e) {
      if (touchOnMain) { pinch = null; return; }
      if (e.touches.length === 2) {
        pinch = { d0: dist(e.touches[0], e.touches[1]), v0: focusedIdx > 0 ? 100 : getZoom() };
        e.preventDefault();
      } else if (e.touches.length > 2) {
        pinch = null;
        e.preventDefault();
      } else {
        pinch = null;
      }
    }, { passive: false });
    document.addEventListener('touchmove', function (e) {
      if (touchOnMain) return;  // mainEl handler owns this gesture
      if (e.touches.length >= 2) e.preventDefault();  // unconditionally block native pinch zoom
      if (!pinch || e.touches.length !== 2) return;
      var d = dist(e.touches[0], e.touches[1]);
      if (d < 1 || pinch.d0 < 1) return;
      var newVal = Math.max(0, Math.min(100, pinch.v0 + Math.log2(d / pinch.d0) * 25));
      handleZoomChange(newVal, true);
      // After a mode flip the pinch baseline is stale (we may have just entered/exited
      // focus). Reseed so further finger movement keeps tracking.
      pinch.d0 = d;
      pinch.v0 = focusedIdx > 0 ? 100 : newVal;
    }, { passive: false });
    document.addEventListener('touchend', function (e) {
      if (e.touches.length < 2) pinch = null;
    });
    document.addEventListener('touchcancel', function () { pinch = null; });
  }

  // ---------- thumb click delegation ----------
  function setupThumbClicks() {
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('#thumbs a[data-i]');
      if (!a) return;
      e.preventDefault();
      preview(parseInt(a.getAttribute('data-i'), 10));
    });
  }

  // ---------- start ----------
  function startjs() {
    // session check: if we have a stored token, the page already rendered with isadmin=0,
    // so probe and reload if a session is valid (cheap one-time check).
    maybePromoteAdmin();

    setupTouch();
    setupThumbClicks();
    setupZoomSlider();

    window.addEventListener('resize', scheduleRender);

    // Show a loading placeholder while the binary imagemap is in flight, then run the
    // initial route once we have data. If there's no imagemap to load (e.g. sprite not
    // built yet) we still want to render — fall through to renderGallery which has its
    // own "Building LoD cache…" placeholder for the spriteMeta=null case.
    function runInitialRoute() {
      var raw = decodeURIComponent(location.hash.slice(1) || '');
      if (!raw || raw.charAt(0) === ':') {
        displaythumbs();
      } else if (lastimagevalue > 0) {
        var found = 0;
        for (var j = 1; j <= lastimagevalue; j++) if (raw === images[j]) { inum = j; found = 1; break; }
        if (found) refreshfromhash(); else displaythumbs();
      } else {
        displaythumbs();
      }
    }

    if (window.imagemapURL && window.spriteMeta) {
      var thumbsEl = $('thumbs');
      if (thumbsEl) thumbsEl.innerHTML = '<div style="padding:32px;text-align:center;color:#888">Loading…</div>';
      loadImagemap().then(function () {
        runInitialRoute();
      }).catch(function (e) {
        console.warn('[imagemap] load failed:', e);
        runInitialRoute();  // attempt render anyway; may show "Generating…" or No images
      });
    } else {
      runInitialRoute();
    }

    window.addEventListener('hashchange', refreshfromhash);
    // Key handlers attached programmatically (inline onkey* attributes on body fire
    // before this IIFE's window.* exports exist — Safari hits the race).
    window.addEventListener('keydown', keycheck);
    window.addEventListener('keyup', unlockkeys);
    pollBuildStatus();
  }

  // Probe the admin cookie. If valid, flip the in-page admin UI on; otherwise no-op.
  // Cookie is HttpOnly so we can't read it from JS — the probe is the only way to know.
  function maybePromoteAdmin() {
    if (window.isadmin) return;
    fetch('/api/admin/probe', { credentials: 'same-origin' })
      .then(function (r) {
        if (r.ok) { window.isadmin = 1; showAdminBar(); }
      })
      .catch(function () { /* offline — silently no-op */ });
  }

  // expose for inline handlers / other scripts
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

  // start when DOM is ready
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startjs);
  else startjs();
})();
