package com.autorush.portal

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.net.URI
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Local pairing policy. Plain ws:// is limited to device loopback for adb reverse development. */
object PortalConfig {
    const val PREFERENCES = "autorush_portal"
    const val KEY_ALLOWED_PACKAGES = "allowed_packages"
    private const val KEY_SERVER = "server_url"
    private const val KEY_TOKEN = "encrypted_token"
    private const val KEY_DEVICE_ID = "device_id"
    private const val KEY_SCREENSHOT = "allow_screenshot"
    private const val KEY_ANY_APP = "allow_any_package"
    private const val KEY_TLS_PIN = "tls_sha256"
    private const val KEY_ALIAS = "autorush.portal.token"
    private val packagePattern = Regex("(?:[A-Za-z_][A-Za-z0-9_]*\\.)+[A-Za-z_][A-Za-z0-9_]*")

    fun allowedPackages(context: Context): Set<String> = prefs(context)
        .getString(KEY_ALLOWED_PACKAGES, "").orEmpty().split(',')
        .filter { it.isNotBlank() && it != context.packageName }.toSet()

    fun saveAllowedPackages(context: Context, raw: String): String {
        val names = raw.split(',', '\n').map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        require(names.isNotEmpty() || anyPackageAllowed(context)) { "请至少填写一个测试应用包名" }
        require(names.all { packagePattern.matches(it) }) { "包名格式不正确" }
        require(context.packageName !in names) { "不能把 Portal 自身加入允许列表" }
        val value = names.joinToString(",")
        prefs(context).edit().putString(KEY_ALLOWED_PACKAGES, value).apply()
        ScreenStreamer.policyChanged()
        return value
    }

    fun serverUrl(context: Context): String = prefs(context).getString(KEY_SERVER, "").orEmpty()
    fun anyPackageAllowed(context: Context): Boolean = prefs(context).getBoolean(KEY_ANY_APP, false)
    fun setAnyPackageAllowed(context: Context, allowed: Boolean) {
        prefs(context).edit().putBoolean(KEY_ANY_APP, allowed).apply()
        ScreenStreamer.policyChanged()
    }
    fun isPackageAllowed(context: Context, pkg: String): Boolean = PackagePolicy.allows(pkg, context.packageName, anyPackageAllowed(context), allowedPackages(context))
    fun tlsPin(context: Context): String? = prefs(context).getString(KEY_TLS_PIN, null)

    fun validateServerUrl(raw: String): String {
        val uri = try { URI(raw.trim()) } catch (_: Exception) { throw IllegalArgumentException("服务器地址无效") }
        require(uri.userInfo == null && uri.fragment == null && uri.query == null) { "地址不能包含用户信息、查询或片段" }
        require(uri.host != null && uri.port in -1..65535 && uri.port != 0) { "需要有效的服务器主机与端口" }
        require(uri.path == "/api/v1/devices/ws") { "地址路径应为 /api/v1/devices/ws" }
        require(uri.scheme == "wss" || (uri.scheme == "ws" && uri.host in setOf("127.0.0.1", "localhost", "[::1]", "::1"))) {
            "远程服务器必须使用 wss://；ws:// 仅允许本机 adb reverse"
        }
        return uri.toString()
    }

    fun savePairing(context: Context, server: String, token: String, allowedPackages: List<String>? = null, tlsPin: String? = null) {
        val validUrl = validateServerUrl(server)
        require(token.length in 32..512 && !token.any { it.isWhitespace() }) { "设备令牌长度需为 32–512 位，且不能含空白" }
        allowedPackages?.let(PairingQr::validatePackages)
        require(tlsPin == null || (validUrl.startsWith("wss://") && Regex("[a-f0-9]{64}").matches(tlsPin)))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val encrypted = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        val value = Base64.encodeToString(cipher.iv + encrypted, Base64.NO_WRAP)
        val edit = prefs(context).edit().putString(KEY_SERVER, validUrl).putString(KEY_TOKEN, value)
        if (tlsPin == null) edit.remove(KEY_TLS_PIN) else edit.putString(KEY_TLS_PIN, tlsPin)
        allowedPackages?.let { edit.putString(KEY_ALLOWED_PACKAGES, it.joinToString(",")) }
        check(edit.commit()) { "无法保存配对配置，请重试" }
    }

    fun token(context: Context): String? {
        val raw = prefs(context).getString(KEY_TOKEN, null) ?: return null
        return try {
            val bytes = Base64.decode(raw, Base64.DEFAULT)
            if (bytes.size < 29) return null
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
        } catch (_: Exception) { null }
    }

    fun hasToken(context: Context): Boolean = token(context) != null

    fun clearPairing(context: Context) {
        prefs(context).edit().remove(KEY_SERVER).remove(KEY_TOKEN).remove(KEY_TLS_PIN).apply()
    }

    fun screenshotAllowed(context: Context): Boolean = prefs(context).getBoolean(KEY_SCREENSHOT, false)

    fun setScreenshotAllowed(context: Context, allowed: Boolean) {
        prefs(context).edit().putBoolean(KEY_SCREENSHOT, allowed).apply()
        ScreenStreamer.policyChanged()
    }

    fun deviceId(context: Context): String {
        val store = prefs(context)
        store.getString(KEY_DEVICE_ID, null)?.let { return it }
        val id = UUID.randomUUID().toString()
        store.edit().putString(KEY_DEVICE_ID, id).commit()
        return store.getString(KEY_DEVICE_ID, id) ?: id
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    private fun secretKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build())
        return generator.generateKey()
    }
}
