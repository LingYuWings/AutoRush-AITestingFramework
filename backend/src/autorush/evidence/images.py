"""Bounded local Web/Desktop image evidence, using the common report store."""
from __future__ import annotations

import io
import json
from pathlib import Path
from uuid import UUID

from autorush.evidence.screenshot import store_jpeg


def encode_jpeg(image) -> tuple[bytes, int, int]:
    image = image.convert('RGB')
    image.thumbnail((1280, 1280))
    for limit in (1280,1024,800):
        image.thumbnail((limit,limit))
        for quality in (65,50,35,25):
            buffer = io.BytesIO()
            image.save(buffer, format='JPEG', quality=quality,optimize=True)
            data = buffer.getvalue()
            if len(data) <= 200_000:return data,image.width,image.height
    raise ValueError('screenshot exceeds the evidence size limit')


def record_local_image(jpeg: bytes, *, report_dir: Path, run_id: UUID, driver: str,
                       target: dict, width: int, height: int, captured_at: int) -> dict:
    if driver not in {'web', 'desktop'} or not isinstance(target, dict) or len(json.dumps(target)) > 4096:
        raise ValueError('invalid screenshot source')
    if any(type(value) is not int or not 1 <= value <= 16384 for value in (width, height)):
        raise ValueError('invalid screenshot dimensions')
    if type(captured_at) is not int or not 1 <= captured_at <= 2**53 - 1:
        raise ValueError('invalid screenshot timestamp')
    return store_jpeg(jpeg, report_dir, run_id, {'driver': driver, 'target': target,
        'width': width, 'height': height, 'captured_at': captured_at})
