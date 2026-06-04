"""Context agent: produce a structured context summary from the evidence bundle."""
from __future__ import annotations

import json
from pathlib import Path

from ..common.logging_utils import get_logger, log_event
from ..common.model_client import ModelClient
from ..workflow_d.schemas import ContextSummary, EvidenceBundle

logger = get_logger(__name__)


def _load_prompt(prompts_dir: str | Path) -> tuple[str, str]:
    path = Path(prompts_dir) / "context_agent.txt"
    text = path.read_text(encoding="utf-8")
    version = "context_agent/v1"
    for line in text.splitlines()[:5]:
        if line.startswith("PROMPT_VERSION:"):
            version = line.split(":", 1)[1].strip()
            break
    return text, version


def _bundle_to_user_message(bundle: EvidenceBundle) -> str:
    payload = {
        "cve_event": bundle.cve_event.model_dump(mode="json"),
        "advisory_status": bundle.advisory_status,
        "fixed_version": bundle.fixed_version,
        "reachability": bundle.reachability,
        "advisory_evidence": [a.model_dump() for a in bundle.advisory_evidence],
        "code_evidence": [
            {
                "id": c.id,
                "path": c.path,
                "lines": f"{c.start_line}-{c.end_line}",
                "snippet": c.snippet[:1200],
                "source": c.source,
                "score": c.score,
            }
            for c in bundle.code_evidence
        ],
    }
    return json.dumps(payload, default=str)


def run_context_agent(
    client: ModelClient, bundle: EvidenceBundle, prompts_dir: str | Path
) -> ContextSummary:
    system, version = _load_prompt(prompts_dir)
    user = _bundle_to_user_message(bundle)
    result = client.call_json(
        role=ModelClient.CONTEXT, system=system, user=user, prompt_version=version
    )
    log_event(logger, "context.done", cve_id=bundle.cve_event.cve_id)
    return ContextSummary(
        summary=str(result.parsed.get("summary", "")),
        code_references=list(result.parsed.get("code_references") or []),
        unknowns=list(result.parsed.get("unknowns") or []),
        context_confidence=float(result.parsed.get("context_confidence", 0.0) or 0.0),
    )
