"""Routing decisions.

Combines verdict + confidence + verifier outcome + patch caps to produce a
single routing decision. Workflow D itself never writes code or upgrades
packages — it only emits the decision and the artifacts needed for the next
workflow (E) or human review.
"""
from __future__ import annotations

from dataclasses import dataclass

from .confidence import ConfidencePolicy, ConfidenceScores, all_above
from .schemas import (
    EvidenceBundle,
    FixProposal,
    RoutingDecision,
    RoutingResult,
    TriageResult,
    Verdict,
    VerifierResult,
    VerifierVerdict,
)
from .version_compare import already_at_or_above


@dataclass(frozen=True)
class RoutingPolicy:
    max_patch_lines: int = 500
    max_patch_files: int = 5


def decide(
    bundle: EvidenceBundle,
    triage: TriageResult,
    fix: FixProposal | None,
    verifier: VerifierResult | None,
    confidence: ConfidenceScores,
    policy: RoutingPolicy,
    confidence_policy: ConfidencePolicy,
    *,
    deterministic_results: dict | None = None,
) -> RoutingResult:
    verdict = triage.verdict
    det = deterministic_results or {}
    gac = det.get("git_apply_check") or {}

    # Suppression based on prior decisions could be added here.
    # Fix author may explicitly override to `needs_human`. We honor that for
    # routing (don't auto-proceed) but we keep `final_verdict` as the triage
    # classification when triage was code_change — otherwise a model that
    # refuses to author a confident patch silently erases the analyst-visible
    # signal that this CVE *is* code-patchable. The CVE will still land in
    # the human_review queue because we flip the decision below.
    fix_override_to_needs_human = False
    if fix and fix.verdict_override:
        if (
            fix.verdict_override == Verdict.needs_human
            and triage.verdict == Verdict.code_change
        ):
            fix_override_to_needs_human = True
            # leave `verdict` as code_change so the CVE shows in the
            # code_change bucket; routing decision below will be human_review.
        else:
            verdict = fix.verdict_override

    if fix_override_to_needs_human:
        return RoutingResult(
            decision=RoutingDecision.human_review,
            final_verdict=Verdict.code_change,
            reason=(
                "triage classified as code_change; fix author declined to "
                "author a patch automatically — needs human authoring/review"
            ),
            auto_proceed=False,
        )

    # Patch caps — applied regardless of confidence. The verdict stays
    # `code_change` (that IS the analyzer's classification); only the routing
    # decision flips to human_review.
    if verdict == Verdict.code_change and fix:
        total_lines = fix.lines_added + fix.lines_removed
        if total_lines > policy.max_patch_lines or len(fix.files_touched) > policy.max_patch_files:
            return RoutingResult(
                decision=RoutingDecision.human_review,
                final_verdict=verdict,
                reason=(
                    f"patch exceeds caps "
                    f"(lines={total_lines}>{policy.max_patch_lines} "
                    f"or files={len(fix.files_touched)}>{policy.max_patch_files})"
                ),
                auto_proceed=False,
            )

    # Hard fail: a patch that `git apply --check` rejects should never
    # auto-proceed regardless of what the verifier said. Keep verdict as
    # code_change so the CVE remains visible in the right bucket; route to
    # human review with the git stderr in the reason so a human can quickly
    # see why.
    if (
        verdict == Verdict.code_change
        and fix
        and fix.patch_unified_diff
        and gac.get("ran")
        and not gac.get("ok")
    ):
        err = (gac.get("stderr") or "").splitlines()[0] if gac.get("stderr") else "unknown"
        return RoutingResult(
            decision=RoutingDecision.human_review,
            final_verdict=verdict,
            reason=f"authored patch failed `git apply --check`: {err}",
            auto_proceed=False,
        )

    # Verifier disagreement blocks auto-proceed on code changes.
    if verdict == Verdict.code_change and verifier and verifier.verdict != VerifierVerdict.pass_:
        # If the patch applies cleanly and the verifier merely returned
        # "uncertain" (not "fail"), surface that distinction in the reason
        # so the human reviewer knows this is a context-gap rather than a
        # rejected patch.
        if (
            verifier.verdict == VerifierVerdict.uncertain
            and gac.get("ok")
        ):
            return RoutingResult(
                decision=RoutingDecision.human_review,
                final_verdict=verdict,
                reason=(
                    "patch applies cleanly (git apply --check OK) but verifier "
                    "could not confirm semantic correctness from the available "
                    "snippets \u2014 quick human sanity-check required"
                ),
                auto_proceed=False,
            )
        return RoutingResult(
            decision=RoutingDecision.human_review,
            final_verdict=verdict,
            reason=f"verifier returned '{verifier.verdict.value}'",
            auto_proceed=False,
        )

    # Confidence gate — fix_confidence only matters for code_change.
    confident = all_above(
        confidence,
        confidence_policy.auto_proceed_min,
        require_fix=(verdict == Verdict.code_change),
    )

    if verdict == Verdict.not_applicable:
        if confident:
            return RoutingResult(
                decision=RoutingDecision.suppress,
                final_verdict=verdict,
                reason="not_applicable with high confidence; suppressing",
                auto_proceed=True,
            )
        return RoutingResult(
            decision=RoutingDecision.human_review,
            final_verdict=verdict,
            reason="not_applicable but confidence below threshold",
            auto_proceed=False,
        )

    if verdict == Verdict.package_upgrade:
        # Ubuntu Security API is the authoritative source for OS-package fixes.
        # When it confirms a fixed version, the upgrade target does not depend
        # on the model's self-confidence — defer to the authority.
        ubuntu = bundle.ubuntu_security or {}
        ubuntu_authoritative = bool(
            ubuntu.get("ok") and ubuntu.get("fixed_version")
        )

        # Version sanity: if installed version already >= Ubuntu fixed,
        # the upgrade is a no-op — flip to not_applicable + suppress.
        current_version = (
            bundle.cve_event.component.current_version
            if bundle.cve_event and bundle.cve_event.component
            else None
        )
        if ubuntu_authoritative:
            at_or_above = already_at_or_above(current_version, ubuntu.get("fixed_version"))
            if at_or_above is True:
                return RoutingResult(
                    decision=RoutingDecision.suppress,
                    final_verdict=Verdict.not_applicable,
                    reason=(
                        f"installed {current_version} >= Ubuntu fixed "
                        f"{ubuntu.get('fixed_version')}; already patched"
                    ),
                    auto_proceed=True,
                )

        if confident or ubuntu_authoritative:
            return RoutingResult(
                decision=RoutingDecision.handoff_workflow_e,
                final_verdict=verdict,
                reason=(
                    "package_upgrade confirmed by Ubuntu Security authority"
                    if ubuntu_authoritative and not confident
                    else "package_upgrade ready for Workflow E"
                ),
                auto_proceed=True,
            )
        return RoutingResult(
            decision=RoutingDecision.human_review,
            final_verdict=verdict,
            reason="package_upgrade but confidence below threshold",
            auto_proceed=False,
        )

    if verdict == Verdict.code_change:
        if confident and verifier and verifier.verdict == VerifierVerdict.pass_:
            return RoutingResult(
                decision=RoutingDecision.handoff_workflow_e,
                final_verdict=verdict,
                reason="code_change verified and confident",
                auto_proceed=True,
            )
        # Detailed reason so analysts know exactly why this was held back.
        missing: list[str] = []
        if confidence.triage_confidence < confidence_policy.auto_proceed_min:
            missing.append(f"triage_confidence={confidence.triage_confidence:.2f}")
        if confidence.fix_confidence < confidence_policy.auto_proceed_min:
            missing.append(f"fix_confidence={confidence.fix_confidence:.2f}")
        if confidence.evidence_confidence < confidence_policy.auto_proceed_min:
            missing.append(f"evidence_confidence={confidence.evidence_confidence:.2f}")
        if missing:
            reason = (
                "code_change not eligible for auto-proceed: "
                + ", ".join(missing)
                + f" below {confidence_policy.auto_proceed_min:.2f} threshold"
            )
        else:
            reason = "code_change not eligible for auto-proceed"
        return RoutingResult(
            decision=RoutingDecision.human_review,
            final_verdict=verdict,
            reason=reason,
            auto_proceed=False,
        )

    # needs_human and anything else
    return RoutingResult(
        decision=RoutingDecision.human_review,
        final_verdict=Verdict.needs_human,
        reason=triage.rationale or "explicit needs_human",
        auto_proceed=False,
    )
