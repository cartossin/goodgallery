// Goodgallery 2.0 client. Vanilla JS, zero deps.
//
// State injected by the server-rendered page:
//   images = [null, "a.jpg", ...]  (1-indexed)
//   lastimagevalue, isadmin, hasPasskey, folderURL, spriteMeta, imagemapURL
//   folderURL and imagemapURL are already %-encoded; use them as they are and
//   encode every name added to them (encodeURIComponent).

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
      if (r.ok) { location.reload(); return; }
      // Expired, already used or mistyped: stay on the gallery, signed out,
      // and say why, or the visitor cannot tell a failed link from a slow one.
      // A dialog, because the top controls hide over a grid of photos.
      var dialog = document.createElement('dialog');
      dialog.textContent = 'This sign-in link is invalid or has expired. A link works once, within 10 minutes of being made. ';
      var form = document.createElement('form');
      form.method = 'dialog';
      var okButton = document.createElement('button');
      okButton.textContent = 'OK';
      form.appendChild(okButton);
      dialog.appendChild(form);
      document.body.appendChild(dialog);
      dialog.showModal();
    }).catch(function () {});
  })();

  var CANONICAL_H = 200;
  var FOCUS_PREFETCH = 3;  // images on each side of focus to keep warm in the bitmap cache.
  // fitAllHeight() is an 18-pass O(N) search; memoize it per viewport size.
  // Its other inputs (images[], spriteMeta.imageMap) are fixed once the
  // imagemap has loaded, and loadImagemap resets the memo.
  var fitAllMemo = { W: -1, H: -1, value: 0 };

  // Binary imagemap format: 'GGMP' (4B) | version u16 LE | reserved u16 |
  // count u32 LE | widths (count × u16 LE) | NUL-terminated UTF-8 names.
  async function loadImagemap() {
    if (!window.imagemapURL) return false;
    var resp = await fetchFromBuild(window.imagemapURL, { credentials: 'same-origin' });
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
      if (pos >= bytes.length) throw new Error('imagemap truncated: ' + i + ' of ' + count + ' names');
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
    fitAllMemo = { W: -1, H: -1, value: 0 };
    return true;
  }

  var GG_DIR = 'gg';
  var focusedIdx = 0;       // 0 = grid view; 1..N = focused image
  var photoListFailed = false;  // the imagemap could not be loaded after all retries


  function $(id) { return document.getElementById(id); }
  function setText(id, t) { var e = $(id); if (e) e.textContent = t; }

  // ---------- failed loads ----------
  // One policy for every load the viewer depends on (the photo list, atlas
  // sheets, per-photo tiles): a failed attempt is tried again after 0.5, 2
  // and 6 seconds; after that the load gives up and the visitor is told.
  // A failure never schedules a redraw, so a load that keeps failing cannot
  // turn into a request loop; the next redraw the visitor causes may try it
  // again.
  var RETRY_DELAYS_MS = [500, 2000, 6000];

  // fetch() for a file of the build the page was rendered from (the photo
  // list, an atlas sheet, a photo's tile); an HTTP error status is a failure.
  // A 404 is not a flaky network: the server removes the previous atlas as
  // soon as a photo is trashed or deleted (it is public, and would keep the
  // photo public), and a removed photo's tiles go with it. So a 404 means
  // the folder has a newer build: the error is marked buildReplaced, is not
  // retried, and the page moves to the new build (noticeBuildReplaced).
  // A file that answered 404 is not asked for again (a redraw would ask for
  // it on every frame until the page has moved to the new build); the rest
  // of the old build is still served meanwhile and keeps being drawn.
  var filesOfReplacedBuild = new Set();
  function fetchFromBuild(url, options) {
    if (filesOfReplacedBuild.has(url)) return Promise.reject(replacedBuildError(url));
    return fetch(url, options).then(function (response) {
      if (response.status === 404) {
        filesOfReplacedBuild.add(url);
        noticeBuildReplaced();
        throw replacedBuildError(url);
      }
      if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
      return response;
    });
  }
  function replacedBuildError(url) {
    var error = new Error('HTTP 404 for ' + url + ': the folder has a newer build');
    error.buildReplaced = true;
    return error;
  }

  // Runs attempt() until it resolves, retrying on rejection with the delays
  // above. Resolves null as soon as `signal` aborts (the load is no longer
  // wanted); rejects with the last error once the retries are used up, and
  // at once for a file of a replaced build (trying again cannot bring it back).
  function withRetries(attempt, signal) {
    return new Promise(function (resolve, reject) {
      var failures = 0;
      function run() {
        if (signal && signal.aborted) { resolve(null); return; }
        attempt().then(resolve, function (err) {
          if (signal && signal.aborted) { resolve(null); return; }
          if (err && err.buildReplaced) { reject(err); return; }
          if (failures >= RETRY_DELAYS_MS.length) { reject(err); return; }
          var timer = setTimeout(run, RETRY_DELAYS_MS[failures]);
          failures++;
          if (signal) signal.addEventListener('abort', function () { clearTimeout(timer); resolve(null); }, { once: true });
        });
      }
      run();
    });
  }

  // A plain message at the bottom of the window, shown once, when a photo or
  // an atlas sheet could not be loaded after all retries. A file of a
  // replaced build is not a load problem: the page moves to the new build,
  // and says so through giveUpOnReplacedBuild() if it cannot.
  var loadProblemShown = false;
  function showLoadProblem(error) {
    if (error && error.buildReplaced) return;
    if (loadProblemShown) return;
    loadProblemShown = true;
    var box = document.createElement('div');
    box.id = 'loadproblem';
    box.setAttribute('role', 'status');
    box.textContent = 'Some photos could not be loaded. Reload the page to try again.';
    box.style.cssText = 'position:fixed; left:50%; bottom:48px; transform:translateX(-50%); z-index:10;' +
      ' max-width:calc(100% - 32px); padding:8px 14px; border-radius:6px; background:#262626; color:#eee;' +
      ' font-size:14px; box-shadow:0 2px 8px rgba(0,0,0,.6);';
    document.body.appendChild(box);
  }

  // ---------- realtime monitor ----------
  function note(msg) {
    var rt = $('realtime');
    if (!rt) return;
    rt.textContent = msg || '';
  }

  // ---------- build status ----------
  // The page watches the folder's build state on the server (?build-status);
  // mutations live in /_admin/. There is one poller per page and one place,
  // onBuildStatus(), that decides what the page says about the build and
  // whether it reloads. Only one request is in flight and at most one timer
  // is pending at a time, so answers are handled in the order they were asked.
  //
  // A page rendered before the folder was built (no atlas yet) waits for the
  // build and reloads when it is done; so does a page whose build was
  // replaced (buildReplaced), and one that just moved a photo to the trash
  // (pendingTrash). Any other page only shows a build in progress in the
  // status line.
  var DEFAULT_BUILD_MESSAGE = 'Building LoD cache…';
  var waitingForFirstBuild = !window.spriteMeta && lastimagevalue > 0;
  var buildReplaced = false;       // a file of the page's build answered 404
  var buildMessage = '';           // what the page says about the build now; '' = nothing
  var buildPoll = {
    timer: null,                   // the next poll, when one is scheduled
    inFlight: false,               // a request is waiting for its answer
    finished: false,               // a final answer came (failed, gone, unreachable); nothing more to ask
    failures: 0,                   // requests in a row that got no answer
    requestsSent: 0,
    firstUsableRequest: 1,         // answers to earlier requests predate a change the page waits on
  };
  // Called with no arguments when the page gives up on a replaced build
  // before it could show anything (its photo list was the file that 404'd).
  var afterReplacedBuildGivenUp = null;

  function reloadIsAwaited() { return waitingForFirstBuild || buildReplaced || trashAwaitsBuild(); }
  // A request that gets no answer (network down, server restarting, an HTTP
  // error) is asked again after these delays; then the page says so and stops.
  var BUILD_STATUS_RETRY_DELAYS_MS = [2000, 4000, 8000, 16000];

  function formatEta(s) {
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    var h = Math.floor(s / 3600);
    var m = Math.round((s - h * 3600) / 60);
    return m === 0 ? h + 'h' : h + 'h ' + m + 'm';
  }

  // Shown in the status line and, on a waiting page, in its box. The box is
  // drawn again by every renderGallery(), which reads buildMessage, so a
  // re-render cannot put the default text back over a later message.
  function setBuildMessage(msg) {
    buildMessage = msg || '';
    note(buildMessage);
    var b = document.getElementById('buildstatus-main');
    if (b) b.textContent = buildMessage || DEFAULT_BUILD_MESSAGE;
  }

  // Starts watching the build, unless the poller is already at it or has
  // had its final answer. Safe to call from every render.
  function watchBuildStatus() {
    if (buildPoll.inFlight || buildPoll.timer || buildPoll.finished) return;
    scheduleBuildStatusPoll(0);
  }

  // Watches again after something changed on the server that the page now
  // waits on: polling starts even if it had stopped, and an answer to a
  // request sent before the change does not count.
  function watchBuildStatusAfterChange() {
    buildPoll.finished = false;
    buildPoll.failures = 0;
    buildPoll.firstUsableRequest = buildPoll.requestsSent + 1;
    if (!buildPoll.inFlight) scheduleBuildStatusPoll(0);
  }

  function scheduleBuildStatusPoll(delayMs) {
    if (buildPoll.timer) clearTimeout(buildPoll.timer);
    buildPoll.timer = setTimeout(requestBuildStatus, delayMs);
  }

  function requestBuildStatus() {
    buildPoll.timer = null;
    buildPoll.inFlight = true;
    var requestNumber = ++buildPoll.requestsSent;
    fetch(folderURL + '?build-status', { credentials: 'same-origin' })
      .then(readBuildStatus)
      .then(function (status) {
        buildPoll.inFlight = false;
        buildPoll.failures = 0;
        if (requestNumber < buildPoll.firstUsableRequest) scheduleBuildStatusPoll(0);
        else onBuildStatus(status);
      }, function () {
        buildPoll.inFlight = false;
        onBuildStatusUnanswered();
      });
  }

  // The server answers 404 when the folder itself is gone (deleted, or moved
  // to the trash with its parent).
  function readBuildStatus(response) {
    if (response.status === 404) return { state: 'gone' };
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  }

  function onBuildStatusUnanswered() {
    if (buildPoll.failures >= BUILD_STATUS_RETRY_DELAYS_MS.length) {
      buildPoll.finished = true;
      setBuildMessage('The server cannot be reached. Reload the page to try again.');
      if (buildReplaced) giveUpOnReplacedBuild();
      return;
    }
    scheduleBuildStatusPoll(BUILD_STATUS_RETRY_DELAYS_MS[buildPoll.failures]);
    buildPoll.failures++;
  }

  // status.state is this folder's own: 'building', 'failed' or 'built', or
  // 'gone' when the folder no longer exists.
  function onBuildStatus(status) {
    if (status.state === 'gone') {
      buildPoll.finished = true;
      setBuildMessage('This folder no longer exists.');
      if (buildReplaced) giveUpOnReplacedBuild();
    } else if (status.state === 'failed') {
      // Stop waiting. A page that shows an earlier build keeps showing it.
      buildPoll.finished = true;
      if (waitingForFirstBuild) setBuildMessage('This folder could not be built.' + (status.error ? ' ' + status.error : ''));
      else if (pendingTrash) setBuildMessage(pendingTrash.name + ' was moved to the trash, but the folder could not be rebuilt.');
      else setBuildMessage('');
      if (buildReplaced) giveUpOnReplacedBuild();
    } else if (status.state === 'built' && pendingTrash) {
      // Built after the trash was accepted (watchBuildStatusAfterChange
      // ignores older answers), so this build no longer has the photo.
      buildPoll.finished = true;
      reloadAfterTrash();
    } else if (pendingTrash && !trashAwaitsBuild()) {
      // Still building after the longest wait: say so and stop.
      buildPoll.finished = true;
      setBuildMessage(trashMessage());
    } else if (status.state === 'building' && status.remaining > 0) {
      var eta = status.etaSeconds != null ? ' — ETA ' + formatEta(status.etaSeconds) : '';
      setBuildMessage(pendingTrash ? trashMessage() : 'Building ' + status.remaining + ' image' + (status.remaining === 1 ? '' : 's') + eta);
      scheduleBuildStatusPoll(5000);
    } else if (reloadIsAwaited() && status.state === 'building') {
      // Its photos are done; the atlas is being made.
      setBuildMessage(pendingTrash ? trashMessage() : 'Finalizing…');
      scheduleBuildStatusPoll(2000);
    } else if (waitingForFirstBuild) {
      buildPoll.finished = true;
      setBuildMessage('Build complete. Reloading…');
      setTimeout(function () { location.reload(); }, 1500);
    } else if (buildReplaced) {
      buildPoll.finished = true;
      reloadOntoCurrentBuild();
    } else {
      setBuildMessage('');
    }
  }

  // ---------- the page's build was replaced ----------
  // A file of the page's build answered 404 (fetchFromBuild): the folder
  // changed. Wait until it is built (never reload while a rebuild runs, or
  // the next page would be replaced again a moment later), then reload at
  // the same URL. The hash keeps the zoom level and the open photo, and the
  // photo at the top of the grid is kept in sessionStorage (persistAnchor).
  function noticeBuildReplaced() {
    if (buildReplaced) return;
    buildReplaced = true;
    watchBuildStatusAfterChange();
  }

  // At most one reload per build: the page remembers which build it reloaded
  // away from, and a page that is handed that same build again (the server
  // keeps serving a build whose files are missing) gives up instead of
  // reloading in a loop.
  function reloadOntoCurrentBuild() {
    var key = 'gg.reloadedFromBuild.' + folderURL;
    var thisBuild = (window.spriteMeta && spriteMeta._atlasDir) || '(flat)';
    try {
      if (sessionStorage.getItem(key) === thisBuild) { giveUpOnReplacedBuild(); return; }
      sessionStorage.setItem(key, thisBuild);
    } catch (_) {
      // No storage to remember it in: no reload, so no loop.
      giveUpOnReplacedBuild();
      return;
    }
    applyPendingHashUpdate();
    location.reload();
  }

  function giveUpOnReplacedBuild() {
    showLoadProblem();
    if (afterReplacedBuildGivenUp) afterReplacedBuildGivenUp();
    afterReplacedBuildGivenUp = null;
  }

  // ---------- nav helpers ----------

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
    if (focusedIdx > 0 && filmstripEl) {
      commandedIdx = next;
      startFocusChase();
    } else {
      location.hash = encodeURIComponent(images[next]);
    }
  }

  // ---------- keys ----------
  function keycheck(e) {
    // Don't hijack typing in inputs / textareas / contenteditable.
    var tn = e.target && e.target.tagName;
    if (tn === 'INPUT' || tn === 'TEXTAREA' || tn === 'SELECT' ||
        (e.target && e.target.isContentEditable)) return;

    var k = e.which || e.keyCode;

    // Grid view: route scroll keys to native browser handling by ensuring
    // #thumbs has focus. We don't preventDefault and we don't scroll ourselves —
    // the browser does it with its native fast animation. If focus drifted
    // (clicked breadcrumb, admin link, etc.) the first keystroke is lost, but
    // subsequent ones (including OS keyrepeat) work because focus is now correct.
    if (focusedIdx === 0 &&
        (k === 33 || k === 34 || k === 35 || k === 36 ||
         (e.metaKey && (k === 38 || k === 40)))) {
      var thumbsEl = document.getElementById('thumbs');
      if (thumbsEl && document.activeElement !== thumbsEl) {
        thumbsEl.focus({ preventScroll: true });
      }
      return;
    }

    var isArrow = (k === 37 || k === 38 || k === 39 || k === 40);
    // Focus mode: arrow keys shift focus. preventDefault blocks the native
    // ~40px arrow-key scroll on the strip that would race with shiftFocus().
    if (focusedIdx > 0 && isArrow) {
      e.preventDefault();
      if (k === 37 || k === 38) leftbutton(); else rightbutton();
    } else if (k === 27 && focusedIdx > 0) {
      e.preventDefault();
      returnToGrid();
    }
  }

  // ---------- view ----------

  // rAF-throttled re-layout: collapses bursts of resize/zoom events into one render per frame.
  var rafPending = false;
  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      renderGallery();
      // Keep zoom-control disabled state synced with the dynamic sort
      // order — fit's effective height changes with the viewport.
      renderZoomControl();
    });
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
    if (fitAllMemo.W === W && fitAllMemo.H === H) return fitAllMemo.value;
    // Upper bound is the viewport height so a few-image gallery can fill the
    // viewport at #fit. Beyond CANONICAL_H the renderer reaches for the h1600
    // tier and the browser upscales — quality cost is mild, layout completeness
    // win is real.
    var lo = 2, hi = Math.max(CANONICAL_H, H);
    for (var i = 0; i < 18; i++) {
      var mid = (lo + hi) / 2;
      var measured = simulateLayoutHeight(mid, W);
      if (measured > H) hi = mid; else lo = mid;
    }
    var value = Math.max(2, lo);
    fitAllMemo = { W: W, H: H, value: value };
    return value;
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
    if (count > 0) totalH += H * lastRowScale(W - rowGap(H) * (count - 1), natRowW) + rowGap(H);
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
  var DEFAULT_LEVEL_NAME = 'fit';
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
    if (location.hash !== newHash) {
      // Each zoom step is a history entry, so Back retraces the steps the
      // same way it does for focus. The hashchange handler renders it.
      location.hash = newHash;
      return;
    }
    scheduleRender();
    renderZoomControl();
  }

  // ZOOM_LEVELS sorted by effective device-px height. fit's h-value
  // resolves to fitAllHeight() * dpr at sort time so its position floats
  // with the viewport. focus is pinned to the end.
  function sortedLevels() {
    var arr = ZOOM_LEVELS.slice();
    var fitH = fitAllHeight() * devicePixelRatio();
    arr.sort(function (a, b) {
      if (a.h === 'focus') return 1;
      if (b.h === 'focus') return -1;
      var ah = a.h == null ? fitH : a.h;
      var bh = b.h == null ? fitH : b.h;
      return ah - bh;
    });
    return arr;
  }

  // Step the current level in the sorted (by effective height) view.
  // -1 → genuinely smaller, +1 → genuinely bigger, regardless of where
  // fit sits in the order this frame.
  function stepLevel(delta) {
    var sorted = sortedLevels();
    var curName = ZOOM_LEVELS[currentLevelIdx] && ZOOM_LEVELS[currentLevelIdx].name;
    if (!curName) return;
    var idx = -1;
    for (var i = 0; i < sorted.length; i++) {
      if (sorted[i].name === curName) { idx = i; break; }
    }
    if (idx < 0) return;
    var next = idx + delta;
    if (next < 0 || next >= sorted.length) return;
    var nextName = sorted[next].name;
    for (var j = 0; j < ZOOM_LEVELS.length; j++) {
      if (ZOOM_LEVELS[j].name === nextName) { setLevel(j); return; }
    }
  }

  // [-] Label [+] in grid mode; [↑] in focus mode.
  function renderZoomControl() {
    var el = document.getElementById('zoomControl');
    if (!el) return;
    if (focusedIdx > 0) {
      el.innerHTML = '<button class="zoom-back" title="Up to gallery" aria-label="Up to gallery">↑</button>';
      el.querySelector('button').addEventListener('click', returnToGrid);
      return;
    }
    var levels = availableLevels();
    var idx = currentLevelIdx;
    if (idx < 0) idx = 0;
    if (idx > levels.length - 1) idx = levels.length - 1;
    var name = levels[idx].name;
    // Disable [-] only when current level is the smallest by effective
    // height (per the dynamic sort). [+] stays enabled — past size6 it
    // walks into focus, which is the up-arrow behavior the user expects.
    var sorted = sortedLevels();
    var sortedIdx = 0;
    for (var i = 0; i < sorted.length; i++) {
      if (sorted[i].name === name) { sortedIdx = i; break; }
    }
    el.innerHTML =
      '<button class="zoom-minus" title="Zoom out"' + (sortedIdx === 0 ? ' disabled' : '') + '>−</button>' +
      '<span class="zoom-label">' + name + '</span>' +
      '<button class="zoom-plus" title="Zoom in">+</button>';
    var minus = el.querySelector('.zoom-minus');
    var plus = el.querySelector('.zoom-plus');
    if (minus) minus.addEventListener('click', function () { stepLevel(-1); });
    if (plus) plus.addEventListener('click', function () { stepLevel(+1); });
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

  // The last row keeps its natural size (stretching a half-empty row would
  // blow it up), except that it shrinks to fit when its photos are wider than
  // the window: one wide photo at the largest zoom on a phone.
  function lastRowScale(contentW, natRowW) {
    return Math.min(1, contentW / Math.max(1, natRowW));
  }

  function finalizeRow(items, natRowW, H, W, isLast) {
    var contentW = W - rowGap(H) * Math.max(0, items.length - 1);
    var rowScale = isLast ? lastRowScale(contentW, natRowW) : Math.min(1.5, contentW / Math.max(1, natRowW));
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
  var pendingHash = null;
  function scheduleHashUpdate(newHash) {
    if (pendingHashTimer) clearTimeout(pendingHashTimer);
    pendingHash = newHash;
    pendingHashTimer = setTimeout(applyPendingHashUpdate, 200);
  }
  // Also called at once before a reload, so the reloaded page opens where
  // the visitor is, not where the URL was 200 ms ago.
  function applyPendingHashUpdate() {
    if (pendingHashTimer) clearTimeout(pendingHashTimer);
    pendingHashTimer = null;
    if (pendingHash === null) return;
    var hash = pendingHash;
    pendingHash = null;
    try { history.replaceState(null, '', hash); } catch (_) {}
  }

  // Per-atlas-height ImageBitmap cache (h5/h10/h50, loaded lazily).
  // Sync mirror so drag-paint can blit prev/next without a microtask hop.
  var atlasBitmapsSync = {};
  // Test hook for the headless memory harness (counts live bitmap refs per
  // atlas tier). A reference to existing state, no per-frame cost.
  window.__memdbg = {
    spriteRefCount: function (atlasH) {
      var arr = atlasBitmapsSync[String(atlasH)] || [];
      var n = 0;
      for (var i = 0; i < arr.length; i++) if (arr[i]) n++;
      return n;
    },
    perImageBitmapCount: function () { return perImageBitmapsSync.size; },
    perImageTextureCount: function () { return perImageTextures.size; },
    mainSrcHeight: function () { return mainDrawSrc ? mainDrawSrc.sh : null; },
    perImageTextureKeys: function () { return Array.from(perImageTextures); },
    perImageBitmapKeys: function () { return Array.from(perImageBitmapsSync.keys()); },
    // Which view is showing and whether the film strip is still animating,
    // for the navigation checks.
    viewer: function () {
      return { focusedIdx: focusedIdx, commandedIdx: commandedIdx, chasing: focusChaseRaf !== null };
    },
    // Scroll mapping: layout height, spacer height, ratio, the layout y at
    // the viewport top and the photo whose row is there.
    layout: function () {
      var thumbsEl = $('thumbs');
      var top = thumbsEl ? viewTop(thumbsEl) : 0;
      var t = tileAtTop(top);
      return { totalLayoutH: totalLayoutH, spacerH: spacerEl ? parseFloat(spacerEl.style.height) : 0,
        scrollRatio: scrollRatio, scaled: scrollScaled, viewTop: top, topTile: t ? t.name : null };
    },
    // Grid layout: the tile rects in layout coordinates.
    tiles: function () {
      return lastTileRects.map(function (t) { return { x: t.x, y: t.y, w: t.w, h: t.h, name: t.name }; });
    },
    // Per-image grid tiles with their ideal-tier texture ready, split into
    // on-screen and whole-buffer counts. Lets a harness time "visible done".
    // On-screen tiles the current draw path would put content under (any
    // per-image tier, or an atlas sprite on the GPU), vs the on-screen total.
    // Lets a harness count black tiles while scrolling fast.
    // Histogram of the best source on the GPU per on-screen tile: per-image
    // tier height, atlas tier height, or 0 for nothing. Times each rung of
    // the quality ladder after a jump.
    // Per-image mode: histogram of the tier each on-screen tile was DRAWN at
    // by the last grid draw (a loaded texture the canvas hasn't shown yet
    // does not count). Null in atlas mode.
    visibleDrawnTiers: function () {
      var thumbsEl = $('thumbs');
      if (!thumbsEl || !canvasEl || pickAtlasHeight(currentRowHeight * devicePixelRatio()) != null) return null;
      var top = viewTop(thumbsEl), bot = top + thumbsEl.clientHeight;
      var hist = {};
      for (var i = firstTileIndexAtOrBelow(top); i < lastTileRects.length; i++) {
        var t = lastTileRects[i];
        if (t.y > bot) break;
        var tier = drawnTierByName.has(t.name) ? drawnTierByName.get(t.name) : 0;
        hist[tier] = (hist[tier] || 0) + 1;
      }
      return hist;
    },
    visibleTiers: function () {
      var thumbsEl = $('thumbs');
      if (!thumbsEl || !canvasEl) return null;
      var top = viewTop(thumbsEl), bot = top + thumbsEl.clientHeight;
      var hist = {};
      for (var i = firstTileIndexAtOrBelow(top); i < lastTileRects.length; i++) {
        var t = lastTileRects[i];
        if (t.y > bot) break;
        var best = bestTexturedPerImageTier(t.name);
        if (!best) {
          var loc = spriteMeta.imageMap[t.name];
          var tiers = ['100', '50', '10', '5'];
          for (var k = 0; k < tiers.length && loc; k++) {
            var atlas = spriteMeta.atlases[tiers[k]];
            if (atlas && gridRenderer.hasTexture(tiers[k] + ':' + Math.floor(loc.idx / atlas.cellsPerSprite))) { best = parseInt(tiers[k], 10); break; }
          }
        }
        hist[best] = (hist[best] || 0) + 1;
      }
      return hist;
    },
    visibleCoverage: function () {
      var thumbsEl = $('thumbs');
      if (!thumbsEl || !canvasEl) return null;
      var top = viewTop(thumbsEl), bot = top + thumbsEl.clientHeight;
      var targetH = currentRowHeight * devicePixelRatio();
      var atlasH = pickAtlasHeight(targetH);
      var tierH = pickPerImageTier(targetH);
      var floorKey = floorAtlasKey();
      var r = { lit: 0, sharp: 0, total: 0, mode: atlasH != null ? 'atlas' + atlasH : 'perimage' + tierH, floor: floorKey };
      for (var i = firstTileIndexAtOrBelow(top); i < lastTileRects.length; i++) {
        var t = lastTileRects[i];
        if (t.y > bot) break;
        r.total++;
        var sharp, lit;
        if (atlasH != null) {
          var loc = spriteMeta.imageMap[t.name];
          sharp = !!loc && gridRenderer.hasTexture(atlasH + ':' + Math.floor(loc.idx / spriteMeta.atlases[String(atlasH)].cellsPerSprite));
          lit = sharp || (!!floorKey && pushAtlasFallback(new Map(), t, [floorKey]));
        } else {
          // Sharp: the tier this tile wants is on the GPU (a tile no tier
          // fits, a panorama, is as sharp as it gets once it is lit).
          var tileTier = perImageTierForTile(t, devicePixelRatio());
          lit = bestTexturedPerImageTier(t.name) > 0 || pushAtlasFallback(new Map(), t, ['50', '10', '5']) > 0;
          sharp = tileTier ? perImageTextures.has(t.name + '|' + tileTier) : lit;
        }
        if (sharp) r.sharp++;
        if (lit) r.lit++;
      }
      return r;
    },
    perImageProgress: function () {
      var thumbsEl = $('thumbs');
      if (!thumbsEl || !canvasEl) return null;
      var top = viewTop(thumbsEl), bot = top + thumbsEl.clientHeight;
      var r = { visibleDone: 0, visibleTotal: 0, bufferDone: 0, bufferTotal: 0 };
      for (var i = firstTileIndexAtOrBelow(bufferTop); i < lastTileRects.length; i++) {
        var t = lastTileRects[i];
        if (t.y > bufferTop + bufferH) break;
        var done = perImageTextures.has(t.name + '|' + perImageTierForTile(t, devicePixelRatio())) ? 1 : 0;
        r.bufferTotal++; r.bufferDone += done;
        if (t.y + t.h >= top && t.y <= bot) { r.visibleTotal++; r.visibleDone += done; }
      }
      return r;
    },
  };
  // ---- per-image loads --------------------------------------------------
  // Tiles above the largest atlas tier are fetched one AVIF per image. Two
  // consumers want different things from the decoded ImageBitmap:
  //   grid  → a GL texture. The bitmap is closed right after upload; the
  //           grid never reads it again, and keeping it doubled the memory
  //           of every large tile.
  //   focus → the bitmap itself, drawn through the 2D main canvas.
  // Both share one fetch/decode queue. Keys are `${name}|${tierH}`.
  var perImageTextures = new Set();       // keys whose texture is on the GPU
  var perImageTexturesRefused = new Set(); // keys the GPU could not take (too large)
  var perImageBitmapsSync = new Map();    // key -> open ImageBitmap (focus)
  var perImageTextureLoads = new Map();   // key -> job, in-progress only
  var perImageBitmapLoads = new Map();    // key -> job, in-progress only
  // Names currently considered "warm" by the visible-buffer / focus-prefetch
  // logic. Updated by drawGridPerImage (grid) and prefetchFilmstripVisible
  // (focus); checked when a load completes so a tile the user has already
  // scrolled past is dropped on arrival instead of waiting for eviction.
  var warmPerImageNames = new Set();
  var currentRowHeight = 200;
  var lastTileRects = [];              // [{x, y, w, h, name}] in layout coords
  var canvasEl = null;
  var spacerEl = null;
  var canvasClickAttached = false;
  var thumbsScrollAttached = false;

  // On-demand per-sprite loading avoids whole-atlas decode spikes that crash
  // iOS Safari on large galleries.
  var spriteLoads = {};  // tier key -> { spriteIdx -> { ctrl, promise } }, in progress or done

  // Fetch + decode one sprite. Resolves null if `signal` was aborted, even
  // after the bytes arrived: the decode is skipped when the abort came
  // first, and closed when it came during the decode.
  // Failed attempts are retried (withRetries); rejects once they give up.
  function fetchSpriteBitmap(atlas, spriteIdx, signal) {
    var url = folderURL + GG_DIR + '/' + atlas.sprites[spriteIdx].file;
    return withRetries(function () {
      return fetchFromBuild(url, { credentials: 'same-origin', signal: signal })
        .then(function (r) { return r.blob(); })
        .then(function (b) { return signal && signal.aborted ? null : createImageBitmap(b); });
    }, signal).then(function (bm) {
      if (bm && signal && signal.aborted) { closeBitmap(bm); return null; }
      return bm;
    });
  }

  // ---- floor tier --------------------------------------------------------
  // The smallest atlas tier stays on the GPU for the whole gallery, so a
  // tile has something to draw the instant it scrolls into view however
  // fast the scrollbar is flicked; the real tier lands on top of it. Its
  // bitmaps are closed after upload (a context swap refetches from the HTTP
  // cache). A tier whose cells are too wide to afford is skipped.
  var FLOOR_MAX_BYTES = 48 * 1024 * 1024;  // 100k images at 4:1 h5 cells = 40 MB
  var floorTierKey;                       // undefined until decided; null = none affordable
  var floorSpritesLoading = new Set();

  function atlasDecodedBytes(atlas) {
    var bytes = 0;
    for (var i = 0; i < atlas.sprites.length; i++) {
      bytes += atlas.across * atlas.cellW * Math.ceil(atlas.sprites[i].count / atlas.across) * atlas.cellH * 4;
    }
    return bytes;
  }

  function floorAtlasKey() {
    if (floorTierKey !== undefined) return floorTierKey;
    floorTierKey = null;
    var keys = Object.keys(spriteMeta.atlases).sort(function (a, b) { return a - b; });
    if (keys.length && atlasDecodedBytes(spriteMeta.atlases[keys[0]]) <= FLOOR_MAX_BYTES) floorTierKey = keys[0];
    return floorTierKey;
  }

  function requestFloorSprites() {
    var key = floorAtlasKey();
    if (!key || !gridRenderer.available()) return;
    var atlas = spriteMeta.atlases[key];
    for (var i = 0; i < atlas.sprites.length; i++) {
      if (gridRenderer.hasTexture(key + ':' + i) || floorSpritesLoading.has(i)) continue;
      loadFloorSprite(key, atlas, i);
    }
  }

  function loadFloorSprite(key, atlas, spriteIdx) {
    floorSpritesLoading.add(spriteIdx);
    fetchSpriteBitmap(atlas, spriteIdx).then(function (bm) {
      floorSpritesLoading.delete(spriteIdx);
      gridRenderer.uploadSprite(key + ':' + spriteIdx, bm);
      closeBitmap(bm);
      // First content for any tile that had nothing — redraw now. (Only if
      // the upload took: a redraw with no texture would just refetch.)
      if (canvasEl && gridRenderer.hasTexture(key + ':' + spriteIdx)) scheduleGridRedraw();
    }, function (err) {
      floorSpritesLoading.delete(spriteIdx);
      showLoadProblem(err);
    });
  }

  // Dynamic batches drawing, from the floor tier, every buffered tile whose
  // active-tier sprite is not on the GPU yet.
  function floorBatchesForMissingSprites(aKey, needed) {
    var floorKey = floorAtlasKey();
    if (!floorKey || floorKey === aKey) return [];
    var missing = new Set();
    needed.forEach(function (spIdx) {
      if (!gridRenderer.hasTexture(aKey + ':' + spIdx)) missing.add(spIdx);
    });
    if (!missing.size) return [];
    var atlas = spriteMeta.atlases[aKey];
    var batchAccum = new Map();
    var bufBot = bufferTop + bufferH;
    for (var i = firstTileIndexAtOrBelow(bufferTop); i < lastTileRects.length; i++) {
      var t = lastTileRects[i];
      if (t.y > bufBot) break;
      var loc = spriteMeta.imageMap[t.name];
      if (loc && missing.has(Math.floor(loc.idx / atlas.cellsPerSprite))) pushAtlasFallback(batchAccum, t, [floorKey]);
    }
    return batchesFromAccum(batchAccum);
  }

  function loadSpriteAt(atlasH, spriteIdx) {
    var key = String(atlasH);
    if (!spriteLoads[key]) spriteLoads[key] = {};
    var job = spriteLoads[key][spriteIdx];
    if (job) return job.promise;
    var atlas = window.spriteMeta && spriteMeta.atlases && spriteMeta.atlases[key];
    if (!atlas || !atlas.sprites[spriteIdx]) return Promise.resolve(null);
    if (!atlasBitmapsSync[key]) atlasBitmapsSync[key] = new Array(atlas.sprites.length).fill(null);
    var ctrl = new AbortController();
    job = { ctrl: ctrl, promise: null };
    job.promise = fetchSpriteBitmap(atlas, spriteIdx, ctrl.signal).then(function (bm) {
      if (!bm) return null;  // evicted before it arrived
      atlasBitmapsSync[key][spriteIdx] = bm;
      gridRenderer.uploadSprite(key + ':' + spriteIdx, bm);
      return bm;
    }, function (err) {
      // Given up after the retries: forget the job, so a later redraw the
      // visitor causes (a scroll, a zoom) can try the sheet again.
      if (spriteLoads[key][spriteIdx] === job) delete spriteLoads[key][spriteIdx];
      showLoadProblem(err);
      throw err;
    });
    spriteLoads[key][spriteIdx] = job;
    return job.promise;
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

  // Loads are queued and started in priority order (lowest number first):
  // the grid passes each tile's distance from the viewport, so on-screen
  // tiles are fetched and decoded before the rest of the buffer. The
  // in-flight cap is what gives the ordering teeth — with everything in
  // flight at once, bandwidth and decode time are shared evenly and the
  // visible rows finish no sooner than the off-screen ones. It also keeps a
  // size3 grid load (hundreds of tiles kicked off in one frame) clear of
  // Chrome's ERR_INSUFFICIENT_RESOURCES fetch cap. Each fetch has its own
  // AbortController so a scroll that moves past the target cancels the
  // in-flight download AND discards still-queued requests for it.
  var PER_IMAGE_MAX_INFLIGHT = 12;
  // Per-photo tiles are cached forever by URL. The server changes tileVersion
  // when a photo's name may mean different pixels, which makes these new URLs.
  var tileQuery = window.tileVersion ? '?v=' + window.tileVersion : '';
  var perImageQueue = [];               // jobs waiting for an in-flight slot
  var perImageInFlight = new Set();     // jobs fetching/decoding right now
  var perImagePumpScheduled = false;
  // job: { key, wantBitmap, priority, url, ctrl, resolve, promise }

  function imageNameOfKey(key) { return key.slice(0, key.lastIndexOf('|')); }
  function closeBitmap(bm) {
    try { if (bm && typeof bm.close === 'function') bm.close(); } catch (_) {}
  }
  function _perImageLoads(wantBitmap) { return wantBitmap ? perImageBitmapLoads : perImageTextureLoads; }
  // Layout px between a tile and the viewport; 0 when any part is on screen.
  function distanceFromViewport(t, scrollY, viewportH) {
    if (t.y + t.h < scrollY) return scrollY - (t.y + t.h);
    if (t.y > scrollY + viewportH) return t.y - (scrollY + viewportH);
    return 0;
  }
  // True if the texture is on the GPU. A tile the GPU refuses (wider than
  // its texture limit) is remembered, so the grid uses a smaller tier or the
  // atlas for it instead of fetching it again.
  function _installPerImageTexture(key, bm) {
    if (!gridRenderer.uploadSprite('img:' + key, bm)) {
      if (gridRenderer.available()) perImageTexturesRefused.add(key);
      return false;
    }
    perImageTextures.add(key);
    return true;
  }

  function _runPerImageJob(job) {
    if (job.ctrl && job.ctrl.signal.aborted) {
      // Got cancelled while waiting in the queue — nothing to fetch.
      _perImageLoads(job.wantBitmap).delete(job.key);
      job.resolve(null);
      return;
    }
    perImageInFlight.add(job);
    // Priority hint for the browser's own request queue (HTTP/1.1 connection
    // limits, HTTP/2 stream weights); ignored where unsupported.
    var fetchOpts = { credentials: 'same-origin', priority: job.priority === 0 ? 'high' : 'low' };
    if (job.ctrl) fetchOpts.signal = job.ctrl.signal;
    withRetries(function () {
      return fetchFromBuild(job.url, fetchOpts)
        .then(function (r) { return r.blob(); })
        // Cancelled after the bytes arrived: skip the decode, it's the expensive part.
        .then(function (b) { return job.ctrl && job.ctrl.signal.aborted ? null : createImageBitmap(b); });
    }, job.ctrl && job.ctrl.signal)
      .catch(function (err) { showLoadProblem(err); return null; })
      .then(function (bm) {
        perImageInFlight.delete(job);
        _perImageLoads(job.wantBitmap).delete(job.key);
        if (bm && !warmPerImageNames.has(imageNameOfKey(job.key))) {
          // User moved on during the load — drop it here rather than leaving
          // it for the next eviction pass.
          closeBitmap(bm);
          bm = null;
        }
        if (!bm) {
          job.resolve(null);              // aborted, failed, or no longer wanted
        } else if (job.wantBitmap) {
          perImageBitmapsSync.set(job.key, bm);
          job.resolve(bm);
        } else {
          var installed = _installPerImageTexture(job.key, bm);
          closeBitmap(bm);
          job.resolve(installed ? true : null);
        }
        _pumpPerImageQueue();
      });
  }
  function _pumpPerImageQueue() {
    if (!perImageQueue.length) return;
    perImageQueue.sort(function (a, b) { return a.priority - b.priority; });
    while (perImageInFlight.size < PER_IMAGE_MAX_INFLIGHT && perImageQueue.length) {
      _runPerImageJob(perImageQueue.shift());
    }
  }
  // A grid redraw queues a whole buffer's worth of loads in one go; pumping
  // once afterwards (microtask) lets them all sort together before any start.
  function _schedulePerImagePump() {
    if (perImagePumpScheduled) return;
    perImagePumpScheduled = true;
    Promise.resolve().then(function () {
      perImagePumpScheduled = false;
      _pumpPerImageQueue();
    });
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
      _perImageLoads(job.wantBitmap).delete(job.key);
      job.resolve(null);
    }
    perImageQueue = kept;
    perImageInFlight.forEach(function (job) {
      if (!keepKeys.has(job.key) && job.ctrl) try { job.ctrl.abort(); } catch (_) {}
    });
    _pumpPerImageQueue();
  }
  function _startPerImageLoad(name, tierH, wantBitmap, priority) {
    var key = name + '|' + tierH;
    var loads = _perImageLoads(wantBitmap);
    var job = loads.get(key);
    if (job) {
      // Already queued or in flight; a closer request bumps its priority.
      if (priority < job.priority) job.priority = priority;
      return job.promise;
    }
    job = {
      key: key, wantBitmap: wantBitmap, priority: priority, ctrl: null, resolve: null, promise: null,
      url: folderURL + GG_DIR + '/' + encodeURIComponent(name) + '.h' + tierH + '.avif' + tileQuery,
    };
    job.promise = new Promise(function (res) { job.resolve = res; });
    if (typeof AbortController !== 'undefined') job.ctrl = new AbortController();
    loads.set(key, job);
    perImageQueue.push(job);
    _schedulePerImagePump();
    return job.promise;
  }
  // Grid: resolves true once `name` at `tierH` has a texture on the GPU,
  // null if the load was cancelled or failed. `priority` is the tile's
  // distance from the viewport in layout px (0 = on screen).
  function loadPerImageTexture(name, tierH, priority) {
    var key = name + '|' + tierH;
    if (perImageTextures.has(key)) return Promise.resolve(true);
    var bm = perImageBitmapsSync.get(key);
    if (bm) {
      // Focus mode already decoded this one (leaving focus back to the grid).
      return Promise.resolve(_installPerImageTexture(key, bm) ? true : null);
    }
    return _startPerImageLoad(name, tierH, false, priority);
  }
  // Focus: resolves with an open ImageBitmap that stays in perImageBitmapsSync
  // until evicted, null if the load was cancelled or failed.
  function loadPerImageBitmap(name, tierH) {
    var bm = perImageBitmapsSync.get(name + '|' + tierH);
    if (bm) return Promise.resolve(bm);
    return _startPerImageLoad(name, tierH, true, 0);
  }
  function getPerImageBitmapSync(name, tierH) {
    return perImageBitmapsSync.get(name + '|' + tierH) || null;
  }

  // Drop per-image textures and bitmaps whose image name isn't in warmNames.
  // ImageBitmap pixel data lives outside the JS heap; without close() it stays
  // pinned even after the Map entry is gone. Never close the bitmap that
  // mainDrawSrc currently references — paintMain can fire after eviction and
  // would crash with "image source is detached" on the closed handle.
  function evictPerImage(warmNames) {
    var pinned = (mainDrawSrc && mainDrawSrc.bitmap) || null;
    var deadKeys = [];
    perImageBitmapsSync.forEach(function (bm, key) {
      if (warmNames.has(imageNameOfKey(key))) return;
      if (bm === pinned) return;
      deadKeys.push(key);
    });
    deadKeys.forEach(function (key) {
      closeBitmap(perImageBitmapsSync.get(key));
      perImageBitmapsSync.delete(key);
    });
    deadKeys = [];
    perImageTextures.forEach(function (key) {
      if (!warmNames.has(imageNameOfKey(key))) deadKeys.push(key);
    });
    deadKeys.forEach(function (key) {
      gridRenderer.deleteTexture('img:' + key);
      perImageTextures.delete(key);
    });
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
  //   gridRenderer.beginFrame(...)       — clear + bind state; false if no GL
  //   gridRenderer.drawStatic(batches)   — pre-uploaded instance buffers
  //   gridRenderer.drawDynamic(batches)  — per-frame instance arrays
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
    var failed = false;              // no WebGL2 here: the grid cannot be drawn
    var contextLost = false;         // the GPU dropped the context; waiting for it back
    var maxTextureSize = 0;

    // aDstRect.y is the tile's WORLD y (layout coord, relative to glOriginY
    // in a very tall layout). uTopOffset is the world y of the canvas top on
    // the same basis; the shader subtracts to get canvas-local pixels. This
    // lets atlas mode pre-upload a single static instance buffer per
    // (atlasH, sprite) and re-draw with just one uniform update.
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
        maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

        attachedCanvas = canvas;
        contextLost = false;
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

    function available() { return !failed && !contextLost && gl !== null; }
    function unsupported() { return failed; }

    // Largest texture side this GPU takes (8192 on many phones and on
    // Chrome's software renderer); a generous guess before the first context.
    function maxTextureSide() { return maxTextureSize || 16384; }

    // True if the texture is on the GPU. A bitmap wider or taller than the
    // GPU allows would fail with INVALID_VALUE and draw black; it is refused
    // here and nothing is recorded, so the caller falls back to a smaller
    // source. (Checking the size up front avoids gl.getError(), which waits
    // for the GPU on every upload.)
    function uploadSprite(key, bitmap) {
      if (!available() || !bitmap) return false;
      if (textures.has(key)) return true;
      if (bitmap.width > maxTextureSize || bitmap.height > maxTextureSize) return false;
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      textures.set(key, { tex: tex, w: bitmap.width, h: bitmap.height });
      return true;
    }

    // The GPU dropped the context (driver reset, GPU switch). Every texture
    // and buffer went with it; forget them until the context comes back.
    function loseContext() {
      contextLost = true;
      textures.clear();
      staticBuffers.clear();
    }
    // The context is back: build the program and buffers again on the same
    // canvas. The caller uploads the textures again.
    function restoreContext() {
      var canvas = attachedCanvas;
      gl = null; program = null; quadVBO = null; dynInstVBO = null;
      attachedCanvas = null;
      return init(canvas);
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

    // A frame is beginFrame() followed by any mix of drawStatic()/drawDynamic().
    function beginFrame(viewportW, viewportH, dpr, topOffset) {
      if (!available()) return false;
      bindCommonState(viewportW, viewportH, dpr, topOffset);
      return true;
    }

    // Dynamic batches: { textureKey, instances: Float32Array }. Used where
    // the per-tile texture varies and instances are rebuilt when the buffer
    // window moves: per-image mode, and the floor under missing sprites.
    function drawDynamic(batches) {
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
    function drawStatic(batches) {
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
      attach: attach, available: available, unsupported: unsupported, uploadSprite: uploadSprite,
      maxTextureSide: maxTextureSide, loseContext: loseContext, restoreContext: restoreContext,
      releaseAll: releaseAll, deleteTexture: deleteTexture,
      uploadStatic: uploadStatic, dropStatic: dropStatic,
      releaseAllStatic: releaseAllStatic, hasStatic: hasStatic,
      beginFrame: beginFrame, drawStatic: drawStatic, drawDynamic: drawDynamic,
      hasTexture: hasTexture,
    };
  })();

  // Best already-loaded atlas source for `name` (h50 → h10 → h5).
  // Where image `loc` sits in its sprite, in sprite pixels. The stored
  // thumbnail fits within (cellW, cellH) at its own aspect, top-left aligned,
  // leftover area black — the same rule as fitInCell() in the server's
  // sprite_worker.js. Sampling outside the stored rect reads padding or the
  // neighbouring cell, so every reader of a sprite goes through this.
  function atlasCellRect(loc, atlas) {
    var spIdx = Math.floor(loc.idx / atlas.cellsPerSprite);
    var posInSprite = loc.idx % atlas.cellsPerSprite;
    var aspect = loc.w / CANONICAL_H;
    var naturalW = aspect * atlas.cellH;
    var sw, sh;
    if (naturalW > atlas.cellW) {
      sw = atlas.cellW;
      sh = Math.max(1, Math.round(atlas.cellW / aspect));
    } else {
      sw = Math.max(1, Math.round(naturalW));
      sh = atlas.cellH;
    }
    return {
      spIdx: spIdx,
      sx: (posInSprite % atlas.across) * atlas.cellW,
      sy: Math.floor(posInSprite / atlas.across) * atlas.cellH,
      sw: sw,
      sh: sh,
      spriteW: atlas.across * atlas.cellW,
      spriteH: Math.ceil(atlas.sprites[spIdx].count / atlas.across) * atlas.cellH,
    };
  }

  // Best decoded sprite cell for `name` across the small atlas tiers, or null.
  function bestCachedAtlasSrc(name) {
    if (!window.spriteMeta || !spriteMeta.atlases) return null;
    var loc = spriteMeta.imageMap && spriteMeta.imageMap[name];
    if (!loc) return null;
    var heights = ['50', '10', '5'];
    for (var hi = 0; hi < heights.length; hi++) {
      var atlas = spriteMeta.atlases[heights[hi]];
      var bitmaps = atlasBitmapsSync[heights[hi]];
      if (!atlas || !bitmaps) continue;
      var cell = atlasCellRect(loc, atlas);
      var bitmap = bitmaps[cell.spIdx];
      if (!bitmap) continue;
      return { bitmap: bitmap, sx: cell.sx, sy: cell.sy, sw: cell.sw, sh: cell.sh };
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
  var atlasInstancesOriginY = 0;      // glOriginY the instance y values are relative to
  var pendingReposition = false;
  var BUFFER_VIEWPORTS = 5;
  var EDGE_MARGIN_FRAC = 0.5;

  // ---- scroll height cap ----
  // Browsers cap how tall an element can be: Chrome and Safari at about
  // 33,554,400 px, and Firefox ignores a height above 17,895,697 px. The
  // layout of a big folder at a large zoom is taller than that (100,000
  // photos at #size6 is about 99 million px), so its end would be out of
  // reach. Above MAX_SCROLL_HEIGHT the spacer is capped at that height and
  // the scroll position maps to the layout through scrollRatio; below it
  // the ratio is exactly 1 and nothing changes. Every read or write of
  // #thumbs.scrollTop goes through the two helpers below.
  var MAX_SCROLL_HEIGHT = 16000000;
  var scrollRatio = 1;        // layout px per scroll px
  var scrollScaled = false;   // true when the spacer is capped

  // Layout y at the top of the viewport for a scrollTop.
  function layoutYFromScrollTop(scrollTop) {
    return scrollScaled ? scrollTop * scrollRatio : scrollTop;
  }
  // scrollTop that puts layout y at (or just past) the viewport top. Rounded
  // up, so the photo whose row starts at y is the one at the top.
  function scrollTopFromLayoutY(y) {
    return scrollScaled ? Math.ceil(y / scrollRatio) : y;
  }
  // Layout y at the top of the viewport now.
  function viewTop(thumbsEl) {
    return layoutYFromScrollTop(thumbsEl.scrollTop);
  }

  // Positions reach the GPU as 32-bit floats, which lose sub-pixel precision
  // above about 4 million (and whole pixels above 16.7 million). In a layout
  // taller than PRECISE_LAYOUT_H every y sent to the GPU is relative to
  // glOriginY, a multiple of GL_ORIGIN_STEP near the canvas top; in a shorter
  // layout the origin is 0 and the values are the layout values themselves.
  var PRECISE_LAYOUT_H = 4194304;  // 2^22
  var GL_ORIGIN_STEP = 1048576;    // 2^20
  var glOriginY = 0;
  function glOriginFor(canvasTop) {
    if (totalLayoutH <= PRECISE_LAYOUT_H) return 0;
    return Math.floor(canvasTop / GL_ORIGIN_STEP) * GL_ORIGIN_STEP;
  }

  // Coalesce redraw requests into one drawCanvasForScroll per animation frame.
  function scheduleGridRedraw() {
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
    canvasEl.addEventListener('webglcontextlost', onGridContextLost);
    canvasEl.addEventListener('webglcontextrestored', onGridContextRestored);
    if (!thumbsScrollAttached) {
      thumbsEl.addEventListener('scroll', onThumbsScroll, { passive: true });
      thumbsScrollAttached = true;
    }
    bufferTop = -1;
    atlasInstancesBuiltFor = null;
    // Mode swap creates a fresh canvas → fresh GL context → textures are gone.
    // Atlas sprites re-upload from their kept bitmaps. Per-image textures had
    // their bitmaps closed at upload, so forget them and let the grid fetch
    // again (served from the HTTP cache); floor sprites refetch the same
    // way, on the next draw. Static instance buffers are
    // per-context too — drop them so renderGallery rebuilds for the new context.
    if (gridRenderer.attach(canvasEl)) reuploadAfterNewContext();
  }

  // A new or restored GL context has no textures. Atlas sprites re-upload
  // from their kept bitmaps; per-image textures and floor sprites are
  // fetched again on the next draw (from the HTTP cache).
  function reuploadAfterNewContext() {
    Object.keys(atlasBitmapsSync).forEach(function (k) {
      var arr = atlasBitmapsSync[k];
      for (var i = 0; i < arr.length; i++) {
        if (arr[i]) gridRenderer.uploadSprite(k + ':' + i, arr[i]);
      }
    });
    perImageTextures.clear();
    perImageTexturesRefused.clear();
    atlasInstancesBuiltFor = null;
  }

  // The GPU can drop the context (driver reset or update, a switch between
  // GPUs). preventDefault() asks the browser to give it back; until then
  // nothing can be drawn, and when it is back the grid is drawn again.
  function onGridContextLost(e) {
    e.preventDefault();
    gridRenderer.loseContext();
    perImageTextures.clear();
  }
  function onGridContextRestored() {
    if (!gridRenderer.restoreContext()) return;
    reuploadAfterNewContext();
    scheduleGridRedraw();
  }

  // Sized to fit content (no overscan needed) or BUFFER_VIEWPORTS viewports
  // tall, whichever is smaller. Called from renderGallery once layout is known.
  //
  // In a layout taller than MAX_SCROLL_HEIGHT the content moves scrollRatio
  // layout px per scroll px, so a canvas that scrolls natively with the
  // spacer would move at the wrong rate between redraws. There the canvas is
  // one viewport tall, pinned to the viewport (position: sticky) and redrawn
  // on every scroll frame.
  function applyGridLayout(thumbsEl, W, viewportH, totalH) {
    totalLayoutH = totalH;
    var fullH = Math.max(1, Math.ceil(totalH));
    scrollScaled = fullH > MAX_SCROLL_HEIGHT;
    var spacerH = scrollScaled ? MAX_SCROLL_HEIGHT : fullH;
    scrollRatio = scrollScaled ? (totalH - viewportH) / (spacerH - viewportH) : 1;
    spacerEl.style.height = spacerH + 'px';
    if (scrollScaled) {
      bufferH = viewportH;
      canvasEl.style.position = 'sticky';
    } else {
      bufferH = Math.min(Math.ceil(totalH), Math.ceil(viewportH * BUFFER_VIEWPORTS));
      if (bufferH < viewportH) bufferH = viewportH;  // never smaller than viewport
      canvasEl.style.position = 'absolute';
    }
    canvasEl.style.top = '0px';
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
    var thumbsEl = $('thumbs');
    if (!thumbsEl || !canvasEl) return;
    if (scrollScaled) { scheduleGridRedraw(); return; }  // pinned canvas: redraw every frame
    var scrollY = viewTop(thumbsEl);
    var viewportH = thumbsEl.clientHeight;
    if (!bufferNeedsReposition(scrollY, viewportH)) return;
    scheduleGridRedraw();
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
  }

  function onCanvasClick(e) {
    var thumbsEl = $('thumbs');
    if (!thumbsEl) return;
    var trect = thumbsEl.getBoundingClientRect();
    var cx = e.clientX - trect.left;
    var cy = e.clientY - trect.top + viewTop(thumbsEl);
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
    var scrollY = viewTop(thumbsEl);
    if (scrollY <= 0) { cachedAnchorName = null; persistAnchor(); return; }
    var t = tileAtTop(scrollY);
    cachedAnchorName = t ? t.name : null;
    persistAnchor();
  }

  // The leftmost tile of the topmost row that is at least partly below
  // layout y `top`: the row spanning `top`, or the next row when `top` falls
  // in the gap between two rows. Past the last row, the last row.
  function tileAtTop(top) {
    if (!lastTileRects.length) return null;
    var i = Math.min(firstTileIndexAtOrBelow(top), lastTileRects.length - 1);
    while (i > 0 && lastTileRects[i - 1].y === lastTileRects[i].y) i--;
    return lastTileRects[i];
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
    // Per-sprite instance arrays. Array growth is amortized; we know
    // approximate counts per sprite (cellsPerSprite-ish).
    var perSprite = new Array(nSprites);
    for (var s = 0; s < nSprites; s++) perSprite[s] = [];
    for (var i = 0; i < lastTileRects.length; i++) {
      var t = lastTileRects[i];
      var loc = spriteMeta.imageMap[t.name];
      if (!loc) continue;
      var cell = atlasCellRect(loc, atlas);
      perSprite[cell.spIdx].push(t.x, t.y - glOriginY, t.w, t.h,
        cell.sx / cell.spriteW, cell.sy / cell.spriteH, cell.sw / cell.spriteW, cell.sh / cell.spriteH);
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
    atlasInstancesOriginY = glOriginY;
  }

  // Index of the first tile that overlaps or lies below world y `top`.
  function firstTileIndexAtOrBelow(top) {
    var n = lastTileRects.length, lo = 0, hi = n - 1, start = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lastTileRects[mid].y < top) { start = mid + 1; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    if (start > 0 && lastTileRects[start - 1].y + lastTileRects[start - 1].h > top) start--;
    return start;
  }

  // Indices of sprites that have at least one tile in the buffer y-range.
  function spritesNeededForBuffer(atlasH) {
    var key = String(atlasH);
    var atlas = spriteMeta && spriteMeta.atlases && spriteMeta.atlases[key];
    if (!atlas) return new Set();
    var aPerSprite = atlas.cellsPerSprite;
    var top = bufferTop, bot = bufferTop + bufferH;
    var needed = new Set();
    var n = lastTileRects.length;
    for (var i = firstTileIndexAtOrBelow(top); i < n; i++) {
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
    if (key === floorAtlasKey()) return;  // resident for the whole gallery
    var arr = atlasBitmapsSync[key];
    if (!arr) return;
    var jobs = spriteLoads[key];
    for (var i = 0; i < arr.length; i++) {
      if (neededIdxs.has(i)) continue;
      closeBitmap(arr[i]);
      arr[i] = null;
      gridRenderer.deleteTexture(key + ':' + i);
      if (jobs && jobs[i]) {
        jobs[i].ctrl.abort();
        delete jobs[i];
      }
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
    var scrollY = viewTop(thumbsEl);
    var dpr = devicePixelRatio();
    var W = canvasEl.width / dpr;
    var viewportH = thumbsEl.clientHeight || (canvasEl.height / dpr);
    if (!viewportH) return;

    if (scrollScaled) {
      bufferTop = scrollY;  // the pinned canvas shows exactly the viewport
    } else if (bufferTop < 0 || bufferNeedsReposition(scrollY, viewportH)) {
      recenterBuffer(scrollY, viewportH);
    }
    glOriginY = glOriginFor(bufferTop);

    var atlasH = pickAtlasHeight(currentRowHeight * dpr);
    if (atlasH != null) drawGridFromAtlas(atlasH, W, dpr);
    else drawGridPerImage(W, dpr, scrollY, viewportH);
    requestFloorSprites();
  }

  // Atlas mode: every tile comes from one sprite tier. Instance buffers are
  // static per layout; per frame we only make sure the sprites the buffer
  // needs are on the GPU and issue one draw per sprite.
  function drawGridFromAtlas(atlasH, W, dpr) {
    var aKey = String(atlasH);
    if (atlasInstancesBuiltFor !== aKey || atlasInstancesLayoutH !== currentRowHeight || atlasInstancesOriginY !== glOriginY) {
      dropStaticBuffersOfPreviousAtlas(aKey);
      buildStaticAtlasBuffers(atlasH);
    }

    // Free any prior atlas tier's sprites (zoom-tier transition).
    evictAtlasTiersOtherThan(new Set([aKey]));
    // Lazy-load only sprites the buffer needs; evict the rest within this tier.
    var needed = spritesNeededForBuffer(atlasH);
    evictAtlasBitmaps(atlasH, needed);
    // (The floor tier is loaded whole by requestFloorSprites instead.)
    if (aKey !== floorAtlasKey()) {
      needed.forEach(function (spIdx) {
        // Already on GPU? Nothing to wait on, nothing to redraw for.
        if (gridRenderer.hasTexture(aKey + ':' + spIdx)) return;
        // Atlas arrival is FIRST content for those tiles — redraw immediately.
        // Only when the texture took: a sheet the GPU refused would otherwise
        // be asked for again by the redraw, which would redraw again, forever.
        loadSpriteAt(atlasH, spIdx).then(function () {
          if (canvasEl && gridRenderer.hasTexture(aKey + ':' + spIdx)) scheduleGridRedraw();
        }, function () {});
      });
    }

    // One batch per sprite. drawStatic skips sprites whose texture isn't loaded yet.
    var atlas = spriteMeta.atlases[aKey];
    var batches = [];
    for (var b = 0; b < atlas.sprites.length; b++) {
      var bk = aKey + ':' + b;
      if (!gridRenderer.hasStatic(bk)) continue;
      batches.push({ textureKey: bk, instanceKey: bk });
    }
    // Tiles whose sprite hasn't arrived draw from the floor tier meanwhile.
    var floorBatches = floorBatchesForMissingSprites(aKey, needed);
    if (gridRenderer.beginFrame(W, bufferH, dpr, bufferTop - glOriginY)) {
      gridRenderer.drawStatic(batches);
      gridRenderer.drawDynamic(floorBatches);
    }
    // Atlas mode doesn't use per-image bitmaps — release any leftovers.
    warmPerImageNames = new Set();
    evictPerImage(new Set());
  }

  function dropStaticBuffersOfPreviousAtlas(newKey) {
    if (!atlasInstancesBuiltFor || atlasInstancesBuiltFor === newKey) return;
    var oldAtlas = spriteMeta.atlases[atlasInstancesBuiltFor];
    if (!oldAtlas) return;
    for (var i = 0; i < oldAtlas.sprites.length; i++) {
      gridRenderer.dropStatic(atlasInstancesBuiltFor + ':' + i);
    }
  }

  // Per-image mode: each tile in the buffer gets its own bitmap at the ideal
  // tier, with a small atlas as the instant placeholder. Batches are dynamic
  // and rebuilt only on edge crossings or bitmap arrivals, not per scroll event.
  var drawnTierByName = new Map();  // per-image mode: tier height each buffered tile was last drawn at (test hook)

  function drawGridPerImage(W, dpr, scrollY, viewportH) {
    var bufBot = bufferTop + bufferH;
    var tilesInBuffer = [];
    var tileTiers = [];  // per tile: the tier it wants, 0 = atlas only
    for (var i = firstTileIndexAtOrBelow(bufferTop); i < lastTileRects.length; i++) {
      if (lastTileRects[i].y > bufBot) break;
      tilesInBuffer.push(lastTileRects[i]);
      tileTiers.push(perImageTierForTile(lastTileRects[i], dpr));
    }

    // h800/h1600 tiles get a per-image h200 first: ~15 KB each, it lands
    // long before the real tier, while the h50 sprite that stands in for
    // smaller tiles (1.7 MB, 50 MB decoded, 1400 tiles) rarely beats it.
    function stepTierFor(tierH) { return tierH >= 800 ? 200 : 0; }

    // Anything queued for a tile outside the buffer is stale (user scrolled past it).
    var keepKeys = new Set();
    for (var k = 0; k < tilesInBuffer.length; k++) {
      if (!tileTiers[k]) continue;
      keepKeys.add(tilesInBuffer[k].name + '|' + tileTiers[k]);
      if (stepTierFor(tileTiers[k])) keepKeys.add(tilesInBuffer[k].name + '|' + stepTierFor(tileTiers[k]));
    }
    cancelPerImageLoadsExcept(keepKeys);

    requestFallbackAtlasSprites(tilesInBuffer);

    var batchAccum = new Map();
    var warmNames = new Set();
    drawnTierByName = new Map();
    for (var ti = 0; ti < tilesInBuffer.length; ti++) {
      var t = tilesInBuffer[ti];
      var tierH = tileTiers[ti];
      var stepTier = stepTierFor(tierH);
      warmNames.add(t.name);
      var loadedTiers = PER_IMAGE_TIERS.filter(function (h) { return h <= tierH; }).reverse();
      var loadedKey = bestLoadedPerImageKey(t.name, loadedTiers);
      var drawnTier;
      if (loadedKey) {
        pushBatch(batchAccum, loadedKey, t.x, t.y, t.w, t.h, 0, 0, 1, 1);
        drawnTier = parseInt(loadedKey.slice(loadedKey.lastIndexOf('|') + 1), 10);
      } else {
        drawnTier = pushAtlasFallback(batchAccum, t, ['50', '10', '5']);
      }
      drawnTierByName.set(t.name, drawnTier);
      var distance = distanceFromViewport(t, scrollY, viewportH);
      if (stepTier && !bestTexturedPerImageTier(t.name)) {
        loadPerImageTexture(t.name, stepTier, distance).then(function (ok) {
          if (ok && canvasEl) scheduleGridRedraw();
        }, function () {});
      }
      // Only chain a redraw if the IDEAL tier isn't already on GPU. Without
      // this, every redraw re-chains and an already-cached promise triggers
      // another redraw — infinite loop.
      if (tierH && !gridRenderer.hasTexture('img:' + t.name + '|' + tierH)) {
        loadPerImageTexture(t.name, tierH, distance).then(function (ok) {
          // null means the load was canceled — no new content arrived.
          // An arrival redraws at once (coalesced to one draw per frame):
          // with the floor under everything, tiles sharpening while the
          // user drags is the feedback that loading is keeping up.
          if (ok && canvasEl) scheduleGridRedraw();
        }, function () {});
      }
    }
    warmPerImageNames = warmNames;
    evictPerImage(warmNames);

    if (gridRenderer.beginFrame(W, bufferH, dpr, bufferTop - glOriginY)) gridRenderer.drawDynamic(batchesFromAccum(batchAccum));
  }

  // The per-photo tier for tile `t`: the smallest tier that covers the height
  // the tile is drawn at, give or take TIER_UPSCALE_ALLOWED. Rows are
  // stretched to fill the width, usually by 5-30%, and the next tier up is
  // four times the pixels to download and decode; a tile drawn up to 30%
  // larger than its texture is not visibly softer, a row stretched further
  // is. Then stepping down past any tier whose
  // texture would be wider than the GPU allows (a panorama) or that the GPU
  // already refused. 0 when no tier fits: the tile is drawn from the atlas.
  var TIER_UPSCALE_ALLOWED = 1.3;
  function perImageTierForTile(t, dpr) {
    var loc = spriteMeta.imageMap[t.name];
    var aspect = (loc ? loc.w : CANONICAL_H) / CANONICAL_H;
    var maxSide = gridRenderer.maxTextureSide();
    var wanted = pickPerImageTier(t.h * dpr / TIER_UPSCALE_ALLOWED);
    for (var i = PER_IMAGE_TIERS.length - 1; i >= 0; i--) {
      var tierH = PER_IMAGE_TIERS[i];
      if (tierH > wanted) continue;
      if (tierH * aspect > maxSide || tierH > maxSide) continue;
      if (perImageTexturesRefused.has(t.name + '|' + tierH)) continue;
      return tierH;
    }
    return 0;
  }

  // Largest per-image tier of `name` that the grid has as a texture, or 0.
  function bestTexturedPerImageTier(name) {
    for (var i = PER_IMAGE_TIERS.length - 1; i >= 0; i--) {
      if (perImageTextures.has(name + '|' + PER_IMAGE_TIERS[i])) return PER_IMAGE_TIERS[i];
    }
    return 0;
  }

  // Texture key of the best per-image tier already on the GPU, or null.
  function bestLoadedPerImageKey(name, tiers) {
    for (var i = 0; i < tiers.length; i++) {
      var key = 'img:' + name + '|' + tiers[i];
      if (gridRenderer.hasTexture(key)) return key;
    }
    return null;
  }

  // Kick off the small-atlas sprites covering the buffer so every tile has a
  // placeholder while per-image bitmaps load; one sprite fetch beats hundreds
  // of per-image ones. Sprites outside the buffer, and every other atlas
  // tier, are evicted.
  function requestFallbackAtlasSprites(tilesInBuffer) {
    var fallbackKey = null;
    var candidates = ['50', '10', '5'];
    for (var c = 0; c < candidates.length && !fallbackKey; c++) {
      if (spriteMeta.atlases[candidates[c]]) fallbackKey = candidates[c];
    }
    if (!fallbackKey) {
      evictAtlasTiersOtherThan(new Set());
      return;
    }
    var atlas = spriteMeta.atlases[fallbackKey];
    var atlasH = parseInt(fallbackKey, 10);
    var spriteIdxs = new Set();
    for (var i = 0; i < tilesInBuffer.length; i++) {
      var loc = spriteMeta.imageMap[tilesInBuffer[i].name];
      if (loc) spriteIdxs.add(Math.floor(loc.idx / atlas.cellsPerSprite));
    }
    spriteIdxs.forEach(function (spIdx) {
      if (gridRenderer.hasTexture(fallbackKey + ':' + spIdx)) return;
      loadSpriteAt(atlasH, spIdx).then(function () {
        if (canvasEl && gridRenderer.hasTexture(fallbackKey + ':' + spIdx)) scheduleGridRedraw();
      }, function () {});
    });
    evictAtlasBitmaps(atlasH, spriteIdxs);
    evictAtlasTiersOtherThan(new Set([fallbackKey]));
  }

  function batchesFromAccum(batchAccum) {
    var batches = [];
    batchAccum.forEach(function (arr, key) {
      batches.push({ textureKey: key, instances: new Float32Array(arr) });
    });
    return batches;
  }

  // `y` is a layout y; the GPU gets it relative to glOriginY.
  function pushBatch(batchAccum, key, x, y, w, h, u0, v0, du, dv) {
    var arr = batchAccum.get(key);
    if (!arr) { arr = []; batchAccum.set(key, arr); }
    arr.push(x, y - glOriginY, w, h, u0, v0, du, dv);
  }

  // Draw a tile from the first of `tiers` whose sprite is on the GPU.
  // Returns the tier height drawn, 0 if none was available.
  function pushAtlasFallback(batchAccum, t, tiers) {
    var loc = spriteMeta.imageMap[t.name];
    if (!loc) return 0;
    for (var i = 0; i < tiers.length; i++) {
      var atlas = spriteMeta.atlases[tiers[i]];
      if (!atlas) continue;
      var cell = atlasCellRect(loc, atlas);
      var textureKey = tiers[i] + ':' + cell.spIdx;
      if (!gridRenderer.hasTexture(textureKey)) continue;
      pushBatch(batchAccum, textureKey, t.x, t.y, t.w, t.h,
        cell.sx / cell.spriteW, cell.sy / cell.spriteH, cell.sw / cell.spriteW, cell.sh / cell.spriteH);
      return parseInt(tiers[i], 10);
    }
    return 0;
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
  // Sync source for the main canvas: { bitmap, sx, sy, sw, sh, forIdx } | null.
  // Updated by drawMainImage with the best resolved per-image / atlas source.
  var mainDrawSrc = null;
  // Filmstrip layout (rebuilt on filmstrip setup / resize).
  var filmTilePos = null;
  var filmTileW   = null;
  var filmTotalW  = 0;
  var filmPadL    = 0;    // pads so the first/last tile can sit at center
  var filmPadR    = 0;
  var filmRedrawRaf = null;       // scheduled filmstrip + main image redraw
  var mainImageDecayRaf = null;   // momentum after a swipe on the main image
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
  var focusChasePreviousScrollLeft = NaN;  // scrollLeft before the last step
  function startFocusChase() {
    focusInProgrammaticScroll = true;
    if (focusChaseRaf) return;
    focusChasePreviousScrollLeft = NaN;
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
    // The chase ends when the strip is within a pixel of the target, or when
    // the last step did not move it at all (the target lies past the end the
    // browser lets the strip scroll to). Every other step moves the strip at
    // least one pixel closer, so the chase always ends.
    if (Math.abs(diff) < 1 || cur === focusChasePreviousScrollLeft) {
      filmstripEl.scrollLeft = target;
      // Authoritative settle: the commanded tile is the focus. drawFilmstrip
      // re-derives focusedIdx from scrollLeft, and a browser-rounded
      // scrollLeft + wide neighbor can flip it to the wrong tile; force the
      // right value here before that runs.
      focusedIdx = commandedIdx;
      focusInProgrammaticScroll = false;
      return;
    }
    // A quarter of the remaining distance, but at least one whole pixel:
    // browsers round scrollLeft, and with under 2 px to go a quarter step
    // rounds back to the same position, so the chase would never arrive.
    // Never more than the remaining distance, so it cannot overshoot.
    var stepSize = Math.min(Math.abs(diff), Math.max(1, Math.abs(diff) * 0.25));
    focusChasePreviousScrollLeft = cur;
    filmstripEl.scrollLeft = cur + (diff > 0 ? stepSize : -stepSize);
    focusChaseRaf = requestAnimationFrame(focusChaseTick);
  }

  // Leaving the photo view, or rebuilding it after a resize, must stop
  // everything the old view scheduled. An animation frame or timer that ran
  // later would read the detached film strip, whose scrollLeft is 0, decide
  // that photo 1 is open and rewrite the URL to it.
  function teardownPhotoView() {
    if (focusChaseRaf) cancelAnimationFrame(focusChaseRaf);
    focusChaseRaf = null;
    focusInProgrammaticScroll = false;
    if (filmRedrawRaf) cancelAnimationFrame(filmRedrawRaf);
    filmRedrawRaf = null;
    if (mainImageDecayRaf) cancelAnimationFrame(mainImageDecayRaf);
    mainImageDecayRaf = null;
    if (pendingHashTimer) clearTimeout(pendingHashTimer);
    pendingHashTimer = null;
    pendingHash = null;
    if (focusStableTimer) clearTimeout(focusStableTimer);
    focusStableTimer = null;
    mainEl = null;
    filmstripEl = null;
    filmCanvasEl = null;
    filmSpacerEl = null;
    filmTilePos = null;
    filmTileW = null;
    mainDrawSrc = null;
  }

  function setupFilmstripFocus(thumbsEl) {
    // A resize or rotation rebuilds the view; a chase still under way keeps
    // the photo it was heading for.
    var chaseTargetIdx = focusChaseRaf ? commandedIdx : 0;
    teardownPhotoView();
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

    filmstripEl.addEventListener('scroll', scheduleFilmstripRedraw, { passive: true });
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
    // Rebuilding the view cancelled any pending URL update for the photo shown.
    var photoHash = '#' + encodeURIComponent(images[focusedIdx]);
    if (location.hash !== photoHash) scheduleHashUpdate(photoHash);
    renderZoomControl();

    drawFilmstrip();
    drawMainImage();
    if (chaseTargetIdx && chaseTargetIdx !== focusedIdx) {
      commandedIdx = chaseTargetIdx;
      startFocusChase();
    }
  }

  // Redraw the filmstrip and main image on the next frame. Scroll events and
  // sprite arrivals share this so a redraw always reads the CURRENT scroll
  // position, not one captured when a load was queued.
  function scheduleFilmstripRedraw() {
    if (filmRedrawRaf) return;
    filmRedrawRaf = requestAnimationFrame(function () {
      filmRedrawRaf = null;
      drawFilmstrip();
      drawMainImage();
    });
  }

  function onFilmstripClick(e) {
    if (!filmstripEl || !filmTilePos) return;
    var rect = filmCanvasEl.getBoundingClientRect();
    var clickX = e.clientX - rect.left + filmstripEl.scrollLeft - filmPadL;
    commandedIdx = filmTileIndexAtX(clickX) + 1;
    startFocusChase();
  }

  // Index of the first filmstrip tile whose right edge is past x.
  function filmTileIndexAtX(x) {
    var lo = 0, hi = filmTilePos.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (filmTilePos[mid] + filmTileW[mid] <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
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
    if (!atlas || filmTilePos.length === 0) return;
    var scrollLeft = filmstripEl.scrollLeft;
    var leftEdge = scrollLeft - filmPadL;
    var rightEdge = leftEdge + W;

    ensureFilmstripSprites(atlasH, atlas, leftEdge, rightEdge);
    settleFocusFromFilmstripScroll(scrollLeft, W);
    paintFilmstripTiles(ctx, atlasH, atlas, leftEdge, rightEdge);
  }

  // Load only the sprites covering the visible tiles (plus a one-sprite
  // cushion so a small scrub doesn't thrash) and evict the rest. Without
  // this, a fast scrub through a 100k gallery accumulates every h50 sprite
  // (~38 MB ImageBitmap each). The centered image's sprite is kept too:
  // drawMainImage uses it as a fallback while the per-image AVIF loads.
  function ensureFilmstripSprites(atlasH, atlas, leftEdge, rightEdge) {
    var first = filmTileIndexAtX(leftEdge);
    var last = first;
    for (var i = first; i < filmTilePos.length; i++) {
      if (filmTilePos[i] > rightEdge) break;
      last = i;
    }
    var firstSp = Math.floor(first / atlas.cellsPerSprite);
    var lastSp = Math.floor(last / atlas.cellsPerSprite);
    var keepLo = Math.max(0, firstSp - 1);
    var keepHi = Math.min(atlas.sprites.length - 1, lastSp + 1);
    var keep = new Set();
    for (var sp = keepLo; sp <= keepHi; sp++) keep.add(sp);
    if (focusedIdx > 0) keep.add(Math.floor((focusedIdx - 1) / atlas.cellsPerSprite));
    evictAtlasBitmaps(atlasH, keep);
    var bitmaps = atlasBitmapsSync[String(atlasH)] || [];
    for (var s = firstSp; s <= lastSp; s++) {
      // Skip already-loaded sprites; chaining .then on a resolved promise
      // would loop (resolves on microtask -> drawFilmstrip -> chain again).
      if (bitmaps[s]) continue;
      loadSpriteAt(atlasH, s).then(scheduleFilmstripRedraw, function () {});
    }
  }

  // When the scroll position has settled at the commanded tile's exact
  // target (within ~1px), trust commandedIdx. filmCenteredIdx1 picks the
  // tile whose center is closest to viewport center, which with a wide
  // neighbor + browser-rounded scrollLeft can deterministically pick the
  // wrong tile by a few pixels — causing focusedIdx to flicker and the
  // main-image stable-focus timer to never fire.
  function settleFocusFromFilmstripScroll(scrollLeft, W) {
    var newCenterIdx = filmCenteredIdx1(scrollLeft, W);
    if (commandedIdx > 0 && Math.abs(scrollLeft - filmScrollForIdx1(commandedIdx, W)) < 1.5) {
      newCenterIdx = commandedIdx;
    }
    if (newCenterIdx === focusedIdx) return;
    focusedIdx = newCenterIdx;
    // Keep mainDrawSrc; drawMainImage installs the fresh source next.
    scheduleHashUpdate('#' + encodeURIComponent(images[focusedIdx]));
    hideControls();
  }

  function paintFilmstripTiles(ctx, atlasH, atlas, leftEdge, rightEdge) {
    var bitmaps = atlasBitmapsSync[String(atlasH)] || [];
    var yPad = Math.round((FILM_H - FILM_TILE_H) / 2);
    for (var ti = filmTileIndexAtX(leftEdge); ti < filmTilePos.length; ti++) {
      var tx = filmTilePos[ti];
      var tw = filmTileW[ti];
      if (tx > rightEdge) break;
      var bm = bitmaps[Math.floor(ti / atlas.cellsPerSprite)];
      if (!bm) continue;
      var loc = spriteMeta.imageMap[images[ti + 1]];
      if (!loc) continue;
      var cell = atlasCellRect(loc, atlas);
      var screenX = tx - leftEdge;
      ctx.drawImage(bm, cell.sx, cell.sy, cell.sw, cell.sh, screenX, yPad, tw, FILM_TILE_H);
      if (ti + 1 === focusedIdx) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(screenX + 0.5, yPad + 0.5, tw - 1, FILM_TILE_H - 1);
      }
    }
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

    // No per-image bitmap yet (nothing, or only the h50 atlas cell). If the
    // grid already holds this image as a texture at a smaller tier, its
    // bitmap was closed at upload — re-decoding that file from the HTTP
    // cache takes a few ms and gives a far sharper placeholder than the
    // atlas while the ideal tier downloads.
    if (!src || src.tier === 0) {
      var cachedTier = bestTexturedPerImageTier(images[capturedIdx]);
      if (cachedTier) {
        loadPerImageBitmap(images[capturedIdx], cachedTier).then(function (bm) {
          if (!bm || !mainEl || focusedIdx !== capturedIdx) return;
          if (mainDrawSrc && mainDrawSrc.forIdx === capturedIdx && mainDrawSrc.sh >= bm.height) return;
          mainDrawSrc = { bitmap: bm, sx: 0, sy: 0, sw: bm.width, sh: bm.height, forIdx: capturedIdx };
          paintMain();
        });
      }
    }
    // Kick off the atlas load too, with a per-sprite waiter so we paint the
    // instant OUR sprite arrives — rather than waiting for every sprite in the
    // atlas to decode. With OI's 32 h50 sprites that turns ~1s of black canvas
    // into <100ms.
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
      if (k === 0) {
        // Any tier of the centered image may be in flight as its placeholder.
        for (var ti = 0; ti < PER_IMAGE_TIERS.length; ti++) keepKeys.add(name + '|' + PER_IMAGE_TIERS[ti]);
      }
    }
    // Abort any in-flight load that's no longer in the keep window — frees
    // sockets/decoder immediately for whatever's about to be requested next.
    cancelPerImageLoadsExcept(keepKeys);
    warmPerImageNames = warmNames;
    evictPerImage(warmNames);

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

  // Best already-cached source for `idx1` at `targetH`: walk per-image tiers
  // (target then smaller), then fall back to atlas h50. `tier` is the
  // per-image tier the source came from, 0 for the atlas.
  function getBestSrcForFocus(idx1, targetH) {
    if (idx1 < 1 || idx1 > lastimagevalue) return null;
    var name = images[idx1];
    if (!name) return null;
    var tier = pickPerImageTier(targetH);
    var ladder = [tier].concat(PER_IMAGE_TIERS.filter(function (h) { return h < tier || tier === 0; }).reverse());
    for (var i = 0; i < ladder.length; i++) {
      var t = ladder[i];
      var bm = getPerImageBitmapSync(name, t);
      if (bm) return { bitmap: bm, sx: 0, sy: 0, sw: bm.width, sh: bm.height, tier: t };
    }
    var atlasSrc = getAtlasSrcSync(idx1);
    if (atlasSrc) atlasSrc.tier = 0;
    return atlasSrc;
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
    var cell = atlasCellRect(loc, atlas);
    var bitmap = bitmaps[cell.spIdx];
    if (!bitmap) return null;
    return { bitmap: bitmap, sx: cell.sx, sy: cell.sy, sw: cell.sw, sh: cell.sh, natW: loc.w, natH: CANONICAL_H };
  }

  // 1-finger horizontal drag on the main image becomes a filmstrip scrub: we
  // adjust filmstripEl.scrollLeft directly, and the existing scroll handler
  // updates focusedIdx + repaints. On touchend we run a manual momentum decay
  // (programmatic scrollLeft doesn't get native scroll inertia). 2-finger
  // gestures are left alone so native pinch-zoom keeps working.
  // A tap (no/tiny movement, short duration) navigates to the original file.
  var TAP_MAX_MOVE_PX = 10;  // the usual touch slop on phones (Android: 8 dp)
  function setupMainImageGestures() {
    if (!mainEl) return;
    var startX = 0, startY = 0, startT = 0, startScrollLeft = 0;
    var dragging = false, multiTouch = false;
    var farthestMove = 0;  // px the finger has moved from where it went down
    var lastX = 0, lastT = 0, velX = 0;  // px/ms
    var lastDragEndAt = 0;

    function stopDecay() {
      if (mainImageDecayRaf) { cancelAnimationFrame(mainImageDecayRaf); mainImageDecayRaf = null; }
    }
    function startDecay() {
      stopDecay();
      var v = velX;  // px/ms (negative means content moves left -> scrollLeft increases)
      var prevT = performance.now();
      function step(now) {
        var dt = Math.max(1, now - prevT);
        prevT = now;
        if (!filmstripEl) { mainImageDecayRaf = null; return; }
        // Decay rate ~exp(-dt/180ms). Stop when below ~0.04 px/ms (~24 px/s).
        var decay = Math.exp(-dt / 180);
        v *= decay;
        if (Math.abs(v) < 0.04) { mainImageDecayRaf = null; return; }
        filmstripEl.scrollLeft -= v * dt;
        mainImageDecayRaf = requestAnimationFrame(step);
      }
      mainImageDecayRaf = requestAnimationFrame(step);
    }

    mainEl.addEventListener('touchstart', function (e) {
      stopDecay();
      multiTouch = e.touches.length > 1;
      if (multiTouch) { dragging = false; return; }
      var t = e.touches[0];
      startX = lastX = t.clientX;
      startY = t.clientY;
      startT = lastT = performance.now();
      startScrollLeft = filmstripEl ? filmstripEl.scrollLeft : 0;
      dragging = false;
      farthestMove = 0;
      velX = 0;
    }, { passive: true });

    mainEl.addEventListener('touchmove', function (e) {
      if (multiTouch || e.touches.length > 1) { dragging = false; return; }
      if (!filmstripEl) return;
      var t = e.touches[0];
      var dx = t.clientX - startX;
      var dy = t.clientY - startY;
      farthestMove = Math.max(farthestMove, Math.sqrt(dx * dx + dy * dy));
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
      if (multiTouch) { multiTouch = e.touches.length > 0; return; }
      if (dragging) {
        startDecay();
        dragging = false;
        lastDragEndAt = performance.now();
        return;
      }
      // Tap: short in time AND in distance -> open original file. A quick
      // vertical swipe is short in time too, but it is not a tap.
      var dt = performance.now() - startT;
      if (dt < 350 && farthestMove <= TAP_MAX_MOVE_PX) {
        var name = images && images[focusedIdx];
        if (name) {
          var url = folderURL + encodeURIComponent(name);
          window.location.href = url;
        }
      }
    });

    mainEl.addEventListener('touchcancel', function () {
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
    if (photoListFailed) {
      thumbsEl.innerHTML = '<div style="padding:32px;text-align:center;color:#888">' +
        'The list of photos in this folder could not be loaded. Reload the page to try again.</div>';
      thumbsEl.style.cssText = '';
      canvasEl = null; spacerEl = null;
      return;
    }
    if (!window.spriteMeta) {
      thumbsEl.innerHTML = '<div style="padding:32px;text-align:center;color:#888">' +
        '<div id="buildstatus-main" style="font-size:16px;margin-bottom:8px"></div>' +
        '<div style="font-size:13px">' + lastimagevalue + ' images in this folder</div>' +
        '</div>';
      $('buildstatus-main').textContent = buildMessage || DEFAULT_BUILD_MESSAGE;
      watchBuildStatus();
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
    if (gridRenderer.unsupported()) {
      thumbsEl.innerHTML = '<div style="padding:32px;text-align:center;color:#888">' +
        'This browser cannot show the photo grid: it needs WebGL 2, which is turned off or not supported here.</div>';
      canvasEl = null; spacerEl = null;
      return;
    }
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
          var newScrollTop = scrollTopFromLayoutY(newTop);
          if (Math.abs(thumbsEl.scrollTop - newScrollTop) > 0.5) {
            suppressNextAnchorCapture = true;
            thumbsEl.scrollTop = newScrollTop;
          }
          break;
        }
      }
    } else {
      thumbsEl.scrollTop = 0;
    }

    drawCanvasForScroll();
  }

  // ---------- hash routing ----------
  // The URL fragment as text. A fragment with a malformed escape ("#%")
  // cannot be decoded; it is treated as no fragment, so the grid still loads.
  function hashText() {
    try { return decodeURIComponent(location.hash.slice(1) || ''); }
    catch (_) { return ''; }
  }

  // The fragment names a zoom level (#fit, #size4), a photo (#name.jpg) or
  // nothing. An empty or unknown fragment shows the grid at the default zoom.
  // Zoom levels are checked first; photo names always carry an extension, so
  // they cannot collide with them.
  function refreshfromhash() {
    var raw = hashText();
    var levels = availableLevels();
    for (var li = 0; li < levels.length; li++) {
      if (levels[li].hash && levels[li].hash === raw) { showGridView(li); return; }
    }
    var photoIdx = photoIndexOfName(raw);
    if (photoIdx > 0) showPhotoView(photoIdx);
    else showGridView(defaultLevelIdx());
  }

  function photoIndexOfName(name) {
    if (!name) return 0;
    for (var i = 1; i <= lastimagevalue; i++) {
      if (images[i] === name) return i;
    }
    return 0;
  }

  // Each view switch starts from a torn-down photo view, so nothing the
  // previous photo view scheduled can act on the new one. The admin bar is
  // refreshed last, after focusedIdx says which view is showing.
  function showGridView(levelIdx) {
    teardownPhotoView();
    currentLevelIdx = levelIdx;
    lastGridLevelIdx = levelIdx;
    var lv = availableLevels()[levelIdx];
    if (lv.h !== 'focus') levelTargetH = lv.h;
    focusedIdx = 0;
    setText('counter', '');
    document.body.classList.add('thumb-view');
    document.body.classList.remove('image-view');
    renderGallery();
    renderZoomControl();
    showAdminBar();
  }

  function showPhotoView(photoIdx) {
    teardownPhotoView();
    focusedIdx = photoIdx;
    document.body.classList.add('image-view');
    document.body.classList.remove('thumb-view');
    renderGallery();
    renderZoomControl();
    showAdminBar();
  }

  // Back to the grid at the zoom the visitor came from, with the photo just
  // viewed at the top. Used by the up button and by Escape.
  function returnToGrid() {
    if (focusedIdx > 0 && images[focusedIdx]) cachedAnchorName = images[focusedIdx];
    var lv = availableLevels()[lastGridLevelIdx];
    location.hash = lv && lv.hash ? '#' + lv.hash : '#fit';
  }

  // ---------- admin bar ----------
  // In focus view: a single "Move to trash" action on the current image.
  // In grid view: just a link to the admin panel — full management lives there.
  function showAdminBar() {
    var bar = $('adminnotify');
    if (!window.isadmin) { bar.classList.remove('on'); return; }
    bar.classList.add('on');
    bar.textContent = '';
    if (focusedIdx > 0) {
      var trashButton = document.createElement('button');
      trashButton.textContent = 'Move to trash';
      trashButton.disabled = trashInProgress;
      trashButton.addEventListener('click', moveFocusedToTrash);
      bar.appendChild(trashButton);
    }
    var adminLink = document.createElement('a');
    adminLink.href = '/_admin/';
    adminLink.style.marginLeft = 'auto';
    adminLink.textContent = 'Admin panel →';
    bar.appendChild(adminLink);
  }
  // ---------- admin actions ----------
  // "Move to trash" on the photo shown. No confirm: trash is reversible via
  // the admin panel's per-folder trash. The server moves the file at once
  // and rebuilds the folder afterwards; a page loaded before that build
  // commits still lists the photo, and trashing it again fails. So once the
  // server has accepted, the page waits (through the build-status poller)
  // until the folder is built without the photo, then reloads onto the next
  // photo. One trash at a time: the button is disabled from the click on.
  var TRASH_WAIT_MS = 10 * 60 * 1000;
  var trashInProgress = false;
  var pendingTrash = null;  // { name, nextHash, waitUntil } once the server accepted

  function moveFocusedToTrash() {
    if (focusedIdx <= 0 || trashInProgress) return;
    var idx = focusedIdx;
    var name = images[idx];
    trashInProgress = true;
    showAdminBar();
    note('Moving ' + name + ' to trash…');
    fetch(folderURL + '?movetotrash=' + encodeURIComponent(name), { method: 'POST', credentials: 'same-origin' })
      .then(function (response) {
        return response.text().then(function (text) {
          if (!response.ok) throw new Error(text || 'HTTP ' + response.status);
        });
      })
      .then(function () {
        pendingTrash = { name: name, nextHash: hashAfterTrashing(idx), waitUntil: Date.now() + TRASH_WAIT_MS };
        setBuildMessage(trashMessage());
        watchBuildStatusAfterChange();
      }, function (error) {
        trashInProgress = false;
        showAdminBar();
        note(name + ' could not be moved to trash: ' + error.message);
      });
  }

  // Where the page opens after the trash: the next photo, else the previous
  // one, else the grid.
  function hashAfterTrashing(idx) {
    var neighbour = images[idx + 1] || images[idx - 1];
    if (neighbour) return '#' + encodeURIComponent(neighbour);
    var lv = availableLevels()[lastGridLevelIdx];
    return '#' + (lv && lv.hash ? lv.hash : 'fit');
  }

  // The wait is bounded: a folder of tens of thousands of photos can take a
  // long time to re-bake its atlas, and the visitor is told instead.
  function trashAwaitsBuild() {
    return pendingTrash !== null && Date.now() < pendingTrash.waitUntil;
  }

  function trashMessage() {
    return trashAwaitsBuild()
      ? pendingTrash.name + ' moved to trash. Updating the folder…'
      : pendingTrash.name + ' is in the trash. The folder is still being updated; reload the page later to see the change.';
  }

  // Unless the visitor has moved on to another photo meanwhile, the
  // reloaded page opens on the photo after the trashed one.
  function reloadAfterTrash() {
    applyPendingHashUpdate();
    if (hashText() === pendingTrash.name) {
      try { history.replaceState(null, '', pendingTrash.nextHash); } catch (_) {}
    }
    location.reload();
  }

  // Image whose tile-center is closest to the viewport center.
  function findCenteredImageName() {
    var thumbsEl = $('thumbs');
    if (!thumbsEl || !lastTileRects.length) return null;
    var sy = viewTop(thumbsEl);
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
      refreshfromhash();
      // Re-render after two rAFs so layoutHeight measures with chrome settled.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { scheduleRender(); });
      });
    }

    if (window.imagemapURL && window.spriteMeta) {
      var thumbsEl = $('thumbs');
      if (thumbsEl) thumbsEl.innerHTML = '<div style="padding:32px;text-align:center;color:#888">Loading…</div>';
      var showPhotoListFailed = function () {
        photoListFailed = true;
        runInitialRoute();
      };
      withRetries(loadImagemap).then(runInitialRoute, function (e) {
        if (e && e.buildReplaced) {
          // The folder has a newer build: the page keeps saying "Loading…"
          // and reloads onto it, or says it failed if it cannot.
          afterReplacedBuildGivenUp = showPhotoListFailed;
          return;
        }
        console.warn('[imagemap] load failed:', e);
        showPhotoListFailed();
      });
    } else {
      runInitialRoute();
    }

    var _thumbsForInit = document.getElementById('thumbs');
    if (_thumbsForInit) { _thumbsForInit.tabIndex = -1; _thumbsForInit.focus({ preventScroll: true }); }
    window.addEventListener('hashchange', refreshfromhash);
    // Programmatic key handlers; inline onkey* attributes hit a race with the
    // IIFE's window.* exports on Safari.
    window.addEventListener('keydown', keycheck);
    watchBuildStatus();
  }

  // Cookie is HttpOnly; the probe is the only way to detect a valid session.
  function maybePromoteAdmin() {
    if (window.isadmin) { showAdminBar(); return; }
    fetch('/api/admin/probe', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.admin) { window.isadmin = 1; showAdminBar(); }
      })
      .catch(function () {});
  }

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
