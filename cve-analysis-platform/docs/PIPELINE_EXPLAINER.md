# CVE Analysis Platform — Pipeline Explainer

A walkthrough for the team covering: how a run starts, what each agent
does, how verdicts are decided, how routing works, what gets written to
disk, and how human-in-the-loop (HITL) overrides plug back in.

All file paths below are workspace-relative inside `cve-analysis-platform/`.

---

## 1. What the user submits when starting a run

**Endpoint:** `POST /runs/start` — handled in [apps/workflow_d/api.py](apps/workflow_d/api.py)

**Request body (JSON):**

| Field | Required | Description |
|---|---|---|
| `vulns_path` | yes | Absolute path to SBOM/findings file (`.json`, `.csv`, `.xlsx`) |
| `repo_root` | no | Absolute path to source tree to index/grep for code evidence |
| `index_id` | no | Use a pre-built index (`<project>__<branch>__<hash>`) instead of the repo |
| `severities` | no | Filter, e.g. `["CRITICAL","HIGH"]` |
| `limit` | no | Cap number of CVEs processed |
| `mode` | no | `standard` (default), `urgent`, `ad_hoc` |
| `workers` | no | Parallel CVEs per run |
| `author_model` / `verifier_model` | no | Override the LLMs used for the fix author / verifier agents |

**Accepted input formats** (loader: `load_findings()` in [scripts/analyze_dt_findings.py](scripts/analyze_dt_findings.py)):

- **DependencyTrack native JSON** — `{"findings":[...], "project":{...}}`
- **CSV / XLSX** with columns:
  `CVE_ID, Severity, CVSS_v3_Score, CVSS_v2_Score, EPSS_Score, EPSS_Percentile, Component_Name, Component_Version, Component_Group, CWE_IDs, Published, Source, Description`

The loader normalizes each row into a **`CVEEvent`** (CVE id + severity + component identity + build context) which is what the rest of the pipeline consumes. Custom JSON shapes are NOT auto-recognised — they get silently dropped, so always use one of the three formats above.

---

## 2. What happens when a run starts (lifecycle)

`POST /runs/start` spawns a daemon thread that:

1. Loads findings → filters by severity / dedupes → caps to `limit`.
2. Builds a list of `CVEEvent`s.
3. Calls `orch.analyze(AnalyzeRequest(mode=..., cves=[events]))` on the orchestrator ([apps/workflow_d/orchestrator.py](apps/workflow_d/orchestrator.py)).
4. The orchestrator fans out CVEs across a `ThreadPoolExecutor` (size = `workers`) and runs `_process_one()` for each CVE.

### Per-CVE flow inside `_process_one`

```
CVEEvent
   │
   ▼
[1] Evidence builder      (advisory enrichment + Ubuntu Security API +
                           coderag retrieve for code snippets)
   │                      → writes evidence_bundle.json
   ▼
[2] Triage agent          → TriageResult (verdict, rationale, evidence_ids,
                            triage_confidence)
   │
   ▼  (only if triage.verdict == code_change)
[3] Fix author agent      → FixProposal (unified diff, files_touched,
                            verdict_override, fix_confidence)
   │                      → writes fix_proposal.json
   ▼  (only if patch produced and no verdict_override)
[4] Verifier agent        → VerifierResult (pass / fail / uncertain)
   │                      → writes verifier_result.json
   ▼
[5] Confidence scoring    (rolls up evidence / triage / fix / verifier
                           confidences)
   │
   ▼
[6] Routing decision      → RoutingResult (final_verdict + decision +
                            reason + auto_proceed)
                          → writes routing_decision.json
   │
   ▼
[7] Registry upsert       (cve_id, component, version → verdict)
```

Events are emitted on a bus throughout, which the UI consumes over WebSocket (`WS /runs/{run_id}/stream`) for the live progress view.

---

## 3. Verdicts — the 4-value enum

Defined in [apps/workflow_d/schemas.py](apps/workflow_d/schemas.py):

| Verdict | Meaning |
|---|---|
| `not_applicable` | The CVE does not affect this codebase (e.g. vulnerable code path is not reachable, or the component is already on the fixed version). |
| `package_upgrade` | Fix is available by upgrading the OS/dependency package. No source change in this repo. |
| `code_change` | The vulnerable code is vendored/in-tree and must be patched (backport, mitigation, etc.). |
| `needs_human` | Evidence is too weak or the model declined to act. Always queued for human review. |

### Where verdicts are decided

| Stage | Can set / change verdict? |
|---|---|
| Triage agent | Initial verdict (the primary classifier). |
| Triage policy guard | If triage said `not_applicable` with `<2` independent evidence items → forced to `needs_human`. |
| Fix author | May set `verdict_override = needs_human` when it refuses to author a patch. |
| Routing | Has a **carve-out** that preserves `code_change` even when the fix author bailed (see §7). |

---

## 4. Triage agent

**File:** [apps/agents/triage_agent.py](apps/agents/triage_agent.py)
**Prompt:** [configs/prompts/triage_agent.txt](configs/prompts/triage_agent.txt)
**Function:** `run_triage_agent(client, bundle, ctx, prompts_dir, ...)`

**Inputs**
- `EvidenceBundle` — advisory evidence, code evidence (snippets from coderag), fixed version, reachability, Ubuntu Security data.
- Optional `ContextSummary` (high-level summary of the codebase area).

**Output (`TriageResult`)**
- `verdict` (one of the 4 above)
- `rationale` — free-text explanation shown in the UI under *Why this verdict*
- `evidence_ids` — which `EvidenceBundle` items the model relied on
- `triage_confidence` (0.0–1.0)

**Role in one line:** *"Given everything we know about this CVE and this codebase, which of the 4 buckets does it belong to?"*

---

## 5. Fix author agent

**File:** [apps/agents/fix_author_agent.py](apps/agents/fix_author_agent.py)
**Prompt:** [configs/prompts/fix_author_agent.txt](configs/prompts/fix_author_agent.txt)
**Function:** `run_fix_author(client, bundle, prompts_dir)`

**Invoked only when** `triage.verdict == code_change`.

**Inputs**
- The same `EvidenceBundle` triage saw (especially `code_evidence` — the candidate vulnerable locations).

**Output (`FixProposal`)**
- `patch_unified_diff` — the actual patch
- `files_touched` — list of paths the diff changes
- `lines_added` / `lines_removed` — computed by us from the diff (not trusted from the model)
- `rationale` — why this patch (shown in *Why no automatic patch* when it bails)
- `verdict_override` — if set to `needs_human`, the fix author is saying *"I will not author this automatically"*
- `fix_confidence` (0.0–1.0)

**Role in one line:** *"Author the actual unified diff that fixes this CVE in this repo, or decline if you can't do it safely."*

When the author returns `verdict_override = needs_human`, the patch is empty. We keep the CVE in the **code_change** bucket so a human sees the suspected locations and crafts the patch by hand.

---

## 6. Verifier agent

**File:** [apps/agents/verifier_agent.py](apps/agents/verifier_agent.py)
**Prompt:** [configs/prompts/verifier_agent.txt](configs/prompts/verifier_agent.txt)
**Function:** `run_verifier(client, bundle, fix, prompts_dir)`

**Invoked only when** there is a fix patch *and* `verdict_override` is not set.

**Inputs — a sealed verification packet (no repo access):**
- CVE metadata
- Advisory summary (status, fixed_version, reachability, advisory evidence)
- Original code snippets (from `code_evidence`)
- The patched snippets (computed from applying the diff in-memory)
- Deterministic results: `git apply --check` outcome, diff stats, file list

**Output (`VerifierResult`)**
- `verdict` — `pass` / `fail` / `uncertain`
- `rationale`
- `unresolved_concerns` (list)
- `verifier_confidence`

**Role in one line:** *"Independent second model: does this patch actually fix the CVE without obvious side effects?"*

If the verifier disagrees (`fail` or `uncertain`), routing will not auto-proceed — the change goes to human review.

---

## 7. Routing — translating verdict into action

**File:** [apps/workflow_d/routing.py](apps/workflow_d/routing.py)
**Function:** `decide(bundle, triage, fix, verifier, confidence, policy, ...) → RoutingResult`

**`RoutingDecision` enum:**

| Decision | Meaning |
|---|---|
| `auto_proceed` | High-confidence — safe to act automatically (e.g. apply patch / open MR). |
| `handoff_workflow_e` | Hand to the upgrade-coordinator workflow (typical for `package_upgrade`). |
| `human_review` | Queue for a human analyst. |
| `suppress` | Ignore / close (typical for confident `not_applicable`, or "already on fixed version"). |

### Decision rules (in order)

1. **Fix-override carve-out (the critical case).**
   If `triage.verdict == code_change` AND `fix.verdict_override == needs_human`:
   - `final_verdict` stays `code_change` (so the CVE is still visible in the Code Change tab)
   - `decision = human_review`
   - `reason = "triage classified as code_change; fix author declined to author a patch automatically — needs human authoring/review"`
   - `auto_proceed = False`

2. **Patch-size caps.** If patch > `max_patch_lines` (default 500) or touches > `max_files` (default 5) → `human_review`.

3. **Verifier disagreement.** `code_change` + verifier != `pass` → `human_review`.

4. **Confidence gate.**
   - `not_applicable` + confident → `suppress`
   - `not_applicable` + low confidence → `human_review`
   - `package_upgrade` + (confident OR Ubuntu authoritative) → `handoff_workflow_e`
   - `code_change` + confident → `auto_proceed`
   - else → `human_review`

5. **Version sanity (package_upgrade only).** If current_version ≥ fixed_version → `suppress` (already patched).

---

## 8. Code retrieval (coderag)

**File:** [apps/coderag/retriever.py](apps/coderag/retriever.py), fallback grep in [apps/coderag/file_fetch.py](apps/coderag/file_fetch.py).

Two paths, tried in order:

1. **Vector / TF-IDF index** (built once per repo by [apps/coderag/indexer.py](apps/coderag/indexer.py); chunks are ~80 lines with 10-line overlap, stored as JSONL under `.data/indexes/<index_id>/`). Query terms = component name + CVE id + extras. Reranked, path-quality scored, then filtered by **family tokens** (see below).

2. **Keyword grep fallback** (`grep_keyword_windows`) when the index has no good hits or no index was built. Same family-token filter applied.

**Family-token filter** (`_family_tokens` in both modules) — extracts identifying tokens from the component name so we only surface paths that plausibly belong to the right component. Handles:
- packaging suffixes: `bind9-libs` → `bind9`
- `python3-foo` → `foo`
- Go-style module paths: `github.com/apache/thrift` → `apache`, `thrift`
- drops generics (`lib`, `bin`, `src`, `com`, `org`, `go`, …)

If no path matches any family token, **no code evidence is returned** (we don't fall back to unrelated files). This is what stops a `thrift` CVE from being "evidenced" by bind9 source.

What the agents see: a list of `code_evidence` items with `path`, `start_line`, `end_line`, `snippet`, `score`, `source` (`index` or `file_fetch`).

---

## 9. Artifacts written to disk

```
.data/
├── runs/
│   ├── run-<id>.start.json              # request that started the run
│   └── decisions/<run_id>/<cve>.json    # HITL ledger (append-only)
│
├── analyses/<analysis_id>/
│   ├── analysis_result.json             # full AnalyzeResponse
│   ├── analysis_log.json                # stage timings
│   ├── analysis_summary.md              # human-readable
│   └── <CVE-ID>/
│       ├── evidence_bundle.json         # advisory + code evidence
│       ├── fix_proposal.json            # patch + rationale + override
│       ├── verifier_result.json         # pass/fail/uncertain
│       └── routing_decision.json        # final_verdict + decision
│
├── indexes/<index_id>/                  # per-project code index
└── registry.sqlite                      # (cve,component,version) → verdict
```

Re-analyses triggered by HITL land under a **new** `analysis_id` and the original decision file gets a `reanalysis` pointer added.

---

## 10. Human-in-the-loop (HITL)

**Endpoint:** `POST /runs/{run_id}/cves/{cve_id}/decision`

```json
{
  "actor": "alice",
  "action": "approve | reject | reassign | note",
  "new_verdict": "package_upgrade | not_applicable | code_change | needs_human",
  "note": "optional comment"
}
```

- `new_verdict` is only used when `action == "reassign"`.
- Every call appends to the decision ledger (`history` array) and updates `latest`.

### Reassign → code_change triggers a re-analysis

When a reviewer reassigns a CVE to `code_change`, the API spawns a background thread that:

1. Reloads that single CVE from the original `vulns_path` + `repo_root`.
2. Runs the full orchestrator pipeline (evidence → triage → fix author → verifier → routing) again.
3. Writes a fresh analysis under `.data/analyses/<new-aid>/<CVE>/`.
4. Patches the decision JSON with `reanalysis = {analysis_id, ts, verdict}`.

Next time the UI fetches `GET /runs/{run_id}/cves/{cve_id}`, the envelope includes `reanalysis_evidence`, `reanalysis_fix`, `reanalysis_routing` so the **Re-analysis after override** panel can render the fresh result.

If the re-analysis decides the codebase doesn't actually use the vulnerable path, the panel shows the `not_applicable` verdict and the supporting evidence so the reviewer can confirm and close.

---

## 11. Main API endpoints (for reference)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/runs/start` | Kick off a run (returns `run_id` immediately) |
| `GET`  | `/runs` | List runs |
| `GET`  | `/runs/{run_id}` | Run summary + tallies |
| `GET`  | `/runs/{run_id}/cves` | One row per CVE in the run |
| `GET`  | `/runs/{run_id}/cves/{cve_id}` | Full per-CVE detail (evidence, triage, fix, verifier, routing, decision, reanalysis) |
| `GET`  | `/runs/{run_id}/cves/{cve_id}/patch` | Download unified diff |
| `POST` | `/runs/{run_id}/cves/{cve_id}/apply_patch` | `git apply --check` or `--apply` against `repo_root` |
| `POST` | `/runs/{run_id}/cves/{cve_id}/decision` | Record HITL decision |
| `GET`  | `/runs/{run_id}/cves/{cve_id}/decision` | Fetch decision ledger |
| `WS`   | `/runs/{run_id}/stream` | Live event stream |
| `GET`  | `/runs/{run_id}/report.xlsx` | Export to Excel |
| `GET`  | `/health` | Service health, current models, index presence |
| `GET`  | `/indexes` | List per-project indexes |

---

## TL;DR — one paragraph

You drop an SBOM into a run. Each CVE goes through: **evidence gathering** (advisory APIs + code retrieval) → **triage** (picks one of 4 verdicts) → **fix author** (writes a unified diff for `code_change` cases, or bails as `needs_human`) → **verifier** (independent pass/fail on the patch) → **routing** (turns verdict + confidence + policy into one of `auto_proceed`, `handoff_workflow_e`, `human_review`, `suppress`). Everything is persisted as JSON. A human can override any verdict via the HITL endpoint; reassigning to `code_change` re-runs the whole per-CVE pipeline in the background and surfaces the fresh evidence + patch (or "not vulnerable" finding) in the UI.
