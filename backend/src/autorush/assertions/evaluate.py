"""Small deterministic assertion set for the API vertical slice."""

from __future__ import annotations

from typing import Any

from autorush.domain.models import AssertionSpec


def evaluate_assertion(spec: AssertionSpec, output: dict[str, Any]) -> tuple[bool, str]:
    if spec.kind == "status_code":
        actual = output["status_code"]
    elif spec.kind == "body_contains":
        actual = output["body"]
        passed = str(spec.expected) in str(actual)
        return passed, f"body_contains: expected {spec.expected!r}"
    elif spec.kind == "json_field_equals":
        actual = output["body"]
        for segment in (spec.path or "").removeprefix("$.").split("."):
            if not isinstance(actual, dict) or segment not in actual:
                return False, f"json_field_equals: missing {spec.path}"
            actual = actual[segment]
    elif spec.kind in {"url_equals", "url_contains", "text_contains", "element_visible"}:
        key = "url" if spec.kind.startswith("url_") else "text" if spec.kind == "text_contains" else "visible"
        if key not in output:
            return False, f"{spec.kind}: observation has no {key}"
        actual = output[key]
        if spec.kind in {"url_contains", "text_contains"}:
            passed = str(spec.expected) in str(actual)
            return passed, f"{spec.kind}: expected {spec.expected!r}, got {actual!r}"
    elif spec.kind == "pixel_rgb_equals":
        if "rgb" not in output:
            return False, "pixel_rgb_equals: observation has no rgb"
        actual = output["rgb"]
    elif spec.kind == "package_equals":
        if "package" not in output:
            return False, "package_equals: observation has no package"
        actual = output["package"]
    else:
        raise ValueError(f"unsupported assertion: {spec.kind}")
    passed = actual == spec.expected
    return passed, f"{spec.kind}: expected {spec.expected!r}, got {actual!r}"
