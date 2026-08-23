#!/bin/sh
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node --test "$REPO_ROOT/tests/web-search.test.mjs"
