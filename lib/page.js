// Gallery page HTML.

import fs from 'fs';
import path from 'path';
import { GG_DIR, PUBLIC_DIR, SITE_TITLE } from './config.js';
import { hxEscape, jsLiteral, jsString } from './http.js';

// Cache-bust static assets by mtime so edits land without a restart while
// unchanged files stay browser-cached.
export function _assetVer(name) {
  try { return String(Math.floor(fs.statSync(path.join(PUBLIC_DIR, name)).mtimeMs)); }
  catch { return Date.now().toString(); }
}

export function galleryHTML({ urlPath, folders, hiddenFolders, images, spriteMeta, tileVersion, isAdminFlag, hasPasskey }) {
  // urlPath has leading and trailing /, e.g. "/" or "/vacation/2024/".
  const breadcrumbs = (() => {
    const parts = urlPath.split('/').filter(Boolean);
    let acc = '/';
    const out = [`<a href="/">${hxEscape(SITE_TITLE)}</a>`];
    for (const p of parts) {
      acc += encodeURIComponent(p) + '/';
      out.push(`<a href="${hxEscape(acc)}">${hxEscape(p)}</a>`);
    }
    return out.join('');
  })();

  // Hidden folders: filtered out for anon, tagged for admin.
  const hiddenSet = new Set(hiddenFolders || []);
  const visibleFolders = isAdminFlag ? folders : folders.filter(n => !hiddenSet.has(n));
  const folderCards = visibleFolders.map(name => {
    const href = encodeURIComponent(name) + '/';
    const isHidden = hiddenSet.has(name);
    const cls = isHidden ? 'folder folder-hidden' : 'folder';
    const tag = isHidden ? '<span class="folder-hidden-tag">(hidden)</span>' : '';
    return `<a class="${cls}" href="${hxEscape(href)}"><span class="folder-icon">📁</span><span class="folder-name">${hxEscape(name)}</span>${tag}</a>`;
  }).join('');

  const lastImageValue = images.length;
  // New layout: atlas_<hash>/_imagemap.bin. Legacy (no atlasDir): flat gg/_imagemap.bin.
  const _atlasSub = (spriteMeta && spriteMeta._atlasDir) ? (spriteMeta._atlasDir + '/') : '';
  const imagemapURL = spriteMeta ? jsString(urlPath + GG_DIR + '/' + _atlasSub + '_imagemap.bin') : 'null';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
<title>${hxEscape(SITE_TITLE)} — ${hxEscape(urlPath)}</title>
<link rel="stylesheet" href="/_static/goodgallery.css?v=${_assetVer('goodgallery.css')}" />
<link rel="icon" type="image/svg+xml" href="/_static/favicon.svg" />
</head>
<body>

<div id="topcontrols">
<header id="topbar">
  <nav id="breadcrumb">${breadcrumbs}</nav>
  <a id="adminlink" href="/_admin/" title="Admin">⚙</a>
</header>

<div id="adminnotify"></div>

${visibleFolders.length ? `<details id="foldersWrap"${images.length ? '' : ' open'}><summary>folders (${visibleFolders.length})</summary><nav id="folders">${folderCards}</nav></details>` : ''}

<div id="prevnext">
  <div id="zoomControl" class="zoom-control"></div>
</div>

<div id="counter"></div>
<div id="realtime"></div>
</div>
<div id="topreveal" aria-label="Show controls"></div>
<div id="thumbs"></div>

<script>
var images           = [null];
var lastimagevalue   = ${lastImageValue};
var isadmin          = ${isAdminFlag ? 1 : 0};
var hasPasskey       = ${hasPasskey ? 'true' : 'false'};
var folderURL        = ${jsString(urlPath)};
var spriteMeta       = ${spriteMeta ? jsLiteral(spriteMeta) : 'null'};
var imagemapURL      = ${imagemapURL};
var tileVersion      = ${Number(tileVersion) || 0};
</script>
<script src="/_static/gallery.js?v=${_assetVer('gallery.js')}"></script>

</body>
</html>`;
}
