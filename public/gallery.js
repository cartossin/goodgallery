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
  function shiftFocus(delta) {
    if (lastimagevalue < 1) return;
    var next = focusedIdx + delta;
    if (next < 1) next = lastimagevalue;
    if (next > lastimagevalue) next = 1;
    location.hash = encodeURIComponent(images[next]);
  }

  // ---------- keys ----------
  function unlockkeys() { keyslocked = 0; }
  function keycheck(e) {
    if (keyslocked) return;
    var k = e.which || e.keyCode;
    if (k === 37) leftbutton();
    else if (k === 39) rightbutton();
    else if (k === 27 && focusedIdx > 0) { location.hash = ''; }  // ESC = back to grid
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
      // Focus mode: row height ~80% of available viewport. Justified-rows layout puts the
      // focused image's row at this height; adjacent rows (above/below) and adjacent
      // images in the same row peek in at the edges.
      return Math.max(50, layoutHeight() * 0.8);
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

  // Per-image LoD: pick the smallest available tier height >= target. The available
  // per-image tiers (h100/h200/h400/h800) are an architectural decision matching
  // the server's LOD_TIERS list.
  var PER_IMAGE_TIERS = [100, 200, 400, 800];
  function pickPerImageTier(targetH) {
    for (var i = 0; i < PER_IMAGE_TIERS.length; i++) {
      if (PER_IMAGE_TIERS[i] >= targetH) return PER_IMAGE_TIERS[i];
    }
    return PER_IMAGE_TIERS[PER_IMAGE_TIERS.length - 1];
  }

  function loadPerImageBitmap(name, tierH) {
    var key = name + '|' + tierH;
    if (perImageBitmaps.has(key)) return perImageBitmaps.get(key);
    var url = folderURL + 'thumbcache/' + encodeURIComponent(name) + '.h' + tierH + '.avif';
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
    if (!canvasClickAttached) {
      canvasEl.addEventListener('click', onCanvasClick);
      canvasClickAttached = true;
    }
    if (!thumbsScrollAttached) {
      thumbsEl.addEventListener('scroll', onThumbsScroll, { passive: true });
      thumbsScrollAttached = true;
    }
  }

  function onThumbsScroll() {
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

    // Anchor the zoom: find the image at the top-left of the viewport BEFORE re-layout
    // so we can restore scroll position to keep it visually pinned. Only meaningful in
    // grid mode (focusedIdx==0); focus mode owns scroll positioning explicitly.
    var anchorName = null, anchorViewportOffset = 0;
    if (focusedIdx === 0 && lastTileRects.length > 0 && thumbsEl.scrollTop > 0) {
      var scrollY = thumbsEl.scrollTop;
      for (var ai = 0; ai < lastTileRects.length; ai++) {
        var at = lastTileRects[ai];
        if (at.y + at.h > scrollY && at.x === 0) {
          anchorName = at.name;
          anchorViewportOffset = at.y - scrollY;  // negative if tile starts above viewport
          break;
        }
      }
    }

    // Compute layout
    var H = targetRowHeight(getZoom());
    currentRowHeight = H;  // drawCanvasForScroll uses this to pick the atlas
    var rows = layoutRows(H);
    var W = layoutWidth();
    var totalH = 0;
    for (var i = 0; i < rows.length; i++) totalH += rows[i].height + ROW_GAP;
    lastTotalH = totalH;

    // Available viewport height for the scroll container
    var viewportH = layoutHeight();

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
    spacerEl.style.height = Math.max(0, Math.ceil(totalH) - canvasH) + 'px';

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

    // Position scroll. Three cases:
    //   1. focus mode: center the focused tile in the viewport.
    //   2. grid mode with anchor: keep the previously-top-left image pinned to the
    //      same viewport offset (so zoom doesn't yank you back to the top of the list).
    //   3. grid mode no anchor (first render or scrollTop already 0): leave at top.
    var maxScroll = Math.max(0, totalH - viewportH);
    if (focusedIdx > 0 && focusedIdx <= lastTileRects.length) {
      var tile = lastTileRects[focusedIdx - 1];
      var target = tile.y + tile.h / 2 - viewportH / 2;
      thumbsEl.scrollTop = Math.max(0, Math.min(maxScroll, target));
    } else if (anchorName) {
      for (var ki = 0; ki < lastTileRects.length; ki++) {
        if (lastTileRects[ki].name === anchorName) {
          var newScroll = lastTileRects[ki].y - anchorViewportOffset;
          thumbsEl.scrollTop = Math.max(0, Math.min(maxScroll, newScroll));
          break;
        }
      }
    } else {
      thumbsEl.scrollTop = 0;
    }

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
      setZoom(parseInt(sl.value, 10));
      scheduleRender();
    });
  }

  function setupTouch() {
    var startX = 0, startY = 0, startT = 0;
    var photodiv = $('photodiv');
    if (!photodiv) return;
    photodiv.addEventListener('touchstart', function (e) {
      var t = e.changedTouches[0];
      startX = t.clientX; startY = t.clientY; startT = Date.now();
    }, { passive: true });
    photodiv.addEventListener('touchend', function (e) {
      var t = e.changedTouches[0];
      var dx = t.clientX - startX, dy = t.clientY - startY;
      var dt = Date.now() - startT;
      if (isfullres) return;
      if (dt < 600 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx < 0) nextimage(); else previousimage();
      }
    }, { passive: true });
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
        if (found) startimage(); else displaythumbs();
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
