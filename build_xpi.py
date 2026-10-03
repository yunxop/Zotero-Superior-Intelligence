# input: plugin_src/ source code and static assets
# output: dist/zotero-superior-intelligence-VERSION.xpi
# pos: build and packaging pipeline for Zotero 10 extension

import os
import json
import zipfile
import sys

def build_plugin():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    src_dir = os.path.join(base_dir, "plugin_src")
    dist_dir = os.path.join(base_dir, "dist")
    os.makedirs(dist_dir, exist_ok=True)

    manifest_path = os.path.join(src_dir, "manifest.json")
    if not os.path.exists(manifest_path):
        print(f"Error: manifest.json not found in {src_dir}")
        sys.exit(1)

    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    zotero_meta = manifest.get("applications", {}).get("zotero", {})
    required = ("id", "update_url", "strict_min_version", "strict_max_version")
    missing = [field for field in required if not zotero_meta.get(field)]
    if missing:
        raise ValueError("Zotero manifest 缺少必需字段: " + ", ".join(missing))

    name = manifest.get("name", "zotero-plugin")
    version = manifest["version"]
    min_version = manifest.get("applications", {}).get("zotero", {}).get("strict_min_version")

    print(f"=== 构建 Zotero 10 扩展安装包 ===")
    print(f"插件名称: {name}")
    print(f"插件版本: {version}")
    print(f"最低运行要求: Zotero {min_version}")

    xpi_filename = f"zotero-superior-intelligence-{version}.xpi"
    xpi_path = os.path.join(dist_dir, xpi_filename)

    file_count = 0
    with zipfile.ZipFile(xpi_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(src_dir):
            for file in files:
                # 排除架构说明文档以免占用 xpi 空间
                if file.endswith("_CATALOG.md"):
                    continue
                full_path = os.path.join(root, file)
                rel_path = os.path.relpath(full_path, src_dir).replace("\\", "/")
                zf.write(full_path, rel_path)
                file_count += 1

    xpi_size = os.path.getsize(xpi_path)
    print(f"\n[OK] 构建成功！")
    print(f"输出文件: {xpi_path}")
    print(f"打包文件数: {file_count}")
    print(f"文件大小: {xpi_size / 1024:.2f} KB ({xpi_size} 字节)")
    print(f"\n安装方式：打开 Zotero 10 -> 工具 -> 插件，将该 .xpi 文件拖入插件窗口。")

if __name__ == "__main__":
    build_plugin()
