#!/usr/bin/env bash
# 打包上架用 zip（排除测试、文档与 git 文件）
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
OUT="dist/doubao-export-${VERSION}.zip"

rm -rf dist && mkdir -p dist
zip -q -r "$OUT" \
  manifest.json background.js content.js hook.js \
  popup.html popup.js popup.css icons \
  -x "*.DS_Store"

echo "已生成 $OUT ($(du -h "$OUT" | cut -f1))"
