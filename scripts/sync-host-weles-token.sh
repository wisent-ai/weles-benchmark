#!/bin/sh
set -eu

source_file="$HOME/.weles/secrets.env"
destination="$HOME/.stado/weles-benchmark-api-token"
if [ ! -r "$source_file" ]; then
  printf 'missing Weles API environment: %s\n' "$source_file" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$source_file"
set +a
token="${WELES_API_TOKEN:-${WELES_CONSOLE_API_TOKEN:-}}"
if [ -z "$token" ]; then
  printf 'Weles API environment contains no API token\n' >&2
  exit 1
fi

umask 077
printf '%s\n' "$token" >"$destination"
printf 'Weles benchmark API token synchronized\n'
