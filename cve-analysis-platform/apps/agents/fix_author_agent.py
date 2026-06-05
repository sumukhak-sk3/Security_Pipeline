"""Fix author agent.

Produces a MINIMAL unified diff for `code_change` verdicts. Returns deterministic
patch statistics computed in Python rather than trusting the model's claim.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from ..common.logging_utils import get_logger, log_event
from ..common.model_client import ModelClient
from ..workflow_d.schemas import EvidenceBundle, FixProposal, Verdict

logger = get_logger(__name__)


def _load_prompt(prompts_dir: str | Path) -> tuple[str, str]:
    text = (Path(prompts_dir) / "fix_author_agent.txt").read_text(encoding="utf-8")
    version = "fix_author_agent/v1"
    for line in text.splitlines()[:5]:
        if line.startswith("PROMPT_VERSION:"):
            version = line.split(":", 1)[1].strip()
            break
    return text, version


_DIFF_FILE_RE = re.compile(r"^\+\+\+\s+(?:b/)?(.+?)\s*$", re.MULTILINE)
_APPLY_PATCH_FILE_RE = re.compile(
    r"^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+?)\s*$", re.MULTILINE
)


def _diff_stats(diff: str) -> tuple[list[str], int, int]:
    if not diff:
        return [], 0, 0
    files = sorted(set(m.group(1) for m in _DIFF_FILE_RE.finditer(diff)))
    if not files:
        # Backstop: some models emit the OpenAI apply_patch dialect
        # (`*** Update File: path`) instead of standard unified diff headers.
        files = sorted(set(m.group(1) for m in _APPLY_PATCH_FILE_RE.finditer(diff)))
    added = 0
    removed = 0
    for line in diff.splitlines():
        if line.startswith("+++") or line.startswith("---"):
            continue
        if line.startswith("+"):
            added += 1
        elif line.startswith("-"):
            removed += 1
    return files, added, removed


def _bundle_to_user(bundle: EvidenceBundle) -> str:
    return json.dumps(
        {
            "cve_event": bundle.cve_event.model_dump(mode="json"),
            "advisory_status": bundle.advisory_status,
            "fixed_version": bundle.fixed_version,
            "reachability": bundle.reachability,
            "code_evidence": [
                {
                    "id": c.id,
                    "path": c.path,
                    "start_line": c.start_line,
                    "end_line": c.end_line,
                    "snippet": c.snippet,
                }
                for c in bundle.code_evidence
            ],
            "advisory_evidence": [a.model_dump() for a in bundle.advisory_evidence],
        },
        default=str,
    )


def run_fix_author(
    client: ModelClient, bundle: EvidenceBundle, prompts_dir: str | Path
) -> FixProposal:
    system, version = _load_prompt(prompts_dir)
    user = _bundle_to_user(bundle)
    result = client.call_json(
        role=ModelClient.AUTHOR,
        system=system,
        user=user,
        prompt_version=version,
        temperature=0.0,
    )
    diff = str(result.parsed.get("patch_unified_diff", "") or "")
    files, added, removed = _diff_stats(diff)

    verdict_override_raw = result.parsed.get("verdict_override")
    verdict_override: Verdict | None = None
    if verdict_override_raw:
        try:
            verdict_override = Verdict(str(verdict_override_raw).strip())
        except ValueError:
            verdict_override = Verdict.needs_human

    confidence = float(result.parsed.get("fix_confidence", 0.0) or 0.0)
    confidence = max(0.0, min(1.0, confidence))

    fp = FixProposal(
        patch_unified_diff=diff,
        files_touched=files,
        lines_added=added,
        lines_removed=removed,
        rationale=str(result.parsed.get("rationale", "")),
        verdict_override=verdict_override,
        fix_confidence=confidence,
    )
    log_event(
        logger,
        "fix.done",
        cve_id=bundle.cve_event.cve_id,
        files_touched=len(files),
        lines_added=added,
        lines_removed=removed,
        verdict_override=verdict_override.value if verdict_override else None,
        fix_confidence=confidence,
    )
    return fp
