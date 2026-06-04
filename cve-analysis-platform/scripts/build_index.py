#!/usr/bin/env python3
"""Build (or incrementally update) the Code-RAG index over a repository."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from apps.coderag.indexer import IndexerConfig, build_index  # noqa: E402
from apps.coderag.incremental_indexer import update_index  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Build / update code RAG index")
    parser.add_argument("--repo", required=True, help="Path to repository root")
    parser.add_argument("--out", required=True, help="Output index directory")
    parser.add_argument("--chunk-lines", type=int, default=80)
    parser.add_argument("--chunk-overlap", type=int, default=10)
    parser.add_argument("--mode", choices=["full", "incremental"], default="incremental",
                        help="full=always rebuild, incremental=use file hash cache")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    cfg = IndexerConfig(chunk_lines=args.chunk_lines, chunk_overlap=args.chunk_overlap)
    if args.mode == "full":
        meta = build_index(args.repo, args.out, cfg)
        print(f"indexed {meta['files_indexed']} files / {meta['chunks']} chunks -> {args.out}")
        return
    upd = update_index(args.repo, args.out, cfg, workers=args.workers)
    print(
        f"{'full rebuild' if upd.full_rebuild else 'incremental'}: "
        f"added={len(upd.added)} modified={len(upd.modified)} deleted={len(upd.deleted)} "
        f"unchanged={upd.unchanged} chunks={upd.chunks_total} duration={upd.duration_ms}ms"
    )


if __name__ == "__main__":
    main()
