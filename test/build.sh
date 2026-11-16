#!/usr/bin/env bash
# Build the store test bundle (see test/vite.config.ts).
set -e
cd "$(dirname "$0")/.."
npx vite build --config test/vite.config.ts --logLevel warn
