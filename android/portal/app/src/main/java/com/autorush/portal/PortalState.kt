package com.autorush.portal

object PortalState {
    @Volatile var accessibilityConnected: Boolean = false
    @Volatile var serverStatus: String = "未连接"
    @Volatile var lastPackage: String = ""
    @Volatile var visibleNodeCount: Int = 0
    @Volatile var lastObservedAt: Long = 0L
    @Volatile var screenStatus: String = "未共享"
    @Volatile var projectionAuthorized: Boolean = false
}
