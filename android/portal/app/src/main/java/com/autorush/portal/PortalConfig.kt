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
    private const val KEY_TLS_KEY_PIN = "tls_key_sha256"
    private const val KEY_LAN_RECONNECT = "lan_reconnect"
    private const val KEY_LAN_PAUSED = "lan_reconnect_paused"
    private const val KEY_ALIAS = "autorush.portal.token"
    private val packagePattern = Regex("(?:[A-Za-z_][A-Za-z0-9_]*\\.)+[A-Za-z_][A-Za-z0-9_]*")

    // Read the saved package allowlist, ignoring blanks and Portal's own package.
    fun allowedPackages(context: Context): Set<String> = prefs(context)
        .getString(KEY_ALLOWED_PACKAGES, "").orEmpty().split(',')
        .filter { it.isNotBlank() && it != context.packageName }.toSet()

    // Normalize and save package names, then recheck active screen sharing.
    fun saveAllowedPackages(context: Context, raw: String): String {
        val value = parseAllowedPackages(context, raw).joinToString(",")
        prefs(context).edit().putString(KEY_ALLOWED_PACKAGES, value).apply()
        ScreenStreamer.policyChanged()
        return value
    }

    // Validate a manual app allowlist before writing settings or a pairing.
    fun parseAllowedPackages(context: Context, raw: String): List<String> {
        val names = raw.split(',', '\n').map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        require(names.isNotEmpty() || anyPackageAllowed(context)) { "请至少填写一个测试应用包名" }
        require(names.all { packagePattern.matches(it) }) { "包名格式不正确" }
        require(context.packageName !in names) { "不能把 Portal 自身加入允许列表" }
        return names
    }

    // Read the saved WebSocket URL, using an empty string before pairing.
    fun serverUrl(context: Context): String = prefs(context).getString(KEY_SERVER, "").orEmpty()
    // Read whether the user enabled testing outside the allowlist.
    fun anyPackageAllowed(context: Context): Boolean = prefs(context).getBoolean(KEY_ANY_APP, false)
    // Save the wildcard package setting and recheck active screen sharing.
    fun setAnyPackageAllowed(context: Context, allowed: Boolean) {
        prefs(context).edit().putBoolean(KEY_ANY_APP, allowed).apply()
        ScreenStreamer.policyChanged()
    }
    // Evaluate a package against the current local policy.
    fun isPackageAllowed(context: Context, pkg: String): Boolean = PackagePolicy.allows(pkg, context.packageName, anyPackageAllowed(context), allowedPackages(context))
    // Read the saved certificate pin, if the pairing supplied one.
    fun tlsPin(context: Context): String? = prefs(context).getString(KEY_TLS_PIN, null)
    // Read the public key pin learned using the QR-authenticated connection.
    fun tlsKeyPin(context: Context): String? = prefs(context).getString(KEY_TLS_KEY_PIN, null)

    // Read the user's preference for LAN discovery and automatic reconnect.
    fun lanReconnectEnabled(context: Context): Boolean = prefs(context).getBoolean(KEY_LAN_RECONNECT, true)

    // Save the preference and resume discovery if the user enables it again.
    fun setLanReconnectEnabled(context: Context, enabled: Boolean) {
        val edit = prefs(context).edit().putBoolean(KEY_LAN_RECONNECT, enabled)
        if (enabled) edit.remove(KEY_LAN_PAUSED)
        edit.apply()
    }

    // Read whether an explicit disconnect or a server rejection paused discovery.
    fun lanReconnectPaused(context: Context): Boolean = prefs(context).getBoolean(KEY_LAN_PAUSED, false)

    // Persist the pause so reopening Portal does not undo a disconnect.
    fun setLanReconnectPaused(context: Context, paused: Boolean) {
        prefs(context).edit().putBoolean(KEY_LAN_PAUSED, paused).apply()
    }

    // Require the device WebSocket endpoint and restrict plaintext connections to loopback.
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

    // Validate the pairing, encrypt its token, and save the credentials in one preferences commit.
    fun savePairing(
        context: Context, server: String, token: String, allowedPackages: List<String>? = null,
        tlsPin: String? = null, tlsKeyPin: String? = null,
    ) {
        val validUrl = validateServerUrl(server)
        require(token.length in 32..512 && !token.any { it.isWhitespace() }) { "设备令牌长度需为 32–512 位，且不能含空白" }
        val normalizedPackages = allowedPackages?.let { parseAllowedPackages(context, it.joinToString(",")) }
        require(tlsPin == null || (validUrl.startsWith("wss://") && PinnedTls.isFingerprint(tlsPin)))
        require(tlsKeyPin == null || (LanPairing.from(validUrl, tlsPin) != null && PinnedTls.isFingerprint(tlsKeyPin)))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val encrypted = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        val value = Base64.encodeToString(cipher.iv + encrypted, Base64.NO_WRAP)
        val edit = prefs(context).edit().putString(KEY_SERVER, validUrl).putString(KEY_TOKEN, value).remove(KEY_LAN_PAUSED)
        if (tlsPin == null) edit.remove(KEY_TLS_PIN) else edit.putString(KEY_TLS_PIN, tlsPin)
        if (tlsKeyPin == null) edit.remove(KEY_TLS_KEY_PIN) else edit.putString(KEY_TLS_KEY_PIN, tlsKeyPin)
        normalizedPackages?.let { edit.putString(KEY_ALLOWED_PACKAGES, it.joinToString(",")) }
        check(edit.commit()) { "无法保存配对配置，请重试" }
        if (allowedPackages != null) ScreenStreamer.policyChanged()
    }

    // Remember the endpoint and key after TLS verification and the device handshake succeed.
    fun rememberLanEndpoint(context: Context, oldUrl: String, expectedToken: String, newUrl: String, key: String) {
        if (serverUrl(context) != oldUrl || token(context) != expectedToken) return
        if (oldUrl == newUrl && tlsKeyPin(context) == key) return
        prefs(context).edit().putString(KEY_SERVER, newUrl).putString(KEY_TLS_KEY_PIN, key).apply()
    }

    // Decrypt the saved device token and return null if it cannot be read.
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

    // Check whether a saved token is readable.
    fun hasToken(context: Context): Boolean = token(context) != null

    // Remove the paired server address, device token, and certificate pin.
    fun clearPairing(context: Context) {
        prefs(context).edit().remove(KEY_SERVER).remove(KEY_TOKEN).remove(KEY_TLS_PIN)
            .remove(KEY_TLS_KEY_PIN).remove(KEY_LAN_PAUSED).apply()
    }

    // Read the separate screenshot permission, which defaults to off.
    fun screenshotAllowed(context: Context): Boolean = prefs(context).getBoolean(KEY_SCREENSHOT, false)

    // Save the screenshot permission and tell the streamer to recheck access.
    fun setScreenshotAllowed(context: Context, allowed: Boolean) {
        prefs(context).edit().putBoolean(KEY_SCREENSHOT, allowed).apply()
        ScreenStreamer.policyChanged()
    }

    // Return the stored device UUID or generate and save one on first use.
    fun deviceId(context: Context): String {
        val store = prefs(context)
        store.getString(KEY_DEVICE_ID, null)?.let { return it }
        val id = UUID.randomUUID().toString()
        store.edit().putString(KEY_DEVICE_ID, id).commit()
        return store.getString(KEY_DEVICE_ID, id) ?: id
    }

    // Open the app-private preferences used for Portal settings.
    private fun prefs(context: Context) = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    // Load or create the Android Keystore key used for token encryption.
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
