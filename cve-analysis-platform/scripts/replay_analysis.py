#!/usr/bin/env python3
"""Replay/inspect a saved analysis result without re-running models."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main() -> None:
    parser = argparse.ArgumentParser(description="Replay a saved analysis")
    parser.add_argument("--artifacts-dir", default=".data/analyses")
    parser.add_argument("--analysis-id", required=True)
    args = parser.parse_args()

    base = Path(args.artifacts_dir) / args.analysis_id
    if not base.exists():
        sys.exit(f"no such analysis: {base}")
    result_path = base / "analysis_result.json"
    if not result_path.exists():
        sys.exit(f"missing analysis_result.json in {base}")
    data = json.loads(result_path.read_text(encoding="utf-8"))
    print(f"analysis_id: {data['analysis_id']}  mode: {data['mode']}  total: {data['total']}")
    for r in data["results"]:
        print(
            f"  {r['cve_id']} :: {r['component']['name']}@{r['component'].get('current_version')} "
            f"-> verdict={r['routing']['final_verdict']} decision={r['routing']['decision']} "
            f"conf=({r['confidence']['triage_confidence']},"
            f"{r['confidence']['fix_confidence']},"
            f"{r['confidence']['evidence_confidence']})"
        )


if __name__ == "__main__":
    main()
