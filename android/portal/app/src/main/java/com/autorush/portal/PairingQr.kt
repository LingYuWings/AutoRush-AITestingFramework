package com.autorush.portal

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.net.URI
import java.time.OffsetDateTime

/** Untrusted scanner data. Never include the one-time code in UI or diagnostic text. */
class PairingQr private constructor(
    val serverUrl: String,
    val pairingCode: String,
    val expiresAt: String,
    val allowedPackages: List<String>,
    val tlsSha256: String?,
) {
    fun claimUrl(): String {
        val server = URI(serverUrl)
        return URI(if (server.scheme == "wss") "https" else "http", null, server.host,
            server.port, "/api/v1/devices/pairings/claim", null, null).toString()
    }

    override fun toString() = "AutoRush pairing for $serverUrl"

    companion object {
        private val fields = setOf("type", "version", "server_url", "pairing_code", "expires_at", "allowed_packages")
        private val packagePattern = Regex("(?:[A-Za-z_][A-Za-z0-9_]*\\.)+[A-Za-z_][A-Za-z0-9_]*")

        fun parse(raw: String): PairingQr {
            try {
                require(raw.toByteArray(Charsets.UTF_8).size <= 1800)
                val input = JSONTokener(raw)
                val json = input.nextValue() as? JSONObject ?: throw IllegalArgumentException()
                require(input.nextClean() == '\u0000')
                val version = json.get("version")
                require(version is Int && version in 1..2)
                require(json.keys().asSequence().toSet() == if (version == 2) fields + "tls_sha256" else fields)
                require(json.get("type") == "autorush.pairing")
                val server = json.get("server_url") as? String ?: throw IllegalArgumentException()
                require(server.length <= 512 && server == server.trim())
                val validServer = PortalConfig.validateServerUrl(server)
                val pin = if (version == 2) json.get("tls_sha256") as? String ?: throw IllegalArgumentException() else null
                require(pin == null || (server.startsWith("wss://") && Regex("[a-f0-9]{64}").matches(pin)))
                val code = json.get("pairing_code") as? String ?: throw IllegalArgumentException()
                require(code.length in 32..256 && !code.any { it.isWhitespace() || it.isISOControl() })
                val expiry = json.get("expires_at") as? String ?: throw IllegalArgumentException()
                require(expiry.length in 20..64)
                OffsetDateTime.parse(expiry) // The server decides expiry; a phone clock may be wrong.
                val packages = parsePackages(json.get("allowed_packages"))
                return PairingQr(validServer, code, expiry, packages, pin)
            } catch (_: Exception) {
                throw IllegalArgumentException("无效的 AutoRush 配对二维码，请重新生成后扫描")
            }
        }

        internal fun parsePackages(raw: Any): List<String> {
            val array = raw as? JSONArray ?: throw IllegalArgumentException()
            val packages = (0 until array.length()).map { array.get(it) as? String ?: throw IllegalArgumentException() }
            validatePackages(packages)
            return packages
        }

        internal fun validatePackages(packages: List<String>) {
            require(packages.size in 1..10 && packages.distinct().size == packages.size)
            require(packages.all { it.length <= 200 && packagePattern.matches(it) && it != "com.autorush.portal" })
        }
    }
}
