"""Lightweight code indexer.

Walks a repo, chunks source files, and writes a JSONL index plus a token-IDF
table. The index is intentionally framework-light so it runs anywhere without
extra services. A future swap to a vector store can replace `retriever.py`
without touching the rest of the pipeline.

Each index entry:
    {
        "id": "<sha1>",
        "path": "<relative path>",
        "language": "<extension-derived language>",
        "start_line": int,
        "end_line": int,
        "imports": [..],
        "symbols": [..],
        "text": "<chunk text>",
        "tokens": ["sorted", "unique", "token", ...]
    }
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from ..common.logging_utils import get_logger, log_event

logger = get_logger(__name__)


SUPPORTED_EXT = {
    ".py": "python",
    ".pyi": "python",
    ".js": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".jsx": "javascript",
    ".go": "go",
    ".java": "java",
    ".c": "c",
    ".h": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".rb": "ruby",
    ".rs": "rust",
    ".sh": "shell",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".json": "json",
    ".toml": "toml",
}

SKIP_DIR_NAMES = {
    ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__",
    "dist", "build", "target", ".next", ".cache", ".tox", ".mypy_cache",
    ".pytest_cache", "vendor",
}

_TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{2,}")
_IMPORT_PATTERNS = [
    re.compile(r"^\s*import\s+([\w\.]+)", re.MULTILINE),
    re.compile(r"^\s*from\s+([\w\.]+)\s+import", re.MULTILINE),
    re.compile(r"^\s*#\s*include\s+[<\"]([^>\"]+)[>\"]", re.MULTILINE),
    re.compile(r"require\(['\"]([^'\"]+)['\"]\)"),
    re.compile(r"^\s*use\s+([\w:]+)", re.MULTILINE),  # rust / perl
]
_SYMBOL_PATTERNS = [
    # python / generic
    re.compile(r"^\s*def\s+(\w+)", re.MULTILINE),
    re.compile(r"^\s*class\s+(\w+)", re.MULTILINE),
    # go
    re.compile(r"^\s*func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(", re.MULTILINE),
    # js / ts
    re.compile(r"^\s*function\s+(\w+)", re.MULTILINE),
    re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)", re.MULTILINE),
    # java / typescript
    re.compile(r"^\s*(?:public|private|protected)\s+(?:static\s+)?(?:[\w<>\[\],\s]+\s+)?(\w+)\s*\(", re.MULTILINE),
    # c / c++ function definitions (best-effort, line starts at column 0 or
    # one indent level; type then name then '(' then args then '{')
    re.compile(
        r"^[A-Za-z_][\w\s\*\&]*?\s+(\w+)\s*\([^;{}]*\)\s*\{",
        re.MULTILINE,
    ),
    # rust
    re.compile(r"^\s*(?:pub\s+)?fn\s+(\w+)", re.MULTILINE),
    # ruby
    re.compile(r"^\s*def\s+(?:self\.)?(\w+)", re.MULTILINE),
]
_SYMBOL_BLACKLIST = {"if", "for", "while", "switch", "return", "else", "do",
                     "case", "static", "const", "void", "int", "char", "long",
                     "short", "signed", "unsigned", "struct", "union", "enum"}


@dataclass(frozen=True)
class IndexerConfig:
    chunk_lines: int = 80
    chunk_overlap: int = 10
    max_file_bytes: int = 1_000_000


def _tokenize(text: str) -> list[str]:
    return [t.lower() for t in _TOKEN_RE.findall(text)]


def _extract_symbols(text: str) -> list[str]:
    out: set[str] = set()
    for pat in _SYMBOL_PATTERNS:
        for m in pat.findall(text):
            if m and m not in _SYMBOL_BLACKLIST:
                out.add(m)
    return sorted(out)


def _extract_imports(text: str) -> list[str]:
    out: set[str] = set()
    for pat in _IMPORT_PATTERNS:
        out.update(pat.findall(text))
    return sorted(out)


def _walk_files(root: Path) -> Iterable[Path]:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIR_NAMES and not d.startswith(".")]
        for name in filenames:
            ext = Path(name).suffix.lower()
            if ext in SUPPORTED_EXT:
                yield Path(dirpath) / name


def _chunk_file(text: str, cfg: IndexerConfig) -> Iterable[tuple[int, int, str]]:
    lines = text.splitlines()
    if not lines:
        return
    step = max(1, cfg.chunk_lines - cfg.chunk_overlap)
    i = 0
    while i < len(lines):
        start = i
        end = min(len(lines), i + cfg.chunk_lines)
        chunk = "\n".join(lines[start:end])
        yield (start + 1, end, chunk)  # 1-indexed line range
        if end >= len(lines):
            break
        i += step


def build_index(repo_root: str | Path, out_dir: str | Path, cfg: IndexerConfig | None = None) -> dict:
    cfg = cfg or IndexerConfig()
    root = Path(repo_root).resolve()
    if not root.exists():
        raise FileNotFoundError(repo_root)
    out_path = Path(out_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    entries_path = out_path / "chunks.jsonl"
    meta_path = out_path / "meta.json"

    doc_freq: Counter[str] = Counter()
    n_entries = 0
    file_count = 0

    with entries_path.open("w", encoding="utf-8") as out_f:
        for fp in _walk_files(root):
            try:
                if fp.stat().st_size > cfg.max_file_bytes:
                    continue
                text = fp.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            file_count += 1
            language = SUPPORTED_EXT.get(fp.suffix.lower(), "text")
            imports = _extract_imports(text)
            symbols = _extract_symbols(text)
            rel_path = str(fp.relative_to(root))
            for start, end, chunk in _chunk_file(text, cfg):
                tokens = sorted(set(_tokenize(chunk)))
                if not tokens:
                    continue
                cid = hashlib.sha1(
                    f"{rel_path}:{start}:{end}".encode("utf-8")
                ).hexdigest()[:16]
                doc_freq.update(tokens)
                entry = {
                    "id": cid,
                    "path": rel_path,
                    "language": language,
                    "start_line": start,
                    "end_line": end,
                    "imports": imports,
                    "symbols": symbols,
                    "text": chunk,
                    "tokens": tokens,
                }
                out_f.write(json.dumps(entry) + "\n")
                n_entries += 1

    idf = {t: math.log((n_entries + 1) / (df + 1)) + 1.0 for t, df in doc_freq.items()}
    meta = {
        "repo_root": str(root),
        "files_indexed": file_count,
        "chunks": n_entries,
        "idf": idf,
        "config": {
            "chunk_lines": cfg.chunk_lines,
            "chunk_overlap": cfg.chunk_overlap,
        },
    }
    meta_path.write_text(json.dumps(meta), encoding="utf-8")

    log_event(
        logger,
        "coderag.index.built",
        repo_root=str(root),
        files=file_count,
        chunks=n_entries,
        out=str(out_path),
    )
    return meta
