#!/bin/bash
# Rebuild minified gallery.js for ggdemo. Run from CT 117.
set -e
SRC=/opt/goodgallery/public/gallery.js
OUT=/opt/goodgallery/public/gallery.min.js
/usr/local/bin/esbuild "$SRC" --minify --target=es2017 --outfile="$OUT" --legal-comments=none
echo "built $(wc -c < $OUT) bytes (from $(wc -c < $SRC))"
