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

  // ---- per-tile blob cache (option A) ------------------------------------
  // Slice each sprite atlas into N independent image blobs (one per thumb), so each
  // <img> has its own self-contained source. Tradeoff vs. shared sprite img:
  //   + Each tile is a tiny independent image — browsers (esp. Safari) composite these
  //     much more efficiently than N elements all referencing the same big JPEG.
  //   - One-time CPU cost: ~10ms per tile (create + drawImage + toBlob), so ~5–10s for
  //     800 tiles. Done in the background after first paint, so user sees placeholder
  //     boxes briefly then the imagery fills in.
  //   - ~10–30MB extra memory for the blobs.
  var blobCache = {};       // name -> blob: URL
  var blobCacheReady = false;
  var blobCacheBuilding = false;

  function clearBlobCache() {
    for (var k in blobCache) { try { URL.revokeObjectURL(blobCache[k]); } catch (e) {} }
    blobCache = {};
    blobCacheReady = false;
  }

  async function buildBlobCache() {
    if (blobCacheBuilding || blobCacheReady) return;
    if (!window.spriteMeta) return;
    blobCacheBuilding = true;
    var t0 = performance.now();
    try {
      // Fetch + decode each unique sprite atlas ONCE
      var spriteBitmaps = await Promise.all(spriteMeta.sprites.map(async function (sp) {
        var url = folderURL + 'thumbcache/' + sp.file;
        var resp = await fetch(url, { credentials: 'same-origin' });
        var blob = await resp.blob();
        return await createImageBitmap(blob);
      }));
      var tFetch = performance.now() - t0;

      // Slice every tile in parallel — browsers throttle internally
      var entries = Object.keys(spriteMeta.imageMap);
      var cellW = spriteMeta.cellW, cellH = spriteMeta.cellH;
      var canvas = document.createElement('canvas');
      var ctx = canvas.getContext('2d', { alpha: false });
      // Sequential is faster than parallel for canvas/toBlob — toBlob queues internally
      // and excessive parallelism just bloats memory without speeding up encoding.
      for (var i = 0; i < entries.length; i++) {
        var name = entries[i];
        var loc = spriteMeta.imageMap[name];
        var sx = loc.col * cellW, sy = loc.row * cellH;
        canvas.width = loc.w; canvas.height = cellH;
        ctx.drawImage(spriteBitmaps[loc.sprite], sx, sy, loc.w, cellH, 0, 0, loc.w, cellH);
        // Use a Promise-wrapped toBlob; Q=0.85 keeps tiles small without visible loss
        var blob = await new Promise(function (res) { canvas.toBlob(res, 'image/jpeg', 0.85); });
        if (blob) blobCache[name] = URL.createObjectURL(blob);
      }
      // Free decoded sprite bitmaps
      for (var s of spriteBitmaps) { try { s.close(); } catch (e) {} }
      var tTotal = performance.now() - t0;
      console.log('[blobcache] ' + entries.length + ' tiles in ' + Math.round(tTotal) + 'ms (fetch+decode: ' + Math.round(tFetch) + 'ms, slice+encode: ' + Math.round(tTotal - tFetch) + 'ms)');
      blobCacheReady = true;
      scheduleRender();   // re-emit with blob URLs
    } catch (e) {
      console.warn('[blobcache] failed:', e);
    } finally {
      blobCacheBuilding = false;
    }
  }

  function renderGallery() {
    var thumbsEl = $('thumbs');
    if (!thumbsEl) return;
    if (lastimagevalue < 1) {
      thumbsEl.innerHTML = '<div style="padding:24px;text-align:center;color:#888">' +
        (window.isadmin ? 'No images yet — upload some via the admin panel.' : 'No images.') +
        '</div>';
      return;
    }
    if (!window.spriteMeta) {
      thumbsEl.innerHTML = '<div style="padding:32px;text-align:center;color:#888">' +
        '<div style="font-size:16px;margin-bottom:8px">Generating thumbnails…</div>' +
        '<div style="font-size:13px">' + lastimagevalue + ' images in this folder</div>' +
        '</div>';
      pollBuildStatus({ reloadOnComplete: true });
      return;
    }
    var H = targetRowHeight(getZoom());
    var rows = layoutRows(H);
    var html = '';
    for (var r = 0; r < rows.length; r++) {
      html += '<div class="row">';
      for (var j = 0; j < rows[r].items.length; j++) {
        var it = rows[r].items[j];
        var name = images[it.index];
        var loc = spriteMeta.imageMap[name];
        var spriteFile = spriteMeta.sprites[loc.sprite].file;
        var spriteURL = folderURL + 'thumbcache/' + spriteFile;
        var scale = it.h / spriteMeta.cellH;
        var bgX = -loc.col * spriteMeta.cellW * scale;
        var bgY = -loc.row * spriteMeta.cellH * scale;
        var bgSizeW = spriteMeta.across * spriteMeta.cellW * scale;
        // Self-contained per-tile <img>: each thumb has its own blob URL (sliced from
        // the atlas in JS). The browser treats it as 800 small independent images rather
        // than 800 references to one big image — Safari/WebKit composites this much more
        // efficiently. Wrapper still does layout sizing; img fills it via width:100%.
        var blobSrc = blobCache[name];
        if (blobSrc) {
          html += '<a class="sprite-thumb solo" href="#' + encodeURIComponent(name) + '" data-i="' + it.index + '" title="' + name + '" ' +
            'style="width:' + it.w + 'px;height:' + it.h + 'px">' +
            '<img src="' + blobSrc + '" alt=""></a>';
        } else {
          // Placeholder: just the wrapper with bg color while blob cache builds
          html += '<a class="sprite-thumb placeholder" href="#' + encodeURIComponent(name) + '" data-i="' + it.index + '" title="' + name + '" ' +
            'style="width:' + it.w + 'px;height:' + it.h + 'px"></a>';
        }
      }
      html += '</div>';
    }
    thumbsEl.classList.add('layout');
    thumbsEl.innerHTML = html;
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
    window.addEventListener('beforeunload', clearBlobCache);

    // Kick off the per-tile blob slicing in the background. Initial render shows
    // placeholder boxes; the slicing pass triggers a re-render when complete.
    if (window.spriteMeta && lastimagevalue > 0) {
      requestIdleCallback ? requestIdleCallback(buildBlobCache, { timeout: 100 }) : setTimeout(buildBlobCache, 16);
    }

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
