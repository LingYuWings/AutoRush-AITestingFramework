package com.autorush.portal

import okhttp3.OkHttpClient
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/** QR confirms one server certificate. Default hostname verification remains enabled. */
object PinnedTls {
    fun configure(builder: OkHttpClient.Builder, pin: String?): OkHttpClient.Builder {
        if (pin == null) return builder
        require(Regex("[a-f0-9]{64}").matches(pin)) { "服务器证书摘要无效" }
        val manager = object : X509TrustManager {
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
                throw CertificateException("Client certificates are unsupported")
            }
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                val leaf = chain.firstOrNull() ?: throw CertificateException("Missing server certificate")
                leaf.checkValidity()
                val actual = MessageDigest.getInstance("SHA-256").digest(leaf.encoded).joinToString("") { "%02x".format(it) }
                if (!MessageDigest.isEqual(actual.toByteArray(), pin.toByteArray())) throw CertificateException("Server certificate changed; pair again")
            }
        }
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(manager), null) }
        return builder.sslSocketFactory(ssl.socketFactory, manager)
    }
}
