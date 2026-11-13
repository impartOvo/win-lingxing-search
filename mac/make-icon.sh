#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p mac/assets/icon.iconset
swift mac/make-icon.swift mac/assets/icon.iconset
iconutil -c icns mac/assets/icon.iconset -o mac/assets/icon.icns
