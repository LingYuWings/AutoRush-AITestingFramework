package com.autorush.portal

// Share current connection, observation, and screen status with the activity.
object PortalState {
    @Volatile var accessibilityConnected: Boolean = false
    @Volatile var serverStatus: String = "未连接"
    @Volatile var lastPackage: String = ""
    @Volatile var visibleNodeCount: Int = 0
    @Volatile var lastObservedAt: Long = 0L
    @Volatile var screenStatus: String = "未共享"
    @Volatile var projectionAuthorized: Boolean = false
}
