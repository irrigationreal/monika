#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
PYTHONPATH="${PWD}/services/art-workshop${PYTHONPATH:+:${PYTHONPATH}}" \
  python3 -m unittest discover -s tests/art-workshop -p 'test_*.py' -v
