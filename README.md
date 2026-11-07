# Goodgallery

A web-based photo gallery solution focusing on ui and performance. One Node.js process, no npm
dependencies, libvips for image work, a WebGL grid on the client. Built and
tested against galleries of 100,000 images.

What makes it different:

- **Sprite-atlas thumbnails.** Small zoom levels are served as a handful of
  atlas images instead of one request per thumbnail, so a 100k-image grid
  scrolls end to end without the browser ever issuing 100k requests.
- **Resolution ladder.** Every image gets AVIF renditions at heights of
  200 to 1600 px plus lossless atlas tiers; the client picks the tier that
  matches the current zoom and viewport.
- **Folders are galleries.** Point it at a directory tree. Each folder is a
  gallery; subfolders show as cards. Add images with the built-in uploader
  or by copying files in and pressing Full rescan.
- **Passkey admin.** One WebAuthn passkey, no passwords, no accounts table.

## Requirements

- Node.js 20 or newer
- libvips command-line tools with AVIF and SVG support. On Debian 13 that is
  `apt install libvips-tools`. The server refuses to start if `vips`,
  `vipsthumbnail` or `vipsheader` are missing.
- Optional: HTTPS in front of it (nginx, Caddy, a tunnel). Browsers only
  offer passkeys on secure origins, so passkey sign-in needs HTTPS or
  `localhost`; without it you sign in with links made on the server. The
  server itself speaks plain HTTP and sets the `Secure` cookie flag when it
  sees `X-Forwarded-Proto: https`.

## Install

```sh
apt install -y nodejs libvips-tools
useradd -r -s /usr/sbin/nologin -d /var/lib/goodgallery goodgallery
git clone <this repo> /opt/goodgallery
mkdir -p /var/lib/goodgallery/galleries
chown -R goodgallery:goodgallery /var/lib/goodgallery
install -m 644 /opt/goodgallery/goodgallery.service /etc/systemd/system/
systemctl enable --now goodgallery
```

The unit runs as the `goodgallery` user on port 3000 with galleries under
`/var/lib/goodgallery/galleries` and state under `/var/lib/goodgallery`.
Edit the `Environment=` lines to change any of that.

To run it by hand instead: `node server.js`.

## First run

1. On the server, run `node server.js login-link` (as root or as
   `goodgallery`, from `/opt/goodgallery`) and open the link it prints within
   10 minutes. The browser that opens it is signed in for 24 hours. There is
   no other way in on a fresh install, so nobody can claim the admin by
   reaching the URL first.
2. Optional, on HTTPS: open `/_admin2/` and press **Create passkey** in the
   Sign-ins card. From then on the passkey signs in directly, and only
   passkey sessions can create login links from the page. Without HTTPS,
   keep using the server command. Lost the passkey? Delete `passkey.json`
   in the state dir and enroll again from a server-made link.
3. Create a folder or upload images from the admin page, or copy a directory
   of images into the galleries root (owned by `goodgallery`) and press
   **Full rescan**.
4. Open `https://your-host/`. The first visit to a folder builds its
   renditions and atlases in the background and shows progress; later visits
   are served from the committed build.

Supported source formats: JPEG, PNG, GIF, WebP, AVIF. Images libvips cannot
read get a red placeholder tile instead of breaking the gallery.

## Admin page

`/_admin/` lists folders and images, uploads files or whole folders (chunked,
resumable), creates folders, hides folders from public listings (they stay
reachable by direct URL), moves images and folders to a per-folder trash,
restores or empties that trash, clears a folder's derived cache, and runs a
full rescan. **Generate login link** mints a one-time URL that signs in
another browser for 24 hours; useful on a device that cannot use your
passkey. Only passkey sessions can mint links from the page;
`node server.js login-link` on the server always can.

## On-disk layout

Each gallery folder keeps all derived state in a `gg/` subdirectory next to
the originals:

```
<folder>/<image>.jpg
<folder>/gg/<image>.jpg.h200.avif     per-image renditions (h5..h1600)
<folder>/gg/atlas_<hash>/             sprite atlases + imagemap for this build
<folder>/gg/_manifest.json            the committed listing a pageview renders from
<folder>/gg/trash/                    soft-deleted images and folders
<folder>/gg/hidden                    sentinel: folder is hidden from listings
```

Everything in `gg/` except `trash/` and `hidden` is a cache and can be
deleted; the next visit rebuilds it. `trash/` and `hidden` are user state.

A manifest is only written after every file it references exists, so an
interrupted build never leaves a half-served gallery; it just rebuilds.

## Configuration

Environment variables, all optional:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `GALLERIES_ROOT` | `/var/lib/goodgallery/galleries` | Root of the gallery tree |
| `STATE_DIR` | `/var/lib/goodgallery` | Passkey, sessions, in-progress uploads, placeholder tiles |
| `SITE_TITLE` | `Goodgallery` | Shown in the page title and breadcrumb |
| `BUILD_CONCURRENCY` | CPU count | Parallel vips processes during builds (each runs at nice 10) |
| `MAX_SPRITE_BYTES` | 4 MiB | Target size of one atlas image |
| `BYTES_PER_PIXEL` | `0.30` | Estimated AVIF bytes per pixel, used to size atlases |
| `SPRITE_CELL_W_MAX` | `600` | Widest atlas cell, in pixels |
| `AVIF_MAX_DIM` | `16384` | libheif per-axis limit; extreme panoramas are bounded to this width |
| `CHUNK_SIZE` | 16 MiB | Upload chunk size |

## Layout of the code

- `server.js` creates the HTTP server; everything else is in `lib/`.
- `lib/router.js` dispatches requests; `lib/page.js` renders the gallery page.
- `lib/rebuild.js` is the one place a folder's build is committed, using
  `lib/build.js` (per-image renditions), `lib/build_queue.js` and
  `lib/atlas.js` (atlases, baked in `lib/sprite_worker.js`).
- `lib/auth.js`, `lib/webauthn.js` and `lib/admin_api.js` handle the passkey
  admin; `lib/upload.js` the chunked uploader; `lib/trash.js` the trash.
- `public/gallery.js` is the client: layout, WebGL grid, focus view.
