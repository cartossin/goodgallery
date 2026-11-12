# Goodgallery

A web-based photo gallery solution focusing on ui and performance. One Node.js process, no npm
dependencies, libvips for image work, a WebGL grid on the client. Built and
tested against galleries of 100,000 images.

What makes it different:

- **Sprite-atlas thumbnails.** Small zoom levels are served as a handful of
  atlas images instead of one request per thumbnail, so a 100k-image grid
  scrolls end to end without the browser ever issuing 100k requests.
- **Resolution ladder.** Every image gets AVIF renditions at heights of
  200 to 1600 px, plus small copies 5 to 100 px high that are packed into
  the atlases; the client picks the tier that matches the current zoom and
  viewport. The small copies are kept lossless only until they are packed:
  the atlas images sent to browsers are AVIF at quality 80, so a thumbnail
  is compressed once.
- **Folders are galleries.** Point it at a directory tree. Each folder is a
  gallery; subfolders show as cards. Add images with the built-in uploader
  or by copying files in and rescanning.
- **No passwords.** Admin sign-in is a one-time link made on the server, or
  an optional WebAuthn passkey once you have HTTPS. Nothing to choose badly,
  nothing to leak, no accounts table.

## Requirements

- Linux. That is where it is developed and tested. On Windows or macOS, run
  it in a Linux VM, a container, or WSL 2 with the galleries on the Linux
  filesystem. Running it natively on Windows is not supported yet.
- Node.js 18 or newer. The packages in Debian 13 (20.19) and Ubuntu 24.04
  (18.19) both work.
- libvips 8.13 or newer, command-line tools, with AVIF and SVG support.
  AVIF needs libheif's AV1 encoder, a separate package on Debian and Ubuntu
  (`libheif-plugin-aomenc`) that `apt install --no-install-recommends` and
  many container images leave out. At startup the server checks the
  version, encodes a tiny AVIF, and refuses to start, naming what is
  missing, if `vips`, `vipsthumbnail` or `vipsheader` are missing, libvips
  is older than 8.13 (needed to keep its risky loaders away from uploaded
  files), or the AVIF encode fails.
- Optional: HTTPS in front of it (nginx, Caddy, a tunnel). Browsers only
  offer passkeys on secure origins, so passkey sign-in needs HTTPS or
  `localhost`; without it you sign in with links made on the server. The
  server itself speaks plain HTTP and sets the `Secure` cookie flag when it
  sees `X-Forwarded-Proto: https`. Serve it at the root of a host name
  (`https://photos.example.com/`); hosting under a path prefix
  (`https://example.com/photos/`) is not supported, because every URL it
  makes starts at `/`.

## Install

Debian 13 or Ubuntu 24.04:

```sh
apt update && apt install -y git nodejs libvips-tools libheif-plugin-aomenc
useradd -r -s /usr/sbin/nologin -d /var/lib/goodgallery goodgallery
git clone https://github.com/cartossin/goodgallery.git /opt/goodgallery
mkdir -p /var/lib/goodgallery/galleries
chown -R goodgallery:goodgallery /var/lib/goodgallery
install -m 644 /opt/goodgallery/goodgallery.service /etc/systemd/system/
systemctl enable --now goodgallery
```

Rocky Linux or RHEL 9: the default Node stream is 16 and libvips is not in
EPEL, so the first line becomes

```sh
dnf module enable -y nodejs:22
dnf install -y git nodejs epel-release
dnf install -y https://rpms.remirepo.net/enterprise/remi-release-9.rpm
dnf install -y vips-tools vips-heif
```

and the rest is the same. `vips-heif` is the AVIF support; the server
needs it.

Each of these was run on a fresh container of that distro, followed by the
first-run steps below.

The unit runs as the `goodgallery` user on port 3000 with galleries under
`/var/lib/goodgallery/galleries` and state under `/var/lib/goodgallery`.
To change any of that, put the settings in `/etc/goodgallery.env` (see
Configuration) and restart the service. Edit that file rather than the
unit: `node server.js login-link` reads the same file, so the link it makes
points at the port the service listens on and is written where the service
looks for it.

Upgrading from a version whose unit has `Environment=PORT=...` lines: that
unit keeps working as it is. If you changed those values, move them into
`/etc/goodgallery.env` when you install the new unit, or `login-link` will
not know them.

The unit sets `UMask=0077`, so the photos and folders the service creates
(uploads, folders made on the admin page) are readable only by the
`goodgallery` user. If other users or a file share (SMB, NFS) must read
them, override it with `systemctl edit goodgallery`:
`[Service]` then `UMask=0022`. The sign-in files in the state dir
(passkey, sessions, login links) stay private either way.

To run it by hand instead: `node server.js`. It then takes its settings
from its own environment only.

## First run

1. On the server, as root, run
   `node /opt/goodgallery/server.js login-link` and open the link it prints
   within 10 minutes. It reads `/etc/goodgallery.env` as the service does,
   and leaves its file owned by the state dir's owner, so the service can
   read it. To run it as the service user instead (it has no login shell,
   so `su` does not work):
   `sudo -u goodgallery node /opt/goodgallery/server.js login-link`. The
   browser that opens the link stays signed in until it signs out, is
   signed out from the admin page, or loses the cookie. There is no other
   way in on a fresh install, so nobody can claim the admin by reaching the
   URL first. A link that has expired or was already used says so on the
   page.
2. Optional, on HTTPS or at `http://localhost`: open `/_admin/` and press
   **Create passkey** in the Sign-ins card. From then on the passkey signs
   in directly, and only passkey sessions can create login links from the
   page. Browsers refuse passkeys over plain HTTP at any address but
   `localhost`, and at an IP address even over HTTPS, so not at
   `http://127.0.0.1` either; there, keep using the server command. Lost
   the passkey? Delete `passkey.json` in the state dir and enroll again
   from a server-made link.

   A passkey belongs to the exact address it was created at: scheme, host
   name and port. One created at `http://localhost:3000` (for example
   through an SSH tunnel) does not work at `https://photos.example.com`,
   and the page allows one passkey. To move to the real address: sign in
   there with a server-made link, delete `passkey.json` in the state dir,
   and press **Create passkey** at the new address.
3. Create a folder or upload images from the admin page, or copy a directory
   of images into the galleries root, give it to the service user
   (`chown -R goodgallery:goodgallery <folder>`: a folder the service
   cannot write cannot be built, and the admin page says so), and press
   **Rescan all folders**
   (under Troubleshooting on the admin page).
4. Open `http://your-host:3000/` (or whatever your proxy serves); the
   server prints the address when it starts. The first visit to a folder
   builds its renditions and atlases in the background and shows
   progress; later visits are served from the committed build.

Everything in the galleries root is public: every photo, in full, with the
metadata embedded in the file, such as the GPS position where it was taken,
the camera and the author. The AVIF renditions keep that metadata too.
Remove it from the originals before adding them if it should stay private.
A hidden folder is only left out of listings; anyone with its address can
open it.

Supported source formats: JPEG, PNG, GIF, WebP, AVIF. A photo libvips cannot
read, one above the pixel limit (`MAX_SOURCE_MEGAPIXELS`), or one whose
conversion failed gets a red placeholder tile instead of breaking the
gallery, and the admin page names it and says why. Rescanning the folder
tries failed conversions again. A photo whose file name is longer than 233
bytes is left out, with a line in the log: its renditions' names would not
fit the filesystem's 255-byte limit.

## Admin page

`/_admin/` is the admin panel. It
shows the build queue, and for the current folder: counts and build state,
a notice when files on disk are not in the gallery yet, subfolders with
hide toggles, uploads of files or whole folders (chunked, several files in
flight), the image list, and the folder's trash. A chunk that fails because
of the network or a server error is sent again, so an upload survives a
brief network drop; a chunk the server refuses is not. An upload does not survive
reloading or closing the page, which starts the file over (the chunks
already sent are removed after 24 hours). Folders can be
created, hidden from public listings (they stay reachable by direct URL),
trashed, restored, emptied, rebuilt from scratch, or rescanned, and the
whole tree can be rescanned after copying files in.

The Sign-ins card lists every signed-in browser. **Create login link** mints
a one-time URL that signs in another browser; useful on a device that
cannot use your passkey. Only passkey sessions can mint links from the
page; `node server.js login-link` on the server always can. **Sign out all
other sessions** ends every session but the current one and cancels every
login link that has not been used yet. Sessions do not expire on their own.

The passkey and the sessions are files in the state dir (`passkey.json`,
`sessions.json`). If one of them is damaged the server refuses to start
and names the file, rather than treating it as absent.

## On-disk layout

Each gallery folder keeps all derived state in a `gg/` subdirectory next to
the originals:

```
<folder>/<image>.jpg
<folder>/gg/<image>.jpg.h200.avif     per-image renditions, AVIF (h200..h1600)
<folder>/gg/<image>.jpg.h5.v          small lossless copies, the atlas input (h5..h100)
<folder>/gg/atlas_<id>/               sprite atlases + imagemap for this build
<folder>/gg/_manifest.json            the committed listing a pageview renders from
<folder>/gg/_sources.json             size and time of each photo at the last build
<folder>/gg/_placeholders.json        photos shown as placeholders, and why
<folder>/gg/trash/                    soft-deleted images and folders
<folder>/gg/hidden                    sentinel: folder is hidden from listings
```

`trash/` and `hidden` are user state; keep them. Everything else in `gg/` is
built from the photos. Deleting all of it at once is safe: the next visit
rebuilds the folder. Deleting only part of it is repaired too: a missing
`atlas_` directory on the next visit, missing renditions at the next rescan
or restart. To rebuild a folder completely, delete all of it but `trash/`
and `hidden`, or use **Rebuild from scratch** on the admin page.

A manifest is only written after every file it references exists, so an
interrupted build never leaves a half-served gallery; it just rebuilds.

## Configuration

Environment variables, all optional. For the systemd service, put them in
`/etc/goodgallery.env`, one `VARIABLE=value` per line (lines starting with
`#` are comments; no `export`), for example:

```sh
PORT=8080
GALLERIES_ROOT=/srv/photos
```

The server checks every value when it starts and refuses to start with a
message naming the variable if one is not valid. Sizes are bytes, or a
whole number with `KiB`, `MiB`, `GiB` or `TiB` (`16MiB` or `16 MiB`; `MB`
is refused as ambiguous).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Listen port (1 to 65535) |
| `HOST` | `0.0.0.0` | Listen address |
| `GALLERIES_ROOT` | `/var/lib/goodgallery/galleries` | Root of the gallery tree; everything in it is public |
| `STATE_DIR` | `/var/lib/goodgallery` | Passkey, sessions, server-made login links, in-progress uploads, placeholder tiles. Must not be inside `GALLERIES_ROOT` |
| `SITE_TITLE` | `Goodgallery` | Shown in the page title and breadcrumb |
| `BUILD_CONCURRENCY` | CPU count | Parallel vips processes during builds (each runs at nice 10); `0` means CPU count |
| `MAX_SPRITE_BYTES` | `4MiB` | Target size of one atlas image (64 KiB to 64 MiB) |
| `BYTES_PER_PIXEL` | `0.30` | Estimated AVIF bytes per pixel, used to size atlases |
| `SPRITE_CELL_W_MAX` | `600` | Widest atlas cell, in pixels |
| `SPRITE_ENCODE_PARALLEL` | `4` | Atlas images encoded at once while a folder bakes |
| `AVIF_MAX_DIM` | `16384` | libheif per-axis limit; extreme panoramas are bounded to this width |
| `MAX_SOURCE_MEGAPIXELS` | `300` | Photos with more pixels than this get a placeholder instead of being decoded (memory follows the pixel count, not the file size) |
| `VIPS_TIMEOUT_SECONDS` | `600` | A vips process running longer than this is stopped and its photo counted as a failed conversion |
| `CHUNK_SIZE` | `16MiB` | Upload chunk size (64 KiB to 1 GiB) |
| `MAX_UPLOAD_BYTES` | `64GiB` | Largest file the uploader accepts |
| `VIPS_CONCURRENCY` | `1` | Threads inside each vips process. Builds run several processes instead (`BUILD_CONCURRENCY`) |
| `GG_DEBUG_BUILDS` | unset | Any value logs a line for every photo the build queue looks at |
| `GG_ENV_FILE` | `/etc/goodgallery.env` | The settings file `login-link` reads (the unit's `EnvironmentFile=` must name the same file) |

## Layout of the code

- `server.js` creates the HTTP server and runs the `login-link` command
  (`lib/login_link.js`); everything else is in `lib/`.
- `lib/config.js` reads and checks the settings; `lib/env_file.js` reads
  the settings file for `login-link`.
- `lib/router.js` dispatches requests; `lib/http.js` holds the response,
  cookie and static-file helpers; `lib/paths.js` maps URLs to folders;
  `lib/page.js` renders the gallery page.
- `lib/manifest.js` keeps each folder's listing (`_manifest.json`) and
  `lib/sources.js` the record of its photos at the last build
  (`_sources.json`).
- `lib/rebuild.js` is the one place a folder's build is committed, using
  `lib/build_plan.js` (which sizes each photo still needs), `lib/build.js`
  (per-image renditions, through the libvips helpers in `lib/vips.js`),
  `lib/build_queue.js`, `lib/placeholders.js` (which photos are shown as
  placeholders, and why) and `lib/atlas.js` (atlases, baked in
  `lib/sprite_worker.js`).
- `lib/auth.js`, `lib/webauthn.js` and `lib/admin_api.js` handle the passkey
  admin; `lib/upload.js` the chunked uploader; `lib/trash.js` the trash;
  `lib/place.js` puts a file under a name without replacing one that is
  there.
- `public/gallery.js` is the client: layout, WebGL grid, focus view.
- `public/admin.html`, `admin.css`, `admin.js` are the admin panel.

## How it was written

Designed and directed by Cory Salvesen, who wrote the original PHP
Goodgallery in 2007. Most of the code in this rewrite was written with Claude
(Anthropic) as a coding collaborator, which is why the commits carry a
co-author line.
