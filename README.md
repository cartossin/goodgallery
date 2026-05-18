# Goodgallery 2.0 (Node.js rewrite)

Fast, scalable photo gallery. Vanilla JS client, zero npm runtime deps, image
resizing via libvips (`vipsthumbnail`).

Per-gallery derived state (manifest, sprite atlases, per-image AVIF LoDs,
trash) lives in a single `gg/` subdirectory alongside the originals.

Folder hierarchy, mobile-friendly UI, WebAuthn admin enrollment, admin
upload of files and folders.

## Run

    apt install -y nodejs npm git libvips-tools
    node server.js

Env vars: `PORT` (3000), `GALLERIES_ROOT` (/var/lib/goodgallery/galleries),
`STATE_DIR` (/var/lib/goodgallery), `SITE_TITLE`, `THUMBS_PER_PAGE`,
`THUMB_DIM`, `PREVIEW_DIM`, `PREVIEW_SIZE_THRESHOLD`.
