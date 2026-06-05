"""Lightweight reranker for retrieval hits.

Currently boosts hits whose imports/symbols mention the queried component name
and applies a small recency / path-affinity bonus when a package name appears in
the file path. Kept dependency-free so it works in offline test environments.
"""
from __future__ import annotations

from typing import Iterable


def rerank(
    hits: list[dict],
    component_name: str | None = None,
    cve_id: str | None = None,
) -> list[dict]:
    if not hits:
        return hits
    name = (component_name or "").lower()
    cve = (cve_id or "").lower()
    for h in hits:
        boost = 0.0
        path_low = h.get("path", "").lower()
        if name and name in path_low:
            boost += 0.15
        if name:
            for sym in h.get("symbols", []):
                if name in sym.lower():
                    boost += 0.05
                    break
            for imp in h.get("imports", []):
                if name in imp.lower():
                    boost += 0.05
                    break
        if cve and cve in (h.get("text", "").lower()):
            boost += 0.2
        h["score"] = float(h.get("score", 0.0)) + boost
    hits.sort(key=lambda r: r.get("score", 0.0), reverse=True)
    return hits


def take_top_k_distinct_files(hits: Iterable[dict], k: int) -> list[dict]:
    """Return top hits with at most one chunk per file."""
    seen: set[str] = set()
    out: list[dict] = []
    for h in hits:
        path = h.get("path", "")
        if path in seen:
            continue
        seen.add(path)
        out.append(h)
        if len(out) >= k:
            break
    return out
