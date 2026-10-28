"""Typed variable substitution, JSON field lookup and evidence redaction."""
from __future__ import annotations
import json
import os
import re
from copy import deepcopy
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

PLACEHOLDER = re.compile(r'\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}')
SENSITIVE = re.compile(r'authorization|cookie|password|passwd|secret|token|api[-_]?key|credential', re.I)


class ApiBlocked(ValueError):
    pass


def variable_values(items):
    values, secrets = {}, set()
    for item in items:
        if not item.get('enabled', True):
            continue
        value = item.get('value', '')
        if isinstance(value, str) and value.startswith('env:'):
            name = value[4:]
            if not re.fullmatch(r'[A-Z_][A-Z0-9_]*', name) or name not in os.environ:
                raise ApiBlocked('environment secret is unavailable: ' + item['key'])
            value = os.environ[name]
            secrets.add(str(value))
        if item.get('secret') or SENSITIVE.search(item['key']):
            if value is not None:
                secrets.add(str(value))
        values[item['key']] = value
    return values, secrets


def substitute(value, variables, depth=0):
    if depth > 15:
        raise ApiBlocked('cyclic or excessively nested variables')
    if isinstance(value, list):
        return [substitute(item, variables, depth) for item in value]
    if isinstance(value, dict):
        return {key: substitute(item, variables, depth) for key, item in value.items()}
    if not isinstance(value, str):
        return value
    def lookup(match):
        key = match.group(1)
        if key not in variables:
            raise ApiBlocked('unresolved variable: ' + key)
        return substitute(deepcopy(variables[key]), variables, depth + 1)
    match = PLACEHOLDER.fullmatch(value)
    if match:
        return lookup(match)
    def replacement(match):
        resolved = lookup(match)
        return json.dumps(resolved, ensure_ascii=False) if isinstance(resolved, (dict, list, bool)) or resolved is None else str(resolved)
    return PLACEHOLDER.sub(replacement, value)


def json_field(value, path):
    if path in {'$', ''}:
        return value
    path = path.removeprefix('$.')
    if not re.fullmatch(r'[A-Za-z0-9_-]+(?:\[\d+\]|\.[A-Za-z0-9_-]+)*', path):
        raise KeyError('unsupported JSON path')
    for key in re.findall(r'[^.\[\]]+', path):
        if isinstance(value, list) and key.isdigit():
            value = value[int(key)]
        elif isinstance(value, dict):
            value = value[key]
        else:
            raise KeyError(path)
    return value


def secret_strings(value):
    """Collect named credentials so echoes outside named fields stay redacted."""
    found = set()
    def leaves(item):
        if isinstance(item, dict):
            for child in item.values(): leaves(child)
        elif isinstance(item, (list, tuple)):
            for child in item: leaves(child)
        elif item is not None and str(item): found.add(str(item))
    def visit(item):
        if isinstance(item, dict):
            for key, child in item.items():
                if SENSITIVE.search(str(key)): leaves(child)
                else: visit(child)
        elif isinstance(item, (list, tuple)):
            for child in item: visit(child)
    visit(value)
    for item in tuple(found):
        if item.lower().startswith(('bearer ', 'basic ')): found.add(item.split(' ', 1)[1])
    return found


def redact(value, secrets=()):
    if isinstance(value, dict):
        return {key: '[redacted]' if SENSITIVE.search(str(key)) else redact(item, secrets) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item, secrets) for item in value]
    if isinstance(value, tuple):
        return tuple(redact(item, secrets) for item in value)
    if isinstance(value, str):
        if value.lstrip().startswith(('{', '[')):
            try:
                return json.dumps(redact(json.loads(value), secrets), ensure_ascii=False)
            except (ValueError, RecursionError):
                pass
        if value.startswith(('http://', 'https://', '{{')):
            try:
                parts = urlsplit(value)
                host = parts.netloc
                if '@' in host: host = '[redacted]@' + host.rsplit('@', 1)[1]
                query = [(key, '[redacted]' if SENSITIVE.search(key) and not PLACEHOLDER.fullmatch(item) else item)
                    for key, item in parse_qsl(parts.query, keep_blank_values=True)]
                value = urlunsplit((parts.scheme, host, parts.path, urlencode(query, safe='{}'), parts.fragment))
            except ValueError:
                pass
        for secret in sorted((str(item) for item in secrets if item), key=len, reverse=True):
            value = value.replace(secret, '[redacted]')
    return value
