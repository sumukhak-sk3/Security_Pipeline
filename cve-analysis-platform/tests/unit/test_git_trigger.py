"""Unit tests for git-diff based pipeline trigger."""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from apps.triggers.git_trigger import ChangeSet, collect_changes, decide_stages


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    r = tmp_path / "r"
    r.mkdir()
    _git(r, "init", "-q", "-b", "main")
    _git(r, "config", "user.email", "t@example.com")
    _git(r, "config", "user.name", "t")
    (r / "README.md").write_text("hi\n")
    _git(r, "add", ".")
    _git(r, "commit", "-q", "-m", "init")
    return r


def test_collect_changes_handles_no_git(tmp_path):
    cs = collect_changes(tmp_path)
    assert cs.error and "not a git" in cs.error


def test_decide_stages_no_changes():
    cs = ChangeSet(files_changed=[])
    d = decide_stages(cs)
    assert d.stages == []
    assert "no changes" in d.reason


def test_decide_stages_docs_only():
    cs = ChangeSet(files_changed=["README.md", "docs/foo.md"], lines_added=5)
    d = decide_stages(cs)
    assert d.stages == []
    assert "docs-only" in d.reason


def test_decide_stages_manifest_change():
    cs = ChangeSet(files_changed=["requirements.txt"], lines_added=2)
    d = decide_stages(cs)
    assert "security" in d.stages
    assert "index" in d.stages
    assert "tests" in d.stages


def test_decide_stages_code_change():
    cs = ChangeSet(files_changed=["apps/x.py"], lines_added=10)
    d = decide_stages(cs)
    assert "index" in d.stages
    assert "tests" in d.stages
    assert "security" not in d.stages


def test_decide_stages_large_changeset_runs_everything():
    cs = ChangeSet(files_changed=[f"f{i}.py" for i in range(60)], lines_added=10)
    d = decide_stages(cs)
    assert set(d.stages) >= {"index", "security", "tests", "lint"}


def test_decide_stages_error_path_runs_conservatively():
    cs = ChangeSet(error="git diff failed")
    d = decide_stages(cs)
    assert "security" in d.stages and "index" in d.stages


def test_collect_changes_real_diff(repo: Path):
    (repo / "a.py").write_text("print('x')\n")
    _git(repo, "add", "a.py")
    _git(repo, "commit", "-q", "-m", "add a")
    cs = collect_changes(repo, base_ref="HEAD~1", head_ref="HEAD")
    assert cs.error is None
    assert "a.py" in cs.files_changed
    assert cs.lines_added >= 1
