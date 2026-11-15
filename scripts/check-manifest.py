#!/usr/bin/env python3
"""校验 manifest.json 引用的文件是否齐全，避免打包后才发现在商店报错。"""
import json
import os
import sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(root)

with open("manifest.json", encoding="utf-8") as f:
    m = json.load(f)

needed = []
needed.append(m["background"]["service_worker"])
needed.append(m["action"]["default_popup"])
for cs in m.get("content_scripts", []):
    needed.extend(cs.get("js", []))
    needed.extend(cs.get("css", []))
needed.extend(m.get("icons", {}).values())
needed.extend(m.get("action", {}).get("default_icon", {}).values())

missing = [p for p in needed if not os.path.exists(p)]
if missing:
    print("缺失文件:", missing)
    sys.exit(1)

print(f"manifest ok: v{m['version']}, {len(set(needed))} 个引用文件全部存在")
