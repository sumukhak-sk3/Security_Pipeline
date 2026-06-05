"""Debian-style version comparison.

Implements `dpkg --compare-versions` semantics in pure Python so we don't
need python-debian or dpkg on the host. Used to decide whether the
component's installed version is already at or above the Ubuntu Security
fixed version.

Reference: https://www.debian.org/doc/debian-policy/ch-controlfields.html#version
"""
from __future__ import annotations

import re
from typing import Optional


_DIGIT_RE = re.compile(r"^(\d+)")
_NONDIGIT_RE = re.compile(r"^(\D+)")


def _split_epoch_upstream_revision(v: str) -> tuple[int, str, str]:
    """Split 'E:UPSTREAM-REVISION' into (epoch, upstream, revision)."""
    v = (v or "").strip()
    if not v:
        return 0, "", ""
    epoch = 0
    if ":" in v:
        ep, rest = v.split(":", 1)
        if ep.isdigit():
            epoch = int(ep)
            v = rest
    if "-" in v:
        upstream, _, revision = v.rpartition("-")
    else:
        upstream, revision = v, ""
    return epoch, upstream, revision


def _char_order(ch: str) -> int:
    """Debian lexicographic order: '~' < '' (end) < letters < everything else."""
    if ch == "~":
        return -1
    if ch == "":
        return 0
    if ch.isalpha():
        return ord(ch)
    # non-alpha non-tilde sorts after letters
    return ord(ch) + 256


def _compare_strings(a: str, b: str) -> int:
    i = j = 0
    while i < len(a) or j < len(b):
        ca = a[i] if i < len(a) else ""
        cb = b[j] if j < len(b) else ""
        # skip digits — they belong to the numeric segment
        if ca.isdigit() and cb.isdigit():
            break
        if ca.isdigit():
            ca = ""
        if cb.isdigit():
            cb = ""
        oa, ob = _char_order(ca), _char_order(cb)
        if oa != ob:
            return -1 if oa < ob else 1
        if ca:
            i += 1
        if cb:
            j += 1
        if not ca and not cb:
            break
    return 0


def _compare_segments(a: str, b: str) -> int:
    """Compare two upstream/revision segments per Debian rules."""
    i = j = 0
    while i < len(a) or j < len(b):
        # non-digit prefix
        na = _NONDIGIT_RE.match(a[i:])
        nb = _NONDIGIT_RE.match(b[j:])
        sa = na.group(1) if na else ""
        sb = nb.group(1) if nb else ""
        c = _compare_strings(sa, sb)
        if c != 0:
            return c
        i += len(sa)
        j += len(sb)
        # numeric prefix
        da = _DIGIT_RE.match(a[i:])
        db = _DIGIT_RE.match(b[j:])
        va = int(da.group(1)) if da else 0
        vb = int(db.group(1)) if db else 0
        if va != vb:
            return -1 if va < vb else 1
        i += len(da.group(1)) if da else 0
        j += len(db.group(1)) if db else 0
    return 0


def compare(v1: str, v2: str) -> int:
    """Return -1 if v1<v2, 0 if equal, 1 if v1>v2."""
    e1, u1, r1 = _split_epoch_upstream_revision(v1)
    e2, u2, r2 = _split_epoch_upstream_revision(v2)
    if e1 != e2:
        return -1 if e1 < e2 else 1
    c = _compare_segments(u1, u2)
    if c != 0:
        return c
    return _compare_segments(r1, r2)


def already_at_or_above(current: Optional[str], fixed: Optional[str]) -> Optional[bool]:
    """True if current >= fixed; None if comparison not possible."""
    if not current or not fixed:
        return None
    try:
        return compare(current, fixed) >= 0
    except Exception:  # noqa: BLE001
        return None
