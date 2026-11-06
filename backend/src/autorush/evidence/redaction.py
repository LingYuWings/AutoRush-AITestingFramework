"""Redact application content without rewriting trusted execution protocol fields."""
from copy import deepcopy
import re
from autorush.api_testing.variables import redact, redact_execution

OUTCOMES = {'passed', 'failed', 'error', 'blocked', 'skipped'}
TEXT_CONTROLS = {'status': OUTCOMES, 'state': {'running', 'stopping', 'finished', 'interrupted'},
    'driver': {'api', 'web', 'android', 'desktop'}, 'lifecycle': {'pending', 'done', 'failed'},
    'kind': {'action', 'verify', 'stop', 'wait'}}
NUMBER_CONTROLS = {'order', 'round', 'rounds_used', 'status_code', 'elapsed_ms', 'captured_at'}
BOOL_CONTROLS = {'passed', 'startup', 'history_truncated'}
# These contain application data, not the execution protocol. Never restore their contents.
OPAQUE = {'parameters', 'body', 'json', 'last_output', 'target', 'elements', 'expected', 'extracted'}


# Mask application secrets while keeping validated execution metadata usable by the console.
def redact_execution_payload(data, secrets, debug_run_id=None):
    sanitized = redact(data, secrets)

    # Restore typed control fields and rewrite screenshot URLs for debug runs.
    def restore(original, public):
        if isinstance(original, list) and isinstance(public, list):
            for source, destination in zip(original, public): restore(source, destination)
        elif isinstance(original, dict) and isinstance(public, dict):
            for key, value in original.items():
                if key == 'screenshot' and isinstance(value, dict) and value.get('mime_type') == 'image/jpeg' and re.fullmatch(r'[a-f0-9-]{36}/[a-f0-9]{32}\.jpg', str(value.get('file', ''))):
                    # Paths, dimensions and hashes come from the bounded evidence store, not application payloads.
                    public[key] = deepcopy(value)
                    if 'target' in value: public[key]['target'] = redact(value['target'], secrets)
                    if debug_run_id is not None:
                        public[key]['url'] = f"/api/v1/case-debug-runs/{debug_run_id}/evidence/{value['file'].split('/')[-1]}"
                elif key == 'api' and isinstance(value, dict):
                    public[key] = redact_execution(value, secrets)
                elif key in TEXT_CONTROLS and isinstance(value, str) and value in TEXT_CONTROLS[key]:
                    public[key] = value
                elif key in NUMBER_CONTROLS and type(value) in {int, float}:
                    public[key] = value
                elif key in BOOL_CONTROLS and type(value) is bool:
                    public[key] = value
                elif key not in OPAQUE:
                    restore(value, public.get(key))
    restore(data, sanitized)
    return sanitized
