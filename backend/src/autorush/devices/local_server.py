"""On-demand LAN TLS listener exposing only the device protocol, sharing its hub."""
from __future__ import annotations

import asyncio
import ipaddress
import socket
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import uvicorn
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


def local_addresses() -> list[str]:
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)}
    except OSError:
        return []
    ranges = [ipaddress.ip_network(value) for value in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')]
    return sorted(value for value in addresses if any(ipaddress.ip_address(value) in subnet for subnet in ranges))


def certificate(directory: Path, host: str) -> tuple[Path, Path, str]:
    directory.mkdir(parents=True, exist_ok=True)
    cert_path, key_path = directory / f'{host}.pem', directory / f'{host}.key'
    now = datetime.now(timezone.utc)
    try:
        cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
        key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
        assert cert.not_valid_after_utc > now + timedelta(days=1)
        assert cert.public_key().public_numbers() == key.public_key().public_numbers()
        assert ipaddress.ip_address(host) in cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.IPAddress)
    except (OSError, ValueError, TypeError, AssertionError, x509.ExtensionNotFound):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'AutoRush local device server')])
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
                .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=5))
                .not_valid_after(now + timedelta(days=365))
                .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address(host))]), critical=False)
                .sign(key, hashes.SHA256()))
        key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        key_path.chmod(0o600)
        cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return cert_path, key_path, cert.fingerprint(hashes.SHA256()).hex()


class DeviceEndpointsOnly:
    def __init__(self, app):
        self.app = app

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


class _Server(uvicorn.Server):
    @contextmanager
    def capture_signals(self):
        # The parent API process owns signals and lifecycle.
        yield


class LocalDeviceServer:
    def __init__(self, app, directory: Path, port: int = 8443):
        self.app, self.directory, self.port = app, directory, port
        self.server = None
        self.task = None
        self.info = {}
        self.lock = asyncio.Lock()

    def status(self) -> dict:
        running = self.task is not None and not self.task.done() and self.server.started
        return {'running': bool(running), 'addresses': local_addresses(), 'port': self.port,
                **(self.info if running else {})}

    async def start(self, host: str | None = None) -> dict:
        async with self.lock:
            addresses = local_addresses()
            host = host or (addresses[0] if addresses else '')
            if host not in addresses:
                raise ValueError('No local private IPv4 address selected; connect this computer to Wi-Fi')
            if self.status()['running']:
                if self.info['host'] != host:
                    raise ValueError('Stop the running local server before selecting another address')
                return self.status()
            cert, key, fingerprint = await asyncio.to_thread(certificate, self.directory, host)
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
                        self.info = {'host': host, 'server_url': f'wss://{host}:{self.port}/api/v1/devices/ws',
                                     'tls_sha256': fingerprint, 'certificate_path': str(cert)}
                        return self.status()
                    await asyncio.sleep(.02)
                raise ValueError('Local TLS listener startup timed out')
            except (OSError, ValueError) as exc:
                if self.task and not self.task.done():
                    self.server.should_exit = True
                    await self.task
                sock.close()
                raise ValueError('Local WSS server could not start; check the selected address and port') from exc

    async def stop(self) -> dict:
        async with self.lock:
            if self.task is not None and not self.task.done():
                self.server.should_exit = True
                await self.task
            self.task = None
            self.server = None
            self.info = {}
            return self.status()
