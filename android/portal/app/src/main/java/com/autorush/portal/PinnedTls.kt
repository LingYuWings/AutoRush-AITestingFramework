package com.autorush.portal

import okhttp3.OkHttpClient
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/** Verifies a QR certificate or the TLS key learned from an authenticated LAN pairing. */
object PinnedTls {
    // Keep default hostname checks while accepting only the selected certificate or key.
    fun configure(
        builder: OkHttpClient.Builder, pin: String?, keyPin: String? = null, verifiedKey: ((String) -> Unit)? = null,
    ): OkHttpClient.Builder {
        if (pin == null) return builder
        require(isFingerprint(pin) && (keyPin == null || isFingerprint(keyPin))) { "服务器证书摘要无效" }
        val manager = object : X509TrustManager {
            // Report an empty issuer list because server trust comes from the certificate pin.
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            // Reject client certificate authentication in this trust manager.
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
                throw CertificateException("Client certificates are unsupported")
            }
            // Check certificate dates and the digest selected by the authenticated pairing.
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                val leaf = chain.firstOrNull() ?: throw CertificateException("Missing server certificate")
                leaf.checkValidity()
                val actual = sha256(if (keyPin == null) leaf.encoded else leaf.publicKey.encoded)
                if (!MessageDigest.isEqual(actual.toByteArray(), (keyPin ?: pin).toByteArray())) {
                    throw CertificateException("Server identity changed; pair again")
                }
                verifiedKey?.invoke(keyPin ?: sha256(leaf.publicKey.encoded))
            }
        }
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(manager), null) }
        return builder.sslSocketFactory(ssl.socketFactory, manager)
    }

    // Encode certificate and public key fingerprints in the shared wire format.
    internal fun sha256(data: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(data).joinToString("") { "%02x".format(it) }

    // Validate a stored SHA-256 fingerprint before using it for TLS.
    internal fun isFingerprint(value: String): Boolean = value.length == 64 && value.all { it in '0'..'9' || it in 'a'..'f' }
}
