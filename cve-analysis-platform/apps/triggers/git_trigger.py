"""Git-diff-based pipeline trigger.

Decides which pipeline stages should run based on the set of changed files
between two refs (default: HEAD~1..HEAD). The decision is intentionally
conservative: when in doubt we include a stage rather than skip it.

Stages we currently know about:
    - "index"     : re-run incremental indexing (only for code/config changes)
    - "security"  : run CVE analysis (always for package/manifest changes; skipped for docs-only)
    - "tests"     : run the test suite (any code change)
    - "lint"      : run linters (any code/config change)

Heuristic rules:
    - 0 changed files            -> []
    - only doc/markdown changes  -> []
    - only test changes          -> [tests]
    - package manifest changed   -> [index, security, tests]
    - any source change          -> [index, tests]
    - many files / many lines    -> all stages
"""
from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional


DOC_EXT = {".md", ".rst", ".txt", ".adoc"}
TEST_PATH_HINTS = {"/tests/", "/test/", "test_", "_test."}
PACKAGE_MANIFESTS = {
    "requirements.txt", "pyproject.toml", "setup.cfg", "setup.py",
    "Pipfile", "Pipfile.lock", "poetry.lock",
    "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "go.mod", "go.sum", "Cargo.toml", "Cargo.lock", "Gemfile", "Gemfile.lock",
    "build.gradle", "pom.xml", "Dockerfile", "docker-compose.yml",
    "debian/control", "debian/changelog",
}
CODE_EXT = {".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".java", ".c", ".h",
            ".cc", ".cpp", ".hpp", ".rb", ".rs", ".sh"}


@dataclass
class ChangeSet:
    files_changed: list[str] = field(default_factory=list)
    lines_added: int = 0
    lines_removed: int = 0
    base_ref: str = "HEAD~1"
    head_ref: str = "HEAD"
    error: Optional[str] = None

    @property
    def total_lines(self) -> int:
        return self.lines_added + self.lines_removed

    def to_dict(self) -> dict[str, Any]:
        return {
            "files_changed": list(self.files_changed),
            "files_changed_count": len(self.files_changed),
            "lines_added": self.lines_added,
            "lines_removed": self.lines_removed,
            "total_lines": self.total_lines,
            "base_ref": self.base_ref,
            "head_ref": self.head_ref,
            "error": self.error,
        }


@dataclass
class TriggerDecision:
    stages: list[str]
    reason: str
    changeset: ChangeSet
    skipped: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "stages": list(self.stages),
            "skipped": list(self.skipped),
            "reason": self.reason,
            "changeset": self.changeset.to_dict(),
        }


# ----------------------------------------------------------------------
def _run_git(repo_root: Path, args: list[str]) -> Optional[str]:
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo_root)] + args,
            capture_output=True, text=True, check=False, timeout=15,
        )
        if proc.returncode != 0:
            return None
        return proc.stdout
    except (OSError, subprocess.TimeoutExpired):
        return None


def collect_changes(
    repo_root: str | Path,
    base_ref: str = "HEAD~1",
    head_ref: str = "HEAD",
) -> ChangeSet:
    root = Path(repo_root).resolve()
    cs = ChangeSet(base_ref=base_ref, head_ref=head_ref)
    if not (root / ".git").exists():
        cs.error = "not a git repository"
        return cs

    name_status = _run_git(root, ["diff", "--name-only", f"{base_ref}..{head_ref}"])
    if name_status is None:
        cs.error = f"git diff failed for {base_ref}..{head_ref}"
        return cs
    cs.files_changed = [ln.strip() for ln in name_status.splitlines() if ln.strip()]

    numstat = _run_git(root, ["diff", "--numstat", f"{base_ref}..{head_ref}"])
    if numstat:
        for line in numstat.splitlines():
            parts = line.split("\t")
            if len(parts) >= 2:
                added_s, removed_s = parts[0], parts[1]
                try:
                    if added_s != "-":
                        cs.lines_added += int(added_s)
                    if removed_s != "-":
                        cs.lines_removed += int(removed_s)
                except ValueError:
                    continue
    return cs


# ----------------------------------------------------------------------
def _classify(path: str) -> set[str]:
    """Return tags describing the file: {doc, test, manifest, code, other}."""
    tags: set[str] = set()
    p = path.lower()
    suffix = Path(p).suffix
    name = Path(p).name
    if suffix in DOC_EXT:
        tags.add("doc")
    if name in PACKAGE_MANIFESTS or "debian/" in p:
        tags.add("manifest")
    if any(h in p for h in TEST_PATH_HINTS):
        tags.add("test")
    if suffix in CODE_EXT:
        tags.add("code")
    if not tags:
        tags.add("other")
    return tags


def decide_stages(
    changeset: ChangeSet,
    large_files_threshold: int = 50,
    large_lines_threshold: int = 2000,
) -> TriggerDecision:
    if changeset.error:
        return TriggerDecision(
            stages=["index", "security", "tests"],
            reason=f"git unavailable ({changeset.error}); running full pipeline conservatively",
            changeset=changeset,
        )
    if not changeset.files_changed:
        return TriggerDecision(
            stages=[],
            reason="no changes detected between refs; nothing to run",
            changeset=changeset,
            skipped=["index", "security", "tests", "lint"],
        )

    tags: set[str] = set()
    for f in changeset.files_changed:
        tags.update(_classify(f))

    # Large changesets -> run everything.
    if (len(changeset.files_changed) >= large_files_threshold
            or changeset.total_lines >= large_lines_threshold):
        return TriggerDecision(
            stages=["index", "security", "tests", "lint"],
            reason=(
                f"large changeset (files={len(changeset.files_changed)}, "
                f"lines={changeset.total_lines}); full pipeline"
            ),
            changeset=changeset,
        )

    # Docs-only
    if tags == {"doc"}:
        return TriggerDecision(
            stages=[],
            reason="docs-only changes; skipping index/security/tests",
            changeset=changeset,
            skipped=["index", "security", "tests", "lint"],
        )

    stages: list[str] = []
    skipped: list[str] = []
    if "manifest" in tags:
        stages += ["index", "security", "tests"]
    if "code" in tags:
        for s in ("index", "tests"):
            if s not in stages:
                stages.append(s)
    if "test" in tags and "tests" not in stages:
        stages.append("tests")
    if "code" in tags or "manifest" in tags:
        if "lint" not in stages:
            stages.append("lint")

    if not stages:
        skipped = ["index", "security", "tests", "lint"]

    reason_bits = []
    if "manifest" in tags:
        reason_bits.append("package manifest changed -> security validation required")
    if "code" in tags:
        reason_bits.append("source code changed -> incremental index + tests")
    if "test" in tags and "code" not in tags:
        reason_bits.append("tests-only change -> run tests")
    if not reason_bits:
        reason_bits.append("only auxiliary files changed")
    return TriggerDecision(
        stages=stages,
        reason="; ".join(reason_bits),
        changeset=changeset,
        skipped=skipped,
    )
