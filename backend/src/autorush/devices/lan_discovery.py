"""Advertise a running LAN device listener through DNS-SD."""

import logging
import socket

_SERVICE_TYPE = '_autorush._tcp.local.'
_log = logging.getLogger(__name__)


# Publish only the device endpoint and public TLS fingerprints on its LAN interface.
async def advertise_device_server(host: str, port: int, identity: str, fingerprint: str):
    from zeroconf import IPVersion, ServiceInfo
    from zeroconf.asyncio import AsyncZeroconf

    instance = f'AutoRush-{identity[:24]}'
    info = ServiceInfo(_SERVICE_TYPE, f'{instance}.{_SERVICE_TYPE}',
                       addresses=[socket.inet_aton(host)], port=port, server=f'{instance.lower()}.local.',
                       properties={'key': identity, 'cert': fingerprint})
    mdns = AsyncZeroconf(interfaces=[host], ip_version=IPVersion.V4Only)
    try:
        announcement = await mdns.async_register_service(info)
        await announcement
    except BaseException:
        await mdns.async_close()
        raise
    return mdns


# Keep QR pairing available when multicast or its dependency is unavailable.
async def try_advertise_device_server(host: str, port: int, identity: str, fingerprint: str):
    try:
        return await advertise_device_server(host, port, identity, fingerprint)
    except Exception as exc:
        _log.warning('Could not advertise the Portal LAN listener: %s', exc)
        return None
