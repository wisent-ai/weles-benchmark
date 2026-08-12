#!/bin/sh
set -eu

archive="$HOME/.stado/files/weles-benchmark-results.tgz"
if [ ! -r "$archive" ]; then
  printf 'missing benchmark results archive: %s\n' "$archive" >&2
  exit 1
fi
exec /usr/bin/base64 "$archive"
