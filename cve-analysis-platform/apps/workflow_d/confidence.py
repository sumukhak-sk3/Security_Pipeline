"""Compute the three independent confidence scores.

Triage confidence comes from the triage agent (with verifier disagreement
penalty when applicable).
Fix confidence comes from the fix author (with the same verifier penalty).
Evidence confidence comes from the deterministic evidence builder heuristic.
"""
from __future__ import annotations

from dataclasses import dataclass

from .schemas import (
    ConfidenceScores,
    EvidenceBundle,
    FixProposal,
    TriageResult,
    Verdict,
    VerifierResult,
    VerifierVerdict,
)


@dataclass(frozen=True)
class ConfidencePolicy:
    auto_proceed_min: float = 0.75
    not_applicable_min_evidence: int = 2
    verifier_disagreement_penalty: float = 0.4


def compute_confidence(
    bundle: EvidenceBundle,
    triage: TriageResult,
    fix: FixProposal | None,
    verifier: VerifierResult | None,
    policy: ConfidencePolicy,
    *,
    deterministic_results: dict | None = None,
) -> ConfidenceScores:
    triage_c = triage.triage_confidence
    fix_c = fix.fix_confidence if fix else 0.0
    evidence_c = bundle.evidence_confidence

    # Verifier disagreement penalty applies only when we actually ran the
    # verifier (i.e. when there is a code change to verify).
    if verifier and triage.verdict == Verdict.code_change:
        if verifier.verdict in (VerifierVerdict.fail, VerifierVerdict.uncertain):
            penalty = policy.verifier_disagreement_penalty
            # If the patch passed `git apply --check`, the structural risk is
            # already retired — uncertainty from the LLM is most often a
            # context-window issue, not evidence of a broken patch. Halve the
            # penalty so a clean-applying patch with author-confidence >= 0.5
            # can still clear the auto-proceed gate.
            gac = (deterministic_results or {}).get("git_apply_check") or {}
            if gac.get("ok"):
                penalty = penalty * 0.5
            fix_c = max(0.0, fix_c - penalty)
            triage_c = max(0.0, triage_c - penalty / 2)

    return ConfidenceScores(
        triage_confidence=round(triage_c, 3),
        fix_confidence=round(fix_c, 3),
        evidence_confidence=round(evidence_c, 3),
    )


def all_above(
    scores: ConfidenceScores,
    threshold: float,
    *,
    require_fix: bool = True,
) -> bool:
    """Check the three confidence scores against `threshold`.

    `require_fix` should be True only for verdicts that produced a fix (i.e.
    `code_change`). For `package_upgrade` and `not_applicable` there is no
    authored patch, so fix_confidence is not meaningful and must not block
    auto-proceed.
    """
    if scores.triage_confidence < threshold:
        return False
    if scores.evidence_confidence < threshold:
        return False
    if require_fix and scores.fix_confidence < threshold:
        return False
    return True
