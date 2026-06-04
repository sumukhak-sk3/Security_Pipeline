"""Unit tests for the incremental Code-RAG indexer."""
from __future__ import annotations

import json
from pathlib import Path

from apps.coderag.incremental_indexer import update_index
from apps.coderag.indexer import IndexerConfig


def _write(p: Path, body: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body, encoding="utf-8")


def test_cold_start_does_full_rebuild_and_seeds_manifest(tmp_path: Path):
    repo = tmp_path / "repo"
    out = tmp_path / "idx"
    _write(repo / "a.py", "def foo():\n    return 1\n")
    _write(repo / "pkg" / "b.py", "import os\n\ndef bar():\n    return os.getcwd()\n")

    upd = update_index(repo, out, IndexerConfig(chunk_lines=20, chunk_overlap=2), workers=2)
    assert upd.full_rebuild is True
    assert upd.files_total >= 2
    assert upd.chunks_total >= 2
    manifest = json.loads((out / "manifest.json").read_text())
    assert "a.py" in manifest
    assert "pkg/b.py" in manifest


def test_incremental_no_change_marks_all_unchanged(tmp_path: Path):
    repo = tmp_path / "repo"
    out = tmp_path / "idx"
    _write(repo / "a.py", "x = 1\n")
    update_index(repo, out, IndexerConfig(chunk_lines=20, chunk_overlap=2), workers=2)
    upd = update_index(repo, out, IndexerConfig(chunk_lines=20, chunk_overlap=2), workers=2)
    assert upd.full_rebuild is False
    assert upd.added == []
    assert upd.modified == []
    assert upd.deleted == []
    assert upd.unchanged >= 1


def test_incremental_modify_detects_modified(tmp_path: Path):
    repo = tmp_path / "repo"
    out = tmp_path / "idx"
    _write(repo / "a.py", "x = 1\n")
    update_index(repo, out, IndexerConfig(chunk_lines=20, chunk_overlap=2), workers=2)
    _write(repo / "a.py", "x = 1\ny = 2\nz = 3\n")
    upd = update_index(repo, out, IndexerConfig(chunk_lines=20, chunk_overlap=2), workers=2)
    assert "a.py" in upd.modified
    assert upd.added == []


def test_incremental_delete_detects_removed(tmp_path: Path):
    repo = tmp_path / "repo"
    out = tmp_path / "idx"
    _write(repo / "a.py", "x = 1\n")
    _write(repo / "b.py", "y = 2\n")
    update_index(repo, out, IndexerConfig(chunk_lines=20, chunk_overlap=2), workers=2)
    (repo / "b.py").unlink()
    upd = update_index(repo, out, IndexerConfig(chunk_lines=20, chunk_overlap=2), workers=2)
    assert "b.py" in upd.deleted


def test_explicit_paths_limits_scope(tmp_path: Path):
    repo = tmp_path / "repo"
    out = tmp_path / "idx"
    _write(repo / "a.py", "x = 1\n")
    _write(repo / "b.py", "y = 2\n")
    update_index(repo, out, IndexerConfig(chunk_lines=20, chunk_overlap=2), workers=2)
    _write(repo / "a.py", "x = 99\n")
    _write(repo / "b.py", "y = 99\n")
    upd = update_index(
        repo, out, IndexerConfig(chunk_lines=20, chunk_overlap=2),
        workers=2, explicit_paths=["a.py"],
    )
    assert "a.py" in upd.modified
    assert "b.py" not in upd.modified
