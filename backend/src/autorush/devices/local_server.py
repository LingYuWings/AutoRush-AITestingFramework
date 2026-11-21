"""On-demand LAN TLS listener exposing only the device protocol, sharing its hub."""
from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import os
import socket
import tempfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import uvicorn

from .lan_discovery import try_advertise_device_server


# List the host's private IPv4 addresses for LAN pairing.
def local_addresses() -> list[str]:
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)}
    except OSError:
        return []
    ranges = [ipaddress.ip_network(value) for value in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')]
    return sorted(value for value in addresses if any(ipaddress.ip_address(value) in subnet for subnet in ranges))


# Atomically save TLS material; a concurrent first start can reuse the winning key.
def _save_tls_file(path: Path, contents: bytes, *, keep_existing: bool = False) -> None:
    descriptor, name = tempfile.mkstemp(dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(contents)
        if keep_existing:
            try:
                os.link(temporary, path)
            except FileExistsError:
                pass
        else:
            temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


# Reuse the installation key across addresses while keeping an IP-specific TLS certificate.
def certificate(directory: Path, host: str) -> tuple[Path, Path, str, str]:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    directory.mkdir(parents=True, exist_ok=True)
    cert_path, key_path = directory / f'{host}.pem', directory / 'server.key'
    if not key_path.exists():
        try:
            initial_key = serialization.load_pem_private_key((directory / f'{host}.key').read_bytes(), password=None)
            if not isinstance(initial_key, rsa.RSAPrivateKey):
                raise ValueError('Unsupported legacy key')
        except (OSError, ValueError, TypeError):
            initial_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        _save_tls_file(key_path, initial_key.private_bytes(serialization.Encoding.PEM,
                       serialization.PrivateFormat.PKCS8, serialization.NoEncryption()), keep_existing=True)
    key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
    public_key = key.public_key()
    address = ipaddress.ip_address(host)
    now = datetime.now(timezone.utc)
    try:
        cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
        names = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        if (not cert.not_valid_before_utc <= now < cert.not_valid_after_utc - timedelta(days=1)
                or cert.public_key() != public_key or address not in names.get_values_for_type(x509.IPAddress)):
            raise ValueError('Certificate needs replacement')
    except (OSError, ValueError, x509.ExtensionNotFound):
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'AutoRush local device server')])
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(public_key)
                .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=5))
                .not_valid_after(now + timedelta(days=365))
                .add_extension(x509.SubjectAlternativeName([x509.IPAddress(address)]), critical=False)
                .sign(key, hashes.SHA256()))
        _save_tls_file(cert_path, cert.public_bytes(serialization.Encoding.PEM))
    identity = hashlib.sha256(public_key.public_bytes(serialization.Encoding.DER,
                              serialization.PublicFormat.SubjectPublicKeyInfo)).hexdigest()
    return cert_path, key_path, cert.fingerprint(hashes.SHA256()).hex(), identity


# Restrict the LAN listener to pairing, health, and device socket endpoints.
class DeviceEndpointsOnly:
    # Store the application that handles allowed requests.
    def __init__(self, app):
        self.app = app

    # Forward permitted requests and reject all other paths.
    async def __call__(self, scope, receive, send):
        allowed = (scope['type'] == 'websocket' and scope['path'] == '/api/v1/devices/ws'
                   or scope['type'] == 'http' and (scope['method'], scope['path']) in {
                       ('POST', '/api/v1/devices/pairings/claim'), ('GET', '/health')})
        if allowed:
            await self.app(scope, receive, send)
        elif scope['type'] == 'websocket':
            await send({'type': 'websocket.close', 'code': 1008})
        else:
            await send({'type': 'http.response.start', 'status': 404, 'headers': []})
            await send({'type': 'http.response.body', 'body': b'Not found'})


# Run the embedded Uvicorn server under the parent application's lifecycle.
class _Server(uvicorn.Server):
    # Leave signal handling with the parent API process.
    @contextmanager
    def capture_signals(self):
        # The parent API process owns signals and lifecycle.
        yield


# Manage the on-demand LAN listener for Portal devices.
class LocalDeviceServer:
    # Initialize the listener settings and lifecycle lock.
    def __init__(self, app, directory: Path, port: int = 8443):
        self.app, self.directory, self.port = app, directory, port
        self.server = None
        self.task = None
        self.advertisement = None
        self.identity = None
        self.info = {}
        self.lock = asyncio.Lock()
        self.preference_path = directory / 'listener-host'
        try:
            with self.preference_path.open(encoding='ascii') as source:
                self.preferred_host = str(ipaddress.IPv4Address(source.read(32).strip()))
        except (OSError, ValueError):
            self.preferred_host = None

    # Report available addresses and the running listener's connection details.
    def status(self) -> dict:
        running = bool(self.info) and self.task is not None and not self.task.done() and self.server.started
        return {'running': bool(running), 'enabled': self.preferred_host is not None,
                'addresses': local_addresses(), 'port': self.port,
                **(self.info if running else {})}

    # Start a TLS listener on a selected private address.
    async def start(self, host: str | None = None, *, restoring: bool = False) -> dict:
        async with self.lock:
            if restoring and self.preferred_host is None:
                return self.status()
            addresses = local_addresses()
            preferred = self.preferred_host
            host = host or next((value for value in (self.info.get('host'), preferred) if value in addresses),
                                addresses[0] if addresses else '')
            if host not in addresses:
                raise ValueError('No local private IPv4 address selected; connect this computer to Wi-Fi')
            if self.status()['running']:
                if self.info['host'] != host:
                    raise ValueError('Stop the running local server before selecting another address')
                return self.status()
            if self.advertisement is not None:
                await self.advertisement.async_close()
                self.advertisement = None
            self.info = {}
            cert, key, fingerprint, identity = await asyncio.to_thread(certificate, self.directory, host)
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                sock.bind((host, self.port))
                sock.listen(128)
                sock.setblocking(False)
                config = uvicorn.Config(DeviceEndpointsOnly(self.app), host=host, port=self.port,
                                        ssl_certfile=str(cert), ssl_keyfile=str(key), lifespan='off',
                                        log_level='warning', access_log=False, ws='websockets', timeout_graceful_shutdown=3)
                self.server = _Server(config)
                self.task = asyncio.create_task(self.server.serve(sockets=[sock]))
                for _ in range(100):
                    if self.task.done():
                        await self.task
                        raise ValueError('Local TLS listener failed to start')
                    if self.server.started:
                        if not ipaddress.ip_address(host).is_loopback:
                            self.advertisement = await try_advertise_device_server(host, self.port, identity, fingerprint)
                        self.identity = identity
                        self.info = {'host': host, 'server_url': f'wss://{host}:{self.port}/api/v1/devices/ws',
                                     'tls_sha256': fingerprint, 'certificate_path': str(cert)}
                        if self.preferred_host != host:
                            _save_tls_file(self.preference_path, host.encode('ascii'))
                            self.preferred_host = host
                        return self.status()
                    await asyncio.sleep(.02)
                raise ValueError('Local TLS listener startup timed out')
            except (OSError, ValueError, asyncio.CancelledError) as exc:
                await self._stop()
                sock.close()
                if isinstance(exc, asyncio.CancelledError):
                    raise
                raise ValueError('Local WSS server could not start; check the selected address and port') from exc

    # Restore an enabled listener on the current interface, including after an address change.
    async def restore(self) -> None:
        async with self.lock:
            if self.preferred_host is None:
                return
            status = self.status()
            if status["running"] and status["host"] in status["addresses"]:
                host = status["host"]
                if self.advertisement is None and self.identity and not ipaddress.ip_address(host).is_loopback:
                    self.advertisement = await try_advertise_device_server(host, self.port, self.identity, status["tls_sha256"])
                return
            if self.task is not None:
                await self._stop()
            if not status["addresses"]:
                return
        await self.start(restoring=True)

    # Stop the listener and optionally persist the user's request to keep it disabled.
    async def stop(self, *, forget: bool = True) -> dict:
        async with self.lock:
            if forget:
                self.preference_path.unlink(missing_ok=True)
                self.preferred_host = None
            await self._stop()
            return self.status()

    # Release the current listener and advertisement while holding the lifecycle lock.
    async def _stop(self) -> None:
        try:
            if self.advertisement is not None:
                await self.advertisement.async_close()
        finally:
            self.advertisement = None
            self.identity = None
            if self.task is not None and not self.task.done():
                self.server.should_exit = True
                await self.task
            self.task = None
            self.server = None
            self.info = {}
