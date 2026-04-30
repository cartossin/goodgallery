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

  var previewimages = [null];
  var thumbs        = [null];
  var inum = 1;
  var isfullres = 0;
  var keyslocked = 0;
  var hashmirror = '';
  var monitortimerid = null;

  // Build cache URLs that live under the current folder URL.
  // For files smaller than previewThreshold we just use the original — modern browsers
  // scale beautifully, so making a smaller "preview" is wasted disk for small files.
  function thumbURL(name)         { return folderURL + 'thumbcache/'   + encodeURIComponent(name) + '.resized.jpg'; }
  function previewCacheURL(name)  { return folderURL + 'previewcache/' + encodeURIComponent(name) + '.resized.jpg'; }
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

  function nextimage()    { inum = nextIndex(inum); startimage(); }
  function previousimage(){ inum = prevIndex(inum); startimage(); }

  function isThumbView() {
    var raw = decodeURIComponent(location.hash.slice(1) || '');
    return !raw || raw.charAt(0) === ':';
  }
  function leftbutton()  { if (isThumbView()) return; previousimage(); }
  function rightbutton() { if (isThumbView()) return; nextimage(); }

  // ---------- keys ----------
  function unlockkeys() { keyslocked = 0; }
  function keycheck(e) {
    if (keyslocked) return;
    var k = e.which || e.keyCode;
    if (k === 37 && !isfullres) leftbutton();
    else if (k === 39 && !isfullres) rightbutton();
    else if (k === 13) togglefullres();
    else if (k === 27 && isfullres) togglefullres();
    keyslocked = 1;
  }

  // ---------- view ----------
  function startimage() {
    showAdminBar();
    setHTML('thumbs', '');
    isfullres = 0;
    document.body.classList.add('image-view');
    document.body.classList.remove('thumb-view');
    var pd = $('photodiv'); if (pd) pd.classList.remove('fullres');
    var name = images[inum];
    hashmirror = encodeURIComponent(name);
    location.hash = hashmirror;

    var photo = $('photospot');
    photo.innerHTML = '<img src="' + previewSrc(inum) + '" id="img-' + inum + '" alt="' + name + '">';

    var pre = $('preimages');
    pre.innerHTML =
      '<img src="' + previewSrc(nextIndex(inum)) + '">' +
      '<img src="' + previewSrc(prevIndex(inum)) + '">';

    setText('counter', inum + ' of ' + lastimagevalue + ' — ' + name);
  }

  function fullres() {
    var name = images[inum];
    var photo = $('photospot');
    photo.innerHTML = '<img src="' + originalURL(name) + '">';
  }
  function togglefullres() {
    if ((decodeURIComponent(location.hash.slice(1)) || '').charAt(0) === ':') return;
    var pd = $('photodiv');
    if (!isfullres) { isfullres = 1; pd.classList.add('fullres'); fullres(); }
    else { startimage(); }
  }

  function preview(i) { inum = i; startimage(); }

  // ---- justified-rows layout + zoom slider ---------------------------------
  // No pagination. The zoom slider drives a single value (target row height in CSS px).
  // At slider=0, the height is computed so all thumbs fit in the viewport with no
  // scroll. At slider=100, height is the atlas height (200 px). In between we
  // interpolate geometrically (one slider notch ~doubles the size of the thumbs).
  //
  // For target row height H: w_disp = loc.w * H / cellH; greedy-pack into rows; each
  // row except the last is justified by scaling uniformly to fill the viewport width.
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
    var lo = 2, hi = spriteMeta.cellH;
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
      var natW = (loc ? loc.w : spriteMeta.cellH) * H / spriteMeta.cellH;
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
    var Hmin = fitAllHeight();
    var Hmax = spriteMeta.cellH;
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
      var natW = (loc ? loc.w : spriteMeta.cellH) * H / spriteMeta.cellH;
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

  var spriteBitmapPromises = null;     // resolved sprite ImageBitmaps (one per sprite-N.jpg)
  var lastTileRects = [];              // [{x, y, w, h, name}] in LAYOUT coords (not screen)
  var lastTotalH = 0;                  // total layout height
  var canvasEl = null;
  var spacerEl = null;
  var canvasClickAttached = false;
  var thumbsScrollAttached = false;
  var pendingScrollDraw = false;

  function loadSpriteBitmaps() {
    if (spriteBitmapPromises || !window.spriteMeta) return spriteBitmapPromises;
    spriteBitmapPromises = Promise.all(spriteMeta.sprites.map(function (sp) {
      var url = folderURL + 'thumbcache/' + sp.file;
      return fetch(url, { credentials: 'same-origin' })
        .then(function (r) { return r.blob(); })
        .then(function (b) { return createImageBitmap(b); });
    }));
    return spriteBitmapPromises;
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
    // Logical (CSS) size of the canvas
    var viewportH = canvasEl.height / dpr;
    var viewportW = canvasEl.width / dpr;
    if (!viewportH) return;
    var ctx = canvasEl.getContext('2d', { alpha: false });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);  // all drawImage calls below use CSS coords
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, viewportW, viewportH);
    if (!spriteBitmapPromises) return;
    spriteBitmapPromises.then(function (bitmaps) {
      if (!canvasEl) return;
      var cellW = spriteMeta.cellW, cellH = spriteMeta.cellH;
      var top = scrollY, bot = scrollY + viewportH;
      for (var k = 0; k < lastTileRects.length; k++) {
        var t = lastTileRects[k];
        if (t.y + t.h < top) continue;
        if (t.y > bot) break;
        var loc = spriteMeta.imageMap[t.name];
        if (!loc) continue;
        var bitmap = bitmaps[loc.sprite];
        if (!bitmap) continue;
        ctx.drawImage(bitmap, loc.col * cellW, loc.row * cellH, loc.w, cellH, t.x, t.y - scrollY, t.w, t.h);
      }
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
        '<div style="font-size:16px;margin-bottom:8px">Generating thumbnails…</div>' +
        '<div style="font-size:13px">' + lastimagevalue + ' images in this folder</div>' +
        '</div>';
      pollBuildStatus({ reloadOnComplete: true });
      thumbsEl.style.cssText = '';
      canvasEl = null; spacerEl = null;
      return;
    }

    // Compute layout
    var H = targetRowHeight(getZoom());
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

    // Reset scroll position to top on layout change (otherwise zooming can leave you
    // looking at empty space below the new shorter layout)
    thumbsEl.scrollTop = 0;

    // Trigger initial paint (sprites may already be loaded; if not, paint runs once they resolve)
    loadSpriteBitmaps();
    drawCanvasForScroll();
  }

  function buildthumbpages() { /* legacy stub — layout is now incremental via renderGallery */ }

  function displaythumbs() {
    if (isfullres) togglefullres();
    showAdminBar();
    if (location.hash) location.hash = '';
    hashmirror = '';
    setHTML('photospot', '');
    setHTML('preimages', '');
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
      displaythumbs();  // empty hash or legacy ':N' both = thumb view
    } else {
      for (var i = 1; i <= lastimagevalue; i++) {
        if (raw === images[i]) { inum = i; break; }
      }
      startimage();
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

    // populate preview-image array (used by image-viewer prev/next preload)
    for (var i = 1; i <= lastimagevalue; i++) {
      previewimages[i] = previewSrc(i);
    }
    window.addEventListener('resize', scheduleRender);
    // Sprite ImageBitmaps load lazily on first renderGallery; nothing to kick off here.

    // initial route: hash empty or ':N' → thumb view; #filename → image view
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
  window.startimage = startimage;
  window.preview = preview;
  window.togglefullres = togglefullres;
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
