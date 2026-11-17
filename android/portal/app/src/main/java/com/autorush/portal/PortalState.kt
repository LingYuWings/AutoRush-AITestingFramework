package com.autorush.portal

// Describe each connection state and whether its foreground service is active.
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

// Share current connection, observation, and screen status with the activity.
object PortalState {
    @Volatile var accessibilityConnected: Boolean = false
    @Volatile internal var connectionPhase = ConnectionPhase.IDLE
    @Volatile var lastPackage: String = ""
    @Volatile var visibleNodeCount: Int = 0
    @Volatile var lastObservedAt: Long = 0L
    @Volatile var screenStatus: String = "未共享"
    @Volatile var projectionAuthorized: Boolean = false
}
