"""Unit tests for the Ubuntu Security API client (no network)."""
from __future__ import annotations

import json
from pathlib import Path

from apps.enrichment.ubuntu_security import UbuntuSecurityClient, UbuntuEnrichment


SAMPLE = {
    "id": "CVE-2023-50387",
    "description": "DNSSEC validation issue (KeyTrap).",
    "status": "active",
    "priority": "medium",
    "notices": [
        {"id": "USN-6633-1", "type": "USN"},
        {"id": "not-a-usn", "type": "USN"},
    ],
    "packages": [
        {
            "name": "bind9",
            "source": "bind9",
            "statuses": [
                {"release_codename": "focal", "status": "released",
                 "description": "1:9.16.48-0ubuntu0.20.04.1"},
                {"release_codename": "jammy", "status": "released",
                 "description": "1:9.18.18-0ubuntu0.22.04.2"},
                {"release_codename": "noble", "status": "needed", "description": ""},
            ],
        },
        {
            "name": "unrelated-pkg",
            "source": "unrelated-pkg",
            "statuses": [
                {"release_codename": "jammy", "status": "released",
                 "description": "WRONG_VERSION"},
            ],
        },
    ],
}


def _client(tmp_path: Path) -> UbuntuSecurityClient:
    return UbuntuSecurityClient(cache_dir=tmp_path / "u", cache_ttl_s=3600, timeout_s=1)


def test_enrich_rejects_non_cve_id(tmp_path):
    c = _client(tmp_path)
    out = c.enrich("not-a-cve")
    assert isinstance(out, UbuntuEnrichment)
    assert out.ok is False
    assert "not a CVE" in (out.error or "")


def test_enrich_disabled(tmp_path):
    c = UbuntuSecurityClient(cache_dir=tmp_path / "u", enabled=False)
    out = c.enrich("CVE-2023-1111")
    assert out.ok is False
    assert "disabled" in (out.error or "")


def test_enrich_uses_cache_and_normalizes(tmp_path, monkeypatch):
    c = _client(tmp_path)
    # Seed cache directly
    (tmp_path / "u" / "CVE-2023-50387.json").write_text(json.dumps(SAMPLE), encoding="utf-8")
    # Force a network call to fail loudly if the cache isn't used.
    monkeypatch.setattr(
        "apps.enrichment.ubuntu_security.urlopen",
        lambda *a, **kw: (_ for _ in ()).throw(AssertionError("network used")),
    )
    out = c.enrich("CVE-2023-50387", component_name="bind9", release_codename="jammy")
    assert out.ok is True
    assert out.status == "active"
    assert out.priority == "medium"
    assert "USN-6633-1" in out.usn_ids
    assert "not-a-usn" not in out.usn_ids
    # Matches release codename for bind9.
    assert out.fixed_version == "1:9.18.18-0ubuntu0.22.04.2"
    assert "Upgrade affected package" in (out.remediation or "")


def test_enrich_release_not_fixed_reports_other_releases(tmp_path, monkeypatch):
    """When the requested release isn't fixed, fixed_version must be None
    and `fixed_in_other_releases` must list the releases that ARE fixed.
    This is the jammy-strict behaviour: never auto-recommend a version that
    Ubuntu hasn't shipped for our actual release.
    """
    c = _client(tmp_path)
    (tmp_path / "u" / "CVE-2023-50387.json").write_text(json.dumps(SAMPLE), encoding="utf-8")
    monkeypatch.setattr(
        "apps.enrichment.ubuntu_security.urlopen",
        lambda *a, **kw: (_ for _ in ()).throw(AssertionError("network used")),
    )
    out = c.enrich("CVE-2023-50387", component_name="bind9", release_codename="impish")
    assert out.ok is True
    assert out.fixed_version is None  # impish not in sample
    assert out.release_status is None
    fixed_releases = {x["release"] for x in out.fixed_in_other_releases}
    assert "focal" in fixed_releases and "jammy" in fixed_releases
    assert "but NOT yet for impish" in (out.remediation or "")


def test_enrich_handles_network_failure(tmp_path, monkeypatch):
    from urllib.error import URLError

    c = _client(tmp_path)

    def boom(*a, **kw):
        raise URLError("dns unreachable")

    monkeypatch.setattr("apps.enrichment.ubuntu_security.urlopen", boom)
    out = c.enrich("CVE-2099-9999")
    assert out.ok is False
    assert out.raw_url and out.raw_url.endswith("CVE-2099-9999.json")
