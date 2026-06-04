"""Typed request/response schemas for Workflow D."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class Mode(str, Enum):
    standard = "standard"
    urgent = "urgent"
    ad_hoc = "ad_hoc"


class Verdict(str, Enum):
    not_applicable = "not_applicable"
    package_upgrade = "package_upgrade"
    code_change = "code_change"
    needs_human = "needs_human"


class VerifierVerdict(str, Enum):
    pass_ = "pass"
    fail = "fail"
    uncertain = "uncertain"


class RoutingDecision(str, Enum):
    auto_proceed = "auto_proceed"
    handoff_workflow_e = "handoff_workflow_e"
    human_review = "human_review"
    suppress = "suppress"


# ---------------------------------------------------------------------------
# CVE event input — matches the normalized batch contract from Workflow B.
# ---------------------------------------------------------------------------


class Severity(BaseModel):
    label: str = Field(..., description="CRITICAL|HIGH|MEDIUM|LOW|UNASSIGNED")
    cvss: Optional[float] = None
    epss: Optional[float] = None
    exploited: Optional[bool] = None


class Component(BaseModel):
    name: str
    current_version: Optional[str] = None
    ecosystem: Optional[str] = None
    purl: Optional[str] = None
    fixed_version: Optional[str] = None


class BuildContext(BaseModel):
    project_name: Optional[str] = None
    project_version: Optional[str] = None
    project_uuid: Optional[str] = None
    repo_root: Optional[str] = Field(
        default=None,
        description="Optional absolute path to the repo for code retrieval.",
    )


class CVEEvent(BaseModel):
    model_config = ConfigDict(extra="allow")

    cve_id: str
    severity: Severity
    component: Component
    source: str = "dependency_track"
    branches_affected: list[str] = Field(default_factory=list)
    filed_at: Optional[datetime] = None
    external_links: list[str] = Field(default_factory=list)
    description: Optional[str] = None
    references: Optional[str] = None
    build_context: Optional[BuildContext] = None


class AnalyzeRequest(BaseModel):
    mode: Mode = Mode.standard
    cves: list[CVEEvent] = Field(..., min_length=1)


# ---------------------------------------------------------------------------
# Evidence bundle
# ---------------------------------------------------------------------------


class CodeEvidence(BaseModel):
    id: str
    path: str
    start_line: int
    end_line: int
    snippet: str
    source: Literal["index", "file_fetch"] = "index"
    score: float = 0.0
    reason: Optional[str] = None


class AdvisoryEvidence(BaseModel):
    id: str
    kind: Literal[
        "advisory_status",
        "usn",
        "fixed_version_known",
        "rejected_cve",
        "exploit_signal",
        "registry_prior_decision",
        "build_only",
        "installed_only",
        "hardware_firmware",
        "runtime_component",
        "external_reference",
        "ubuntu_security",
        "ubuntu_remediation",
    ]
    summary: str
    detail: dict[str, Any] = Field(default_factory=dict)


class EvidenceBundle(BaseModel):
    cve_event: CVEEvent
    advisory_status: str = "ACTIVE"
    fixed_version: Optional[str] = None
    reachability: str = "NEEDS_ASSESSMENT"
    advisory_evidence: list[AdvisoryEvidence] = Field(default_factory=list)
    code_evidence: list[CodeEvidence] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    evidence_confidence: float = 0.0
    ubuntu_security: Optional[dict[str, Any]] = None

    def independent_evidence_count(self) -> int:
        """Counts distinct, independent evidence items used for the not_applicable rule."""
        # Independence is approximated by distinct ids across both buckets.
        seen: set[str] = set()
        for e in self.advisory_evidence:
            seen.add(f"adv:{e.id}")
        for c in self.code_evidence:
            seen.add(f"code:{c.id}")
        return len(seen)


# ---------------------------------------------------------------------------
# Stage outputs
# ---------------------------------------------------------------------------


class ContextSummary(BaseModel):
    summary: str = ""
    code_references: list[dict[str, Any]] = Field(default_factory=list)
    unknowns: list[str] = Field(default_factory=list)
    context_confidence: float = 0.0


class TriageResult(BaseModel):
    verdict: Verdict
    rationale: str
    evidence_ids: list[str] = Field(default_factory=list)
    triage_confidence: float = 0.0


class FixProposal(BaseModel):
    patch_unified_diff: str = ""
    files_touched: list[str] = Field(default_factory=list)
    lines_added: int = 0
    lines_removed: int = 0
    rationale: str = ""
    verdict_override: Optional[Verdict] = None
    fix_confidence: float = 0.0


class VerifierResult(BaseModel):
    verdict: VerifierVerdict
    rationale: str
    unresolved_concerns: list[str] = Field(default_factory=list)
    verifier_confidence: float = 0.0


class ConfidenceScores(BaseModel):
    triage_confidence: float = 0.0
    fix_confidence: float = 0.0
    evidence_confidence: float = 0.0


class RoutingResult(BaseModel):
    decision: RoutingDecision
    final_verdict: Verdict
    reason: str
    auto_proceed: bool = False


class CVEAnalysis(BaseModel):
    cve_id: str
    component: Component
    triage: TriageResult
    fix: Optional[FixProposal] = None
    verifier: Optional[VerifierResult] = None
    confidence: ConfidenceScores
    routing: RoutingResult
    evidence_summary: dict[str, Any] = Field(default_factory=dict)
    artifacts_dir: str
    rationale: str = ""
    # Explainability block: structured, human-readable explanation of why
    # this verdict was reached. Populated by the orchestrator.
    explanation: dict[str, Any] = Field(default_factory=dict)


class AnalyzeResponse(BaseModel):
    analysis_id: str
    mode: Mode
    started_at: datetime
    completed_at: datetime
    total: int
    results: list[CVEAnalysis]


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    author_model: str
    verifier_model: str
    index_present: bool
