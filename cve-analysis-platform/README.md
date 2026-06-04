# CVE Analysis Platform — Workflow D

Workflow D is the central **CVE Analysis Agent brain**. It consumes normalized
CVE events (produced by Workflow B, see [`../Dependency_Track_Final_2 1.py`](../Dependency_Track_Final_2%201.py))
and runs context gathering, RAG retrieval, evidence bundling, triage,
fix authoring, semantic verification, confidence scoring, and routing.

In addition to the analysis backend it ships:

- a **FastAPI service** exposing both the original synchronous `/analyze` and
  a long-running **run lifecycle API** (`/runs/start`, `/runs/{rid}/cancel`,
  WebSocket event stream, XLSX export);
- a **per-project CodeRAG index** registry with a build/update workflow;
- a **React + Vite dashboard** (under [`frontend/`](frontend/)) for kicking
  off runs, watching live progress, drilling into individual CVE verdicts,
  and recording human-in-the-loop decisions.

It deliberately does **not**:

- redesign or replace Workflow B,
- create Jira tickets (artifacts are written as JSON),
- implement Workflow E (package-upgrade execution).

## Layout

```
cve-analysis-platform/
├── apps/
│   ├── workflow_d/        # FastAPI app, orchestrator, evidence bundle, routing
│   │   ├── api.py         # REST + WebSocket surface (runs, indexes, models …)
│   │   ├── orchestrator.py# Parallel pipeline w/ cooperative cancellation
│   │   └── evidence_builder.py
│   ├── agents/            # context / triage / fix author / verifier
│   ├── coderag/           # indexer + retriever + file-fetch fallback
│   ├── enrichment/        # Ubuntu Security Tracker, etc.
│   ├── common/            # model client, logging, event bus, schemas helpers
│   └── registry/          # SQLite registry
├── configs/
│   ├── app.yaml
│   ├── logging.yaml
│   ├── prompts/           # Versioned prompt files
│   └── policies/          # Confidence + routing thresholds
├── frontend/              # React + TS + Vite dashboard
│   └── src/pages/         # Dashboard, RunDetail, CVEDetail, NewRun, IndexPage…
├── scripts/
│   ├── run_workflow_d.py  # Uvicorn launcher
│   ├── build_index.py     # Build Code-RAG index over a repo
│   └── replay_analysis.py # Replay a saved analysis from artifacts
└── tests/
    ├── unit/
    ├── integration/
    └── contract/
```

## Quick start

### Backend

```bash
cd cve-analysis-platform
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 1) (optional) build a per-project code RAG index from the CLI.
#    The UI's Indexes page can do the same thing interactively.
python scripts/build_index.py --repo /path/to/repo --out .data/indexes/myrepo__main__abcd1234

# 2) configure the LiteLLM proxy + key (single key for all models)
export LITELLM_PROXY_BASE_URL="https://litellm.services.sdp.infoblox.com/"
export LITELLM_PROXY_API_KEY="sk-..."        # your one LiteLLM key
# Pick two models exposed by the proxy. They MUST be from different families.
export LITELLM_AUTHOR_MODEL="gpt-5-mini-us-east-2-prod"
export LITELLM_VERIFIER_MODEL="bedrock/claude-opus-4.7"

# 3) run the service (defaults to :8088)
python scripts/run_workflow_d.py
```

### Frontend (dashboard)

```bash
cd frontend
npm install
# Point at the backend (defaults to http://localhost:8088).
echo 'VITE_API_BASE=http://localhost:8088' > .env.local
npm run dev          # development server on http://localhost:5173
# or
npm run build        # production bundle in frontend/dist/
```

The dashboard talks to the backend over REST + a per-run WebSocket
(`/runs/{rid}/stream`) and renders verdict tallies, severity, project
metadata, Ubuntu Security details, and HITL controls live.

### Single-shot CLI usage

You can still POST a batch of CVE events directly to
`http://localhost:8088/analyze` — see
[`apps/workflow_d/schemas.py`](apps/workflow_d/schemas.py) for the request shape.

## HTTP API

All endpoints live in [`apps/workflow_d/api.py`](apps/workflow_d/api.py).

### Runs

| Method | Path                                  | Purpose                                      |
| ------ | ------------------------------------- | -------------------------------------------- |
| POST   | `/analyze`                            | Synchronous one-shot analysis                |
| POST   | `/runs/start`                         | Kick off a run async; returns `run_id`       |
| POST   | `/runs/{rid}/cancel`                  | Cooperative stop (drains in-flight CVEs)     |
| GET    | `/runs`                               | List runs (enriched with project + state)    |
| GET    | `/runs/{rid}`                         | Run envelope: status + artifact              |
| GET    | `/runs/{rid}/events?since_seq=N`      | Poll-style event log                         |
| WS     | `/runs/{rid}/stream`                  | Live event stream (replays history first)    |
| GET    | `/runs/{rid}/cves`                    | Per-CVE table (severity, verdict, decision)  |
| GET    | `/runs/{rid}/cves/{cve_id}`           | Per-CVE detail w/ evidence bundle            |
| GET    | `/runs/{rid}/report.xlsx`             | Download Excel summary                       |

The `/runs/start` body accepts `vulns_path`, `severities`, `limit`, `mode`,
`workers`, `repo_root`, `index_id`, `author_model`, `verifier_model`. A
sidecar `.data/runs/<rid>.start.json` is written so project name, the
chosen index, and per-CVE severity survive a server restart.

### Code indexes

| Method | Path             | Purpose                                          |
| ------ | ---------------- | ------------------------------------------------ |
| GET    | `/indexes`       | List all per-project indexes                     |
| GET    | `/index/status`  | Build status + index registry                    |
| POST   | `/index/build`   | Create new (auto-id) or update an existing index |

Each per-project index lives under `.data/indexes/<project>__<branch>__<short>/`
with a `meta.json` describing project, branch, repo_root/git_url, and
indexed-file counts. The legacy single `.data/index/` directory is still
honoured and shows up in the index list as `__legacy__`.

### Misc

| Method | Path                                          | Purpose                                |
| ------ | --------------------------------------------- | -------------------------------------- |
| GET    | `/health`                                     | Liveness + active models               |
| GET    | `/config`                                     | UI hints: worker bounds, defaults      |
| GET    | `/models`                                     | LiteLLM proxy model list (with cache)  |
| POST   | `/runs/{rid}/cves/{cve_id}/decision`          | HITL: approve / reject / reassign      |
| GET    | `/runs/{rid}/cves/{cve_id}/decision`          | HITL: read decision history            |
| POST   | `/jenkins/trigger`                            | Stub; records a ticket request         |

`/models` honours `models.proxy_ca_bundle` and falls back to `certifi.where()`
so corporate-CA-signed LiteLLM proxies work without disabling TLS
verification. Set `models.proxy_verify_ssl: false` only as a last resort.

## Architectural rules enforced in code

- Triage produces exactly one verdict: `not_applicable`, `package_upgrade`,
  `code_change`, or `needs_human`.
- `not_applicable` requires **2 independent evidence items**; otherwise the
  verdict is forced to `needs_human` (see [`apps/agents/triage_agent.py`](apps/agents/triage_agent.py)).
- Author and verifier must come from **different model families**
  (enforced in [`apps/common/model_client.py`](apps/common/model_client.py)).
- Patches > **500 lines** or > **5 files** auto-escalate to `needs_human`
  (see [`apps/workflow_d/routing.py`](apps/workflow_d/routing.py)).
- Three independent confidence scores: triage, fix, evidence; auto-proceed
  only when **all ≥ 0.75** (see [`apps/workflow_d/confidence.py`](apps/workflow_d/confidence.py)).
- One **shared evidence bundle per CVE** is built once and reused across all
  stages (see [`apps/workflow_d/evidence_builder.py`](apps/workflow_d/evidence_builder.py)).
- Code retrieval is **index-first with file-fetch fallback**
  (see [`apps/coderag/retriever.py`](apps/coderag/retriever.py)).
- All LLM calls go through LiteLLM with timeouts, bounded retries, JSON
  parsing, and token/cost logging.
- Run cancellation is **cooperative**: already-running CVEs finish naturally,
  pending CVEs are skipped, and the run resolves with state `cancelled`.

## Artifacts & storage

```
.data/
├── analyses/<analysis_id>/                # Per-analysis outputs
│   ├── analysis_result.json
│   └── <cve_id>/
│       ├── evidence_bundle.json
│       ├── fix_proposal.json              # when applicable
│       ├── verifier_result.json           # when applicable
│       ├── routing_decision.json
│       └── analysis_log.json
├── runs/
│   ├── <run_id>.json                      # Run-level summary
│   ├── <run_id>.start.json                # Sidecar: project, index, severity
│   └── events/<run_id>.events.jsonl       # Replayable event log
├── indexes/<project>__<branch>__<short>/  # Per-project Code-RAG indexes
│   └── meta.json
└── index/                                 # Legacy shared index (still supported)
```

JSON is the source of truth; a short Markdown summary and an XLSX report
(via `/runs/{rid}/report.xlsx`) are produced alongside.

