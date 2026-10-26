"""Bounded, argument-only adb operations used by local USB pairing."""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path
from uuid import UUID


class AdbError(ValueError):
    pass


def adb_executable() -> str:
    root = Path(__file__).resolve().parents[4]
    bundled = root / "artifacts" / "tools" / "android-sdk" / "platform-tools" / "adb.exe"
    if bundled.is_file():
        return str(bundled)
    executable = shutil.which("adb")
    if executable is None:
        raise AdbError("adb is unavailable; install Android platform tools")
    return executable


def _run(arguments: list[str]) -> str:
    try:
        result = subprocess.run([adb_executable(), *arguments], capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=10, shell=False,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired as exc:
        raise AdbError("adb operation timed out") from exc
    except OSError as exc:
        raise AdbError("adb could not be started") from exc
    if result.returncode:
        raise AdbError("adb operation failed; check the USB connection and device authorization")
    return result.stdout


def list_devices() -> list[dict[str, str]]:
    devices = []
    for line in _run(["devices", "-l"]).splitlines():
        fields = line.split()
        if len(fields) < 2 or fields[0] == "List" or line.startswith("*"):
            continue
        serial, state = fields[:2]
        if not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", serial):
            continue
        model = next((value[6:].replace("_", " ") for value in fields[2:] if value.startswith("model:")), "")
        devices.append({"serial": serial, "model": model, "state": state})
    return devices


def reverse(serial: str | None, port: int) -> None:
    if serial is None or not any(device["serial"] == serial and device["state"] == "device" for device in list_devices()):
        raise AdbError("select an authorized USB device")
    _run(["-s", serial, "reverse", f"tcp:{port}", f"tcp:{port}"])


def portal_device_id(serial: str) -> UUID:
    """Read only Portal's shell-only identity provider; never read preferences."""
    if not re.fullmatch(r'[A-Za-z0-9._:-]{1,128}', serial):
        raise AdbError('invalid ADB serial')
    output = _run(['-s', serial, 'exec-out', 'content', 'call', '--uri',
                   'content://com.autorush.portal.identity', '--method', 'identify']).strip()
    match = re.fullmatch(r'Result: Bundle\[\{device_id=([0-9a-fA-F-]{36})\}\]', output)
    if match:
        try:
            return UUID(match[1])
        except ValueError:
            pass
    raise AdbError('无法核对配对手机身份，请安装 Portal 0.5.1 或更高版本')
