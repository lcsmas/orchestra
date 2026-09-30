#!/usr/bin/env bash
# Build the exec/connect logger next to its source. Output (execlog.so) is gitignored.
set -eu
cd "$(dirname "$0")"
gcc -shared -fPIC -O2 -o execlog.so execlog.c -ldl
echo "built $(pwd)/execlog.so"
