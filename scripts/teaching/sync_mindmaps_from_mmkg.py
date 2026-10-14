"""将 MMKG-runtime 的知识导图归档同步到 VAT-KG data/viz。

默认从同级目录 ../MMKG-runtime 读取；可用 --mmkg-root 覆盖。
按文件内容 SHA256 跳过未变文件，覆盖已变文件。
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEFAULT_MMKG = REPO.parent / "MMKG-runtime"
DEFAULT_COURSE = "离散数学(图论+数理逻辑与集合论)"

SYNC_NAMES = (
    "mindmaps",
    "mindmap_showcase.json",
    "chapter_catalog.json",
)


def _refresh_showcase_from_index(viz_dir: Path, *, dry_run: bool) -> str:
    """mindmap_showcase.json 常为短预览；用 mindmaps/index.json 覆盖为完整目录。"""
    index_path = viz_dir / "mindmaps" / "index.json"
    showcase_path = viz_dir / "mindmap_showcase.json"
    if not index_path.is_file():
        return "skip_no_index"
    if dry_run:
        return "would_refresh_showcase"
    showcase_path.write_bytes(index_path.read_bytes())
    return "refresh_showcase"


def _sha256(path: Path) -> str | None:
    if not path.is_file():
        return None
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _copy_file(src: Path, dst: Path, *, dry_run: bool) -> str:
    src_hash = _sha256(src)
    dst_hash = _sha256(dst) if dst.exists() else None
    if src_hash and src_hash == dst_hash:
        return "skip"
    if dry_run:
        return "would_copy"
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    return "copy"


def _sync_tree(src_dir: Path, dst_dir: Path, *, dry_run: bool) -> dict[str, int]:
    stats = {"copy": 0, "skip": 0, "would_copy": 0, "delete": 0}
    if not src_dir.is_dir():
        raise FileNotFoundError(f"missing source dir: {src_dir}")

    src_files = {p.relative_to(src_dir) for p in src_dir.rglob("*") if p.is_file()}
    for rel in sorted(src_files):
        action = _copy_file(src_dir / rel, dst_dir / rel, dry_run=dry_run)
        stats[action] = stats.get(action, 0) + 1

    if dst_dir.is_dir():
        dst_files = {p.relative_to(dst_dir) for p in dst_dir.rglob("*") if p.is_file()}
        extras = dst_files - src_files
        for rel in sorted(extras):
            # 仅删除明显的中间态/导图产物，避免误删无关文件
            name = rel.name
            if not (
                name.endswith(".json")
                or any(name.endswith(s) for s in (".draft.json", ".tidy.json", ".assign.json", ".prev.json"))
            ):
                continue
            if dry_run:
                stats["would_copy"] += 0
                stats["delete"] += 1
            else:
                (dst_dir / rel).unlink(missing_ok=True)
                stats["delete"] += 1
    return stats


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--mmkg-root", type=Path, default=DEFAULT_MMKG)
    ap.add_argument("--vatkg-root", type=Path, default=REPO)
    ap.add_argument("--course", default=DEFAULT_COURSE)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    mmkg_viz = args.mmkg_root / "data" / "viz" / args.course
    vat_viz = args.vatkg_root / "data" / "viz" / args.course
    if not mmkg_viz.is_dir():
        print(f"ERROR: MMKG viz not found: {mmkg_viz}", file=sys.stderr)
        return 1

    total = {"copy": 0, "skip": 0, "would_copy": 0, "delete": 0}
    for name in SYNC_NAMES:
        src = mmkg_viz / name
        dst = vat_viz / name
        if not src.exists():
            print(f"warn: skip missing {src}")
            continue
        if src.is_dir():
            stats = _sync_tree(src, dst, dry_run=args.dry_run)
            print(f"{name}/: {stats}")
            for k, v in stats.items():
                total[k] = total.get(k, 0) + v
        else:
            action = _copy_file(src, dst, dry_run=args.dry_run)
            print(f"{name}: {action}")
            total[action] = total.get(action, 0) + 1

    action = _refresh_showcase_from_index(vat_viz, dry_run=args.dry_run)
    print(f"mindmap_showcase from index: {action}")

    mode = "dry-run" if args.dry_run else "done"
    print(f"{mode}: {total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
