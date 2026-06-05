"""Verifier agent.

Receives a sealed verification packet (NOT the whole repo) and returns a
semantic verdict. The verifier MUST run on a different model family than the
author; that constraint is enforced at the model client layer.
"""
from __future__ import annotations

import json
from pathlib import Path

from ..common.logging_utils import get_logger, log_event
from ..common.model_client import ModelClient
from ..workflow_d.schemas import (
    EvidenceBundle,
    FixProposal,
    VerifierResult,
    VerifierVerdict,
)

logger = get_logger(__name__)


def _load_prompt(prompts_dir: str | Path) -> tuple[str, str]:
    text = (Path(prompts_dir) / "verifier_agent.txt").read_text(encoding="utf-8")
    version = "verifier_agent/v1"
    for line in text.splitlines()[:5]:
        if line.startswith("PROMPT_VERSION:"):
            version = line.split(":", 1)[1].strip()
            break
    return text, version


def build_verification_packet(
    bundle: EvidenceBundle,
    fix: FixProposal,
    *,
    config_snippets: list[dict] | None = None,
    deterministic_results: dict | None = None,
    patched_code_snippets: list[dict] | None = None,
) -> dict:
    """The sealed packet handed to the verifier — no repo access permitted."""
    return {
        "cve_event": bundle.cve_event.model_dump(mode="json"),
        "vulnerability_summary": {
            "advisory_status": bundle.advisory_status,
            "fixed_version": bundle.fixed_version,
            "reachability": bundle.reachability,
            "advisory_evidence": [a.model_dump() for a in bundle.advisory_evidence],
        },
        "original_code_snippets": [
            {
                "id": c.id,
                "path": c.path,
                "start_line": c.start_line,
                "end_line": c.end_line,
                "snippet": c.snippet,
            }
            for c in bundle.code_evidence
        ],
        "patched_code_snippets": patched_code_snippets or [],
        "config_snippets": config_snippets or [],
        "authored_patch": fix.patch_unified_diff,
        "author_rationale": fix.rationale,
        "patch_stats": {
            "files_touched": fix.files_touched,
            "files_touched_count": len(fix.files_touched),
            "lines_added": fix.lines_added,
            "lines_removed": fix.lines_removed,
        },
        "deterministic_results": deterministic_results or {},
    }


def run_verifier(
    client: ModelClient,
    bundle: EvidenceBundle,
    fix: FixProposal,
    prompts_dir: str | Path,
    *,
    config_snippets: list[dict] | None = None,
    deterministic_results: dict | None = None,
    patched_code_snippets: list[dict] | None = None,
) -> VerifierResult:
    system, version = _load_prompt(prompts_dir)
    packet = build_verification_packet(
        bundle,
        fix,
        config_snippets=config_snippets,
        deterministic_results=deterministic_results,
        patched_code_snippets=patched_code_snippets,
    )
    result = client.call_json(
        role=ModelClient.VERIFIER,
        system=system,
        user=json.dumps(packet, default=str),
        prompt_version=version,
        temperature=0.0,
    )
    raw = str(result.parsed.get("verdict", "")).strip()
    try:
        verdict = VerifierVerdict(raw)
    except ValueError:
        verdict = VerifierVerdict.uncertain
    confidence = float(result.parsed.get("verifier_confidence", 0.0) or 0.0)
    confidence = max(0.0, min(1.0, confidence))
    log_event(
        logger,
        "verifier.done",
        cve_id=bundle.cve_event.cve_id,
        verifier_verdict=verdict.value,
        verifier_confidence=confidence,
    )
    return VerifierResult(
        verdict=verdict,
        rationale=str(result.parsed.get("rationale", "")),
        unresolved_concerns=[str(x) for x in (result.parsed.get("unresolved_concerns") or [])],
        verifier_confidence=confidence,
    )
