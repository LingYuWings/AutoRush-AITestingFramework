"""Maintain explicitly enabled LAN listeners and identity-checked USB tunnels."""

import asyncio
import logging
import sqlite3
from collections.abc import Awaitable, Callable, Collection

from . import adb
from .pairing import PairingStore

_log = logging.getLogger(__name__)


def restore_usb(store: PairingStore, online: Collection[str], backend_port: int) -> None:
    """Reconcile offline paired phones that are still authorized by ADB."""
    bindings = [binding for binding in store.usb_bindings() if str(binding[0]) not in online]
    if not bindings:
        return
    authorized = {item["serial"] for item in adb.list_devices() if item["state"] == "device"}
    by_device = {device_id: (serial, port) for device_id, serial, port in bindings}
    candidates = authorized if any(serial is None for _, serial, _ in bindings) else (
        authorized.intersection(serial for _, serial, _ in bindings)
    )
    for serial in candidates:
        try:
            device_id = adb.portal_device_id(serial)
            binding = by_device.get(device_id)
            if binding is None:
                continue
            expected_serial, remote_port = binding
            if expected_serial in (None, serial) and (device_id, expected_serial, remote_port) in store.usb_bindings():
                adb.restore_reverse(serial, remote_port, backend_port)
        except adb.AdbError as exc:
            _log.debug("Could not restore Portal USB tunnel: %s", exc)


async def retry_connections(restore: Callable[[], Awaitable[None]], label: str, *, initial_delay: int = 0) -> None:
    """Retry transient transport failures with a bounded delay until shutdown."""
    if initial_delay:
        await asyncio.sleep(initial_delay)
    delay = 5
    while True:
        try:
            await restore()
        except (OSError, ValueError, sqlite3.OperationalError) as exc:
            if delay == 5:
                _log.warning("Could not restore Portal %s: %s", label, exc)
            delay = min(30, delay * 2)
        else:
            delay = 5
        await asyncio.sleep(delay)
