"""Validate and persist non-secret startup overrides shared by the console and launchers."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
from tempfile import NamedTemporaryFile
from urllib.parse import urlsplit


FIELDS = {
    'AUTORUSH_DB_PATH': 'path', 'AUTORUSH_REPORT_DIR': 'path', 'AUTORUSH_LOG_DIR': 'path',
    'AUTORUSH_ALLOWED_API_HOSTS': 'hosts', 'AUTORUSH_ALLOWED_WEB_HOSTS': 'hosts', 'AUTORUSH_ALLOWED_LLM_HOSTS': 'hosts',
    'AUTORUSH_BACKEND_PORT': 'port', 'AUTORUSH_FRONTEND_PORT': 'port', 'AUTORUSH_LOCAL_DEVICE_PORT': 'port',
    'AUTORUSH_DESKTOP_ENABLED': 'switch', 'AUTORUSH_LOCAL_VISION_LAUNCHER': 'path',
    'PLAYWRIGHT_BROWSERS_PATH': 'path', 'AUTORUSH_VITE_CACHE_DIR': 'path',
    'AUTORUSH_MCP_API_URL': 'loopback', 'AUTORUSH_MCP_CONSOLE_ORIGIN': 'loopback', 'AUTORUSH_MCP_ALLOWED_PACKAGES': 'packages',
}


def config_path() -> Path:
    """Locate the settings file independently of the selected database and log directories."""
    return Path(os.getenv('AUTORUSH_CONFIG_PATH', Path.cwd() / 'autorush.settings.json')).resolve()


def normalize(key: str, value: str) -> str:
    """Validate one supported setting and normalize list and port values."""
    if key not in FIELDS or not isinstance(value, str) or len(value) > 4096 or any(ord(ch) < 32 for ch in value):
        raise ValueError('Invalid setting value')
    value = value.strip()
    kind = FIELDS[key]
    if kind == 'port':
        if not re.fullmatch(r'[0-9]{1,5}', value) or not 1024 <= int(value) <= 65535:
            raise ValueError('Port must be between 1024 and 65535')
        return str(int(value))
    if kind == 'switch' and value not in {'0', '1'}:
        raise ValueError('Expected 0 or 1')
    if kind == 'path' and not Path(value).is_absolute() and (value or key not in {'AUTORUSH_LOCAL_VISION_LAUNCHER', 'AUTORUSH_VITE_CACHE_DIR'}):
        raise ValueError('Use an absolute path on the backend machine')
    if kind == 'loopback':
        url = urlsplit(value)
        if (url.scheme != 'http' or url.hostname not in {'localhost', '127.0.0.1', '::1'} or
                url.username is not None or url.path not in {'', '/'} or url.query or url.fragment or not url.port):
            raise ValueError('Use a loopback HTTP origin with an explicit port')
        return value.rstrip('/')
    if kind in {'hosts', 'packages'}:
        items = (item.strip() for item in value.split(','))
        pattern = r'[\w.\-:]+' if kind == 'hosts' else r'(?:[A-Za-z_][A-Za-z0-9_]*\.)+[A-Za-z_][A-Za-z0-9_]*'
        result = []
        for item in items:
            if not item:
                continue
            if not re.fullmatch(pattern, item) or (kind == 'hosts' and ':' in item and not valid_ipv6(item)):
                raise ValueError('Enter hostnames or IP addresses without ports or schemes' if kind == 'hosts' else 'Enter Android package names')
            result.append(item.lower() if kind == 'hosts' else item)
        if kind == 'packages' and not result:
            raise ValueError('Enter at least one authorized Android package name')
        return ','.join(dict.fromkeys(result))
    return value


def valid_ipv6(value: str) -> bool:
    """Accept unbracketed IPv6 allowlist entries without interpreting host:port as a host."""
    from ipaddress import IPv6Address

    try:
        IPv6Address(value)
        return True
    except ValueError:
        return False


def read_overrides(path: Path) -> dict[str, str]:
    """Load the configured values, or use defaults when the file has not been created."""
    try:
        with path.open(encoding='utf-8') as source:
            raw = source.read(131073)
    except FileNotFoundError:
        return {}
    if len(raw) > 131072:
        raise ValueError('Runtime settings file exceeds the size limit')
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError('Runtime settings must be a JSON object')
    return {key: normalize(key, value) for key, value in data.items()}


def write_overrides(path: Path, values: dict[str, str]) -> None:
    """Replace the settings file atomically after writing the complete validated document."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as target:
        temporary = Path(target.name)
        try:
            json.dump(values, target, ensure_ascii=False, indent=2)
        except BaseException:
            target.close()
            temporary.unlink(missing_ok=True)
            raise
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    """Print persisted overrides for development launchers without exporting secrets."""
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument('--lines', action='store_true')
    args = parser.parse_args()
    values = read_overrides(config_path())
    if args.lines:
        for key, value in values.items():
            print(f'{key}={value}')
    else:
        print(json.dumps(values))


if __name__ == '__main__':
    main()
