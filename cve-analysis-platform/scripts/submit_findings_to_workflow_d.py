#!/usr/bin/env python3
"""Submit Dependency-Track findings JSON to Workflow D and save final analysis.

This script is CI/Jenkins friendly: it validates inputs, normalizes findings,
retries API submission, and writes the final analysis response as JSON.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.analyze_dt_findings import filter_findings, load_findings, to_event  # noqa: E402


def _die(msg: str, code: int = 1) -> None:
    print(f"ERROR: {msg}")
    raise SystemExit(code)


def _parse_severities(raw: str) -> list[str] | None:
    parts = [x.strip().upper() for x in (raw or "").split(",") if x.strip()]
    return parts or None


def main() -> None:
    parser = argparse.ArgumentParser(description="Submit DT findings to Workflow D /analyze")
    parser.add_argument("--vulns", required=True, help="Path to findings JSON/XLSX/CSV")
    parser.add_argument("--api", required=True, help="Workflow D API base URL, e.g. http://host:8088")
    parser.add_argument("--repo-root", default="", help="Optional repo root used by workflow context")
    parser.add_argument("--mode", default="standard", choices=["standard", "urgent", "ad_hoc"])
    parser.add_argument("--severities", default="CRITICAL,HIGH", help="Comma-separated severities")
    parser.add_argument("--limit", type=int, default=0, help="Max findings to submit (0 means all)")
    parser.add_argument("--timeout", type=int, default=900, help="HTTP timeout in seconds")
    parser.add_argument("--retries", type=int, default=3, help="Retry attempts on submission failure")
    parser.add_argument("--out", required=True, help="Path to write final analysis response JSON")
    parser.add_argument(
        "--normalized-out",
        default="",
        help="Optional path to write normalized payload sent to /analyze",
    )
    args = parser.parse_args()

    vulns_path = Path(args.vulns).resolve()
    if not vulns_path.exists():
        _die(f"findings file not found: {vulns_path}")

    findings, build_context = load_findings(vulns_path)
    if args.repo_root.strip():
        build_context["repo_root"] = args.repo_root.strip()

    selected = filter_findings(
        findings,
        severities=_parse_severities(args.severities),
        components=None,
        limit=(args.limit or None),
    )
    events = [to_event(f, build_context) for f in selected]
    if not events:
        _die("no findings selected after filtering", 2)

    payload = {"mode": args.mode, "cves": events}
    if args.normalized_out:
        Path(args.normalized_out).write_text(
            json.dumps(payload, indent=2, default=str), encoding="utf-8"
        )

    url = args.api.rstrip("/") + "/analyze"
    last_err = ""
    for attempt in range(1, max(1, args.retries) + 1):
        try:
            resp = requests.post(url, json=payload, timeout=args.timeout)
            if resp.status_code == 200:
                out_path = Path(args.out)
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_text(
                    json.dumps(resp.json(), indent=2, default=str),
                    encoding="utf-8",
                )
                print(f"Submitted {len(events)} CVEs to {url}")
                print(f"Saved final analysis to: {out_path}")
                return
            last_err = f"HTTP {resp.status_code}: {resp.text[:500]}"
        except Exception as exc:  # noqa: BLE001
            last_err = str(exc)

        if attempt < max(1, args.retries):
            backoff = min(30, attempt * 5)
            print(f"Attempt {attempt} failed, retrying in {backoff}s: {last_err}")
            time.sleep(backoff)

    _die(f"submission failed after {args.retries} attempts: {last_err}")


if __name__ == "__main__":
    main()
