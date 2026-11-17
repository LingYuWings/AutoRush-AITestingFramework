package com.autorush.portal

import java.net.URI

/** Matches DNS-SD candidates to trust established by a LAN QR pairing. */
internal class LanPairing private constructor(private val certificate: String, private val publicKey: String?) {
    // Turn a matching advertisement into a private IPv4 device endpoint.
    fun endpoint(address: String?, port: Int, advertisedCertificate: String?, advertisedKey: String?): String? {
        if (publicKey?.let { it != advertisedKey } ?: (certificate != advertisedCertificate)) return null
        if (address == null || !isPrivateIpv4(address) || port !in 1..65535) return null
        return "wss://$address:$port/api/v1/devices/ws"
    }

    companion object {
        // Limit multicast discovery to private addresses paired with a certificate pin.
        fun from(url: String, certificate: String?, publicKey: String? = null): LanPairing? {
            val uri = runCatching { URI(url) }.getOrNull() ?: return null
            val host = uri.host ?: return null
            if (uri.scheme != "wss" || certificate == null || !isPrivateIpv4(host)) return null
            return LanPairing(certificate, publicKey)
        }

        // Match the same private IPv4 ranges exposed by the backend listener.
        private fun isPrivateIpv4(address: String): Boolean {
            val parts = address.split('.', limit = 5)
            if (parts.size != 4) return false
            val octets = parts.map {
                val value = it.toIntOrNull() ?: return false
                if (value !in 0..255 || value.toString() != it) return false
                value
            }
            return octets[0] == 10 || (octets[0] == 172 && octets[1] in 16..31) ||
                (octets[0] == 192 && octets[1] == 168)
        }
    }
}
