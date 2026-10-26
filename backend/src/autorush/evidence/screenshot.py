"""Bounded JPEG execution evidence, bound to the run and its Android target."""
from __future__ import annotations

import base64
import binascii
import hashlib
import io
import os
import re
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4


def evidence_path(report_dir: Path, run_id: UUID, relative: str) -> Path:
    if not isinstance(relative, str) or not re.fullmatch(rf"{run_id}/[a-f0-9]{{32}}\.jpg", relative):
        raise ValueError("invalid screenshot evidence path")
    root = report_dir.resolve()
    path = (root / relative).resolve()
    if not path.is_relative_to(root):
        raise ValueError("screenshot path escapes the report directory")
    return path


def record_screenshot(captured: dict[str, Any], report_dir: Path, run_id: UUID, package: str) -> dict[str, Any]:
    if captured.get("package") != package or captured.get("mime_type") != "image/jpeg":
        raise ValueError("screenshot does not match the Android plan target or image format")
    width, height, timestamp = (captured.get(name) for name in ("width", "height", "captured_at"))
    if any(type(value) is not int or not 1 <= value <= 16384 for value in (width, height)):
        raise ValueError("invalid screenshot dimensions")
    if type(timestamp) not in (int, float) or not 1 <= timestamp <= 2**53 - 1:
        raise ValueError("invalid screenshot timestamp")
    encoded = captured.get("data_base64")
    if not isinstance(encoded, str) or len(encoded) > 1_400_000:
        raise ValueError("screenshot exceeds the evidence size limit")
    try:
        jpeg = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("invalid screenshot encoding") from exc
    source_width,source_height=width,height
    bounds=captured.get('source_bounds')
    if bounds is not None and (not isinstance(bounds,list) or len(bounds)!=4 or any(type(v) is not int or not 0<=v<=16384 for v in bounds)
        or bounds[2]<=bounds[0] or bounds[3]<=bounds[1]):raise ValueError('invalid screenshot crop bounds')
    if len(jpeg)>200_000 or max(width,height)>1280:
        from PIL import Image
        from autorush.evidence.images import encode_jpeg
        with Image.open(io.BytesIO(jpeg)) as image:
            if image.size!=(width,height) or width*height>40_000_000:
                raise ValueError('Android screenshot dimensions do not match the image or exceed the decode limit')
            jpeg,width,height=encode_jpeg(image)
    return store_jpeg(jpeg, report_dir, run_id, {"package": package, "driver": "android",
        "captured_at": timestamp, "width": width, "height": height,
        "source_width":source_width,"source_height":source_height,**({'source_bounds':bounds} if bounds is not None else {})})


def store_jpeg(jpeg: bytes, report_dir: Path, run_id: UUID, metadata: dict[str, Any]) -> dict[str, Any]:
    if not 4 <= len(jpeg) <= 1_000_000 or not jpeg.startswith(b"\xff\xd8") or not jpeg.endswith(b"\xff\xd9"):
        raise ValueError("invalid or oversized JPEG screenshot")
    digest=hashlib.sha256(jpeg).hexdigest()
    filename = f"{digest[:32]}.jpg"
    relative = f"{run_id}/{filename}"
    destination = evidence_path(report_dir, run_id, relative)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f'.{destination.stem}.{uuid4().hex}.tmp')
    try:
        if not destination.exists() or hashlib.sha256(destination.read_bytes()).hexdigest()!=digest:
            temporary.write_bytes(jpeg)
            os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return {"file": relative, "url": f"/api/v1/runs/{run_id}/evidence/{filename}",
            "sha256": digest, "bytes": len(jpeg), "mime_type": "image/jpeg",
            **metadata}
