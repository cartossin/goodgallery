# Goodgallery 2.0 (Node.js rewrite)

Fast, scalable photo gallery. Vanilla JS client, zero npm runtime deps, image
resizing via libvips (`vipsthumbnail`).

Preserves the URL/data layout of the 2014 PHP build:
```
GALLERIES_ROOT/<path>/<image>                    # original
GALLERIES_ROOT/<path>/thumbcache/<image>.resized.jpg
GALLERIES_ROOT/<path>/previewcache/<image>.resized.jpg   # only for originals >= 500KB
GALLERIES_ROOT/<path>/ggTrash/<image>             # soft-deleted
```

New: folder hierarchy, mobile-friendly UI, WebAuthn admin enrollment,
admin upload of files and folders.

## Run

    apt install -y nodejs npm git libvips-tools
    node server.js

Env vars: `PORT` (3000), `GALLERIES_ROOT` (/var/lib/goodgallery/galleries),
`STATE_DIR` (/var/lib/goodgallery), `SITE_TITLE`, `THUMBS_PER_PAGE`,
`THUMB_DIM`, `PREVIEW_DIM`, `PREVIEW_SIZE_THRESHOLD`.
