"""Run the demo's case, approval, plan and report workflow on a local AutoRush backend."""

import argparse
import json
from datetime import datetime
from http.client import HTTPConnection, HTTPException
from pathlib import Path
from uuid import UUID


DEMO = Path(__file__).resolve().parent
API = "/api/v1"


def request(port, path, *, payload=None, headers=None, expected=200):
    """Send a direct loopback request and report unexpected API responses."""
    connection = HTTPConnection("127.0.0.1", port, timeout=120)
    request_headers = dict(headers or {})
    try:
        if payload is None:
            connection.request("GET", path, headers=request_headers)
        else:
            request_headers["Content-Type"] = "application/json"
            connection.request("POST", path, json.dumps(payload).encode("utf-8"), request_headers)
        response = connection.getresponse()
        body = response.read()
        if response.status != expected:
            detail = body.decode("utf-8", errors="replace")[:400]
            raise RuntimeError(f"{path}: HTTP {response.status} (expected {expected})\n{detail}")
        return body
    finally:
        connection.close()


def run_flow(backend_port, demo_port, headed=False):
    """Create and approve the two demo cases, run a plan, and export its report."""
    catalog = json.loads(request(demo_port, "/api/catalog"))
    if catalog.get("service") != "autorush-equipment-demo":
        raise RuntimeError(f"Start the equipment demo with python demo/serve.py --port {demo_port}.")
    request(backend_port, "/health")

    headers = {"Origin": "app://autorush"}
    session = json.loads(request(backend_port, f"{API}/devices/operator-session", headers=headers))
    headers["X-Autorush-Operator-Token"] = session["operator_token"]
    cases = [json.loads((DEMO / "cases" / name).read_text(encoding="utf-8"))
             for name in ("web-request.json", "api-request.json")]

    case_ids = []
    for case in cases:
        saved = json.loads(request(backend_port, f"{API}/cases", payload=case, headers=headers, expected=201))
        case_id = saved["id"]
        request(backend_port, f"{API}/cases/{case_id}/approve", payload={}, headers=headers)
        case_ids.append(case_id)
        print(f"Approved: {saved['title']}", flush=True)

    target = f"http://127.0.0.1:{demo_port}"
    plan = json.loads(request(backend_port, f"{API}/plans", headers=headers, expected=201, payload={
        "name": f"演示 · 设备领用流程 {datetime.now():%Y-%m-%d %H:%M:%S}",
        "environment": "equipment-demo",
        "case_ids": case_ids,
        "web_base_url": target,
        "api_base_url": target,
        "web_headless": not headed,
        "capture_screenshots": True,
    }))
    path = f"{API}/plans/{plan['id']}"
    request(backend_port, path + "/ready", headers=headers, payload={})
    print(f"Running: {plan['name']}", flush=True)
    run = json.loads(request(backend_port, path + "/runs", headers=headers, payload={}, expected=201))
    run_id = str(UUID(run["id"]))
    destination = DEMO.parent / "artifacts" / "equipment-demo" / run_id
    destination.mkdir(parents=True, exist_ok=True)
    for format_name, filename in (("json", "report.json"), ("html", "report.html"), ("junit", "junit.xml")):
        report = request(backend_port, f"{API}/runs/{run_id}/report/{format_name}", headers=headers)
        (destination / filename).write_bytes(report)
    print(f"Run: {run_id} ({run['status']})\nReports: {destination}", flush=True)
    return 0 if run["status"] == "passed" else 1


def main():
    """Parse the local ports and choose visible or headless Chromium."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend-port", type=int, choices=range(1, 65536), metavar="PORT", default=8000)
    parser.add_argument("--demo-port", type=int, choices=range(1, 65536), metavar="PORT", default=8766)
    parser.add_argument("--headed", action="store_true", help="Show the browser while running the Web case.")
    args = parser.parse_args()
    try:
        return run_flow(args.backend_port, args.demo_port, args.headed)
    except (ValueError, OSError, HTTPException, RuntimeError, KeyError) as exc:
        parser.exit(1, f"{exc}\nCheck that the demo and AutoRush backend are running on the selected ports.\n")


if __name__ == "__main__":
    raise SystemExit(main())
