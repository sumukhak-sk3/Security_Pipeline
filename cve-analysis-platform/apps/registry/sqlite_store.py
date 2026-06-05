"""SQLite registry: dedupe, suppression, verdict expiry, and re-evaluation."""
from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

from ..common.exceptions import RegistryError
from ..common.logging_utils import get_logger, log_event

logger = get_logger(__name__)


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS analyses (
    cve_id TEXT NOT NULL,
    component TEXT NOT NULL,
    version TEXT NOT NULL,
    verdict TEXT NOT NULL,
    triage_confidence REAL,
    fix_confidence REAL,
    evidence_confidence REAL,
    rationale TEXT,
    source TEXT,
    expiry_timestamp TEXT NOT NULL,
    last_updated TEXT NOT NULL,
    analysis_id TEXT NOT NULL,
    metadata_hash TEXT,
    PRIMARY KEY (cve_id, component, version)
);

CREATE TABLE IF NOT EXISTS suppressions (
    cve_id TEXT NOT NULL,
    component TEXT NOT NULL,
    reason TEXT,
    suppressed_until TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (cve_id, component)
);
"""


@dataclass
class RegistryEntry:
    cve_id: str
    component: str
    version: str
    verdict: str
    triage_confidence: float | None
    fix_confidence: float | None
    evidence_confidence: float | None
    rationale: str | None
    source: str | None
    expiry_timestamp: datetime
    last_updated: datetime
    analysis_id: str
    metadata_hash: str | None


class SqliteRegistry:
    def __init__(self, db_path: str | Path, ttl_days: int = 30) -> None:
        self.db_path = str(db_path)
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self.ttl = timedelta(days=ttl_days)
        self._lock = threading.Lock()
        with self._conn() as conn:
            conn.executescript(SCHEMA_SQL)

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            conn = sqlite3.connect(self.db_path, timeout=10, isolation_level=None)
            conn.row_factory = sqlite3.Row
            try:
                yield conn
            finally:
                conn.close()

    # ------------------------------------------------------------------
    # Lookups
    # ------------------------------------------------------------------

    def lookup(self, cve_id: str, component: str, version: str) -> Optional[RegistryEntry]:
        try:
            with self._conn() as conn:
                row = conn.execute(
                    "SELECT * FROM analyses WHERE cve_id=? AND component=? AND version=?",
                    (cve_id, component, version),
                ).fetchone()
        except sqlite3.Error as exc:
            raise RegistryError(f"lookup failed: {exc}") from exc
        if not row:
            return None
        return RegistryEntry(
            cve_id=row["cve_id"],
            component=row["component"],
            version=row["version"],
            verdict=row["verdict"],
            triage_confidence=row["triage_confidence"],
            fix_confidence=row["fix_confidence"],
            evidence_confidence=row["evidence_confidence"],
            rationale=row["rationale"],
            source=row["source"],
            expiry_timestamp=datetime.fromisoformat(row["expiry_timestamp"]),
            last_updated=datetime.fromisoformat(row["last_updated"]),
            analysis_id=row["analysis_id"],
            metadata_hash=row["metadata_hash"],
        )

    def is_suppressed(self, cve_id: str, component: str) -> bool:
        try:
            with self._conn() as conn:
                row = conn.execute(
                    "SELECT suppressed_until FROM suppressions WHERE cve_id=? AND component=?",
                    (cve_id, component),
                ).fetchone()
        except sqlite3.Error as exc:
            raise RegistryError(f"suppression lookup failed: {exc}") from exc
        if not row:
            return False
        until = row["suppressed_until"]
        if not until:
            return True
        return datetime.fromisoformat(until) > datetime.now(timezone.utc)

    # ------------------------------------------------------------------
    # Re-evaluation policy
    # ------------------------------------------------------------------

    def needs_reevaluation(
        self,
        prior: RegistryEntry | None,
        current_version: str,
        current_metadata_hash: str,
    ) -> bool:
        if prior is None:
            return True
        if prior.version != current_version:
            return True
        if prior.metadata_hash and prior.metadata_hash != current_metadata_hash:
            return True
        if prior.expiry_timestamp <= datetime.now(timezone.utc):
            return True
        return False

    # ------------------------------------------------------------------
    # Writes
    # ------------------------------------------------------------------

    def upsert(self, entry: dict[str, Any]) -> None:
        now = datetime.now(timezone.utc)
        expiry = now + self.ttl
        params = (
            entry["cve_id"],
            entry["component"],
            entry["version"],
            entry["verdict"],
            entry.get("triage_confidence"),
            entry.get("fix_confidence"),
            entry.get("evidence_confidence"),
            entry.get("rationale"),
            entry.get("source"),
            entry.get("expiry_timestamp", expiry).isoformat()
            if isinstance(entry.get("expiry_timestamp"), datetime)
            else expiry.isoformat(),
            now.isoformat(),
            entry["analysis_id"],
            entry.get("metadata_hash"),
        )
        try:
            with self._conn() as conn:
                conn.execute(
                    """
                    INSERT INTO analyses (
                        cve_id, component, version, verdict,
                        triage_confidence, fix_confidence, evidence_confidence,
                        rationale, source, expiry_timestamp, last_updated,
                        analysis_id, metadata_hash
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(cve_id, component, version) DO UPDATE SET
                        verdict=excluded.verdict,
                        triage_confidence=excluded.triage_confidence,
                        fix_confidence=excluded.fix_confidence,
                        evidence_confidence=excluded.evidence_confidence,
                        rationale=excluded.rationale,
                        source=excluded.source,
                        expiry_timestamp=excluded.expiry_timestamp,
                        last_updated=excluded.last_updated,
                        analysis_id=excluded.analysis_id,
                        metadata_hash=excluded.metadata_hash
                    """,
                    params,
                )
        except sqlite3.Error as exc:
            raise RegistryError(f"upsert failed: {exc}") from exc

        log_event(
            logger,
            "registry.upsert",
            cve_id=entry["cve_id"],
            component=entry["component"],
            version=entry["version"],
            verdict=entry["verdict"],
        )

    def suppress(
        self,
        cve_id: str,
        component: str,
        reason: str | None = None,
        until: datetime | None = None,
    ) -> None:
        now = datetime.now(timezone.utc).isoformat()
        try:
            with self._conn() as conn:
                conn.execute(
                    """
                    INSERT INTO suppressions (cve_id, component, reason, suppressed_until, created_at)
                    VALUES (?,?,?,?,?)
                    ON CONFLICT(cve_id, component) DO UPDATE SET
                        reason=excluded.reason,
                        suppressed_until=excluded.suppressed_until
                    """,
                    (cve_id, component, reason, until.isoformat() if until else None, now),
                )
        except sqlite3.Error as exc:
            raise RegistryError(f"suppress failed: {exc}") from exc


def metadata_hash(event_dict: dict[str, Any]) -> str:
    """Stable hash over CVE metadata that should trigger re-evaluation when changed."""
    import hashlib

    keys = [
        "cve_id",
        "severity",
        "description",
        "references",
        "external_links",
        ("component", "name"),
        ("component", "fixed_version"),
    ]
    parts: list[str] = []
    for k in keys:
        if isinstance(k, tuple):
            cur: Any = event_dict
            for kk in k:
                cur = (cur or {}).get(kk) if isinstance(cur, dict) else None
            parts.append(json.dumps(cur, sort_keys=True, default=str))
        else:
            parts.append(json.dumps(event_dict.get(k), sort_keys=True, default=str))
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()
