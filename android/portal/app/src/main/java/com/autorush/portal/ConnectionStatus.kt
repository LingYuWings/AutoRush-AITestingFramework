package com.autorush.portal

import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.ProtocolException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.cert.CertificateException
import javax.net.ssl.SSLException

// Describe each connection phase and whether its foreground service is active.
internal enum class ConnectionPhase(val label: String, val active: Boolean = false) {
    IDLE("未连接"),
    CONNECTING("正在连接", true),
    SEARCHING("正在查找配对的后端", true),
    RETRYING("正在等待重连", true),
    ONLINE("已连接", true),
    REJECTED("配对已被拒绝"),
    INVALID("连接配置不完整"),
    TIMED_OUT("已达到后台运行时限"),
}

// Publish the phase, failure, and monotonic retry deadline as one consistent snapshot.
internal data class ConnectionStatus(
    val phase: ConnectionPhase = ConnectionPhase.IDLE,
    val failure: ConnectionFailure? = null,
    val retryAtMs: Long? = null,
) {
    // Round the remaining wait up to seconds for display.
    fun secondsUntilRetry(nowMs: Long): Long? {
        if (phase != ConnectionPhase.SEARCHING && phase != ConnectionPhase.RETRYING) return null
        val remaining = (retryAtMs ?: return null) - nowMs
        return if (remaining > 0) (remaining + 999) / 1000 else null
    }
}

// Describe safe diagnostic categories without displaying raw transport errors or credentials.
internal enum class ConnectionFailure(val label: String, val hint: String? = null, val terminal: Boolean = false) {
    REJECTED("服务端拒绝配对", "请重新扫码配对，或在手工配对中更新设备令牌。", terminal = true),
    TLS("服务器 TLS 校验失败", "核对设备时间和服务端证书。若后端身份已变更，请确认新后端后重新扫码。"),
    DNS("无法解析服务器地址", "检查服务器域名和当前网络。"),
    UNREACHABLE("无法连接到测试服务器"),
    TIMEOUT("连接或网络响应超时"),
    HANDSHAKE_TIMEOUT("服务器未响应 Portal 握手", "请确认连接的是正在运行的 AutoRush 后端。"),
    ENDPOINT("服务器未接受 WebSocket 连接", "请核对服务器地址、端口以及反向代理的 WebSocket 配置。"),
    SERVER_UNAVAILABLE("服务器暂不可用", "请检查 PC 后端或远程服务是否在线。"),
    SESSION_BUSY("服务端仍持有上一次设备连接", "请等旧连接释放后再试。"),
    DISCONNECTED("与测试服务器的连接已中断");

    companion object {
        // Preserve the terminal policy close codes and distinguish a stale server session.
        fun forClose(code: Int): ConnectionFailure = when (code) {
            1008, 4001 -> REJECTED
            4009 -> SESSION_BUSY
            in 1011..1014 -> SERVER_UNAVAILABLE
            else -> DISCONNECTED
        }

        // Classify the response or typed exception without relying on its text.
        fun forFailure(httpStatus: Int?, error: Throwable): ConnectionFailure {
            if (httpStatus != null && httpStatus != 101) return when (httpStatus) {
                401, 403 -> REJECTED
                in 500..599 -> SERVER_UNAVAILABLE
                else -> ENDPOINT
            }
            return when (error) {
                is SSLException, is CertificateException -> TLS
                is UnknownHostException -> DNS
                is SocketTimeoutException -> TIMEOUT
                is ConnectException, is NoRouteToHostException -> UNREACHABLE
                is ProtocolException -> ENDPOINT
                else -> DISCONNECTED
            }
        }
    }
}
