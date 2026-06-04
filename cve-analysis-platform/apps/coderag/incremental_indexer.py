"""Incremental, parallel Code-RAG indexer.

Builds on top of `indexer.build_index` for first-run / full rebuilds, but is
incremental on subsequent runs:

- Maintains a `manifest.json` next to `chunks.jsonl` mapping
  `rel_path -> {sha256, size, mtime, n_chunks}`.
- On `update_index(repo_root, out_dir)`:
    1. Walks the repo (same SUPPORTED_EXT + SKIP_DIR_NAMES filters).
    2. Hashes each candidate file in a thread pool.
    3. Classifies each as added / modified / unchanged / deleted.
    4. Re-chunks only added+modified files in parallel.
    5. Rewrites `chunks.jsonl` atomically, dropping entries for removed/changed
       files and appending fresh ones.
    6. Updates IDF + manifest.

This is parallel via `concurrent.futures.ThreadPoolExecutor` (I/O-bound work).
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from ..common.logging_utils import get_logger, log_event
from .indexer import (
    IndexerConfig,
    SKIP_DIR_NAMES,
    SUPPORTED_EXT,
    _chunk_file,
    _extract_imports,
    _extract_symbols,
    _tokenize,
    build_index,
)

logger = get_logger(__name__)

MANIFEST_NAME = "manifest.json"


@dataclass
class IndexUpdate:
    added: list[str] = field(default_factory=list)
    modified: list[str] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    unchanged: int = 0
    files_total: int = 0
    chunks_total: int = 0
    duration_ms: int = 0
    full_rebuild: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "added": list(self.added),
            "modified": list(self.modified),
            "deleted": list(self.deleted),
            "unchanged": self.unchanged,
            "files_total": self.files_total,
            "chunks_total": self.chunks_total,
            "duration_ms": self.duration_ms,
            "full_rebuild": self.full_rebuild,
        }


def _walk(root: Path) -> Iterable[Path]:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIR_NAMES and not d.startswith(".")]
        for name in filenames:
            ext = Path(name).suffix.lower()
            if ext in SUPPORTED_EXT:
                yield Path(dirpath) / name


def _hash_file(path: Path, max_bytes: int) -> tuple[str, int] | None:
    try:
        st = path.stat()
        if st.st_size > max_bytes:
            return None
        h = hashlib.sha256()
        with path.open("rb") as f:
            for block in iter(lambda: f.read(65536), b""):
                h.update(block)
        return h.hexdigest(), st.st_size
    except OSError:
        return None


def _chunk_for_file(rel_path: str, abs_path: Path, cfg: IndexerConfig) -> list[dict[str, Any]]:
    try:
        text = abs_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    language = SUPPORTED_EXT.get(abs_path.suffix.lower(), "text")
    imports = _extract_imports(text)
    symbols = _extract_symbols(text)
    out: list[dict[str, Any]] = []
    for start, end, chunk in _chunk_file(text, cfg):
        tokens = sorted(set(_tokenize(chunk)))
        if not tokens:
            continue
        cid = hashlib.sha1(
            f"{rel_path}:{start}:{end}".encode("utf-8")
        ).hexdigest()[:16]
        out.append({
            "id": cid,
            "path": rel_path,
            "language": language,
            "start_line": start,
            "end_line": end,
            "imports": imports,
            "symbols": symbols,
            "text": chunk,
            "tokens": tokens,
        })
    return out


def _load_manifest(out_path: Path) -> dict[str, Any]:
    mp = out_path / MANIFEST_NAME
    if not mp.exists():
        return {}
    try:
        return json.loads(mp.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _write_manifest(out_path: Path, manifest: dict[str, Any]) -> None:
    mp = out_path / MANIFEST_NAME
    tmp = mp.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(manifest), encoding="utf-8")
    tmp.replace(mp)


def update_index(
    repo_root: str | Path,
    out_dir: str | Path,
    cfg: IndexerConfig | None = None,
    workers: int = 4,
    explicit_paths: list[str] | None = None,
) -> IndexUpdate:
    """Update the index incrementally.

    When `explicit_paths` is supplied (e.g. from git diff), only those paths
    are considered as candidates for change detection. Other files keep their
    cached manifest entries unchanged.
    """
    import time

    cfg = cfg or IndexerConfig()
    started = time.time()
    root = Path(repo_root).resolve()
    if not root.exists():
        raise FileNotFoundError(repo_root)
    out_path = Path(out_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    entries_path = out_path / "chunks.jsonl"
    meta_path = out_path / "meta.json"

    manifest = _load_manifest(out_path)
    if not entries_path.exists() or not manifest:
        # Cold start: do a full build, then write a manifest for future runs.
        meta = build_index(root, out_path, cfg)
        new_manifest: dict[str, Any] = {}
        # Re-hash files now to seed the manifest.
        for fp in _walk(root):
            rel = str(fp.relative_to(root))
            h = _hash_file(fp, cfg.max_file_bytes)
            if h:
                sha, size = h
                new_manifest[rel] = {"sha256": sha, "size": size}
        _write_manifest(out_path, new_manifest)
        upd = IndexUpdate(
            added=list(new_manifest.keys()),
            modified=[],
            deleted=[],
            unchanged=0,
            files_total=meta["files_indexed"],
            chunks_total=meta["chunks"],
            duration_ms=int((time.time() - started) * 1000),
            full_rebuild=True,
        )
        log_event(
            logger,
            "coderag.index.update.full",
            files=upd.files_total,
            chunks=upd.chunks_total,
            duration_ms=upd.duration_ms,
        )
        return upd

    # Incremental path
    if explicit_paths:
        candidates = [root / p for p in explicit_paths if (root / p).exists()]
        candidates = [p for p in candidates if p.suffix.lower() in SUPPORTED_EXT]
    else:
        candidates = list(_walk(root))

    candidate_rel = {str(p.relative_to(root)) for p in candidates}

    # Hash candidates in parallel
    new_hashes: dict[str, tuple[str, int]] = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        future_to_rel = {
            ex.submit(_hash_file, p, cfg.max_file_bytes): str(p.relative_to(root))
            for p in candidates
        }
        for fut in as_completed(future_to_rel):
            rel = future_to_rel[fut]
            h = fut.result()
            if h:
                new_hashes[rel] = h

    added: list[str] = []
    modified: list[str] = []
    unchanged_n = 0
    for rel, (sha, _size) in new_hashes.items():
        prev = manifest.get(rel)
        if prev is None:
            added.append(rel)
        elif prev.get("sha256") != sha:
            modified.append(rel)
        else:
            unchanged_n += 1

    # Detect deletions only when we walked the whole tree (no explicit_paths)
    deleted: list[str] = []
    if explicit_paths is None:
        deleted = [rel for rel in manifest.keys() if rel not in new_hashes]

    if not added and not modified and not deleted:
        upd = IndexUpdate(
            added=[], modified=[], deleted=[],
            unchanged=unchanged_n,
            files_total=len(manifest),
            chunks_total=_count_lines(entries_path),
            duration_ms=int((time.time() - started) * 1000),
            full_rebuild=False,
        )
        log_event(
            logger,
            "coderag.index.update.noop",
            files=upd.files_total,
            duration_ms=upd.duration_ms,
        )
        return upd

    # Re-chunk added + modified in parallel.
    new_chunks: list[dict[str, Any]] = []
    chunks_per_file: dict[str, int] = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {
            ex.submit(_chunk_for_file, rel, root / rel, cfg): rel
            for rel in (added + modified)
        }
        for fut in as_completed(futures):
            rel = futures[fut]
            chunks = fut.result()
            chunks_per_file[rel] = len(chunks)
            new_chunks.extend(chunks)

    # Rebuild chunks.jsonl: drop entries for changed/deleted files, append new.
    drop_paths = set(modified) | set(deleted)
    tmp_path = entries_path.with_suffix(".jsonl.tmp")
    total_chunks = 0
    doc_freq: Counter[str] = Counter()
    with tmp_path.open("w", encoding="utf-8") as out_f:
        # Stream existing entries, skipping those we are replacing.
        if entries_path.exists():
            with entries_path.open("r", encoding="utf-8") as in_f:
                for line in in_f:
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if entry.get("path") in drop_paths:
                        continue
                    out_f.write(line if line.endswith("\n") else line + "\n")
                    total_chunks += 1
                    doc_freq.update(entry.get("tokens") or [])
        for entry in new_chunks:
            out_f.write(json.dumps(entry) + "\n")
            total_chunks += 1
            doc_freq.update(entry["tokens"])
    tmp_path.replace(entries_path)

    # Rebuild IDF + meta.
    idf = {t: math.log((total_chunks + 1) / (df + 1)) + 1.0 for t, df in doc_freq.items()}
    meta = {
        "repo_root": str(root),
        "files_indexed": len(manifest) + len(added) - len(deleted),
        "chunks": total_chunks,
        "idf": idf,
        "config": {
            "chunk_lines": cfg.chunk_lines,
            "chunk_overlap": cfg.chunk_overlap,
        },
    }
    meta_path.write_text(json.dumps(meta), encoding="utf-8")

    # Update manifest.
    for rel in deleted:
        manifest.pop(rel, None)
    for rel in added + modified:
        sha, size = new_hashes[rel]
        manifest[rel] = {"sha256": sha, "size": size, "n_chunks": chunks_per_file.get(rel, 0)}
    _write_manifest(out_path, manifest)

    upd = IndexUpdate(
        added=added,
        modified=modified,
        deleted=deleted,
        unchanged=unchanged_n,
        files_total=len(manifest),
        chunks_total=total_chunks,
        duration_ms=int((time.time() - started) * 1000),
        full_rebuild=False,
    )
    log_event(
        logger,
        "coderag.index.update.incremental",
        added=len(added),
        modified=len(modified),
        deleted=len(deleted),
        chunks=total_chunks,
        duration_ms=upd.duration_ms,
    )
    return upd


def _count_lines(path: Path) -> int:
    n = 0
    try:
        with path.open("rb") as f:
            for _ in f:
                n += 1
    except OSError:
        pass
    return n
