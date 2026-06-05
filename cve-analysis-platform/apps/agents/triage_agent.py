"""Triage agent.

Produces exactly one verdict, with strict policy enforcement applied in Python
AFTER the model returns (so prompts cannot bypass the rules):

- "not_applicable" requires >= 2 independent evidence items, otherwise force
  "needs_human".
- Unknown verdicts collapse to "needs_human".
"""
from __future__ import annotations

import json
from pathlib import Path

from ..common.logging_utils import get_logger, log_event
from ..common.model_client import ModelClient
from ..workflow_d.schemas import (
    ContextSummary,
    EvidenceBundle,
    TriageResult,
    Verdict,
)

logger = get_logger(__name__)


def _load_prompt(prompts_dir: str | Path) -> tuple[str, str]:
    text = (Path(prompts_dir) / "triage_agent.txt").read_text(encoding="utf-8")
    version = "triage_agent/v1"
    for line in text.splitlines()[:5]:
        if line.startswith("PROMPT_VERSION:"):
            version = line.split(":", 1)[1].strip()
            break
    return text, version


def _summarize_for_prompt(bundle: EvidenceBundle, ctx: ContextSummary | None) -> str:
    return json.dumps(
        {
            "context": ctx.model_dump() if ctx else None,
            "cve_event": bundle.cve_event.model_dump(mode="json"),
            "advisory_status": bundle.advisory_status,
            "fixed_version": bundle.fixed_version,
            "reachability": bundle.reachability,
            "advisory_evidence": [a.model_dump() for a in bundle.advisory_evidence],
            "code_evidence_ids": [c.id for c in bundle.code_evidence],
            "code_evidence_paths": [c.path for c in bundle.code_evidence],
        },
        default=str,
    )


def run_triage_agent(
    client: ModelClient,
    bundle: EvidenceBundle,
    ctx: ContextSummary | None,
    prompts_dir: str | Path,
    not_applicable_min_evidence: int = 2,
) -> TriageResult:
    system, version = _load_prompt(prompts_dir)
    user = _summarize_for_prompt(bundle, ctx)
    result = client.call_json(
        role=ModelClient.AUTHOR,
        system=system,
        user=user,
        prompt_version=version,
    )
    raw_verdict = str(result.parsed.get("verdict", "")).strip()
    try:
        verdict = Verdict(raw_verdict)
    except ValueError:
        log_event(
            logger,
            "triage.unknown_verdict",
            raw=raw_verdict,
            cve_id=bundle.cve_event.cve_id,
        )
        verdict = Verdict.needs_human

    rationale = str(result.parsed.get("rationale", "")) or "no rationale provided"
    evidence_ids = [str(x) for x in (result.parsed.get("evidence_ids") or [])]
    confidence = float(result.parsed.get("triage_confidence", 0.0) or 0.0)
    confidence = max(0.0, min(1.0, confidence))

    # Enforce: not_applicable requires N independent evidence items.
    if verdict == Verdict.not_applicable:
        if bundle.independent_evidence_count() < not_applicable_min_evidence:
            log_event(
                logger,
                "triage.forced_needs_human",
                reason="insufficient_independent_evidence",
                cve_id=bundle.cve_event.cve_id,
                evidence_count=bundle.independent_evidence_count(),
            )
            rationale = (
                f"not_applicable requires >= {not_applicable_min_evidence} "
                f"independent evidence items; only "
                f"{bundle.independent_evidence_count()} present. "
                f"Original model rationale: {rationale}"
            )
            verdict = Verdict.needs_human

    log_event(
        logger,
        "triage.done",
        cve_id=bundle.cve_event.cve_id,
        verdict=verdict.value,
        triage_confidence=confidence,
    )
    return TriageResult(
        verdict=verdict,
        rationale=rationale,
        evidence_ids=evidence_ids,
        triage_confidence=confidence,
    )
