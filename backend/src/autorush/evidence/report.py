"""Atomic JSON, standalone HTML and JUnit report publishing."""

from __future__ import annotations

import os
import json
import base64
import hashlib
from html import escape
from pathlib import Path
from xml.etree import ElementTree

from autorush.domain.models import RunRecord
from autorush.evidence.screenshot import evidence_path


def save_json_report(run: RunRecord, report_dir: Path) -> Path:
    report_dir.mkdir(parents=True, exist_ok=True)
    destination = report_dir / f"{run.id}.json"
    temporary = report_dir / f".{run.id}.tmp"
    try:
        temporary.write_text(run.model_dump_json(indent=2), encoding="utf-8")
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination.resolve()


def save_reports(run: RunRecord, report_dir: Path) -> dict[str, Path]:
    """Persist all report formats before any report-ready event is emitted."""
    report_dir.mkdir(parents=True, exist_ok=True)
    paths = {
        "json": (report_dir / f"{run.id}.json").resolve(),
        "html": (report_dir / f"{run.id}.html").resolve(),
        "junit": (report_dir / f"{run.id}.xml").resolve(),
    }
    complete_run = run.model_copy(update={
        "report_path": str(paths["json"]),
        "report_paths": {name: str(path) for name, path in paths.items()},
    })
    _write_atomic(paths["json"], complete_run.model_dump_json(indent=2))
    _write_atomic(paths["html"], _render_html(complete_run, report_dir))
    _write_atomic(paths["junit"], _render_junit(complete_run))
    return paths


def _write_atomic(destination: Path, content: str) -> Path:
    temporary = destination.with_name(f".{destination.name}.tmp")
    try:
        temporary.write_text(content, encoding="utf-8")
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination.resolve()


def _screenshot_html(evidence: dict, run: RunRecord, report_dir: Path) -> str:
    metadata = evidence.get("screenshot")
    if not isinstance(metadata, dict):
        return ""
    try:
        path = evidence_path(report_dir, run.id, metadata.get("file"))
        if path.stat().st_size > 1_000_000:
            return ""
        with path.open('rb') as source:
            jpeg = source.read(1_000_001)
        if len(jpeg) > 1_000_000 or len(jpeg) != metadata.get('bytes') or hashlib.sha256(jpeg).hexdigest() != metadata.get("sha256"):
            return "<p>Screenshot evidence checksum mismatch</p>"
        encoded = base64.b64encode(jpeg).decode("ascii")
        return (f'<figure><a href="data:image/jpeg;base64,{encoded}" target="_blank">'
                f'<img alt="Step screenshot" src="data:image/jpeg;base64,{encoded}"></a>'
                f'<figcaption>{escape(str(metadata.get("package") or metadata.get("target", "")))} · '
                f'SHA-256 {escape(str(metadata.get("sha256", "")))}</figcaption></figure>')
    except (OSError, ValueError, TypeError):
        return "<p>Screenshot evidence unavailable</p>"


def _render_html(run: RunRecord, report_dir: Path) -> str:
    total = len(run.cases)
    passed = sum(case.status.value == "passed" for case in run.cases)
    case_sections: list[str] = []
    for case in run.cases:
        rows = "".join(
            "<tr>"
            f"<td>{step.order}</td><td>{escape(step.intent)}</td>"
            f"<td><span class='status {escape(step.status.value)}'>{escape(step.status.value)}</span></td>"
            f"<td>{escape(step.detail)}"
            + _screenshot_html(step.evidence, run, report_dir)
            + _agent_html(step.evidence,run,report_dir)
            + (f"<details><summary>Evidence</summary><pre>{escape(json.dumps(step.evidence, ensure_ascii=False, indent=2))}</pre></details>" if step.evidence else "")
            + f"</td><td>{'<br>'.join(escape(item) for item in step.assertions)}</td>"
            +
            "</tr>"
            for step in case.steps
        )
        case_sections.append(
            f"<section><h2>{escape(case.title or str(case.case_id))} "
            f"<span class='status {escape(case.status.value)}'>{escape(case.status.value)}</span></h2>"
            f"<small>Case {escape(str(case.case_id))}</small>"
            "<table><thead><tr><th>#</th><th>Intent</th><th>Status</th><th>Detail</th><th>Assertions</th></tr></thead>"
            f"<tbody>{rows}</tbody></table></section>"
        )
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>AutoRush report {escape(str(run.id))}</title><style>
body{{font:14px system-ui,sans-serif;color:#17253a;background:#f5f7fb;margin:0;padding:32px}}main{{max-width:1100px;margin:auto}}
header,section{{background:white;border:1px solid #e5ebef;border-radius:12px;padding:22px;margin-bottom:16px}}h1{{margin:0 0 8px}}h2{{font-size:16px}}
.summary{{display:flex;gap:12px;margin-top:18px}}.metric{{background:#f2f6f8;border-radius:8px;padding:10px 14px}}table{{border-collapse:collapse;width:100%}}
th,td{{border-top:1px solid #e8edf1;text-align:left;padding:10px;vertical-align:top}}th{{font-size:12px;color:#66798a}}.status{{font-weight:700}}
.passed{{color:#168565}}.failed,.error{{color:#b14e48}}.blocked,.skipped{{color:#9b702a}}small{{color:#718596}}
pre{{white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto}}
figure{{margin:12px 0}}figure img{{max-width:280px;max-height:520px;object-fit:contain;border:1px solid #e5ebef}}figcaption{{font-size:11px;overflow-wrap:anywhere}}
</style></head><body><main><header><h1>AutoRush 测试报告</h1><small>Run {escape(str(run.id))} · Plan {escape(str(run.plan_id))} · {escape(run.created_at.isoformat())}</small>
<div class="summary"><div class="metric">结果 <b>{escape(run.status.value)}</b></div><div class="metric">用例 <b>{total}</b></div><div class="metric">通过 <b>{passed}</b></div></div></header>
{''.join(case_sections)}</main></body></html>"""


def _agent_html(evidence,run,report_dir):
    agent=evidence.get('agent',{})
    if not isinstance(agent,dict): return ''
    parts=[]
    for trace in agent.get('traces',[]):
        result=trace.get('result',{})
        parts.append('<article><h4>'+escape(str(trace.get('operation') or 'decision'))+' · '+escape(str(result.get('status','')))
            +'</h4><p>'+escape(str(trace.get('brief_reason') or trace.get('error','')))+'</p>'
            +'<small>'+escape(str(trace.get('verification_kind','')))+'</small>'
            +_screenshot_html(trace.get('observation',{}),run,report_dir)
            +_screenshot_html(result.get('evidence',{}),run,report_dir)+'</article>')
    return ''.join(parts)


def _render_junit(run: RunRecord) -> str:
    failures = sum(case.status.value == "failed" for case in run.cases)
    errors = sum(case.status.value in {"error", "blocked"} for case in run.cases)
    skipped = sum(case.status.value == "skipped" for case in run.cases)
    suite = ElementTree.Element("testsuite", {
        "name": f"AutoRush plan {run.plan_id}", "tests": str(len(run.cases)),
        "failures": str(failures), "errors": str(errors), "skipped": str(skipped),
        "timestamp": run.created_at.isoformat(),
    })
    for case in run.cases:
        item = ElementTree.SubElement(suite, "testcase", {"name": case.title or str(case.case_id), "classname": f"autorush.{case.case_id}"})
        details = "\n".join(f"{step.order}. {step.intent}: {step.status.value} - {step.detail}" for step in case.steps)
        details += "\n" + "\n".join(json.dumps(step.evidence, ensure_ascii=False) for step in case.steps if step.evidence)
        if case.status.value == "failed":
            ElementTree.SubElement(item, "failure", {"message": "assertion failed"}).text = details
        elif case.status.value in {"error", "blocked"}:
            ElementTree.SubElement(item, "error", {"message": case.status.value}).text = details
        elif case.status.value == "skipped":
            ElementTree.SubElement(item, "skipped")
        ElementTree.SubElement(item, "system-out").text = details
    ElementTree.indent(suite)
    return '<?xml version="1.0" encoding="utf-8"?>\n' + ElementTree.tostring(suite, encoding="unicode")
