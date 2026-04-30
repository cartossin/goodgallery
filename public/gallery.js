// Goodgallery 2.0 client. Vanilla JS, no third-party libraries.
// Preserves the 2014 logic: images[], previewimages[], thumbs[], hash navigation,
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

  var previewimages = [null];
  var thumbs        = [null];
  var inum = 1;             // legacy alias for focusedIdx — keep for any old refs
  var focusedIdx = 0;       // 0 = no focus (grid view); 1..N = focused image index (1-based)
  var isfullres = 0;        // unused after viewer removal; kept to satisfy any leftover refs
  var keyslocked = 0;
  var hashmirror = '';
  var monitortimerid = null;

  // Build cache URLs that live under the current folder URL.
  // For files smaller than previewThreshold we just use the original — modern browsers
  // scale beautifully, so making a smaller "preview" is wasted disk for small files.
  function thumbURL(name)         { return folderURL + 'thumbcache/'   + encodeURIComponent(name) + '.resized.jpg'; }
  function previewCacheURL(name)  { return folderURL + 'previewcache/' + encodeURIComponent(name) + '.resized.avif'; }
  function originalURL(name)      { return folderURL + encodeURIComponent(name); }
  // Server transparently serves the original when no preview file exists, so the client
  // never has to know which to ask for. Avoids embedding per-image sizes in the page —
  // important at 60k scale where that'd mean 60k stats per render.
  function previewSrc(i) { return previewCacheURL(images[i]); }

  function $(id) { return document.getElementById(id); }
  function setText(id, t) { var e = $(id); if (e) e.textContent = t; }
  function setHTML(id, h) { var e = $(id); if (e) e.innerHTML = h; }

  // ---------- realtime monitor ----------
  function note(msg) {
    var rt = $('realtime');
    if (!rt) return;
    rt.textContent = msg || '';
  }
  function clearmonitor() {
    if (waitingfor <= 0) {
      note('');
      requestbuildall();
    }
  }
  function finalclearmonitor() { note(''); }

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

  // Server now owns validation/build. Fire-and-forget: ask the server to enqueue,
  // then poll status for feedback. No more client-driven loop.
  // Server owns validation/build. requestbuildall fires it explicitly and waits-with-poll
  // for completion (then reloads). On a fresh page load we just monitor whatever is
  // currently active — never reload, so we don't loop on stale historical totals.
  function requestbuildall() {
    note('Asking server to validate gallery…');
    fetch(folderURL + '?buildall=1', { credentials: 'same-origin', headers: adminHeader() })
      .then(function (r) { return r.text(); })
      .then(function () { pollBuildStatus({ reloadOnComplete: true }); })
      .catch(function () { note('(could not reach server)'); });
  }
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
          note('Building thumbnails — ' + active + ' remaining (' + p.done + '/' + p.total + ' done)');
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
  var ROW_GAP = 2;  // matches CSS .row gap
  function simulateLayoutHeight(H, W) {
    if (!window.spriteMeta) return 0;
    var rows = 0, totalH = 0;
    var natRowW = 0, count = 0;
    for (var i = 1; i <= lastimagevalue; i++) {
      var name = images[i];
      var loc = spriteMeta.imageMap[name];
      var natW = (loc ? loc.w : CANONICAL_H) * H / CANONICAL_H;
      if (count > 0 && (natRowW + ROW_GAP * count + natW) > W) {
        // close row
        var rowScale = Math.min(1.5, (W - ROW_GAP * (count - 1)) / Math.max(1, natRowW));
        totalH += H * rowScale + ROW_GAP;
        rows++; natRowW = 0; count = 0;
      }
      natRowW += natW; count++;
    }
    if (count > 0) totalH += H + ROW_GAP;  // last row at natural height
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
      var avail = W - ROW_GAP * Math.max(0, current.length - 1);
      if (current.length > 0 && (natRowW + natW + ROW_GAP) > W) {
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
    var contentW = W - ROW_GAP * Math.max(0, items.length - 1);
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
  // Per-image bitmap cache for high-zoom views. Keyed by `${name}|${tierH}`. At
  // tierH=100/200/400/800 we fetch each visible image as its own AVIF; the canvas
  // composites them. Only viewport-visible images are fetched, so memory is bounded.
  var perImageBitmaps = new Map();
  var currentRowHeight = 200;          // current target row height in CSS px
  var renderFrame = 0;                 // increments per renderGallery; async draws check this
  var lastTileRects = [];              // [{x, y, w, h, name}] in LAYOUT coords (not screen)
  var lastTotalH = 0;                  // total layout height
  var canvasEl = null;
  var spacerEl = null;
  var canvasClickAttached = false;
  var thumbsScrollAttached = false;
  var pendingScrollDraw = false;

  function loadSpriteBitmapsForAtlas(atlasH) {
    var key = String(atlasH);
    if (spriteBitmapsByHeight[key]) return spriteBitmapsByHeight[key];
    var atlas = window.spriteMeta && spriteMeta.atlases && spriteMeta.atlases[key];
    if (!atlas) return Promise.resolve([]);
    spriteBitmapsByHeight[key] = Promise.all(atlas.sprites.map(function (sp) {
      var url = folderURL + 'thumbcache/' + sp.file;
      return fetch(url, { credentials: 'same-origin' })
        .then(function (r) { return r.blob(); })
        .then(function (b) { return createImageBitmap(b); });
    }));
    return spriteBitmapsByHeight[key];
  }

  // Atlas pick: smallest atlas height >= target. Returns null if target exceeds the
  // largest atlas (caller should switch to per-image rendering).
  function pickAtlasHeight(targetH) {
    if (!window.spriteMeta || !spriteMeta.atlases) return null;
    var heights = Object.keys(spriteMeta.atlases).map(Number).sort(function (a, b) { return a - b; });
    for (var i = 0; i < heights.length; i++) {
      if (heights[i] >= targetH) return heights[i];
    }
    return null;  // target is larger than any atlas — caller uses per-image AVIF
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
      : folderURL + 'thumbcache/' + encodeURIComponent(name) + '.h' + tierH + '.avif';
    var prom = fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.blob(); })
      .then(function (b) { return createImageBitmap(b); })
      .catch(function () { return null; });
    perImageBitmaps.set(key, prom);
    return prom;
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
      loadSpriteBitmapsForAtlas(atlasH).then(function (bitmaps) {
        if (!canvasEl || renderFrame !== myFrame) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        var aCellW = atlas.cellW, aCellH = atlas.cellH;
        var aPerSprite = atlas.cellsPerSprite, aAcross = atlas.across;
        var canonicalH = 200;
        for (var k = 0; k < visible.length; k++) {
          var t = visible[k];
          var loc = spriteMeta.imageMap[t.name];
          if (!loc) continue;
          var idx = loc.idx;
          var spriteIdx = Math.floor(idx / aPerSprite);
          var posInSprite = idx % aPerSprite;
          var row = Math.floor(posInSprite / aAcross);
          var col = posInSprite % aAcross;
          var bitmap = bitmaps[spriteIdx];
          if (!bitmap) continue;
          var srcW = Math.round(loc.w * (aCellH / canonicalH));
          ctx.drawImage(bitmap, col * aCellW, row * aCellH, srcW, aCellH, t.x, t.y - scrollY, t.w, t.h);
        }
      });
    } else {
      // PER-IMAGE PATH: target row height too big for the atlas. Each tile fetches its
      // own AVIF at the appropriate LoD tier. Decodes happen in parallel and the canvas
      // fills in progressively as bitmaps resolve.
      var tierH = pickPerImageTier(currentRowHeight);
      visible.forEach(function (t) {
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
    mainEl.style.cssText = 'display:block; width:' + W + 'px; height:' + mainH + 'px; background:#000;';
    thumbsEl.appendChild(mainEl);

    filmstripEl = document.createElement('div');
    filmstripEl.id = 'focus-strip';
    filmstripEl.style.cssText =
      'position:absolute; left:0; bottom:0; width:' + W + 'px; height:' + FILM_H + 'px;' +
      'overflow-x:auto; overflow-y:hidden; background:#0a0a0a;' +
      ' -ms-overflow-style:none; scrollbar-width:none;';
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
  function drawMainImage() {
    if (!mainEl || !window.spriteMeta) return;
    var g = mainImageGeom();
    if (!g) return;
    var dpr = devicePixelRatio();
    var ctx = mainEl.getContext('2d', { alpha: false });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, g.W, g.mainH);

    var atlasH = 50;
    var atlas = spriteMeta.atlases && spriteMeta.atlases[String(atlasH)];
    if (atlas) {
      var capturedIdx = focusedIdx;
      loadSpriteBitmapsForAtlas(atlasH).then(function (bitmaps) {
        if (!mainEl || focusedIdx !== capturedIdx) return;
        var idx0 = capturedIdx - 1;
        var spriteIdx = Math.floor(idx0 / atlas.cellsPerSprite);
        var posInSprite = idx0 % atlas.cellsPerSprite;
        var row = Math.floor(posInSprite / atlas.across);
        var col = posInSprite % atlas.across;
        var bitmap = bitmaps[spriteIdx];
        if (!bitmap) return;
        var srcW = Math.round(g.natW * atlasH / g.natH);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.drawImage(bitmap, col * atlas.cellW, row * atlas.cellH, srcW, atlas.cellH, g.dx, g.dy, g.dw, g.dh);
      });
    }
    // Schedule the high-res upgrade. Resets on every scrub, so it only fires
    // 150ms after scrolling settles — no point burning network on images the user
    // is scrolling past.
    if (mainUpgradeTimer) clearTimeout(mainUpgradeTimer);
    mainUpgradeTimer = setTimeout(upgradeMainImage, 150);
  }

  // After the user stops scrubbing, upgrade the main image to whatever LoD tier
  // best matches the displayed pixel size. Above h800 we serve the original.
  // Also warms ±FOCUS_PREFETCH neighbors at the same tier so a few prev/next
  // taps after settling are instant.
  var mainUpgradeTimer = null;
  function upgradeMainImage() {
    mainUpgradeTimer = null;
    if (!mainEl) return;
    var g = mainImageGeom();
    if (!g) return;
    var tier = pickPerImageTier(g.dh);
    var capturedIdx = focusedIdx;
    loadPerImageBitmap(g.name, tier).then(function (bm) {
      if (!mainEl || !bm || focusedIdx !== capturedIdx) return;
      var dpr = devicePixelRatio();
      var ctx = mainEl.getContext('2d', { alpha: false });
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, g.W, g.mainH);
      ctx.drawImage(bm, 0, 0, bm.width, bm.height, g.dx, g.dy, g.dw, g.dh);
    });
    // Prefetch neighbors so prev/next is instant after a settle.
    for (var d = -FOCUS_PREFETCH; d <= FOCUS_PREFETCH; d++) {
      if (d === 0) continue;
      var idx = focusedIdx + d;
      while (idx < 1) idx += lastimagevalue;
      while (idx > lastimagevalue) idx -= lastimagevalue;
      if (images[idx]) loadPerImageBitmap(images[idx], tier);
    }
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
        '<div style="font-size:16px;margin-bottom:8px">Generating thumbnails…</div>' +
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
    for (var i = 0; i < rows.length; i++) totalH += rows[i].height + ROW_GAP;
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
        x += it.w + ROW_GAP;
      }
      y += rows[r].height + ROW_GAP;
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
        '<button onclick="ggRequestBuildAll()">Validate</button>' +
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
  function ggRequestBuildAll() { requestbuildall(); }
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
      handleZoomChange(parseInt(sl.value, 10));
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
    // own "Generating thumbnails…" placeholder for the spriteMeta=null case.
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
        for (var i = 1; i <= lastimagevalue; i++) previewimages[i] = previewSrc(i);
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
  window.ggRequestBuildAll = ggRequestBuildAll;
  window.ggExploreTrash = ggExploreTrash;
  window.ggRestoreFile = ggRestoreFile;
  window.ggDeleteFile = ggDeleteFile;
  window.ggRestoreAll = ggRestoreAll;
  window.ggEmptyTrash = ggEmptyTrash;

  // start when DOM is ready
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startjs);
  else startjs();
})();
