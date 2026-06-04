from apps.workflow_d.confidence import ConfidencePolicy, compute_confidence
from apps.workflow_d.routing import RoutingPolicy, decide
from apps.workflow_d.schemas import (
    CVEEvent, Component, Severity, EvidenceBundle, FixProposal,
    TriageResult, Verdict, VerifierResult, VerifierVerdict, RoutingDecision,
)


def _bundle(adv_count=2, code_count=0, evidence_conf=0.9):
    bundle = EvidenceBundle(
        cve_event=CVEEvent(
            cve_id="CVE-2024-9",
            severity=Severity(label="HIGH"),
            component=Component(name="openssl", current_version="3.0.11"),
        ),
        advisory_evidence=[],
        code_evidence=[],
    )
    from apps.workflow_d.schemas import AdvisoryEvidence
    bundle.advisory_evidence = [
        AdvisoryEvidence(id=f"a{i}", kind="usn", summary="") for i in range(adv_count)
    ]
    bundle.evidence_confidence = evidence_conf
    return bundle


def test_package_upgrade_handoff_when_confident():
    bundle = _bundle()
    triage = TriageResult(verdict=Verdict.package_upgrade, rationale="r",
                          evidence_ids=[], triage_confidence=0.9)
    scores = compute_confidence(bundle, triage, None, None, ConfidencePolicy())
    r = decide(bundle, triage, None, None, scores, RoutingPolicy(), ConfidencePolicy())
    assert r.decision == RoutingDecision.handoff_workflow_e
    assert r.final_verdict == Verdict.package_upgrade
    assert r.auto_proceed is True


def test_low_confidence_forces_human_review():
    bundle = _bundle(evidence_conf=0.3)
    triage = TriageResult(verdict=Verdict.package_upgrade, rationale="r",
                          evidence_ids=[], triage_confidence=0.4)
    scores = compute_confidence(bundle, triage, None, None, ConfidencePolicy())
    r = decide(bundle, triage, None, None, scores, RoutingPolicy(), ConfidencePolicy())
    assert r.decision == RoutingDecision.human_review
    assert r.final_verdict == Verdict.package_upgrade
    assert r.auto_proceed is False


def test_patch_cap_escalates():
    bundle = _bundle()
    triage = TriageResult(verdict=Verdict.code_change, rationale="r",
                          evidence_ids=[], triage_confidence=0.9)
    fix = FixProposal(patch_unified_diff="x", files_touched=["a", "b", "c", "d", "e", "f"],
                      lines_added=10, lines_removed=10, fix_confidence=0.9)
    verifier = VerifierResult(verdict=VerifierVerdict.pass_, rationale="ok",
                              verifier_confidence=0.9)
    scores = compute_confidence(bundle, triage, fix, verifier, ConfidencePolicy())
    r = decide(bundle, triage, fix, verifier, scores, RoutingPolicy(), ConfidencePolicy())
    assert r.decision == RoutingDecision.human_review
    assert r.final_verdict == Verdict.code_change
    assert "exceeds caps" in r.reason


def test_verifier_disagreement_blocks_auto():
    bundle = _bundle()
    triage = TriageResult(verdict=Verdict.code_change, rationale="r",
                          evidence_ids=[], triage_confidence=0.9)
    fix = FixProposal(patch_unified_diff="x", files_touched=["a"],
                      lines_added=1, lines_removed=1, fix_confidence=0.9)
    verifier = VerifierResult(verdict=VerifierVerdict.fail, rationale="bad",
                              verifier_confidence=0.8)
    scores = compute_confidence(bundle, triage, fix, verifier, ConfidencePolicy())
    r = decide(bundle, triage, fix, verifier, scores, RoutingPolicy(), ConfidencePolicy())
    assert r.decision == RoutingDecision.human_review
    assert r.final_verdict == Verdict.code_change
    assert "verifier" in r.reason


def test_not_applicable_suppressed_when_confident():
    bundle = _bundle(adv_count=3, evidence_conf=0.9)
    triage = TriageResult(verdict=Verdict.not_applicable, rationale="not in runtime",
                          evidence_ids=["a0","a1"], triage_confidence=0.9)
    scores = compute_confidence(bundle, triage, None, None, ConfidencePolicy())
    r = decide(bundle, triage, None, None, scores, RoutingPolicy(), ConfidencePolicy())
    assert r.decision == RoutingDecision.suppress
    assert r.auto_proceed is True
