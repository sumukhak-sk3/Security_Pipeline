"""Deterministic patch-validation helpers used by the orchestrator.

These run BEFORE the verifier LLM so the verifier gets a sealed packet that
includes (a) whether the patch applies cleanly to the indexed repo and
(b) the post-patch view of every code-evidence snippet the diff touches.

Without these signals the verifier has to mentally reconstruct the patched
state from a unified diff alone, which is why it tends to bail with
"uncertain" even on patches that apply cleanly.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path


def git_apply_check(diff: str, repo_root: str | Path, *, timeout: int = 30) -> dict:
    """Run `git apply --check` against repo_root. Returns a small dict that
    is safe to embed in the verifier packet."""
    if not diff or not diff.strip():
        return {"ok": False, "ran": False, "reason": "empty diff"}
    repo = Path(repo_root)
    if not repo.is_dir():
        return {"ok": False, "ran": False, "reason": f"repo_root not a directory: {repo}"}
    try:
        proc = subprocess.run(
            ["git", "apply", "--check", "--whitespace=nowarn"],
            input=diff,
            cwd=str(repo),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "ran": False, "reason": f"git apply failed to run: {exc!s}"}
    return {
        "ok": proc.returncode == 0,
        "ran": True,
        "returncode": proc.returncode,
        "stderr": (proc.stderr or "").strip()[:1000],
    }


# --- Unified-diff parsing (minimal — only what we need for in-memory apply) ---

_FILE_HDR = re.compile(r"^\+\+\+\s+(?:b/)?(.+?)\s*$")
_HUNK = re.compile(r"^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@")


def _parse_hunks(diff: str) -> dict[str, list[dict]]:
    """Return {file_path: [{old_start, old_len, new_start, new_len, lines}, ...]}.

    `lines` is a list of (tag, text) where tag is ' ', '+', or '-'."""
    out: dict[str, list[dict]] = {}
    cur_file: str | None = None
    cur_hunk: dict | None = None
    for raw in diff.splitlines():
        if raw.startswith("+++ "):
            m = _FILE_HDR.match(raw)
            if m:
                cur_file = m.group(1).strip()
                if cur_file == "/dev/null":
                    cur_file = None
                else:
                    out.setdefault(cur_file, [])
            cur_hunk = None
            continue
        if raw.startswith("@@"):
            m = _HUNK.match(raw)
            if not m or cur_file is None:
                cur_hunk = None
                continue
            cur_hunk = {
                "old_start": int(m.group(1)),
                "old_len": int(m.group(2) or 1),
                "new_start": int(m.group(3)),
                "new_len": int(m.group(4) or 1),
                "lines": [],
            }
            out[cur_file].append(cur_hunk)
            continue
        if cur_hunk is None or cur_file is None:
            continue
        if not raw:
            cur_hunk["lines"].append((" ", ""))
            continue
        tag = raw[0]
        if tag not in (" ", "+", "-", "\\"):
            cur_hunk = None
            continue
        if tag == "\\":  # "\ No newline at end of file"
            continue
        cur_hunk["lines"].append((tag, raw[1:]))
    return out


def _apply_hunks_to_text(original: str, hunks: list[dict]) -> str | None:
    """Apply hunks to `original` text. Returns patched text or None on conflict."""
    src = original.splitlines()
    # Build a list of (line_no_1based, line_text) for the source.
    out_lines: list[str] = []
    cursor = 0  # 0-based index into src
    # Sort hunks by old_start to apply in order.
    for h in sorted(hunks, key=lambda x: x["old_start"]):
        target = h["old_start"] - 1  # 0-based
        if target < cursor:
            return None  # overlapping hunks — bail
        # Copy untouched lines up to the hunk.
        out_lines.extend(src[cursor:target])
        cursor = target
        for tag, text in h["lines"]:
            if tag == " ":
                if cursor >= len(src) or src[cursor] != text:
                    return None  # context mismatch — patch wouldn't apply
                out_lines.append(src[cursor])
                cursor += 1
            elif tag == "-":
                if cursor >= len(src) or src[cursor] != text:
                    return None
                cursor += 1
            elif tag == "+":
                out_lines.append(text)
    # Copy the tail.
    out_lines.extend(src[cursor:])
    return "\n".join(out_lines) + ("\n" if original.endswith("\n") else "")


def build_patched_snippets(
    diff: str,
    repo_root: str | Path | None,
    code_evidence: list,
    *,
    pad_lines: int = 20,
) -> list[dict]:
    """For each code_evidence entry whose path is touched by the diff,
    return a window of the POST-patch file (so the verifier can read what
    the code looks like *after* the fix, not just the diff)."""
    if not diff or not repo_root:
        return []
    repo = Path(repo_root)
    if not repo.is_dir():
        return []
    hunks_by_file = _parse_hunks(diff)
    if not hunks_by_file:
        return []

    out: list[dict] = []
    # Cache patched-file text so multiple snippets in same file share work.
    patched_cache: dict[str, str | None] = {}

    for ev in code_evidence:
        # CodeEvidence pydantic model OR plain dict.
        path = getattr(ev, "path", None) or (ev.get("path") if isinstance(ev, dict) else None)
        if not path or path not in hunks_by_file:
            continue
        start = getattr(ev, "start_line", None) or (ev.get("start_line") if isinstance(ev, dict) else None) or 1
        end = getattr(ev, "end_line", None) or (ev.get("end_line") if isinstance(ev, dict) else None) or start

        if path not in patched_cache:
            fp = repo / path
            if not fp.is_file():
                patched_cache[path] = None
            else:
                try:
                    original = fp.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    patched_cache[path] = None
                else:
                    patched_cache[path] = _apply_hunks_to_text(original, hunks_by_file[path])

        patched = patched_cache[path]
        if patched is None:
            continue
        lines = patched.splitlines()
        # Translate original line numbers to approximate post-patch ones by
        # walking the hunks for this file and accumulating delta.
        delta = 0
        for h in sorted(hunks_by_file[path], key=lambda x: x["old_start"]):
            if h["old_start"] + h["old_len"] <= start:
                delta += h["new_len"] - h["old_len"]
        win_start = max(1, start + delta - pad_lines)
        win_end = min(len(lines), end + delta + pad_lines)
        snippet = "\n".join(lines[win_start - 1: win_end])
        out.append({
            "path": path,
            "post_patch_start_line": win_start,
            "post_patch_end_line": win_end,
            "snippet": snippet,
        })
    return out
