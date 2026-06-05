#!/usr/bin/env python3
"""Launch the Workflow D FastAPI service with uvicorn."""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from apps.common.utils import load_yaml  # noqa: E402
from apps.workflow_d.api import create_app  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Run Workflow D API")
    parser.add_argument("--config", default=str(ROOT / "configs" / "app.yaml"))
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    args = parser.parse_args()

    os.environ.setdefault("WORKFLOW_D_CONFIG", args.config)
    cfg = load_yaml(args.config)
    svc = cfg.get("service", {})
    host = args.host or svc.get("host", "0.0.0.0")
    port = int(args.port or svc.get("port", 8088))

    import uvicorn

    app = create_app(args.config)
    uvicorn.run(app, host=host, port=port, log_level=svc.get("log_level", "info").lower())


if __name__ == "__main__":
    main()
