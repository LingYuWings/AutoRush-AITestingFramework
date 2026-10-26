"""Single-use pairing grants and device credentials; SQLite stores only secret hashes."""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def secret_hash(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


class PairingCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    connection: Literal["usb", "wss", "lan"]
    adb_serial: str | None = Field(default=None, max_length=128)
    server_url: str | None = Field(default=None, max_length=512)
    allowed_packages: list[str] = Field(min_length=1, max_length=10)
    expires_in: int = Field(default=180, ge=30, le=300, strict=True)

    @field_validator("allowed_packages")
    @classmethod
    def validate_packages(cls, packages: list[str]) -> list[str]:
        for package in packages:
            if len(package) > 200 or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+", package):
                raise ValueError("invalid Android package")
            if package == "com.autorush.portal":
                raise ValueError("Portal cannot be a test target")
        return list(dict.fromkeys(packages))


class PairingClaim(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pairing_code: str = Field(min_length=1, max_length=256)
    device_id: UUID
    manufacturer: str = Field(max_length=80)
    model: str = Field(max_length=128)
    sdk_int: int = Field(ge=1, le=100, strict=True)


def validate_wss_url(value: str | None) -> str:
    if not value or any(character.isspace() or ord(character) < 32 for character in value):
        raise ValueError("a WSS server URL is required")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("invalid WSS server URL") from exc
    if (parsed.scheme != "wss" or not parsed.hostname or parsed.username is not None
        or parsed.password is not None or parsed.query or parsed.fragment
        or "?" in value or "#" in value or parsed.path != "/api/v1/devices/ws"
        or (port is not None and not 1 <= port <= 65535)):
        raise ValueError("use a WSS URL ending in /api/v1/devices/ws without credentials, query or fragment")
    return value


class PairingStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS device_pairings (
                    id TEXT PRIMARY KEY,
                    code_hash TEXT NOT NULL UNIQUE,
                    expires_at TEXT NOT NULL,
                    server_url TEXT NOT NULL,
                    allowed_packages TEXT NOT NULL,
                    status TEXT NOT NULL,
                    device_id TEXT
                );
                CREATE TABLE IF NOT EXISTS paired_devices (
                    device_id TEXT PRIMARY KEY,
                    token_hash TEXT NOT NULL UNIQUE,
                    manufacturer TEXT NOT NULL,
                    model TEXT NOT NULL,
                    sdk_int INTEGER NOT NULL,
                    paired_at TEXT NOT NULL,
                    revoked INTEGER NOT NULL DEFAULT 0
                );
            """)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        return connection

    @staticmethod
    def _record(row: sqlite3.Row) -> dict:
        status = row["status"]
        if status == "pending" and datetime.fromisoformat(row["expires_at"]) <= utc_now():
            status = "expired"
        return {"id": row["id"], "expires_at": row["expires_at"], "server_url": row["server_url"],
                "allowed_packages": json.loads(row["allowed_packages"]), "status": status, "device_id": row["device_id"]}

    def create(self, server_url: str, packages: list[str], lifetime: int, tls_sha256: str | None = None) -> dict:
        pairing_id, code = str(uuid4()), secrets.token_urlsafe(32)
        expires_at = (utc_now() + timedelta(seconds=lifetime)).isoformat()
        qr = {"type": "autorush.pairing", "version": 2 if tls_sha256 else 1, "server_url": server_url,
              "pairing_code": code, "expires_at": expires_at, "allowed_packages": packages}
        if tls_sha256:
            qr['tls_sha256'] = tls_sha256
        payload = json.dumps(qr, ensure_ascii=False, separators=(",", ":"))
        if len(payload.encode("utf-8")) > 1800:
            raise ValueError("pairing payload exceeds QR capacity")
        with self._connect() as connection:
            connection.execute("INSERT INTO device_pairings VALUES (?, ?, ?, ?, ?, 'pending', NULL)",
                               (pairing_id, secret_hash(code), expires_at, server_url, json.dumps(packages)))
        return {"id": pairing_id, "expires_at": expires_at, "server_url": server_url, "allowed_packages": packages,
                "status": "pending", "device_id": None, "qr_payload": payload}

    def get(self, pairing_id: UUID) -> dict | None:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM device_pairings WHERE id = ?", (str(pairing_id),)).fetchone()
        return self._record(row) if row else None

    def cancel(self, pairing_id: UUID) -> dict | None:
        with self._connect() as connection:
            connection.execute("UPDATE device_pairings SET status = 'cancelled' WHERE id = ? AND status = 'pending' AND expires_at > ?",
                               (str(pairing_id), utc_now().isoformat()))
        return self.get(pairing_id)

    def claim(self, payload: PairingClaim) -> dict | None:
        device_id = str(payload.device_id)
        token = secrets.token_urlsafe(32)
        with self._connect() as connection:
            # Take the write lock before inspecting status. Claim, cancellation, and
            # the credential replacement therefore share one serialization point.
            connection.execute("BEGIN IMMEDIATE")
            now = utc_now().isoformat()
            row = connection.execute("SELECT * FROM device_pairings WHERE code_hash = ?", (secret_hash(payload.pairing_code),)).fetchone()
            if row is None or row["status"] != "pending" or row["expires_at"] <= now:
                return None
            connection.execute("UPDATE device_pairings SET status = 'claimed', device_id = ? WHERE id = ?", (device_id, row["id"]))
            connection.execute("""INSERT INTO paired_devices VALUES (?, ?, ?, ?, ?, ?, 0)
                ON CONFLICT(device_id) DO UPDATE SET token_hash=excluded.token_hash, manufacturer=excluded.manufacturer,
                model=excluded.model, sdk_int=excluded.sdk_int, paired_at=excluded.paired_at, revoked=0""",
                (device_id, secret_hash(token), payload.manufacturer, payload.model, payload.sdk_int, now))
        return {"device_id": device_id, "server_url": row["server_url"], "device_token": token,
                "allowed_packages": json.loads(row["allowed_packages"])}

    def authenticate(self, token: str) -> UUID | None:
        with self._connect() as connection:
            row = connection.execute("SELECT device_id FROM paired_devices WHERE token_hash = ? AND revoked = 0",
                                     (secret_hash(token),)).fetchone()
        return UUID(row["device_id"]) if row else None

    def has_device(self, device_id: UUID) -> bool:
        with self._connect() as connection:
            return connection.execute("SELECT 1 FROM paired_devices WHERE device_id = ?", (str(device_id),)).fetchone() is not None

    def is_active_device(self, device_id: UUID) -> bool:
        with self._connect() as connection:
            return connection.execute('SELECT 1 FROM paired_devices WHERE device_id = ? AND revoked = 0', (str(device_id),)).fetchone() is not None

    def list_devices(self) -> list[dict]:
        with self._connect() as connection:
            rows = connection.execute("SELECT device_id, manufacturer, model, sdk_int, paired_at, revoked FROM paired_devices ORDER BY paired_at DESC").fetchall()
        return [{**dict(row), "revoked": bool(row["revoked"])} for row in rows]

    def revoke(self, device_id: UUID) -> bool:
        with self._connect() as connection:
            result = connection.execute("UPDATE paired_devices SET revoked = 1 WHERE device_id = ?", (str(device_id),))
        return result.rowcount > 0
