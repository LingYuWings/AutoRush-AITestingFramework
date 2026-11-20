"""Bounded, argument-only adb operations used by local USB pairing."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from uuid import UUID


# Report an ADB discovery or command failure.
class AdbError(ValueError):
    pass


# Resolve an ADB executable, platform-tools folder, or Android SDK folder.
def adb_in(folder: Path) -> str | None:
    name = "adb.exe" if os.name == "nt" else "adb"
    candidates = (folder,) if folder.is_file() and folder.name.lower() == name else (
        folder / name, folder / "platform-tools" / name,
    )
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate.resolve())
    return None


# Prefer an explicit path, then known local installations and finally PATH.
def adb_executable() -> str:
    configured = os.getenv("AUTORUSH_ADB_PATH", "").strip()
    if configured:
        path = Path(configured).expanduser()
        if path.is_absolute() and (found := adb_in(path)):
            return found
        raise AdbError("AUTORUSH_ADB_PATH must point to adb, platform-tools, or a valid Android SDK directory")

    root = Path(__file__).resolve().parents[4]
    install = Path(sys.executable).parent if getattr(sys, "frozen", False) else root
    locations = [root / "artifacts/tools/android-sdk", root / "artifacts/tools", install / "platform-tools", install / "adb", install]
    if getattr(sys, "frozen", False):
        locations.extend((install.parent / "platform-tools", install.parent.parent / "platform-tools",
                          install.parent.parent / "adb"))
    locations.extend(Path(value) for name in ("ANDROID_HOME", "ANDROID_SDK_ROOT") if (value := os.getenv(name)))
    if local_app_data := os.getenv("LOCALAPPDATA"):
        locations.append(Path(local_app_data) / "Android/Sdk")
    locations.extend((Path.home() / "Library/Android/sdk", Path.home() / "Android/Sdk"))
    for location in locations:
        if found := adb_in(location):
            return found
    executable = shutil.which("adb")
    if executable is None:
        raise AdbError("adb is unavailable; set the ADB path in System Settings or install Android platform tools")
    return executable


# Run a bounded ADB command and report command failures.
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


# Parse connected devices and their states from the ADB listing.
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


# Forward the selected authorized device's local port back to this host.
def reverse(serial: str | None, port: int) -> None:
    if serial is None or not any(device["serial"] == serial and device["state"] == "device" for device in list_devices()):
        raise AdbError("select an authorized USB device")
    _run(["-s", serial, "reverse", f"tcp:{port}", f"tcp:{port}"])


# Restore the paired phone's tunnel if it is missing or still targets a previous backend port.
def restore_reverse(serial: str, remote_port: int, backend_port: int) -> None:
    remote, local = f"tcp:{remote_port}", f"tcp:{backend_port}"
    mappings = _run(["-s", serial, "reverse", "--list"]).splitlines()
    if any(line.split()[-2:] == [remote, local] for line in mappings):
        return
    _run(["-s", serial, "reverse", remote, local])


# Read Portal's device UUID through its shell-only identity provider.
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
