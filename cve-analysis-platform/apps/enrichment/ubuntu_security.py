"""Ubuntu Security API client.

Ubuntu publishes a structured JSON view of every CVE at
    https://ubuntu.com/security/{CVE-ID}.json

We treat this source as the highest-priority validator for any Ubuntu-tracked
package CVE. The response shape (relevant fields):

    {
      "id": "CVE-2023-50387",
      "description": "...",
      "status": "active" | "pending" | ...,
      "priority": "low|medium|high|critical|negligible|unknown",
      "notes": [...],
      "notices": [{"id": "USN-6633-1", "type": "USN", ...}],
      "packages": [
        {
          "name": "bind9",
          "source": "bind9",
          "statuses": [
            {
              "release_codename": "jammy",
              "status": "released" | "needed" | "DNE" | ...,
              "description": "1:9.18.18-0ubuntu0.22.04.1",   # fixed version
            },
            ...
          ]
        },
        ...
      ]
    }

This client:
- caches responses on disk (TTL configurable) to avoid hammering ubuntu.com
- exposes a single `enrich(cve_id, component_name, release_codename=None)`
  call that returns a normalized result
- never raises on network errors; returns `UbuntuEnrichment(ok=False, ...)`
"""
from __future__ import annotations

import json
import re
import ssl
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional
from urllib.error import URLError, HTTPError
from urllib.request import Request, urlopen

from ..common.logging_utils import get_logger, log_event

logger = get_logger(__name__)


UBUNTU_API_BASE = "https://ubuntu.com/security/cves"
DEFAULT_TIMEOUT_S = 10
DEFAULT_CACHE_TTL_S = 24 * 3600  # 1 day
USN_ID_RE = re.compile(r"USN-\d+-\d+")


def _build_ssl_context() -> ssl.SSLContext:
    """Build an SSL context that works on macOS where the system Python
    install may lack a CA bundle. Falls back to certifi if available, then
    to the default context.
    """
    try:
        import certifi  # type: ignore

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:  # pragma: no cover - best-effort
        return ssl.create_default_context()


@dataclass
class PackageStatus:
    release: str
    status: str
    fixed_version: Optional[str] = None


@dataclass
class UbuntuEnrichment:
    """Normalized result from the Ubuntu Security API for one CVE."""

    ok: bool
    cve_id: str
    source: str = "ubuntu_security_api"
    status: Optional[str] = None        # active | not-affected | ...
    priority: Optional[str] = None      # low | medium | high | critical | ...
    description: Optional[str] = None
    usn_ids: list[str] = field(default_factory=list)
    package_statuses: list[PackageStatus] = field(default_factory=list)
    fixed_version: Optional[str] = None
    remediation: Optional[str] = None
    raw_url: Optional[str] = None
    error: Optional[str] = None
    # Release-specific fields (default release_codename = jammy via config).
    release_codename: Optional[str] = None       # the release we asked about
    release_status: Optional[str] = None         # its status (released/needed/pending/DNE/...)
    fixed_in_other_releases: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "cve_id": self.cve_id,
            "source": self.source,
            "status": self.status,
            "priority": self.priority,
            "description": self.description,
            "usn_ids": list(self.usn_ids),
            "fixed_version": self.fixed_version,
            "remediation": self.remediation,
            "package_statuses": [
                {"release": p.release, "status": p.status, "fixed_version": p.fixed_version}
                for p in self.package_statuses
            ],
            "raw_url": self.raw_url,
            "error": self.error,
            "release_codename": self.release_codename,
            "release_status": self.release_status,
            "fixed_in_other_releases": list(self.fixed_in_other_releases),
        }


class UbuntuSecurityClient:
    def __init__(
        self,
        cache_dir: str | Path = ".data/ubuntu_cache",
        cache_ttl_s: int = DEFAULT_CACHE_TTL_S,
        timeout_s: int = DEFAULT_TIMEOUT_S,
        enabled: bool = True,
    ) -> None:
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.cache_ttl_s = cache_ttl_s
        self.timeout_s = timeout_s
        self.enabled = enabled

    # ------------------------------------------------------------------
    def enrich(
        self,
        cve_id: str,
        component_name: Optional[str] = None,
        release_codename: Optional[str] = None,
    ) -> UbuntuEnrichment:
        cve_id = (cve_id or "").upper().strip()
        if not cve_id.startswith("CVE-"):
            return UbuntuEnrichment(ok=False, cve_id=cve_id, error="not a CVE id")
        if not self.enabled:
            return UbuntuEnrichment(ok=False, cve_id=cve_id, error="ubuntu enrichment disabled")

        raw = self._fetch(cve_id)
        if not raw:
            return UbuntuEnrichment(
                ok=False,
                cve_id=cve_id,
                error="ubuntu api unreachable or returned no data",
                raw_url=f"{UBUNTU_API_BASE}/{cve_id}.json",
            )
        return self._normalize(cve_id, raw, component_name, release_codename)

    # ------------------------------------------------------------------
    def _cache_path(self, cve_id: str) -> Path:
        return self.cache_dir / f"{cve_id.upper()}.json"

    def _fetch(self, cve_id: str) -> Optional[dict[str, Any]]:
        cache_path = self._cache_path(cve_id)
        now = time.time()
        if cache_path.exists() and (now - cache_path.stat().st_mtime) < self.cache_ttl_s:
            try:
                return json.loads(cache_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                pass  # fall through to fetch

        url = f"{UBUNTU_API_BASE}/{cve_id}.json"
        req = Request(url, headers={"User-Agent": "cve-analysis-platform/1.0"})
        try:
            with urlopen(req, timeout=self.timeout_s, context=_build_ssl_context()) as resp:
                payload = resp.read()
            data = json.loads(payload.decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            log_event(logger, "ubuntu.fetch_failed", cve_id=cve_id, error=str(exc))
            return None
        try:
            cache_path.write_text(json.dumps(data), encoding="utf-8")
        except OSError:
            pass
        log_event(logger, "ubuntu.fetched", cve_id=cve_id, bytes=len(payload))
        return data

    # ------------------------------------------------------------------
    def _normalize(
        self,
        cve_id: str,
        raw: dict[str, Any],
        component_name: Optional[str],
        release_codename: Optional[str],
    ) -> UbuntuEnrichment:
        notices = raw.get("notices") or []
        usn_ids: list[str] = []
        for n in notices:
            nid = str(n.get("id", ""))
            if USN_ID_RE.match(nid):
                usn_ids.append(nid)

        status = raw.get("status")
        priority = raw.get("priority") or raw.get("ubuntu_priority")
        description = raw.get("description")

        # Filter packages: best-effort match against component name (incl. upstream).
        all_statuses: list[PackageStatus] = []
        match_statuses: list[PackageStatus] = []
        wanted_names: set[str] = set()
        if component_name:
            wanted_names.add(component_name.lower())
            # Best-effort upstream guess: strip common suffixes.
            base = re.sub(r"(-libs?|-utils?|-common|-bin|-dev|-tools?|-doc)$",
                          "", component_name.lower())
            wanted_names.add(base)

        for pkg in raw.get("packages", []) or []:
            pkg_name = str(pkg.get("name", "")).lower()
            # 'source' on the current Ubuntu API is a URL, not a package
            # name, so ignore it for matching purposes.
            for st in pkg.get("statuses", []) or []:
                ps = PackageStatus(
                    release=str(st.get("release_codename", "")),
                    status=str(st.get("status", "")),
                    fixed_version=(st.get("description") or None) if st.get("status") == "released" else None,
                )
                all_statuses.append(ps)
                if wanted_names and pkg_name in wanted_names:
                    match_statuses.append(ps)

        # Release-aware decision:
        #  * Only set `fixed_version` when the requested release (e.g. jammy)
        #    has a `released` status. Routing should NOT auto-upgrade to a
        #    version that isn't actually shipped for the deployed release.
        #  * When the requested release is NOT yet fixed but other releases
        #    are, report them in `fixed_in_other_releases` so triage can say
        #    "fixed by Ubuntu in <X> but not yet in <release>; check code
        #    reachability".
        chosen_fixed: Optional[str] = None
        release_status_val: Optional[str] = None
        fixed_in_other: list[dict] = []
        scope = match_statuses or all_statuses

        if release_codename:
            for ps in scope:
                if ps.release == release_codename:
                    release_status_val = ps.status
                    if ps.status == "released" and ps.fixed_version:
                        chosen_fixed = ps.fixed_version
                    break  # one entry per release

        if not chosen_fixed:
            for ps in scope:
                if (
                    ps.status == "released"
                    and ps.fixed_version
                    and (not release_codename or ps.release != release_codename)
                ):
                    fixed_in_other.append(
                        {"release": ps.release, "fixed_version": ps.fixed_version}
                    )

        # If caller didn't specify a release, fall back to the legacy
        # "any released fix" behaviour for backwards compatibility.
        if not chosen_fixed and not release_codename:
            for ps in scope:
                if ps.status == "released" and ps.fixed_version:
                    chosen_fixed = ps.fixed_version
                    break

        remediation: Optional[str] = None
        if chosen_fixed:
            rel_txt = f" on Ubuntu {release_codename}" if release_codename else ""
            remediation = (
                f"Upgrade affected package to {chosen_fixed}{rel_txt} "
                f"(per Ubuntu Security)."
            )
        elif fixed_in_other:
            sample = ", ".join(
                f"{x['release']}={x['fixed_version']}" for x in fixed_in_other[:4]
            )
            rel_txt = release_codename or "requested release"
            stat_txt = release_status_val or "unknown"
            remediation = (
                f"Ubuntu Security has released a fix in other releases ({sample}) "
                f"but NOT yet for {rel_txt} (status={stat_txt}). "
                f"Evaluate code reachability before taking action."
            )
        elif usn_ids:
            remediation = f"Apply Ubuntu security update: {', '.join(usn_ids)}."

        return UbuntuEnrichment(
            ok=True,
            cve_id=cve_id,
            status=status,
            priority=priority,
            description=description,
            usn_ids=usn_ids,
            package_statuses=match_statuses or all_statuses,
            fixed_version=chosen_fixed,
            remediation=remediation,
            raw_url=f"{UBUNTU_API_BASE}/{cve_id}.json",
            release_codename=release_codename,
            release_status=release_status_val,
            fixed_in_other_releases=fixed_in_other,
        )
