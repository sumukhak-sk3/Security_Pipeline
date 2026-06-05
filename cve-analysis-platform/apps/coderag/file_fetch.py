"""File-fetch fallback: read exact files and slice symbol/keyword windows.

Used when the indexed retriever returns weak hits or no hits at all.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Iterable

from ..common.logging_utils import get_logger

logger = get_logger(__name__)


def _safe_path(repo_root: Path, candidate: str) -> Path | None:
    """Resolve `candidate` against `repo_root` and ensure it stays inside it."""
    try:
        target = (repo_root / candidate).resolve()
    except (OSError, RuntimeError):
        return None
    try:
        target.relative_to(repo_root.resolve())
    except ValueError:
        return None
    if not target.is_file():
        return None
    return target


def grep_keyword_windows(
    repo_root: str | os.PathLike[str],
    keywords: Iterable[str],
    window_lines: int = 40,
    max_files: int = 8,
    max_per_file: int = 3,
) -> list[dict]:
    """Search the repo for any of `keywords` and return surrounding code windows.

    Returns a list of {path, start_line, end_line, snippet, matched_keyword,
    score}. Results are ranked by path quality so that real upstream source
    files outrank tests, build scripts, docs, and excludelists that just
    happen to mention the component/CVE name in passing.
    """
    root = Path(repo_root).resolve()
    if not root.exists():
        return []
    keywords = [k for k in keywords if k]
    if not keywords:
        return []
    pattern = re.compile(
        "|".join(re.escape(k) for k in keywords), re.IGNORECASE
    )
    # CVE IDs match too broadly (tests are often named after the CVE). Track them
    # separately so we can demote pure-CVE-ID matches in the ranking.
    cve_pattern = re.compile(r"CVE-\d{4}-\d+", re.IGNORECASE)

    SKIP_DIRS = {
        ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__",
        "dist", "build", "target", ".next", ".cache", ".tox",
        # Noise dirs that bury real upstream source under huge hit counts
        "test", "tests", "testing", "doc", "docs", "examples", "example",
        "sample", "samples", "contrib", "packaging", "debian", "rpm",
        "win32", "msvc",
    }
    SKIP_EXT = {".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".gz", ".tar", ".so", ".dll", ".exe"}
    SOURCE_EXT = {".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".py", ".go", ".rs", ".java", ".js", ".ts", ".pl", ".pm", ".rb"}
    # Tokens that indicate a path is *not* upstream library source.
    DEMOTE_TOKENS = (
        "/test/", "/tests/", "_test", "_tests", "/doc/", "/docs/",
        "/example", "/sample", "/contrib/", "/vendor/", "rsync-exclude",
        "makefile", "/mk/", "/build/", "/install", "/packaging/", ".sh",
        ".txt", ".md", ".cfg", ".ini", ".conf", ".yaml", ".yml", ".json",
        "/manifest", "show_upgrade", "upgrade_path",
    )
    # Component name family hints — first-path-segment matches earn a big boost.
    def _family_tokens(kws: list[str]) -> set[str]:
        toks: set[str] = set()
        for k in kws:
            kl = k.lower()
            if not kl or cve_pattern.fullmatch(k):
                continue
            toks.add(kl)
            # Module / package paths like "github.com/apache/thrift" — only
            # keep the *trailing* segment as a search token. Earlier segments
            # (org names like "apache" or "google") are far too broad and
            # match unrelated code.
            if "/" in kl:
                last = kl.rsplit("/", 1)[-1].strip()
                if last:
                    toks.add(last)
            # bind9-libs -> bind9; python3-dnspython -> dnspython
            for sep in ("-libs", "-utils", "-common", "-dev", "-bin", "-server", "-client"):
                if kl.endswith(sep):
                    toks.add(kl[:-len(sep)])
            if "-" in kl and "/" not in kl:
                toks.add(kl.split("-", 1)[-1])
            if kl.startswith("python3-") or kl.startswith("python-"):
                toks.add(kl.split("-", 1)[1])
            # trailing digits/dots (python3.10 -> python)
            stripped = re.sub(r"[\d.]+$", "", kl)
            if stripped and stripped != kl:
                toks.add(stripped)
        GENERIC = {"lib", "libs", "bin", "src", "util", "utils", "common",
                   "dev", "server", "client", "core", "test", "tests",
                   "python", "python3", "com", "org", "net", "io", "go",
                   "apache", "google", "golang", "kubernetes", "openstack",
                   "microsoft", "amazon", "aws", "github", "gitlab"}
        return {t for t in toks if len(t) >= 3 and t not in GENERIC}

    family = _family_tokens(list(keywords))

    def _score(path_str: str, matched: str) -> float:
        p = path_str.lower()
        s = 1.0
        # Strong boost: extension is real source
        if Path(p).suffix in SOURCE_EXT:
            s += 3.0
        # Strong boost: first path segment matches component family
        first_seg = p.split("/", 1)[0]
        if family and any(first_seg == t or first_seg.startswith(t) for t in family):
            s += 4.0
        # Mild boost: family token anywhere in path
        if family and any(t in p for t in family):
            s += 1.5
        # Penalties for non-source paths
        for tok in DEMOTE_TOKENS:
            if tok in p:
                s -= 2.0
        # CVE-ID-only matches are weak signal (test files named after CVE)
        if cve_pattern.fullmatch(matched or ""):
            s -= 2.0
        return s

    out: list[dict] = []
    # No early-stop on file count: collect all hits then rank.
    HARD_HIT_CAP = max_files * max_per_file * 30
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            if Path(name).suffix.lower() in SKIP_EXT:
                continue
            if len(out) >= HARD_HIT_CAP:
                break
            fp = Path(dirpath) / name
            rel_early = str(fp.relative_to(root)).lower()
            # When we know the component family, only consider files whose path
            # mentions it. Otherwise every grep walks the whole repo and the cap
            # fills with unrelated NIOS files.
            if family and not any(t in rel_early for t in family):
                continue
            try:
                if fp.stat().st_size > 1_000_000:
                    continue
                lines = fp.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
            file_hits = 0
            for i, line in enumerate(lines):
                m = pattern.search(line)
                if not m:
                    continue
                start = max(0, i - window_lines // 2)
                end = min(len(lines), i + window_lines // 2)
                snippet = "\n".join(lines[start:end])
                rel = str(fp.relative_to(root))
                out.append({
                    "path": rel,
                    "start_line": start + 1,
                    "end_line": end,
                    "snippet": snippet,
                    "matched_keyword": m.group(0),
                    "score": _score(rel, m.group(0)),
                })
                file_hits += 1
                if file_hits >= max_per_file:
                    break
        if len(out) >= HARD_HIT_CAP:
            break

    # Rank by score (desc), then keep at most max_per_file per file, top max_files files.
    out.sort(key=lambda h: h["score"], reverse=True)
    seen_files: dict[str, int] = {}
    picked: list[dict] = []
    for h in out:
        n = seen_files.get(h["path"], 0)
        if n >= max_per_file:
            continue
        seen_files[h["path"]] = n + 1
        picked.append(h)
        if len(seen_files) >= max_files and all(c >= 1 for c in seen_files.values()):
            # Have hits from `max_files` distinct files; stop adding more files.
            distinct = len(seen_files)
            if distinct >= max_files:
                break
    # Final trim to max_files distinct files
    final: list[dict] = []
    distinct_seen: set[str] = set()
    for h in picked:
        if h["path"] not in distinct_seen and len(distinct_seen) >= max_files:
            continue
        distinct_seen.add(h["path"])
        final.append(h)
    return final


def fetch_exact_window(
    repo_root: str | os.PathLike[str],
    relative_path: str,
    start_line: int,
    end_line: int,
) -> dict | None:
    """Return an exact line window from `relative_path` inside `repo_root`."""
    root = Path(repo_root).resolve()
    target = _safe_path(root, relative_path)
    if not target:
        return None
    try:
        lines = target.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    start = max(0, start_line - 1)
    end = min(len(lines), end_line)
    return {
        "path": relative_path,
        "start_line": start + 1,
        "end_line": end,
        "snippet": "\n".join(lines[start:end]),
    }
