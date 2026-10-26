"""Deterministic Web action contract, independent of a browser process."""
from urllib.parse import urlsplit
from autorush.domain.models import StepSpec


def validate_web_step(step: StepSpec) -> None:
    op, p = step.operation, step.parameters
    fields = {'web.open': {'path'}, 'web.click': {'target'}, 'web.fill': {'target', 'value'},
              'web.inspect': {'target'}, 'web.press': {'target', 'key'}, 'web.select': {'target', 'value'},
              'web.wait': {'target', 'state', 'timeout_ms'}}
    if step.driver != 'web' or op not in fields or set(p) - fields[op]:
        raise ValueError('unsupported Web operation or parameters')
    if op == 'web.open':
        path = p.get('path')
        if not isinstance(path, str) or not path.startswith('/') or path.startswith('//') or len(path) > 4000:
            raise ValueError('web.open requires an absolute path on the configured host')
        parsed = urlsplit(path)
        if parsed.scheme or parsed.netloc or parsed.fragment or '\\' in path or any(ord(c) < 32 for c in path):
            raise ValueError('web.open path cannot change host or contain a fragment')
        return
    target = p.get('target')
    if not isinstance(target, dict): raise ValueError('Web action requires a target object')
    keys = set(target) & {'role', 'label', 'test_id', 'css'}
    if len(keys) != 1 or set(target) - keys - {'name'}:
        raise ValueError('target must specify exactly one locator')
    if any(not isinstance(v, str) or not v or len(v) > 1000 for v in target.values()):
        raise ValueError('target locator must be a non-empty string')
    if 'name' in target and 'role' not in target: raise ValueError('name requires role')
    if op in {'web.fill', 'web.select'} and (not isinstance(p.get('value'), str) or len(p['value']) > 10000):
        raise ValueError('Web input requires a bounded string value')
    if op == 'web.press' and (not isinstance(p.get('key'),str) or p['key'] not in {'Enter', 'Tab', 'Escape', 'Control+A'}):
        raise ValueError('unsupported Web key')
    if op == 'web.wait' and (not isinstance(p.get('state','visible'),str) or p.get('state', 'visible') not in {'visible', 'hidden'} or
            type(p.get('timeout_ms', 10000)) is not int or not 100 <= p.get('timeout_ms', 10000) <= 15000):
        raise ValueError('invalid Web wait state or timeout')
