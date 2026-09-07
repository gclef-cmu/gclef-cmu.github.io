#!/bin/bash
# Rebuilds the site whenever a content or asset file changes.
# Uses a snapshot hash (path+size+mtime) instead of "-newer <marker>" so that
# files with preserved/backdated timestamps (e.g. downloaded from Google Drive)
# are still detected as new.
cd "$(dirname "$0")/.." || exit 1

snapshot() {
  find . \
    -not -path './node_modules/*' \
    -not -path './_site/*' \
    -not -path './.git/*' \
    -type f \
    \( -name '*.md' -o -name '*.json' -o -name '*.js' -o -name '*.yml' \
       -o -name '*.html' -o -name '*.css' \
       -o -path './static/pdfs/*' -o -path './static/previews/*' \) \
    -exec stat -f '%N %z %m' {} \; 2>/dev/null | sort | md5
}

LAST="$(snapshot)"

while true; do
  sleep 1
  CURRENT="$(snapshot)"
  if [ "$CURRENT" != "$LAST" ]; then
    echo "[watch] change detected, rebuilding..."
    node .render/render.js
    LAST="$(snapshot)"
  fi
done
