"""Contract tests for the externally-visible request/response schemas.

These tests pin the wire format Workflow B (and other producers) must satisfy.
If any of these break, the upstream contract changed and downstream consumers
must be notified.
"""
from datetime import datetime, timezone

from apps.workflow_d.schemas import (
    AnalyzeRequest, AnalyzeResponse, CVEAnalysis, Component, ConfidenceScores,
    CVEEvent, Mode, RoutingDecision, RoutingResult, Severity, TriageResult,
    Verdict,
)


def test_minimal_request_payload_is_valid():
    raw = {
        "mode": "standard",
        "cves": [{
            "cve_id": "CVE-2024-1",
            "severity": {"label": "HIGH"},
            "component": {"name": "openssl", "current_version": "3.0.11"},
            "source": "dependency_track",
            "branches_affected": [],
            "external_links": [],
        }]
    }
    req = AnalyzeRequest.model_validate(raw)
    assert req.mode == Mode.standard
    assert req.cves[0].component.name == "openssl"


def test_response_is_serializable():
    resp = AnalyzeResponse(
        analysis_id="an-1",
        mode=Mode.standard,
        started_at=datetime.now(timezone.utc),
        completed_at=datetime.now(timezone.utc),
        total=1,
        results=[CVEAnalysis(
            cve_id="CVE-2024-1",
            component=Component(name="openssl", current_version="3.0.11"),
            triage=TriageResult(verdict=Verdict.package_upgrade, rationale="x",
                                evidence_ids=[], triage_confidence=0.9),
            fix=None,
            verifier=None,
            confidence=ConfidenceScores(triage_confidence=0.9, fix_confidence=0.0,
                                        evidence_confidence=0.9),
            routing=RoutingResult(decision=RoutingDecision.handoff_workflow_e,
                                  final_verdict=Verdict.package_upgrade,
                                  reason="ok", auto_proceed=True),
            evidence_summary={}, artifacts_dir=".",
        )]
    )
    payload = resp.model_dump(mode="json")
    assert payload["results"][0]["routing"]["decision"] == "handoff_workflow_e"
