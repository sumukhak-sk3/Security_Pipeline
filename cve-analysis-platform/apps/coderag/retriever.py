"""Code-RAG retriever.

Index-first retrieval with a file-fetch fallback. The retriever loads the
index lazily and caches it per repo_root. It computes simple TF-IDF cosine
similarity over token sets, then reranks. When the top score is below the
configured threshold (or the index is missing), it falls back to keyword grep.
"""
from __future__ import annotations

import json
import math
import re
import threading
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from ..common.logging_utils import get_logger, log_event
from . import file_fetch
from .reranker import rerank, take_top_k_distinct_files

logger = get_logger(__name__)

_TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{2,}")
_CVE_RE = re.compile(r"CVE-\d{4}-\d+", re.IGNORECASE)


def _tokenize(text: str) -> list[str]:
    return [t.lower() for t in _TOKEN_RE.findall(text)]


def _family_tokens(component_name: str | None) -> set[str]:
    """Tokens that should appear in a path for it to be considered relevant
    to `component_name`. Strips common packaging suffixes and version digits.

    For module paths like ``github.com/apache/thrift`` we keep only the
    *last* segment (``thrift``) as a search token. Intermediate organisation
    segments such as ``apache`` or ``google`` are far too broad — letting
    them through caused unrelated code (e.g. Apache HTTPD certs) to be
    returned as evidence for ``github.com/apache/thrift``.
    """
    if not component_name:
        return set()
    c = component_name.lower()
    toks: set[str] = {c}
    if "/" in c:
        # Only the trailing path segment carries the actual library name.
        # Discard `github.com`, organisation names, etc.
        last = c.rsplit("/", 1)[-1].strip()
        if last:
            toks.add(last)
    for suf in ("-libs", "-utils", "-common", "-dev", "-bin",
                "-server", "-client"):
        if c.endswith(suf):
            toks.add(c[:-len(suf)])
    if "-" in c and "/" not in c:
        # Only split dashes for distro-style package names (e.g.
        # ``bind9-libs``). For module paths we already picked the trailing
        # segment above.
        toks.add(c.split("-", 1)[-1])
        toks.add(c.split("-", 1)[0])
    if c.startswith("python3-") or c.startswith("python-"):
        toks.add(c.split("-", 1)[1])
    stripped = re.sub(r"[\d.]+$", "", c)
    if stripped and stripped != c:
        toks.add(stripped)
    # Drop short / generic tokens that match unrelated paths.
    GENERIC = {"lib", "libs", "bin", "src", "util", "utils", "common",
               "dev", "server", "client", "core", "test", "tests",
               "python", "python3", "com", "org", "net", "io", "go",
               # Common ecosystem organisation names that are *never*
               # specific enough on their own.
               "apache", "google", "golang", "kubernetes", "openstack",
               "microsoft", "amazon", "aws", "github", "gitlab"}
    return {t for t in toks if len(t) >= 3 and t not in GENERIC}


_DEMOTE_PATH_TOKENS = (
    "/test/", "/tests/", "_test", "_tests", "/doc/", "/docs/",
    "/example", "/sample", "/contrib/", "/packaging/", "/debian/",
    "rsync-exclude", "makefile", "/mk/", ".sh", ".txt", ".md",
    ".cfg", ".ini", ".conf", ".yaml", ".yml", "/manifest",
    "show_upgrade", "upgrade_path",
)


def _path_quality(path: str) -> float:
    p = path.lower()
    s = 0.0
    for tok in _DEMOTE_PATH_TOKENS:
        if tok in p:
            s -= 0.5
    if p.endswith((".c", ".h", ".cc", ".cpp", ".py", ".go", ".rs",
                   ".pl", ".pm", ".java", ".js", ".ts")):
        s += 0.3
    return s


def _filter_by_family(hits: list[dict], family: set[str]) -> list[dict]:
    """Drop hits whose path doesn't mention any family token. Returns an
    empty list when no path matches — surfacing unrelated code as "evidence"
    is worse than admitting the component isn't present in-tree."""
    if not family:
        return hits
    return [h for h in hits if any(t in (h.get("path", "")).lower() for t in family)]


@dataclass
class RetrievalConfig:
    chunk_lines: int = 80
    chunk_overlap: int = 10
    max_files_per_query: int = 8
    fallback_window_lines: int = 40
    fallback_score_threshold: float = 0.18


class _IndexHandle:
    def __init__(self, index_dir: Path) -> None:
        self.index_dir = index_dir
        meta_path = index_dir / "meta.json"
        chunks_path = index_dir / "chunks.jsonl"
        if not meta_path.exists() or not chunks_path.exists():
            raise FileNotFoundError(f"index missing at {index_dir}")
        self.meta = json.loads(meta_path.read_text(encoding="utf-8"))
        self.idf: dict[str, float] = self.meta.get("idf", {})
        self.chunks: list[dict] = []
        with chunks_path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                self.chunks.append(json.loads(line))
        # Precompute per-chunk weighted vector norm for cosine sim.
        for c in self.chunks:
            vec = {t: self.idf.get(t, 1.0) for t in c["tokens"]}
            c["_vec"] = vec
            c["_norm"] = math.sqrt(sum(w * w for w in vec.values())) or 1.0


class Retriever:
    def __init__(self, cfg: RetrievalConfig) -> None:
        self.cfg = cfg
        self._handles: dict[str, _IndexHandle] = {}
        self._lock = threading.Lock()

    def _handle_for(self, index_dir: Path) -> _IndexHandle | None:
        key = str(index_dir.resolve())
        with self._lock:
            if key in self._handles:
                return self._handles[key]
            try:
                handle = _IndexHandle(index_dir)
            except FileNotFoundError:
                return None
            self._handles[key] = handle
            return handle

    # ------------------------------------------------------------------

    def _score_query(self, handle: _IndexHandle, query_terms: list[str]) -> list[dict]:
        if not query_terms:
            return []
        q_counts = Counter(query_terms)
        q_vec = {t: handle.idf.get(t, 1.0) * c for t, c in q_counts.items()}
        q_norm = math.sqrt(sum(w * w for w in q_vec.values())) or 1.0
        hits: list[dict] = []
        for chunk in handle.chunks:
            vec = chunk["_vec"]
            dot = 0.0
            for t, qw in q_vec.items():
                if t in vec:
                    dot += qw * vec[t]
            if dot <= 0:
                continue
            score = dot / (q_norm * chunk["_norm"])
            hits.append({
                "id": chunk["id"],
                "path": chunk["path"],
                "start_line": chunk["start_line"],
                "end_line": chunk["end_line"],
                "text": chunk["text"],
                "imports": chunk["imports"],
                "symbols": chunk["symbols"],
                "score": score,
            })
        hits.sort(key=lambda r: r["score"], reverse=True)
        return hits

    def retrieve(
        self,
        *,
        index_dir: str | Path | None,
        repo_root: str | Path | None,
        component_name: str | None,
        cve_id: str | None,
        extra_keywords: Iterable[str] = (),
    ) -> dict:
        """Return {"hits": [...], "source": "index|file_fetch|none"}."""
        keywords = [k for k in [component_name, cve_id, *extra_keywords] if k]
        family = _family_tokens(component_name)
        index_hits: list[dict] = []
        source = "none"

        if index_dir:
            handle = self._handle_for(Path(index_dir))
            if handle:
                query_terms: list[str] = []
                for kw in keywords:
                    query_terms.extend(_tokenize(kw))
                index_hits = self._score_query(handle, query_terms)
                index_hits = rerank(index_hits, component_name, cve_id)
                # Apply path-quality demotion + family filter before truncation.
                for h in index_hits:
                    h["score"] = float(h.get("score", 0.0)) + _path_quality(h.get("path", ""))
                index_hits.sort(key=lambda r: r.get("score", 0.0), reverse=True)
                index_hits = _filter_by_family(index_hits, family)
                index_hits = take_top_k_distinct_files(
                    index_hits, self.cfg.max_files_per_query
                )
                if index_hits and index_hits[0]["score"] >= self.cfg.fallback_score_threshold:
                    source = "index"
                    log_event(
                        logger,
                        "coderag.retrieve.index",
                        component=component_name,
                        cve_id=cve_id,
                        hits=len(index_hits),
                        top_score=index_hits[0]["score"],
                    )
                    return {"hits": index_hits, "source": source}

        # Fallback: file-fetch keyword scan.
        if repo_root:
            # Put component_name FIRST so file_fetch's own family-token
            # extraction keys off the real component, not description noise.
            ff_keywords = [k for k in [component_name, *extra_keywords, cve_id] if k]
            file_hits = file_fetch.grep_keyword_windows(
                repo_root,
                ff_keywords,
                window_lines=self.cfg.fallback_window_lines,
                max_files=self.cfg.max_files_per_query,
            )
            file_hits = _filter_by_family(file_hits, family)
            if file_hits:
                # Decorate with index-like fields and score so callers can use uniformly.
                decorated = [
                    {
                        "id": f"ff:{i}",
                        "path": h["path"],
                        "start_line": h["start_line"],
                        "end_line": h["end_line"],
                        "text": h["snippet"],
                        "imports": [],
                        "symbols": [],
                        "score": 0.2,
                        "matched_keyword": h["matched_keyword"],
                    }
                    for i, h in enumerate(file_hits)
                ]
                source = "file_fetch"
                log_event(
                    logger,
                    "coderag.retrieve.fallback",
                    component=component_name,
                    cve_id=cve_id,
                    hits=len(decorated),
                )
                return {"hits": decorated, "source": source}

        # Nothing found anywhere; return whatever weak index hits we had, if any.
        if index_hits:
            log_event(
                logger,
                "coderag.retrieve.weak_index_only",
                component=component_name,
                cve_id=cve_id,
                hits=len(index_hits),
                top_score=index_hits[0]["score"] if index_hits else 0.0,
            )
            return {"hits": index_hits, "source": "index"}

        log_event(
            logger,
            "coderag.retrieve.none",
            component=component_name,
            cve_id=cve_id,
        )
        return {"hits": [], "source": "none"}
