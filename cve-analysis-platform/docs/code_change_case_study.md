# Code-Change Verdict — How It Works & Why Recent Runs Produced Zero


**Run analysed:** `run-c8bae06b0f6e` (90 CVEs, NIOS SBOM, May 31 2026)
**Result summary:** 65 `package_upgrade`, 17 `not_applicable`, 8 `needs_human`, **0 `code_change`**

This document explains (1) the exact pipeline that decides whether a CVE becomes a
`code_change` verdict, and (2) why — for this particular NIOS scan — no CVE met the
bar. The conclusion is that the pipeline is behaving **correctly**: NIOS does not
vendor the affected source code in-tree, so an in-repo patch is not the right fix.

---

## 1. The `code_change` Pipeline (4 stages)

```
┌──────────┐    ┌─────────────┐    ┌──────────┐    ┌──────────────┐
│ Triage   │───►│ Fix Author  │───►│ Verifier │───►│ Routing /    │
│ Agent    │    │ (writes a   │    │ (semantic│    │ Confidence   │
│          │    │ unified     │    │ + git    │    │ gate         │
│          │    │  diff)      │    │ apply)   │    │              │
└──────────┘    └─────────────┘    └──────────┘    └──────────────┘
```

### Stage 1 — Triage Agent decides the *intent*

Triage emits one of four verdicts using a strict ordered ruleset
(`configs/prompts/triage_agent.txt` v2):

| Rule | Verdict | Trigger |
|---|---|---|
| 1 | `not_applicable` | ≥2 independent evidence items show the code isn't reachable / used |
| 2 | **`code_change`** | The vulnerable code is **vendored in-tree** OR has a custom suffix (`*blox*`, `+local`) OR no upstream fix exists AND repo references the vulnerable code |
| 3 | `package_upgrade` | A `fixed_version` is published AND no in-tree source for this component |
| 4 | `needs_human` | `fixed_version` is null AND no in-tree source AND reachability unknown |

**The single hardest gate is Rule 2's "vendored in-tree" check.** If the dependency
ships as a binary, a Go module, an npm package, or a Debian package, triage will
never pick `code_change` — there are no source files in this repository for the
author to patch.

### Stage 2 — Fix Author writes a unified diff (only if triage said `code_change`)

`apps/agents/fix_author_agent.py` is invoked with the bundle. It can either:

- Produce a `patch_unified_diff` (the proposed change).
- Return `verdict_override = needs_human` if it cannot author a safe patch (e.g.
  evidence too thin, file too large, ambiguous semantics).

### Stage 3 — Verifier validates the patch

`apps/agents/verifier_agent.py` receives:

- The original code snippets,
- The **patched** code snippets (computed by `apps/workflow_d/patch_utils.py`),
- A deterministic `git apply --check` result on the patch.

It returns `pass`, `fail`, or `uncertain`.

### Stage 4 — Routing & Confidence gate

`apps/workflow_d/routing.py` makes the final call:

| Condition | Final decision |
|---|---|
| `git apply --check` fails | `human_review` ("authored patch failed git apply") |
| Verifier `fail` | `human_review` |
| Verifier `uncertain` but patch applies cleanly | `human_review` (sanity-check) |
| Verifier `pass` AND `fix_conf ≥ 0.75` AND `evidence_conf ≥ 0.75` | **`handoff_workflow_e`** (auto-merge candidate) |
| Verifier `pass` but confidences below threshold | `human_review` |

So a CVE only ends up as an *auto-applied* code change if **all four** stages
agree. Anything weaker is escalated to a human — by design.

### Why `code_change` is *intentionally* rare

`code_change` is reserved for one specific situation: the vulnerable library's
source lives **inside this repository** (vendored, forked, or locally patched).
For modern Go / Python / Node monorepos that consume libraries via package
managers, the correct fix is a version bump (`package_upgrade`), not a source
patch. The pipeline is designed to detect this and *not* fabricate a patch
against code it doesn't own.

---

## 2. Five Case Studies from `run-c8bae06b0f6e`

The table below summarises representative CVEs from the run. Each illustrates a
distinct reason why `code_change` was — correctly — not chosen.

| # | CVE | Component | Triage verdict | Final | Why no code change |
|---|---|---|---|---|---|
| 1 | CVE-2026-41411 | `vim@2:8.2.3995-1ubuntu2.24` | `package_upgrade` | `handoff_workflow_e` | Ubuntu published a fix; vim is a Debian package, not in-tree |
| 2 | CVE-2026-41491 | `github.com/dapr/dapr@v1.14.0` | `needs_human` | `human_review` | No fix version *and* no vendored source → cannot author a patch |
| 3 | CVE-2026-41602 | `github.com/apache/thrift@v0.19.0` | `package_upgrade` | `human_review` | Third-party Go module, no in-tree thrift source |
| 4 | CVE-2026-42307 | `vim@2:8.2.3995-1ubuntu2.24` | `not_applicable` | `human_review` | Triage decided the bug is unreachable in this build |
| 5 | CVE-2026-42499 | `cloud.google.com/go@v0.110.10` | `package_upgrade` | `human_review` | Managed Go module; fix is a `go.mod` bump, not a source patch |

### Case 1 — CVE-2026-41411 (vim) — `handoff_workflow_e`

- **What happened:** Ubuntu Security API authoritatively confirmed a fixed
  version exists for vim. Triage chose `package_upgrade` with high confidence
  (evidence 0.95). Routing fast-tracked it to Workflow E.
- **Why not code_change:** vim is shipped by Ubuntu as a `.deb`. There is no
  vim source in NIOS to patch. The correct remediation is `apt upgrade vim`.

### Case 2 — CVE-2026-41491 (Dapr) — `needs_human`

- **What happened:** No `fixed_version` was published, and `code_evidence` came
  back empty (no Dapr source in NIOS). Triage applied Rule 4 → `needs_human`.
- **Why not code_change:** The fix author has nothing to author against
  (no source files), and there is no upstream version to upgrade to. A human
  must decide whether Dapr is actually deployed, whether the vulnerable path is
  reachable, and whether to wait for an upstream fix.

### Case 3 — CVE-2026-41602 (Apache Thrift) — `package_upgrade` (low-confidence)

- **What happened:** Triage picked `package_upgrade` (Rule 3) because thrift is
  a managed Go module, but confidence was 0.65 / 0.50. The gate requires ≥0.75,
  so routing demoted it to `human_review`.
- **Why not code_change:** Apache Thrift's source is **not** vendored in NIOS.
  Even if a patch existed upstream, it would land in thrift's repo and reach
  NIOS via `go get -u`.
- **Why low confidence:** the advisory data we received did not include an
  explicit fixed-version, only a "vulnerable range." After the recent
  coderag fix (org-name token blocklist), this no longer pulls Apache HTTPD
  code as false-positive evidence — but the missing fixed_version still kept
  confidence below the auto-merge bar.

### Case 4 — CVE-2026-42307 (vim) — `not_applicable` (low-confidence)

- **What happened:** Triage believed the affected vim subsystem is not used in
  NIOS (`not_applicable`). Evidence confidence was 0.95 but triage confidence
  was only 0.40 (the prompt requires ≥2 independent evidence items for
  `not_applicable` — only one was found). Routing demoted to `human_review`.
- **Why not code_change:** Triage's hypothesis is the opposite — the code path
  isn't reachable, so neither a patch nor an upgrade is required. A human just
  needs to confirm the unreachability claim.

### Case 5 — CVE-2026-42499 (cloud.google.com/go) — `package_upgrade` (low-confidence)

- **What happened:** Standard Go-module pattern. Triage chose `package_upgrade`
  but confidence was very low (triage 0.15, evidence 0.35) because the SBOM row
  for this component lacked rich advisory context.
- **Why not code_change:** It's a Google-managed module; NIOS does not vendor
  its source. Remediation is a `go.mod` version bump, not an in-repo patch.

---

## 3. Take-Aways

1. **Zero `code_change` is the expected outcome for NIOS today.** NIOS is a
   thin orchestration layer over many third-party libraries and Debian
   packages. None of the 90 CVEs implicates source code that lives in this
   repository.
2. **The pipeline does the safe thing.** When the author cannot produce a
   confident patch (or when no patch is needed because an upgrade exists), the
   CVE is either routed to `package_upgrade` (Workflow E) or escalated to
   human review. We never fabricate a diff against code we don't own.
3. **Where we *would* see `code_change`:** if NIOS ever forks a library
   in-tree (e.g. `third_party/<lib>/...`) or carries Infoblox-specific patches
   (suffix `*blox*` / `+local`), triage's Rule 2 will fire, the author will
   produce a unified diff, the verifier will run `git apply --check` plus
   semantic review, and the routing gate will hand off to Workflow E only when
   every signal agrees.
4. **Confidence gates are working as designed.** Many third-party-package CVEs
   in this run (Apache Thrift, cloud.google.com/go, docker/distribution, etc.)
   were routed to `human_review` purely because evidence was thin. This is a
   data-quality observation, not a pipeline bug — improving SBOM enrichment
   (e.g. attaching `fixed_version` from the advisory feeds at ingest time) is
   the highest-leverage way to convert these into clean `package_upgrade`
   auto-handoffs.
