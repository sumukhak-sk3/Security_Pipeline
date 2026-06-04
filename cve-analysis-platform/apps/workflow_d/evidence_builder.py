"""Build the shared evidence bundle for one CVE.

The bundle is built ONCE and reused across context, triage, fix authoring, and
verifier stages. This is intentional: avoid letting each stage rescan the repo.
"""
from __future__ import annotations

import re
from typing import Iterable

from ..coderag.retriever import Retriever
from ..common.logging_utils import get_logger, log_event
from ..enrichment.ubuntu_security import UbuntuEnrichment, UbuntuSecurityClient
from ..registry.sqlite_store import SqliteRegistry
from .schemas import (
    AdvisoryEvidence,
    CodeEvidence,
    Component,
    CVEEvent,
    EvidenceBundle,
)

logger = get_logger(__name__)


# Reuse the heuristic taxonomy from the prototype orchestrator so we stay
# consistent with existing reports. Kept local to avoid importing the prototype.
RUNTIME_COMPONENTS = {
    "openssl", "curl", "bind9", "suricata", "strongswan", "frr",
    "openssh", "python3", "expat", "libxml2", "dnsmasq", "ntp",
    "gsoap", "openvpn", "syslog-ng", "gunicorn", "redis",
}
BUILD_ONLY_COMPONENTS = {
    "binutils", "cmake", "flex", "gdb", "devscripts", "indent",
    "autogen", "dpkg", "check",
}
INSTALLED_ONLY_COMPONENTS = {
    "vim", "patch", "screen", "dmidecode", "cpio", "sed",
    "elfutils", "tar", "wget", "xz-utils", "gdisk",
    "lxc", "rpm", "coreutils", "kmod",
}
HARDWARE_FIRMWARE = {"amd64-microcode", "intel-microcode", "tpm2-tools"}

UPSTREAM_MAP = {
    "libcurl4": "curl", "libcurl3-gnutls": "curl",
    "libssl3": "openssl", "libssl-dev": "openssl",
    "openssh-client": "openssh", "openssh-server": "openssh",
    "python3-minimal": "python3", "python3.10": "python3", "libpython3.10": "python3",
    "vim-common": "vim", "vim-runtime": "vim", "vim-tiny": "vim", "xxd": "vim",
    "bind9-libs": "bind9", "bind9-host": "bind9", "bind9-utils": "bind9",
    "systemd-sysv": "systemd", "udev": "systemd", "libsystemd0": "systemd",
    "libbinutils": "binutils",
    "busybox-initramfs": "busybox",
    "libexpat1": "expat",
    "libxml2-utils": "libxml2",
}


def _upstream(name: str) -> str:
    return UPSTREAM_MAP.get(name, name)


def _classify_reachability(name: str) -> str:
    upstream = _upstream(name)
    if upstream in RUNTIME_COMPONENTS or name in RUNTIME_COMPONENTS:
        return "RUNTIME"
    if upstream in BUILD_ONLY_COMPONENTS or name in BUILD_ONLY_COMPONENTS:
        return "BUILD_ONLY"
    if upstream in INSTALLED_ONLY_COMPONENTS or name in INSTALLED_ONLY_COMPONENTS:
        return "INSTALLED_ONLY"
    if name in HARDWARE_FIRMWARE:
        return "HARDWARE_FIRMWARE"
    return "NEEDS_ASSESSMENT"


def _assess_advisory_status(description: str | None, references: str | None) -> tuple[str, list[str]]:
    desc = (description or "").upper()
    refs = references or ""
    if "REJECT" in desc or "DO NOT USE THIS CANDIDATE" in desc:
        return "REJECTED", []
    usn = re.findall(r"USN-\d+-\d+", refs)
    if usn:
        return "USN_TRACKED", usn
    return "ACTIVE", []


def _evidence_confidence(bundle: EvidenceBundle) -> float:
    """Heuristic confidence score for the evidence bundle as a whole.

    Weights:
      - up to 0.30 for diverse advisory signals (USN, fixed_version, reachability, ...)
      - up to 0.20 for code evidence (index hits are weighted higher than fallback)
      - +0.35 if upstream-fixed version is known
      - +0.25 if reachability classification is decisive
      - +0.20 if Ubuntu Security API confirmed the CVE (any verdict, ok=True)
    Capped at 0.85 unless an authoritative remediation is present (then 0.95).
    Authoritative = Ubuntu API returned a release-matched fixed_version.
    """
    score = 0.0
    n_adv = len(bundle.advisory_evidence)
    index_hits = sum(1 for c in bundle.code_evidence if c.source == "index")
    fallback_hits = sum(1 for c in bundle.code_evidence if c.source == "file_fetch")
    score += min(0.30, 0.15 * n_adv)
    # Index hits earn more than grep fallbacks (which are often noisy).
    score += min(0.20, 0.04 * index_hits + 0.01 * fallback_hits)
    if bundle.fixed_version:
        score += 0.35
    if bundle.reachability in {"RUNTIME", "BUILD_ONLY", "INSTALLED_ONLY", "HARDWARE_FIRMWARE"}:
        score += 0.25
    has_ubuntu = bool(bundle.ubuntu_security and bundle.ubuntu_security.get("ok"))
    if has_ubuntu:
        score += 0.20
    cap = 0.85
    if has_ubuntu and bundle.ubuntu_security.get("fixed_version"):
        cap = 0.95
    return round(min(cap, score), 3)


class EvidenceBuilder:
    def __init__(
        self,
        retriever: Retriever,
        registry: SqliteRegistry,
        default_repo_root: str | None = None,
        default_index_dir: str | None = None,
        ubuntu_client: UbuntuSecurityClient | None = None,
        release_codename: str | None = None,
    ) -> None:
        self.retriever = retriever
        self.registry = registry
        self.default_repo_root = default_repo_root
        self.default_index_dir = default_index_dir
        self.ubuntu_client = ubuntu_client
        self.release_codename = release_codename

    def build(self, event: CVEEvent) -> EvidenceBundle:
        comp: Component = event.component
        adv_status, usn_ids = _assess_advisory_status(event.description, event.references)
        reachability = _classify_reachability(comp.name)
        fixed_version = comp.fixed_version

        advisory_evidence: list[AdvisoryEvidence] = []
        notes: list[str] = []

        if adv_status == "REJECTED":
            advisory_evidence.append(AdvisoryEvidence(
                id="rejected", kind="rejected_cve",
                summary="Upstream advisory marked this CVE as REJECTED.",
                detail={"description": event.description or ""},
            ))
        if adv_status == "USN_TRACKED":
            advisory_evidence.append(AdvisoryEvidence(
                id="usn", kind="usn",
                summary=f"Ubuntu USN tracking found ({len(usn_ids)}).",
                detail={"usn_ids": usn_ids},
            ))
        if fixed_version:
            advisory_evidence.append(AdvisoryEvidence(
                id="fixed_version", kind="fixed_version_known",
                summary=f"Upstream-fixed version is known: {fixed_version}.",
                detail={"fixed_version": fixed_version,
                        "current_version": comp.current_version},
            ))
        if reachability == "RUNTIME":
            advisory_evidence.append(AdvisoryEvidence(
                id="runtime", kind="runtime_component",
                summary=f"Component '{comp.name}' is part of the runtime surface.",
                detail={"upstream": _upstream(comp.name)},
            ))
        if reachability == "BUILD_ONLY":
            advisory_evidence.append(AdvisoryEvidence(
                id="build_only", kind="build_only",
                summary=f"Component '{comp.name}' is build-only.",
                detail={"upstream": _upstream(comp.name)},
            ))
        if reachability == "INSTALLED_ONLY":
            advisory_evidence.append(AdvisoryEvidence(
                id="installed_only", kind="installed_only",
                summary=f"Component '{comp.name}' is installed but not invoked by the runtime.",
                detail={"upstream": _upstream(comp.name)},
            ))
        if reachability == "HARDWARE_FIRMWARE":
            advisory_evidence.append(AdvisoryEvidence(
                id="hw_fw", kind="hardware_firmware",
                summary=f"Component '{comp.name}' is hardware/firmware-bound.",
                detail={},
            ))
        if (event.severity.exploited or 0):
            advisory_evidence.append(AdvisoryEvidence(
                id="exploited", kind="exploit_signal",
                summary="CVE is flagged as actively exploited.",
                detail={"epss": event.severity.epss},
            ))
        for link in event.external_links:
            advisory_evidence.append(AdvisoryEvidence(
                id=f"ref:{link}", kind="external_reference",
                summary=f"External reference: {link}",
                detail={"url": link},
            ))

        # Registry: pull prior decision (if any) as an evidence item.
        # We deliberately skip prior `needs_human` decisions so a single
        # cautious run does not pin a CVE there forever — re-evaluate fresh.
        prior = None
        try:
            prior = self.registry.lookup(
                event.cve_id, comp.name, comp.current_version or ""
            )
        except Exception as exc:  # noqa: BLE001
            notes.append(f"registry lookup failed: {exc}")
        if prior and prior.verdict != "needs_human":
            advisory_evidence.append(AdvisoryEvidence(
                id="registry_prior", kind="registry_prior_decision",
                summary=f"Prior verdict was '{prior.verdict}'.",
                detail={
                    "verdict": prior.verdict,
                    "triage_confidence": prior.triage_confidence,
                    "fix_confidence": prior.fix_confidence,
                    "evidence_confidence": prior.evidence_confidence,
                    "analysis_id": prior.analysis_id,
                    "expires": prior.expiry_timestamp.isoformat(),
                },
            ))

        # Code retrieval (index-first, file-fetch fallback).
        repo_root = (event.build_context.repo_root if event.build_context else None) or self.default_repo_root
        code_evidence: list[CodeEvidence] = []
        if repo_root or self.default_index_dir:
            try:
                result = self.retriever.retrieve(
                    index_dir=self.default_index_dir,
                    repo_root=repo_root,
                    component_name=comp.name,
                    cve_id=event.cve_id,
                    extra_keywords=self._keywords_for(event),
                )
            except Exception as exc:  # noqa: BLE001
                notes.append(f"retrieval failed: {exc}")
                result = {"hits": [], "source": "none"}
            for h in result["hits"]:
                code_evidence.append(CodeEvidence(
                    id=str(h.get("id")),
                    path=h["path"],
                    start_line=int(h["start_line"]),
                    end_line=int(h["end_line"]),
                    snippet=h["text"],
                    source="index" if result["source"] == "index" else "file_fetch",
                    score=float(h.get("score", 0.0)),
                    reason=h.get("matched_keyword"),
                ))
        else:
            notes.append("no repo_root or index configured; skipping code retrieval")

        # Ubuntu Security API — highest-priority validator for OS-package CVEs.
        ubuntu_dict = None
        if self.ubuntu_client is not None:
            enrichment: UbuntuEnrichment = self.ubuntu_client.enrich(
                event.cve_id,
                component_name=comp.name,
                release_codename=self.release_codename,
            )
            if enrichment.ok:
                ubuntu_dict = enrichment.to_dict()
                # Promote Ubuntu's fixed_version when the input lacked one.
                if enrichment.fixed_version and not fixed_version:
                    fixed_version = enrichment.fixed_version
                    advisory_evidence.append(AdvisoryEvidence(
                        id="ubuntu_fixed_version",
                        kind="fixed_version_known",
                        summary=(
                            f"Ubuntu Security API reports fixed version: "
                            f"{enrichment.fixed_version}."
                        ),
                        detail={
                            "fixed_version": enrichment.fixed_version,
                            "source": "ubuntu_security_api",
                            "raw_url": enrichment.raw_url,
                        },
                    ))
                advisory_evidence.append(AdvisoryEvidence(
                    id="ubuntu_security",
                    kind="ubuntu_security",
                    summary=(
                        f"Ubuntu Security: status={enrichment.status or 'unknown'}, "
                        f"priority={enrichment.priority or 'unknown'}, "
                        f"USNs={len(enrichment.usn_ids)}"
                    ),
                    detail=enrichment.to_dict(),
                ))
                # Merge USN ids that the Ubuntu API knows about (de-dup).
                if enrichment.usn_ids:
                    known = set(usn_ids)
                    for u in enrichment.usn_ids:
                        if u not in known:
                            usn_ids.append(u)
                            known.add(u)
                if enrichment.remediation:
                    advisory_evidence.append(AdvisoryEvidence(
                        id="ubuntu_remediation",
                        kind="ubuntu_remediation",
                        summary=enrichment.remediation,
                        detail={"source": "ubuntu_security_api"},
                    ))
                # If Ubuntu lists USN tracking that we missed, lift status.
                if adv_status == "ACTIVE" and enrichment.usn_ids:
                    adv_status = "USN_TRACKED"
            else:
                notes.append(f"ubuntu enrichment skipped: {enrichment.error}")

        bundle = EvidenceBundle(
            cve_event=event,
            advisory_status=adv_status,
            fixed_version=fixed_version,
            reachability=reachability,
            advisory_evidence=advisory_evidence,
            code_evidence=code_evidence,
            notes=notes,
            ubuntu_security=ubuntu_dict,
        )
        bundle.evidence_confidence = _evidence_confidence(bundle)

        log_event(
            logger,
            "evidence.built",
            cve_id=event.cve_id,
            component=comp.name,
            advisory_status=adv_status,
            reachability=reachability,
            advisory_count=len(advisory_evidence),
            code_count=len(code_evidence),
            evidence_confidence=bundle.evidence_confidence,
        )
        return bundle

    @staticmethod
    def _keywords_for(event: CVEEvent) -> Iterable[str]:
        keywords: list[str] = []
        # Tokens from the description that look like identifiers (function/file names).
        if event.description:
            for tok in re.findall(r"[A-Za-z_][A-Za-z0-9_]{3,}", event.description):
                tok_low = tok.lower()
                if tok_low not in {"vulnerability", "issue", "this", "that",
                                   "from", "into", "when", "with", "would",
                                   "could", "should"}:
                    keywords.append(tok)
            if len(keywords) > 8:
                keywords = keywords[:8]
        return keywords
