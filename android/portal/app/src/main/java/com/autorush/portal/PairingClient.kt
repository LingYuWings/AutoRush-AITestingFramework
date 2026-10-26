package com.autorush.portal

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.json.JSONTokener
import java.util.concurrent.TimeUnit

class PairingDevice(val id: String, val manufacturer: String, val model: String, val sdkInt: Int)

class ClaimedPairing(val serverUrl: String, val deviceToken: String, val allowedPackages: List<String>, val tlsSha256: String? = null) {
    override fun toString() = "Claimed AutoRush pairing"
}

/** One code exchange, without redirects, automatic retries or secret-bearing diagnostics. */
class PairingClient {
    private val client = OkHttpClient.Builder()
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS)
        .callTimeout(15, TimeUnit.SECONDS).build()
    @Volatile private var activeClient = client

    fun claim(pairing: PairingQr, device: PairingDevice): ClaimedPairing {
        val json = JSONObject().put("pairing_code", pairing.pairingCode)
            .put("device_id", device.id).put("manufacturer", device.manufacturer)
            .put("model", device.model).put("sdk_int", device.sdkInt)
        val request = Request.Builder().url(pairing.claimUrl())
            .header("Accept", "application/json").header("Cache-Control", "no-store")
            .post(json.toString().toRequestBody("application/json; charset=utf-8".toMediaType())).build()
        try {
            activeClient = PinnedTls.configure(client.newBuilder(), pairing.tlsSha256).build()
            activeClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw IllegalStateException("二维码已失效、已使用或服务器拒绝配对，请重新生成后扫描")
                }
                val body = response.body ?: throw IllegalArgumentException()
                require(body.contentLength() <= 8192)
                val source = body.source()
                source.request(8193)
                require(source.buffer.size <= 8192)
                val input = JSONTokener(source.buffer.readUtf8())
                val result = input.nextValue() as? JSONObject ?: throw IllegalArgumentException()
                require(input.nextClean() == '\u0000')
                require(result.get("device_id") == device.id)
                val server = result.get("server_url") as? String ?: throw IllegalArgumentException()
                require(PortalConfig.validateServerUrl(server) == pairing.serverUrl)
                val packages = PairingQr.parsePackages(result.get("allowed_packages"))
                require(packages.toSet() == pairing.allowedPackages.toSet())
                val token = result.get("device_token") as? String ?: throw IllegalArgumentException()
                require(token.length in 32..512 && !token.any { it.isWhitespace() || it.isISOControl() })
                return ClaimedPairing(pairing.serverUrl, token, packages, pairing.tlsSha256)
            }
        } catch (_: Exception) {
            throw IllegalStateException("配对未完成。请检查服务器连接，或重新生成二维码后扫描")
        }
    }

    fun cancel() {
        client.dispatcher.cancelAll()
        activeClient.dispatcher.cancelAll()
    }

    fun close() {
        cancel()
        client.connectionPool.evictAll()
    }
}
