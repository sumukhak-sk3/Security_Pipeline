from datetime import datetime, timedelta, timezone
from pathlib import Path

from apps.registry.sqlite_store import SqliteRegistry, metadata_hash


def test_upsert_lookup_and_reeval(tmp_path: Path):
    reg = SqliteRegistry(tmp_path / "r.sqlite", ttl_days=30)
    entry = {
        "cve_id": "CVE-2024-1",
        "component": "openssl",
        "version": "3.0.11",
        "verdict": "package_upgrade",
        "triage_confidence": 0.9,
        "fix_confidence": 0.0,
        "evidence_confidence": 0.8,
        "rationale": "fixed upstream",
        "source": "dependency_track",
        "analysis_id": "an-1",
        "metadata_hash": "h1",
    }
    reg.upsert(entry)
    got = reg.lookup("CVE-2024-1", "openssl", "3.0.11")
    assert got is not None
    assert got.verdict == "package_upgrade"

    # same version + hash => no re-evaluation
    assert not reg.needs_reevaluation(got, "3.0.11", "h1")
    # version change => re-evaluate
    assert reg.needs_reevaluation(got, "3.0.12", "h1")
    # hash change => re-evaluate
    assert reg.needs_reevaluation(got, "3.0.11", "h2")


def test_suppression(tmp_path: Path):
    reg = SqliteRegistry(tmp_path / "r.sqlite")
    assert not reg.is_suppressed("CVE-X", "vim")
    reg.suppress("CVE-X", "vim", reason="test", until=datetime.now(timezone.utc) + timedelta(days=1))
    assert reg.is_suppressed("CVE-X", "vim")


def test_metadata_hash_is_stable():
    e = {"cve_id": "CVE-1", "severity": {"label": "HIGH"}, "component": {"name": "x"}}
    assert metadata_hash(e) == metadata_hash(dict(e))
