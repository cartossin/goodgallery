// Goodgallery admin panel (/_admin/).
//
// Three scopes, kept apart on the page:
//   header      : the build queue and Clear queue
//   folder cards: everything about the folder you are looking at
//   sign-ins    : sessions, login links, sign out (a collapsed card)
//
// The session is an HttpOnly cookie; this script never sees the token.
'use strict';

const QUEUE_POLL_MS = 3000;
const FOLDER_REFRESH_WHILE_BUILDING_MS = 10000;
const IMAGE_LIST_LIMIT = 200;
const PARALLEL_UPLOADS = 4;
const UPLOAD_RETRY_MAX_WAIT_MS = 8000;
const NOTICE_MS = 6000;

const state = {
  folderSegments: [],      // current folder, e.g. ['trips', '2024']
  folderInfo: null,        // last /api/admin/folder response
  imageNames: null,        // loaded lazily when the Images section opens
  sessionOrigin: null,     // 'passkey' | 'server-link' | 'link'
  canCreatePasskey: false, // only a session from a server-made link, while no passkey exists
  lastQueueRemaining: null,
  lastFolderRefreshAt: 0,
  uploadBatch: newUploadBatch(),  // counter for the upload list in this folder
};

function newUploadBatch() {
  return { total: 0, uploaded: 0, failed: 0 };
}

const byId = id => document.getElementById(id);

// ======================================================================
// HTTP helpers
// ======================================================================

class SignedOutError extends Error {}

// The body is read before the status is judged: a response whose body is
// never read stays open in the browser's network stack.
async function requestJson(url, options) {
  const response = await fetch(url, Object.assign({ credentials: 'same-origin' }, options));
  let data = null;
  try { data = await response.json(); } catch {}
  if (response.status === 401) { showSignIn(); throw new SignedOutError('signed out'); }
  if (!response.ok) throw new Error((data && data.error) || ('HTTP ' + response.status));
  return data;
}

function getJson(url) {
  return requestJson(url);
}

function postJson(url, body) {
  return requestJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

// The per-folder query actions (?mkdir, ?sethidden, ?movetotrash, ...) answer
// in plain text, not JSON.
async function postFolderAction(url) {
  const response = await fetch(url, { method: 'POST', credentials: 'same-origin' });
  const text = await response.text();
  if (response.status === 401 || response.status === 403) { showSignIn(); throw new SignedOutError('signed out'); }
  if (!response.ok) throw Object.assign(new Error(text || ('HTTP ' + response.status)), { status: response.status });
  return text;
}

// Run an action, then report its outcome in the notice line.
async function runAction(description, action) {
  try {
    const message = await action();
    showNotice(message || description + ': done');
  } catch (error) {
    if (error instanceof SignedOutError) return;
    showNotice(description + ' failed: ' + error.message, true);
  }
}

// A toast at the bottom of the window. Confirmations fade out on their own;
// errors stay until clicked or replaced.
let noticeTimer = null;
function showNotice(message, isError) {
  const notice = byId('notice');
  notice.textContent = message;
  notice.classList.toggle('is-error', !!isError);
  notice.hidden = false;
  clearTimeout(noticeTimer);
  if (!isError) noticeTimer = setTimeout(() => { notice.hidden = true; }, NOTICE_MS);
}

// ======================================================================
// Formatting
// ======================================================================

const numberFormat = new Intl.NumberFormat();

function plural(count, word) {
  return numberFormat.format(count) + ' ' + word + (count === 1 ? '' : 's');
}

function timeAgo(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.round(seconds / 60) + ' min ago';
  if (seconds < 86400) return Math.round(seconds / 3600) + ' h ago';
  return Math.round(seconds / 86400) + ' d ago';
}

function durationText(seconds) {
  if (seconds < 90) return 'under 2 min';
  if (seconds < 5400) return 'about ' + Math.round(seconds / 60) + ' min';
  return 'about ' + Math.round(seconds / 3600) + ' h';
}

function bytesText(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// A short label for a session's browser, e.g. "Chrome on macOS".
function describeUserAgent(userAgent) {
  if (!userAgent) return 'Unknown browser';
  let browser = 'Browser';
  if (/Edg\//.test(userAgent)) browser = 'Edge';
  else if (/Firefox\/|FxiOS\//.test(userAgent)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(userAgent)) browser = 'Chrome';
  else if (/Safari\//.test(userAgent)) browser = 'Safari';
  let system = '';
  if (/iPhone/.test(userAgent)) system = 'iPhone';
  else if (/iPad/.test(userAgent)) system = 'iPad';
  else if (/Android/.test(userAgent)) system = 'Android';
  else if (/Mac OS X/.test(userAgent)) system = 'macOS';
  else if (/Windows/.test(userAgent)) system = 'Windows';
  else if (/Linux/.test(userAgent)) system = 'Linux';
  return system ? browser + ' on ' + system : browser;
}

// ======================================================================
// Folder paths
// ======================================================================

// A folder is held as its list of names, e.g. ['trips', 'a b'], and turned
// into text only at the edge: percent-encoded once for a URL, plain for
// people. Names never contain "/", so joining and splitting on it is exact.

// Gallery URL of a folder: "/" or "/trips/a%20b/".
function folderUrl(segments) {
  return '/' + segments.map(encodeURIComponent).join('/') + (segments.length ? '/' : '');
}

// The same folder for messages: "/" or "/trips/a b/".
function folderPathText(segments) {
  return '/' + segments.join('/') + (segments.length ? '/' : '');
}

// The form the JSON APIs take: "trips/2024" ("" for the root).
function folderRelativePath(segments) {
  return segments.join('/');
}

function folderDisplayName(segments) {
  return segments.length ? segments[segments.length - 1] : 'Galleries';
}

// This page's own URL for a folder: ?p= carries the plain path, encoded
// once here and decoded once by URLSearchParams below.
function adminUrlFor(segments) {
  return location.pathname + '?p=' + encodeURIComponent(folderPathText(segments));
}

function segmentsFromLocation() {
  const pathParam = new URLSearchParams(location.search).get('p') || '/';
  return pathParam.split('/').filter(Boolean);
}

function openFolder(segments) {
  history.pushState(null, '', adminUrlFor(segments));
  showFolder(segments);
}

function showFolder(segments) {
  state.folderSegments = segments;
  state.imageNames = null;
  byId('imagesSection').open = false;
  byId('trashSection').open = false;
  byId('imageFilter').value = '';
  byId('uploadList').replaceChildren();
  state.uploadBatch = newUploadBatch();
  renderUploadCount();
  showNewFolderForm(false);
  renderBreadcrumb();
  loadFolder();
}

// Link that navigates inside the panel on a plain click but still opens in a
// new tab on middle-click or Cmd/Ctrl-click.
function folderLink(anchor, segments) {
  anchor.href = adminUrlFor(segments);
  anchor.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openFolder(segments);
  });
}

function renderBreadcrumb() {
  const breadcrumb = byId('breadcrumb');
  breadcrumb.replaceChildren();
  const segments = state.folderSegments;
  if (!segments.length) return;
  for (let depth = 0; depth < segments.length; depth++) {
    const anchor = document.createElement('a');
    anchor.textContent = depth === 0 ? 'Galleries' : segments[depth - 1];
    folderLink(anchor, segments.slice(0, depth));
    const separator = document.createElement('span');
    separator.className = 'separator';
    separator.textContent = '/';
    breadcrumb.append(anchor, separator);
  }
}

// ======================================================================
// Current folder
// ======================================================================

async function loadFolder() {
  const segments = state.folderSegments;
  let info;
  try {
    info = await getJson('/api/admin/folder?path=' + encodeURIComponent(folderRelativePath(segments)));
  } catch (error) {
    if (error instanceof SignedOutError) return;
    if (segments.length) {
      showNotice('Could not open ' + folderPathText(segments) + ': ' + error.message + '. Showing the top level instead.', true);
      history.replaceState(null, '', adminUrlFor([]));
      showFolder([]);
    } else {
      showNotice('Could not load folders: ' + error.message, true);
    }
    return;
  }
  if (segments !== state.folderSegments) return;  // navigated away meanwhile
  state.folderInfo = info;
  state.lastFolderRefreshAt = Date.now();
  renderFolderSummary(info);
  renderSubfolders(info);
  byId('trashCount').textContent = numberFormat.format(info.trashCount);
  byId('imageCount').textContent = numberFormat.format(info.imageCount);
  if (byId('trashSection').open) loadTrash();
}

// One line for a folder's build state, with a CSS class for its colour.
function describeBuild(build, imageCount) {
  if (build.queued > 0) return { text: 'Building, ' + plural(build.queued, 'image') + ' left', className: 'status-busy' };
  if (!build.built) return { text: 'Not built yet', className: 'status-none' };
  if (imageCount === 0) return { text: 'Built', className: 'status-built' };
  return { text: 'Built ' + (build.builtAt ? timeAgo(build.builtAt) : ''), className: 'status-built' };
}

function renderFolderSummary(info) {
  const segments = state.folderSegments;
  byId('folderTitle').textContent = folderDisplayName(segments);
  document.title = folderDisplayName(segments) + ' · Goodgallery Admin';

  const facts = byId('folderFacts');
  facts.replaceChildren();
  const build = describeBuild(info.build, info.imageCount);
  const buildSpan = document.createElement('span');
  buildSpan.className = build.className;
  buildSpan.textContent = build.text;
  if (info.build.lastError) buildSpan.title = 'Last build error: ' + info.build.lastError;
  facts.append(
    plural(info.imageCount, 'image') + ' · ' + plural(info.subfolders.length, 'subfolder') + ' · ',
    buildSpan,
  );
  if (info.hidden) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'Hidden';
    badge.title = 'Not listed in its parent folder. Still reachable by direct URL.';
    facts.append(' ', badge);
  }

  renderNotYetBuilt(info.notYetBuilt);
  byId('openInGallery').href = folderUrl(segments);
  byId('trashFolderButton').hidden = info.isRoot;
  byId('rescanTreeButton').textContent = info.isRoot ? 'Rescan all folders' : 'Rescan this folder and all subfolders';
  byId('rebuildTreeButton').textContent = info.isRoot ? 'Rebuild every folder from scratch' : 'Rebuild this folder and all subfolders from scratch';
}

// The gallery serves the last committed build. Say what it does not show yet,
// which covers both a build still running and files dropped in by rsync.
function renderNotYetBuilt(notYetBuilt) {
  const parts = [];
  if (notYetBuilt) {
    const { images, folders } = notYetBuilt;
    if (images.added) parts.push(plural(images.added, 'image') + ' added');
    if (images.removed) parts.push(plural(images.removed, 'image') + ' removed');
    if (folders.added) parts.push(plural(folders.added, 'folder') + ' added');
    if (folders.removed) parts.push(plural(folders.removed, 'folder') + ' removed');
  }
  byId('folderNotYetBuilt').hidden = parts.length === 0;
  byId('folderNotYetBuiltText').textContent = 'Not in the gallery yet: ' + parts.join(', ') +
    '. It shows up when the folder\'s next build finishes. If nothing is building, rescan this folder.';
}

function renderSubfolders(info) {
  const list = byId('subfolderList');
  list.replaceChildren();
  if (!info.subfolders.length) {
    list.append(emptyRow('No subfolders.'));
    return;
  }
  for (const subfolder of info.subfolders) list.append(subfolderRow(subfolder));
}

function subfolderRow(subfolder) {
  const row = byId('subfolderRowTemplate').content.firstElementChild.cloneNode(true);
  const segments = state.folderSegments.concat(subfolder.name);
  row.classList.toggle('is-hidden', subfolder.hidden);

  const link = row.querySelector('.row-name');
  link.textContent = subfolder.name;
  folderLink(link, segments);

  const build = describeBuild(subfolder.build, subfolder.imageCount);
  const meta = row.querySelector('.row-meta');
  const counts = [];
  const hasOnlyFolders = subfolder.imageCount === 0 && subfolder.folderCount > 0;
  if (subfolder.imageCount != null && !hasOnlyFolders) counts.push(plural(subfolder.imageCount, 'image'));
  if (subfolder.folderCount) counts.push(plural(subfolder.folderCount, 'folder'));
  const buildSpan = document.createElement('span');
  buildSpan.className = build.className;
  buildSpan.textContent = build.text;
  meta.append(counts.length ? counts.join(', ') + ' · ' : '', buildSpan);

  const hiddenCheckbox = row.querySelector('input[type=checkbox]');
  hiddenCheckbox.checked = subfolder.hidden;
  hiddenCheckbox.addEventListener('change', () => setSubfolderHidden(subfolder.name, hiddenCheckbox));

  row.querySelector('button').addEventListener('click', () => trashFolder(segments));
  return row;
}

function emptyRow(text) {
  const row = document.createElement('li');
  row.className = 'row empty';
  row.textContent = text;
  return row;
}

async function setSubfolderHidden(name, checkbox) {
  const hide = checkbox.checked;
  checkbox.disabled = true;
  await runAction(hide ? 'Hide' : 'Unhide', async () => {
    try {
      await postFolderAction(folderUrl(state.folderSegments) + '?sethidden=' + encodeURIComponent(name) + '&hide=' + (hide ? 1 : 0));
    } catch (error) {
      checkbox.checked = !hide;
      throw error;
    }
    checkbox.closest('.row').classList.toggle('is-hidden', hide);
    return hide ? '"' + name + '" is hidden from the public folder list.' : '"' + name + '" is listed publicly again.';
  });
  checkbox.disabled = false;
}

async function trashFolder(segments) {
  const name = folderDisplayName(segments);
  if (!confirm('Move the folder "' + name + '" and everything in it to the trash?\n\nYou can restore it from the trash of its parent folder.')) return;
  await runAction('Move to trash', () => postFolderAction(folderUrl(segments) + '?deletefolder=1'));
  const isCurrentFolder = segments.length === state.folderSegments.length;
  if (isCurrentFolder) openFolder(segments.slice(0, -1));
  else loadFolder();
}

async function rescanCurrentFolder() {
  await runAction('Rescan', async () => {
    await postJson('/api/admin/rescanfolder', { folder: folderRelativePath(state.folderSegments) });
    return 'Rescanning ' + folderPathText(state.folderSegments) + '. Changes show up here as they build.';
  });
  setTimeout(loadFolder, 1500);
}

async function rescanCurrentTree() {
  const isRoot = state.folderSegments.length === 0;
  const where = isRoot ? 'all folders' : folderPathText(state.folderSegments) + ' and everything below it';
  await runAction('Rescan with subfolders', async () => {
    await postJson('/api/admin/rescanfolder', { folder: folderRelativePath(state.folderSegments), recursive: true });
    return 'Rescanning ' + where + '. Progress shows in the bar above.';
  });
  pollQueueOnce();
}

async function rebuildCurrentTree() {
  const isRoot = state.folderSegments.length === 0;
  const where = isRoot ? 'every folder' : folderPathText(state.folderSegments) + ' and everything below it';
  if (!confirm('Delete every thumbnail and atlas in ' + where + ' and build them all again from the originals?\n\nThis is the recursive rebuild. Folders are rebuilt one at a time and each shows "Building" until it finishes. On a large tree this takes hours.')) return;
  await runAction('Rebuild with subfolders', async () => {
    await postJson('/api/admin/rebuildtree', { folder: folderRelativePath(state.folderSegments) });
    return 'Rebuilding ' + where + ' from scratch. Progress shows in the bar above.';
  });
  pollQueueOnce();
  loadFolder();
}

async function rebuildCurrentFolder() {
  const where = folderPathText(state.folderSegments);
  if (!confirm('Delete every thumbnail and atlas in ' + where + ' and build them again from the originals?\n\nThis is a troubleshooting step, not routine maintenance. Subfolders are not touched. The folder shows "Building" until it finishes; large folders take a long time.')) return;
  await runAction('Rebuild', () => postFolderAction(folderUrl(state.folderSegments) + '?clearcache=1'));
  loadFolder();
}

// The create form stays out of the way until "+ New subfolder" is clicked.
function showNewFolderForm(show) {
  byId('newFolderForm').hidden = !show;
  byId('newFolderButton').hidden = show;
  if (show) byId('newFolderName').focus();
  else byId('newFolderName').value = '';
}

async function createSubfolder(event) {
  event.preventDefault();
  const input = byId('newFolderName');
  const name = input.value.trim();
  if (!name) return;
  await runAction('Create folder', async () => {
    await postFolderAction(folderUrl(state.folderSegments) + '?mkdir=' + encodeURIComponent(name));
    showNewFolderForm(false);
    return 'Created "' + name + '".';
  });
  loadFolder();
}

// ======================================================================
// Images in the current folder (loaded only when the section is opened;
// a folder can hold tens of thousands)
// ======================================================================

async function loadImages() {
  const segments = state.folderSegments;
  byId('imageListNote').textContent = 'Loading…';
  let data;
  try {
    data = await getJson(folderUrl(segments) + '?api=list');
  } catch (error) {
    if (!(error instanceof SignedOutError)) byId('imageListNote').textContent = 'Could not load images: ' + error.message;
    return;
  }
  if (segments !== state.folderSegments) return;
  state.imageNames = data.images;
  renderImages();
}

function renderImages() {
  if (!state.imageNames) return;  // still loading
  const names = state.imageNames;
  const filter = byId('imageFilter').value.trim().toLowerCase();
  const matches = filter ? names.filter(name => name.toLowerCase().includes(filter)) : names;
  const shown = matches.slice(0, IMAGE_LIST_LIMIT);

  const list = byId('imageList');
  list.replaceChildren();
  list.classList.add('scroll');
  for (const name of shown) list.append(imageRow(name));
  if (!names.length) list.append(emptyRow('No images in this folder.'));
  else if (!matches.length) list.append(emptyRow('No image names contain "' + filter + '".'));

  byId('imageListNote').textContent = matches.length > shown.length
    ? 'Showing ' + numberFormat.format(shown.length) + ' of ' + numberFormat.format(matches.length) + '. Type to narrow the list.'
    : '';
}

function imageRow(name) {
  const row = byId('imageRowTemplate').content.firstElementChild.cloneNode(true);
  const link = row.querySelector('.row-name');
  link.textContent = name;
  link.href = folderUrl(state.folderSegments) + encodeURIComponent(name);
  // Trash is reversible from the Trash section, so no confirmation.
  row.querySelector('button').addEventListener('click', () => trashImage(name, row));
  return row;
}

async function trashImage(name, row) {
  row.querySelector('button').disabled = true;
  await runAction('Move to trash', async () => {
    const message = await postFolderAction(folderUrl(state.folderSegments) + '?movetotrash=' + encodeURIComponent(name));
    state.imageNames = state.imageNames.filter(other => other !== name);
    renderImages();
    return message;
  });
  loadFolder();
}

// ======================================================================
// Trash of the current folder
// ======================================================================

async function fetchTrashItems(segments) {
  const data = await getJson('/api/trash?folder=' + encodeURIComponent(folderRelativePath(segments)));
  return data.items || [];
}

async function loadTrash() {
  const segments = state.folderSegments;
  let items;
  try {
    items = await fetchTrashItems(segments);
  } catch (error) {
    if (!(error instanceof SignedOutError)) showNotice('Could not load the trash: ' + error.message, true);
    return;
  }
  if (segments !== state.folderSegments) return;
  renderTrash(items);
}

function renderTrash(items) {
  const list = byId('trashList');
  list.replaceChildren();
  list.classList.add('scroll');
  byId('trashCount').textContent = numberFormat.format(items.length);
  byId('trashActions').hidden = items.length === 0;
  if (!items.length) { list.append(emptyRow('The trash is empty.')); return; }
  for (const item of items) list.append(trashRow(item));
}

function trashRow(item) {
  const row = byId('trashRowTemplate').content.firstElementChild.cloneNode(true);
  row.querySelector('.row-name').textContent = item.name + (item.isFolder ? '/' : '');
  const details = [item.isFolder ? 'folder' : bytesText(item.size), 'trashed ' + timeAgo(item.trashedAt)];
  row.querySelector('.row-meta').textContent = details.join(' · ');
  row.querySelector('[data-action=restore]').addEventListener('click', () => restoreFromTrash(item.name));
  row.querySelector('[data-action=delete]').addEventListener('click', () => deleteFromTrash(item.name));
  return row;
}

function trashRequestBody(extra) {
  return Object.assign({ folder: folderRelativePath(state.folderSegments) }, extra);
}

async function restoreFromTrash(name) {
  await runAction('Restore', async () => (await postJson('/api/trash/restore', trashRequestBody({ name }))).message);
  afterTrashChange();
}

async function deleteFromTrash(name) {
  if (!confirm('Permanently delete "' + name + '"? This cannot be undone.')) return;
  await runAction('Delete', async () => (await postJson('/api/trash/delete', trashRequestBody({ name }))).message);
  afterTrashChange();
}

async function restoreAllFromTrash() {
  await runAction('Restore all', async () => (await postJson('/api/trash/restoreAll', trashRequestBody())).message);
  afterTrashChange();
}

// The confirmation counts what is in the trash now, read again and shown
// first, and the request names exactly those items: anything trashed after
// that (from the gallery, another tab) stays in the trash.
async function emptyTrash() {
  const segments = state.folderSegments;
  let items;
  try {
    items = await fetchTrashItems(segments);
  } catch (error) {
    if (!(error instanceof SignedOutError)) showNotice('Could not load the trash: ' + error.message, true);
    return;
  }
  if (segments !== state.folderSegments) return;
  renderTrash(items);
  if (!items.length) { showNotice('The trash is already empty.'); return; }
  if (!confirm('Permanently delete ' + plural(items.length, 'item') + ' in the trash of ' + folderPathText(segments) + '? This cannot be undone.')) return;
  const names = items.map(item => item.name);
  await runAction('Empty trash', async () => (await postJson('/api/trash/empty', trashRequestBody({ names }))).message);
  afterTrashChange();
}

function afterTrashChange() {
  state.imageNames = null;
  if (byId('imagesSection').open) loadImages();
  loadFolder();  // also reloads the open trash list
}

// ======================================================================
// Build queue (server bar)
// ======================================================================

async function pollQueue() {
  if (document.visibilityState === 'visible' && !byId('app').hidden) {
    try {
      renderQueue(await getJson('/api/admin/queue'));
    } catch (error) {
      if (!(error instanceof SignedOutError)) {
        byId('queueStatus').textContent = 'Build queue unavailable: ' + error.message;
        byId('queueStatus').className = 'queue-status';
      }
    }
  }
  setTimeout(pollQueue, QUEUE_POLL_MS);
}

function renderQueue(queue) {
  const status = byId('queueStatus');
  const busy = queue.remaining > 0 || queue.rescanning.length > 0 || queue.rebuilding.length > 0;
  const parts = [];
  if (queue.remaining > 0) {
    let text = 'Building ' + plural(queue.remaining, 'image');
    if (queue.etaSeconds != null) text += ', ' + durationText(queue.etaSeconds) + ' left';
    parts.push(text);
  }
  for (const folder of queue.rescanning) {
    parts.push(folder === '' ? 'Rescanning all folders' : 'Rescanning ' + folder + '/ with subfolders');
  }
  for (const folder of queue.rebuilding) {
    parts.push(folder === '' ? 'Rebuilding every folder from scratch' : 'Rebuilding ' + folder + '/ with subfolders from scratch');
  }
  status.textContent = busy ? parts.join(' · ') : 'Idle';
  status.className = 'queue-status ' + (busy ? 'busy' : 'idle');
  byId('clearQueueButton').disabled = queue.remaining === 0;
  refreshFolderIfBuildMoved(queue.remaining);
}

// Keep the folder's build labels current without re-reading it on every poll:
// refresh when the queue drains, and at most every FOLDER_REFRESH_WHILE_BUILDING_MS
// while it is moving.
function refreshFolderIfBuildMoved(remaining) {
  const previous = state.lastQueueRemaining;
  state.lastQueueRemaining = remaining;
  if (previous === null || previous === remaining) return;
  const drained = remaining === 0;
  const due = Date.now() - state.lastFolderRefreshAt > FOLDER_REFRESH_WHILE_BUILDING_MS;
  if (drained || due) loadFolder();
}

async function clearQueue() {
  if (!confirm('Drop every queued image build?\n\nBuilds already running finish. Dropped images are built again on the next rescan or visit.')) return;
  await runAction('Clear queue', async () => {
    const result = await postJson('/api/admin/clearqueue');
    return 'Dropped ' + plural(result.dropped, 'queued build') + '.';
  });
  pollQueueOnce();
}

async function pollQueueOnce() {
  try { renderQueue(await getJson('/api/admin/queue')); } catch {}
}

// ======================================================================
// Uploads (chunked: create, chunks with SHA-256 and retry, finalize)
// ======================================================================

function setUpUploads() {
  setUpPageDrop();
  byId('pickFilesButton').addEventListener('click', () => byId('filePicker').click());
  byId('pickFolderButton').addEventListener('click', () => byId('folderPicker').click());
  byId('filePicker').addEventListener('change', handlePickedFiles);
  byId('folderPicker').addEventListener('change', handlePickedFolder);
}

// Files dropped anywhere on the page upload into the current folder; the
// drop zone only lights up to say so. dragenter and dragleave fire for every
// element the pointer crosses, so count them rather than trusting one leave.
let dragDepth = 0;

function dragHasFiles(event) {
  return Array.from((event.dataTransfer && event.dataTransfer.types) || []).includes('Files');
}

function setUpPageDrop() {
  document.addEventListener('dragenter', event => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragDepth++;
    document.body.classList.add('is-dragging');
  });
  document.addEventListener('dragover', event => {
    if (dragHasFiles(event)) event.preventDefault();
  });
  document.addEventListener('dragleave', event => {
    if (!dragHasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('is-dragging');
  });
  document.addEventListener('drop', event => {
    dragDepth = 0;
    document.body.classList.remove('is-dragging');
    if (!dragHasFiles(event)) return;
    if (byId('app').hidden) { event.preventDefault(); return; }  // signed out: don't open the file
    handleDrop(event);
  });
}

// Whatever is dropped or picked is listed first and then sent through one
// queue, so a folder tree uploads PARALLEL_UPLOADS files at a time just like a
// flat pick does, and the counter knows the total from the start.
async function handleDrop(event) {
  event.preventDefault();
  const targetSegments = state.folderSegments;
  const entries = Array.from(event.dataTransfer.items || [])
    .map(item => item.webkitGetAsEntry && item.webkitGetAsEntry())
    .filter(Boolean);
  const items = [];
  if (entries.length) {
    byId('uploadCount').textContent = 'Listing files';
    for (const entry of entries) await collectEntry(entry, targetSegments, items);
  } else {
    for (const file of event.dataTransfer.files || []) items.push({ file, folderSegments: targetSegments });
  }
  await uploadItems(items);
  finishUploads(targetSegments);
}

async function handlePickedFiles(event) {
  const targetSegments = state.folderSegments;
  const items = Array.from(event.target.files, file => ({ file, folderSegments: targetSegments }));
  await uploadItems(items);
  event.target.value = '';
  finishUploads(targetSegments);
}

// Each picked File carries webkitRelativePath like "Trip/day1/a.jpg".
async function handlePickedFolder(event) {
  const targetSegments = state.folderSegments;
  const filesByFolder = new Map();
  for (const file of event.target.files) {
    const subfolders = (file.webkitRelativePath || file.name).split('/').slice(0, -1);
    const key = subfolders.join('/');
    if (!filesByFolder.has(key)) filesByFolder.set(key, { subfolders, files: [] });
    filesByFolder.get(key).files.push(file);
  }
  const items = [];
  for (const { subfolders, files } of filesByFolder.values()) {
    const folderSegments = await createFolderChain(targetSegments, subfolders);
    for (const file of files) items.push({ file, folderSegments });
  }
  await uploadItems(items);
  event.target.value = '';
  finishUploads(targetSegments);
}

// Create each missing folder along parentSegments + subfolders. ?mkdir on an
// existing folder answers 409, which here just means it is already there.
async function createFolderChain(parentSegments, subfolders) {
  let segments = parentSegments;
  for (const name of subfolders) {
    try { await postFolderAction(folderUrl(segments) + '?mkdir=' + encodeURIComponent(name)); }
    catch (error) { if (error.status !== 409) throw error; }
    segments = segments.concat(name);
  }
  return segments;
}

// Walk a dropped file or directory entry, creating folders as it goes, and
// add every file found to items.
async function collectEntry(entry, parentSegments, items) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    items.push({ file, folderSegments: parentSegments });
    return;
  }
  if (!entry.isDirectory) return;
  const folderSegments = await createFolderChain(parentSegments, [entry.name]);
  const reader = entry.createReader();
  while (true) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const child of batch) await collectEntry(child, folderSegments, items);
  }
}

function finishUploads(targetSegments) {
  if (targetSegments === state.folderSegments) loadFolder();
}

async function uploadItems(items) {
  const images = items.filter(({ file }) => file.type && file.type.startsWith('image/'));
  const skipped = items.length - images.length;
  if (skipped) showNotice('Skipped ' + plural(skipped, 'file') + ' that ' + (skipped === 1 ? 'is' : 'are') + ' not an image.', true);
  const batch = state.uploadBatch;
  batch.total += images.length;
  renderUploadCount();
  let next = 0;
  async function worker() {
    while (next < images.length) {
      const item = images[next++];
      const row = addUploadRow(item.file, item.folderSegments);
      try {
        await uploadOneFile(item, row);
        batch.uploaded++;
      } catch (error) {
        setUploadRowState(row, 'failed', 'Failed: ' + error.message);
        batch.failed++;
      }
      renderUploadCount();
    }
  }
  await Promise.all(Array.from({ length: PARALLEL_UPLOADS }, worker));
}

// A row appears when its file starts, so the list reads top-down in upload
// order with the files in flight at the bottom. The list follows the newest
// row unless the user has scrolled up to look at an earlier one.
function addUploadRow(file, folderSegments) {
  const list = byId('uploadList');
  const row = byId('uploadRowTemplate').content.firstElementChild.cloneNode(true);
  const relativeFolder = folderSegments.slice(state.folderSegments.length).join('/');
  row.querySelector('.row-name').textContent = (relativeFolder ? relativeFolder + '/' : '') + file.name;
  row.querySelector('.row-meta').textContent = 'Starting';
  const wasAtBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 8;
  list.append(row);
  if (wasAtBottom) list.scrollTop = list.scrollHeight;
  return row;
}

// "12 of 300" in the card title, plus ", 2 failed" when any did. The
// numbers belong to the folder shown; opening another folder starts over.
function renderUploadCount() {
  const { total, uploaded, failed } = state.uploadBatch;
  let text = total ? uploaded + ' of ' + total : '';
  if (failed) text += ', ' + plural(failed, 'file') + ' failed';
  byId('uploadCount').textContent = text;
}

function setUploadRowState(row, stateName, text, fraction) {
  row.classList.toggle('done', stateName === 'done');
  row.classList.toggle('failed', stateName === 'failed');
  row.classList.toggle('retrying', stateName === 'retrying');
  row.querySelector('.row-meta').textContent = text;
  if (fraction != null) row.querySelector('progress').value = fraction;
}

async function uploadOneFile({ file, folderSegments }, row) {
  const upload = await postJson('/api/upload/create', {
    filename: file.name,
    size: file.size,
    targetFolder: folderUrl(folderSegments),
  });
  for (let index = 0; index < upload.totalChunks; index++) {
    const start = index * upload.chunkSize;
    const bytes = await file.slice(start, Math.min(start + upload.chunkSize, file.size)).arrayBuffer();
    await sendChunkWithRetry(upload.id, index, bytes, row);
    setUploadRowState(row, 'active', (index + 1) + ' of ' + upload.totalChunks + ' chunks', (index + 1) / upload.totalChunks);
  }
  setUploadRowState(row, 'active', 'Finishing');
  await requestJson('/api/upload/finalize/' + upload.id, { method: 'POST' });
  setUploadRowState(row, 'done', 'Uploaded', 1);
}

// Network blips must not lose a large batch: retry each chunk until it lands,
// backing off up to UPLOAD_RETRY_MAX_WAIT_MS.
async function sendChunkWithRetry(uploadId, index, bytes, row) {
  const hash = await sha256Hex(bytes);
  const headers = hash ? { 'X-Chunk-Hash': hash } : {};
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch('/api/upload/chunk/' + uploadId + '/' + index, {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: bytes,
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) { showSignIn(); throw new SignedOutError('signed out'); }
      if (response.ok) return;
      throw new Error(data.error || ('HTTP ' + response.status));
    } catch (error) {
      if (error instanceof SignedOutError) throw error;
      const waitMs = Math.min(attempt * 1000, UPLOAD_RETRY_MAX_WAIT_MS);
      setUploadRowState(row, 'retrying', 'Retry ' + attempt + ' in ' + (waitMs / 1000) + ' s (' + error.message + ')');
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
}

// Browsers only provide crypto.subtle on HTTPS or localhost. On plain http
// the chunk goes without a hash and the server skips that check.
async function sha256Hex(bytes) {
  if (!window.crypto || !window.crypto.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

// ======================================================================
// Sign-ins (sessions, login link, sign out)
// ======================================================================

async function loadSessions() {
  let data, status;
  try { [data, status] = await Promise.all([getJson('/api/admin/sessions'), getJson('/api/admin/status')]); }
  catch (error) {
    if (!(error instanceof SignedOutError)) showNotice('Could not load sign-ins: ' + error.message, true);
    return;
  }
  renderSessions(data.sessions, status.passkeyExists);
}

function renderSessions(sessions, passkeyExists) {
  const list = byId('sessionList');
  list.replaceChildren();
  const canManage = state.sessionOrigin === 'passkey';
  for (const session of sessions) list.append(sessionRow(session, canManage));
  byId('sessionCount').textContent = numberFormat.format(sessions.length);
  // The card is collapsed by default; a fresh install opens it so the
  // passkey offer and the server-command hint are seen.
  if (!passkeyExists) byId('access').open = true;
  const others = sessions.filter(session => !session.current).length;
  byId('revokeOthersButton').disabled = !canManage || others === 0;
  byId('loginLinkButton').disabled = !canManage;
  const createButton = byId('createPasskeyButton');
  createButton.hidden = passkeyExists || !state.canCreatePasskey;
  createButton.disabled = !window.PublicKeyCredential;
  byId('accessHint').textContent = accessHintText(canManage, passkeyExists);
}

function accessHintText(canManage, passkeyExists) {
  if (!passkeyExists && !state.canCreatePasskey) {
    return 'No passkey yet. Only a browser signed in with a link made on the server ("node server.js login-link") can create it.';
  }
  if (!passkeyExists) {
    return window.PublicKeyCredential
      ? 'No passkey yet. Create one to sign in without the server command. Only passkey sessions can create login links here; until then, make them on the server with "node server.js login-link".'
      : 'No passkey yet, and passkeys need HTTPS or localhost. Sign in with "node server.js login-link" on the server; only passkey sessions can create login links here.';
  }
  return canManage
    ? 'A session lasts until it signs out, is signed out here, or its browser loses the cookie.'
    : 'This browser signed in with a one-time link, so it cannot create links or sign out other sessions. Use a browser with the passkey for that.';
}

const SIGN_IN_METHODS = {
  'passkey': 'passkey',
  'server-link': 'login link from the server',
  'link': 'login link',
};

function sessionRow(session, canManage) {
  const row = byId('sessionRowTemplate').content.firstElementChild.cloneNode(true);
  row.querySelector('.row-name').textContent = describeUserAgent(session.userAgent) + (session.current ? ' (this browser)' : '');
  if (session.userAgent) row.querySelector('.row-name').title = session.userAgent;
  row.querySelector('.row-meta').textContent = 'Signed in ' + timeAgo(session.createdAt) + ' with ' + SIGN_IN_METHODS[session.origin];
  return row;
}

async function revokeOtherSessions() {
  if (!confirm('Sign out every other browser? Only this one stays signed in, and login links not used yet stop working.')) return;
  await runAction('Sign out others', async () => {
    const result = await postJson('/api/admin/sessions/revoke-others');
    const links = result.cancelledLinks ? ' and cancelled ' + plural(result.cancelledLinks, 'unused login link') : '';
    return 'Signed out ' + plural(result.revoked, 'other session') + links + '.';
  });
  loadSessions();
}

async function createLoginLink() {
  await runAction('Login link', async () => {
    const result = await postJson('/api/admin/login/link');
    const input = byId('loginLinkInput');
    input.value = result.link;
    byId('loginLinkDialog').showModal();
    input.select();
    return 'Login link created. It expires in ' + Math.round(result.ttlSeconds / 60) + ' minutes.';
  });
}

async function copyLoginLink() {
  const input = byId('loginLinkInput');
  const button = byId('copyLoginLinkButton');
  try {
    await navigator.clipboard.writeText(input.value);
    button.textContent = 'Copied';
  } catch {
    input.select();
    button.textContent = 'Press Ctrl+C / Cmd+C';
  }
  setTimeout(() => { button.textContent = 'Copy'; }, 2000);
}

async function signOut() {
  await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  byId('notice').hidden = true;
  startAuth();
}

// ======================================================================
// Passkey sign-in
// ======================================================================

function base64urlToBuffer(text) {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0)).buffer;
}

function bufferToBase64url(buffer) {
  const binary = String.fromCharCode.apply(null, new Uint8Array(buffer));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function startAuth() {
  const probe = await fetch('/api/admin/probe', { credentials: 'same-origin' }).catch(() => null);
  const data = probe ? await probe.json().catch(() => ({})) : null;
  if (data && data.admin) {
    state.sessionOrigin = data.origin || 'passkey';
    state.canCreatePasskey = !!data.canCreatePasskey;
    byId('version').textContent = data.version ? 'v' + data.version : '';
    showApp();
    return;
  }
  showSignIn();
}

async function showSignIn() {
  byId('app').hidden = true;
  byId('serverBar').hidden = true;
  byId('topbarLinks').hidden = true;
  byId('signIn').hidden = false;
  const title = byId('signInTitle');
  const text = byId('signInText');
  const command = byId('signInCommand');
  const button = byId('signInButton');
  button.disabled = true;

  const status = await fetch('/api/admin/status').then(response => response.json()).catch(() => null);
  if (!status) { byId('signInError').textContent = 'Cannot reach the server.'; return; }
  if (!status.passkeyExists) {
    // A fresh install has no way in except a link made on the server. That
    // is deliberate: an open "create passkey" button would make the first
    // visitor the admin.
    title.textContent = 'No admin yet';
    text.textContent = 'On the server, run this command and open the link it prints. The browser that opens it is signed in, and can create a passkey from the Sign-ins card if this page is on HTTPS.';
    command.hidden = false;
    button.hidden = true;
    return;
  }
  if (!window.PublicKeyCredential) {
    title.textContent = 'Passkeys unavailable here';
    text.textContent = 'Passkeys need HTTPS or localhost. Open this page there, or make a login link on the server:';
    command.hidden = false;
    button.hidden = true;
    return;
  }
  title.textContent = 'Sign in';
  text.textContent = 'Use your passkey to manage this gallery.';
  command.hidden = true;
  button.hidden = false;
  button.textContent = 'Sign in with passkey';
  button.onclick = signInWithPasskey;
  button.disabled = false;
}

async function signInWithPasskey() {
  const error = byId('signInError');
  error.textContent = '';
  await passkeyCeremony(byId('signInButton'), message => { error.textContent = message; }, async () => {
    const options = await postJson('/api/admin/login/start');
    options.challenge = base64urlToBuffer(options.challenge);
    options.allowCredentials = (options.allowCredentials || [])
      .map(credential => Object.assign({}, credential, { id: base64urlToBuffer(credential.id) }));
    const credential = await navigator.credentials.get({ publicKey: options });
    return postJson('/api/admin/login/finish', {
      id: credential.id,
      rawId: bufferToBase64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
        authenticatorData: bufferToBase64url(credential.response.authenticatorData),
        signature: bufferToBase64url(credential.response.signature),
        userHandle: credential.response.userHandle ? bufferToBase64url(credential.response.userHandle) : null,
      },
    });
  });
}

async function registerPasskey() {
  await passkeyCeremony(byId('createPasskeyButton'), message => showNotice('Create passkey failed: ' + message, true), async () => {
    const options = await postJson('/api/admin/register/start');
    options.challenge = base64urlToBuffer(options.challenge);
    options.user.id = base64urlToBuffer(options.user.id);
    const credential = await navigator.credentials.create({ publicKey: options });
    return postJson('/api/admin/register/finish', {
      id: credential.id,
      rawId: bufferToBase64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
        attestationObject: bufferToBase64url(credential.response.attestationObject),
      },
    });
  });
}

async function passkeyCeremony(button, reportError, ceremony) {
  button.disabled = true;
  try {
    await ceremony();
    startAuth();  // the server set the session cookie
  } catch (failure) {
    reportError(failure.message || 'Sign-in failed.');
  } finally {
    button.disabled = false;
  }
}

// ======================================================================
// Start-up
// ======================================================================

function showApp() {
  byId('signIn').hidden = true;
  byId('app').hidden = false;
  byId('serverBar').hidden = false;
  byId('topbarLinks').hidden = false;
  showFolder(segmentsFromLocation());
  loadSessions();
  pollQueueOnce();
}

function wireControls() {
  byId('clearQueueButton').addEventListener('click', clearQueue);
  byId('rescanFolderButton').addEventListener('click', rescanCurrentFolder);
  byId('rescanChangedButton').addEventListener('click', rescanCurrentFolder);
  byId('rebuildFolderButton').addEventListener('click', rebuildCurrentFolder);
  byId('rescanTreeButton').addEventListener('click', rescanCurrentTree);
  byId('rebuildTreeButton').addEventListener('click', rebuildCurrentTree);
  byId('trashFolderButton').addEventListener('click', () => trashFolder(state.folderSegments));
  byId('newFolderForm').addEventListener('submit', createSubfolder);
  byId('newFolderButton').addEventListener('click', () => showNewFolderForm(true));
  byId('cancelNewFolderButton').addEventListener('click', () => showNewFolderForm(false));
  byId('notice').addEventListener('click', () => { byId('notice').hidden = true; });
  byId('signInsLink').addEventListener('click', () => { byId('access').open = true; });
  byId('imagesSection').addEventListener('toggle', () => {
    if (byId('imagesSection').open && !state.imageNames) loadImages();
  });
  byId('imageFilter').addEventListener('input', renderImages);
  byId('trashSection').addEventListener('toggle', () => {
    if (byId('trashSection').open) loadTrash();
  });
  byId('restoreAllButton').addEventListener('click', restoreAllFromTrash);
  byId('emptyTrashButton').addEventListener('click', emptyTrash);
  byId('createPasskeyButton').addEventListener('click', registerPasskey);
  byId('loginLinkButton').addEventListener('click', createLoginLink);
  byId('copyLoginLinkButton').addEventListener('click', copyLoginLink);
  byId('revokeOthersButton').addEventListener('click', revokeOtherSessions);
  byId('signOutButton').addEventListener('click', signOut);
  window.addEventListener('popstate', () => showFolder(segmentsFromLocation()));
  setUpUploads();
}

wireControls();
startAuth();
setTimeout(pollQueue, QUEUE_POLL_MS);
