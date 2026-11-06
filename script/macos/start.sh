#!/usr/bin/env bash
set -eu

if [[ $(uname -s) != Darwin ]]; then
    printf 'This launcher requires macOS.\n' >&2
    exit 1
fi

exec bash "$(dirname "${BASH_SOURCE[0]}")/../unix/start.sh" "$@"
