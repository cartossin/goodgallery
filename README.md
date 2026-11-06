# Goodgallery 2.0 (Node.js rewrite)

Fast, scalable photo gallery. Vanilla JS client, zero npm runtime deps, image
resizing via libvips (`vipsthumbnail`).

Per-gallery derived state (manifest, sprite atlases, per-image AVIF LoDs,
trash) lives in a single `gg/` subdirectory alongside the originals.

Folder hierarchy, mobile-friendly UI, WebAuthn admin enrollment, admin
upload of files and folders.

## Run

    apt install -y nodejs libvips-tools
    node server.js

Env vars: `PORT` (3000), `HOST` (0.0.0.0), `GALLERIES_ROOT`
(/var/lib/goodgallery/galleries), `STATE_DIR` (/var/lib/goodgallery),
`SITE_TITLE` (Goodgallery).

Tuning knobs (defaults usually fine): `MAX_SPRITE_BYTES`,
`BYTES_PER_PIXEL`, `BUILD_CONCURRENCY`, `AVIF_MAX_DIM`,
`SPRITE_CELL_W_MAX`, `SPRITE_DEBOUNCE_MS`, `CHUNK_SIZE`.
