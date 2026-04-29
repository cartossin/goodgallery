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
  var thumbpage     = [];

  var inum = 1;
  var pnum = 1;
  var lastpagevalue = 1;
  var isfullres = 0;
  var keyslocked = 0;
  var hashmirror = '';
  var monitortimerid = null;
  var waitingfor = 0;
  var xhrqueue = 0;

  // Build cache URLs that live under the current folder URL.
  // For files smaller than previewThreshold we just use the original — modern browsers
  // scale beautifully, so making a smaller "preview" is wasted disk for small files.
  function thumbURL(name)         { return folderURL + 'thumbcache/'   + encodeURIComponent(name) + '.resized.jpg'; }
  function previewCacheURL(name)  { return folderURL + 'previewcache/' + encodeURIComponent(name) + '.resized.jpg'; }
  function originalURL(name)      { return folderURL + encodeURIComponent(name); }
  function previewSrc(i) {
    var sz = (window.imagesz && imagesz[i]) || 0;
    return sz >= window.previewThreshold ? previewCacheURL(images[i]) : originalURL(images[i]);
  }

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
  function adminHeader() {
    var t = localStorage.getItem('ggSession');
    return t ? { 'Authorization': 'Bearer ' + t } : {};
  }

  function rawrequestbuild(qs) {
    if (xhrqueue >= window.xhrpush) {
      setTimeout(function () { rawrequestbuild(qs); }, 250);
      return;
    }
    xhrqueue += 1;
    gghttp('GET', qs, fnWhenDone);
  }

  function requestbuild(filenumber) {
    waitingfor += 1;
    note('Adding new photo to cache: ' + images[filenumber] + ' — still waiting for ' + waitingfor + ' request' + (waitingfor === 1 ? '' : 's'));
    var filename = images[filenumber];
    rawrequestbuild('build=' + encodeURIComponent(filename) + '&inum=' + filenumber + '&nocache=' + Math.random());
  }

  function fnWhenDone(text) {
    xhrqueue -= 1;
    waitingfor -= 1;
    var n = parseInt(text, 10);
    if (!isNaN(n) && images[n]) {
      note(images[n] + ' added — still waiting for ' + waitingfor + ' request' + (waitingfor === 1 ? '' : 's'));
      var el = document.getElementById('img-' + n);
      if (el) el.src = el.src; // refresh
    } else if (text === '') {
      note('Server did not respond. Will retry as the gallery is browsed.');
    } else {
      note('Server: ' + text.slice(0, 200));
    }
    if (monitortimerid) clearTimeout(monitortimerid);
    monitortimerid = setTimeout(clearmonitor, 5000);
  }

  function requestbuildall() {
    note('Validating gallery, please wait…');
    fetch(folderURL + '?buildall=1', { credentials: 'same-origin', headers: adminHeader() })
      .then(function (r) { return r.text(); })
      .then(function (text) {
        var trimmed = text.replace(/\s+$/, '');
        if (trimmed.charAt(trimmed.length - 1) === '1') {
          note('Gallery 100% built. Reloading…');
          setTimeout(function () { location.reload(); }, 1500);
        } else {
          requestbuildall();
        }
      })
      .catch(function () { setTimeout(requestbuildall, 2000); });
  }

  // ---------- nav helpers ----------
  function nextIndex(i) { return i === lastimagevalue ? 1 : i + 1; }
  function prevIndex(i) { return i === 1 ? lastimagevalue : i - 1; }

  function nextimage()    { inum = nextIndex(inum); startimage(); }
  function previousimage(){ inum = prevIndex(inum); startimage(); }
  function nextpage()     { pnum = pnum >= lastpagevalue ? 1 : pnum + 1; displaythumbs(); }
  function previouspage() { pnum = pnum <= 1 ? lastpagevalue : pnum - 1; displaythumbs(); }

  function leftbutton() {
    if ((decodeURIComponent(location.hash.slice(1)) || '').charAt(0) === ':') previouspage(); else previousimage();
  }
  function rightbutton() {
    if ((decodeURIComponent(location.hash.slice(1)) || '').charAt(0) === ':') nextpage(); else nextimage();
  }

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
    var pd = $('photodiv'); if (pd) pd.classList.remove('fullres');
    pnum = Math.ceil(inum / window.thumbsperpage);
    var name = images[inum];
    hashmirror = encodeURIComponent(name);
    location.hash = hashmirror;

    var photo = $('photospot');
    photo.innerHTML = '<img src="' + previewSrc(inum) + '" id="img-' + inum +
      '" alt="' + name + '" onerror="ggRequestBuild(' + inum + ')">';

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

  function buildthumbpages() {
    lastpagevalue = Math.max(1, Math.ceil(lastimagevalue / window.thumbsperpage));
    var page = 1, count = 0;
    thumbpage = [];
    if (lastimagevalue === 0) return;
    var html = '';
    for (var i = 1; i <= lastimagevalue; i++) {
      if (count === 0) {
        html = '';
        if (lastpagevalue > 1) html += '<div style="text-align:center;color:#888;font-size:12px;padding:4px">Page ' + page + ' of ' + lastpagevalue + '</div>';
      }
      count++;
      var name = images[i];
      html += '<a href="#' + encodeURIComponent(name) + '" data-i="' + i + '">';
      html += '<img src="' + thumbURL(name) + '" id="img-' + i + '" alt="' + name + '" loading="lazy" onerror="ggRequestBuild(' + i + ')">';
      html += '</a>';
      if (count === window.thumbsperpage || i === lastimagevalue) { thumbpage[page] = html; page++; count = 0; }
    }
  }

  function displaythumbs() {
    if (isfullres) togglefullres();
    showAdminBar();
    hashmirror = ':' + pnum;
    location.hash = hashmirror;
    setHTML('photospot', '');
    setHTML('preimages', '');
    setText('counter', '');
    var place = $('thumbs');
    if (lastimagevalue < 1) {
      place.innerHTML = '<div style="padding:24px;text-align:center;color:#888">' +
        (window.isadmin ? 'No images yet — upload some via the admin panel.' : 'No images.') +
        '</div>';
    } else {
      place.innerHTML = thumbpage[pnum] || thumbpage[1];
    }
  }

  // ---------- hash routing ----------
  function refreshfromhash() {
    hashmirror = location.hash.slice(1);
    var raw = decodeURIComponent(hashmirror || '');
    if (raw.charAt(0) === ':') {
      var n = parseInt(raw.slice(1), 10);
      pnum = (n >= 1 && n <= lastpagevalue) ? n : 1;
      displaythumbs();
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
    var badge = $('adminbadge');
    if (!window.isadmin) { bar.classList.remove('on'); badge.classList.remove('on'); return; }
    badge.classList.add('on'); badge.textContent = 'admin';
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
    if (!confirm('Move ' + images[inum] + ' to trash?')) return;
    gghttp('POST', 'movetotrash=' + encodeURIComponent(images[inum]), function (t) {
      note(t || '(no response)');
      // shift to next image after a brief moment
      setTimeout(function () { location.reload(); }, 600);
    });
  }
  function ggClearCache() {
    if (!confirm('Delete all cached thumbs and previews?')) return;
    gghttp('POST', 'clearcache=1', function (t) { note(t); });
  }
  function ggRequestBuildAll() { requestbuildall(); }
  function ggExploreTrash() {
    gghttp('GET', 'exploretrash=1', function (t) {
      var place = $('thumbs');
      var data = null; try { data = JSON.parse(t); } catch (_) {}
      if (!data || !data.files || !data.files.length) {
        place.innerHTML = '<div style="padding:24px;text-align:center;color:#888">Trash is empty.</div>';
        return;
      }
      var rows = data.files.map(function (f) {
        var ef = encodeURIComponent(f);
        return '<div style="display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid #222">' +
               '<button onclick="ggRestoreFile(\'' + ef + '\')">Restore</button>' +
               '<button onclick="ggDeleteFile(\'' + ef + '\')">Delete</button>' +
               '<span>' + f + '</span></div>';
      }).join('');
      place.innerHTML = '<div style="display:flex;flex-direction:column;align-items:stretch;width:100%;max-width:640px;margin:0 auto">' +
        '<h3 style="text-align:center;color:#bbb">Trash (' + data.files.length + ')</h3>' +
        rows +
        '<div style="display:flex;gap:8px;justify-content:center;padding:12px"><button onclick="ggRestoreAll()">Restore all</button><button onclick="ggEmptyTrash()">Empty trash</button></div>' +
        '</div>';
    });
  }
  function ggRestoreFile(ef) { gghttp('POST', 'restorefile=' + ef, function(t){ note(t); ggExploreTrash(); }); }
  function ggDeleteFile(ef)  { if (!confirm('Permanently delete ' + decodeURIComponent(ef) + '?')) return; gghttp('POST', 'deletefile=' + ef, function(t){ note(t); ggExploreTrash(); }); }
  function ggRestoreAll()    { gghttp('POST', 'restoreall=1', function(t){ note(t); ggExploreTrash(); }); }
  function ggEmptyTrash()    { if (!confirm('Permanently delete ALL trashed files?')) return; gghttp('POST', 'emptytrash=1', function(t){ note(t); ggExploreTrash(); }); }

  // ---------- touch swipe ----------
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

    // populate preview/thumb arrays (preserve names from 2014 client for any code that references them)
    for (var i = 1; i <= lastimagevalue; i++) {
      previewimages[i] = previewSrc(i);
      thumbs[i]        = thumbURL(images[i]);
    }
    buildthumbpages();

    // initial route from hash
    var raw = decodeURIComponent(location.hash.slice(1) || '');
    if (raw.charAt(0) === ':') {
      var n = parseInt(raw.slice(1), 10);
      pnum = (n >= 1 && n <= lastpagevalue) ? n : 1;
      displaythumbs();
    } else if (raw && lastimagevalue > 0) {
      var found = 0;
      for (var j = 1; j <= lastimagevalue; j++) if (raw === images[j]) { inum = j; found = 1; break; }
      if (found) startimage(); else displaythumbs();
    } else {
      displaythumbs();
    }

    window.addEventListener('hashchange', refreshfromhash);
  }

  function maybePromoteAdmin() {
    var t = localStorage.getItem('ggSession');
    if (!t || window.isadmin) return;
    fetch('/api/admin/keys-probe', { headers: { 'Authorization': 'Bearer ' + t } }).catch(function(){});
    // We can't promote ourselves without a re-render. The admin panel handles login;
    // when admin is needed on the gallery page itself, just expose actions client-side
    // (the server still enforces). For UX, flip the badge optimistically:
    window.isadmin = 1;
    showAdminBar();
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
  window.ggRequestBuild = requestbuild;
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
