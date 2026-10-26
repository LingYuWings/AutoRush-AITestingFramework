package com.autorush.portal

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import okhttp3.WebSocket
import okio.ByteString.Companion.toByteString
import org.json.JSONObject

/** Main-thread owner of a viewing stream. Async capture callbacks carry an identity token. */
internal object ScreenStreamer {
    private val main = Handler(Looper.getMainLooper())
    private val session = ScreenSession()
    private var context: Context? = null
    private var socket: WebSocket? = null
    private var pacer = FramePacer(2)
    private var lastState = ""
    private var lastDetail = ""
    private var previewPending = false

    fun bind(context: Context, socket: WebSocket) {
        disconnect()
        this.context = context.applicationContext
        this.socket = socket
        session.bind()
    }

    fun detach(socket: WebSocket) { if (this.socket === socket) disconnect() }

    private fun disconnect() {
        val previous = session.active
        if (previous != null) status(previous, "stopped", "设备连接已结束")
        session.bind()
        socket = null
        main.removeCallbacksAndMessages(null)
        previewPending = false
        ScreenCaptureService.instance?.stopSharing("设备连接已结束")
    }

    fun start(context: Context, socket: WebSocket, params: JSONObject): JSONObject {
        check(this.socket === socket) { "画面连接尚未就绪" }
        val id = params.getString("stream_id")
        val mode = params.getString("mode")
        ScreenFrames.validateId(id)
        require(mode in setOf("preview", "smooth")) { "不支持的画面模式" }
        session.active?.let { previous ->
            status(previous, "stopped", "已切换画面流")
            session.stop(previous.id)
            if (previous.mode == "smooth") ScreenCaptureService.instance?.stopSharing("已切换画面流")
        }
        main.removeCallbacksAndMessages(null)
        previewPending = false
        this.context = context.applicationContext
        val active = session.start(id, mode)
        pacer = FramePacer(if (mode == "preview") 2 else 15)
        lastState = ""
        lastDetail = ""
        val state = when {
            !PortalConfig.screenshotAllowed(context) -> "blocked"
            PortalAccessibilityService.instance == null || !PortalState.accessibilityConnected -> "blocked"
            mode == "preview" && Build.VERSION.SDK_INT < 30 -> "error"
            mode == "smooth" && ScreenCaptureService.instance == null -> "permission_required"
            else -> "blocked"
        }
        val detail = when (state) {
            "permission_required" -> "请在管理台通过已配对 ADB 连接启动流畅投屏，无需系统录屏授权"
            "error" -> "调试预览需要 Android 11 或更高版本"
            else -> "等待允许的测试应用画面"
        }
        status(active, state, detail)
        if (mode == "preview" && Build.VERSION.SDK_INT >= 30) preview(active)
        return JSONObject().put("stream_id", id).put("mode", mode).put("state", state)
    }

    fun stop(params: JSONObject): JSONObject {
        val id = params.getString("stream_id")
        ScreenFrames.validateId(id)
        val active = session.stop(id)
        if (active != null) {
            main.removeCallbacksAndMessages(null)
            previewPending = false
            // Status is emitted after invalidation, so no capture callback can race it.
            emitStatus(id, "stopped", "已停止共享")
            ScreenCaptureService.instance?.stopSharing("已停止共享")
        }
        return JSONObject().put("stream_id", id).put("state", "stopped").put("stopped", active != null)
    }

    fun stopByUser() {
        session.active?.let { stop(JSONObject().put("stream_id", it.id)) }
        session.invalidateAuthorization()
        ScreenCaptureService.instance?.stopSharing("手机已停止共享")
    }

    fun canAuthorize() = socket != null && context?.let(PortalConfig::screenshotAllowed) == true
    val authorizationEpoch get() = session.authorizationEpoch
    fun isAuthorizationCurrent(epoch: Long) = canAuthorize() && epoch == authorizationEpoch
    fun consentDeclined() {
        session.active?.takeIf { it.mode == "smooth" }?.let { status(it, "permission_required", "系统录屏授权未完成") }
    }
    fun projectionAvailable() {
        session.active?.takeIf { it.mode == "smooth" }?.let { status(it, "blocked", "等待允许的测试应用画面") }
    }
    fun projectionStopped(detail: String) {
        val active = session.active?.takeIf { it.mode == "smooth" } ?: return
        session.stop(active.id)
        emitStatus(active.id, "stopped", detail)
    }
    fun projectionError(detail: String) {
        session.active?.takeIf { it.mode == "smooth" }?.let { status(it, "error", detail) }
    }
    fun projectionBlocked(detail: String) {
        session.active?.takeIf { it.mode == "smooth" }?.let { status(it, "blocked", detail) }
    }

    fun policyChanged() {
        val active = session.active ?: return
        val allowed = runCatching { PortalAccessibilityService.instance?.currentCapturePackage() ?: error("无障碍服务未启用") }
        if (allowed.isFailure) status(active, "blocked", allowed.exceptionOrNull()?.message ?: "当前画面不允许共享")
        if (context?.let(PortalConfig::screenshotAllowed) == false) {
            session.invalidateAuthorization()
            ScreenCaptureService.instance?.stopSharing("截图许可已关闭")
        }
    }

    fun smoothTicket(): ScreenSession.Active? {
        val active = session.active?.takeIf { it.mode == "smooth" } ?: return null
        val queued = socket?.queueSize() ?: return null
        if (!pacer.acquire(SystemClock.elapsedRealtime(), queued)) return null
        return active
    }
    fun isCurrent(active: ScreenSession.Active) = socket != null && session.isCurrent(active)

    fun send(active: ScreenSession.Active, image: CapturedScreen, epochNs: Long) {
        if (!isCurrent(active)) return
        try {
            val service = PortalAccessibilityService.instance ?: error("无障碍服务未启用")
            val ctx = context ?: return
            val current = service.currentCapturePackage(image.pkg)
            check(CapturePolicy.accepts(PortalConfig.screenshotAllowed(ctx), ctx.packageName, PortalConfig.anyPackageAllowed(ctx),
                PortalConfig.allowedPackages(ctx), image.pkg, current, image.pkg, epochNs, service.captureEpochNs) &&
                service.captureEpochNs == epochNs) { "采集期间应用已变化" }
            val connection = socket ?: return
            val bytes = ScreenFrames.encode(active.id, session.nextSequence(active), image.width, image.height,
                image.pkg, image.capturedAt, image.jpeg)
            if (connection.queueSize() + bytes.size > 512 * 1024) return
            if (isCurrent(active) && connection.send(bytes.toByteString())) status(active, "streaming", "正在共享允许的测试应用")
        } catch (error: Exception) { status(active, "blocked", error.message ?: "画面已阻止") }
    }

    private fun preview(active: ScreenSession.Active) {
        if (!isCurrent(active)) return
        val service = PortalAccessibilityService.instance
        val ready = runCatching { service?.currentCapturePackage() ?: error("无障碍服务未启用") }
        if (ready.isFailure) status(active, "blocked", ready.exceptionOrNull()?.message ?: "画面已阻止")
        else if (!previewPending && pacer.acquire(SystemClock.elapsedRealtime(), socket?.queueSize() ?: Long.MAX_VALUE)) {
            previewPending = true
            val epoch = service!!.captureEpochNs
            service.captureScreenshot(ready.getOrThrow(), 1280, ScreenFrames.QUALITY) { result ->
                if (!isCurrent(active)) return@captureScreenshot
                previewPending = false
                result.fold(onSuccess = { send(active, it, epoch) }, onFailure = { status(active, "blocked", it.message ?: "截图失败") })
            }
        }
        main.postDelayed({ preview(active) }, 500)
    }

    fun blocked(active: ScreenSession.Active, detail: String) { status(active, "blocked", detail) }
    private fun status(active: ScreenSession.Active, state: String, detail: String) {
        if (!session.isCurrent(active)) return
        if (lastState == state && lastDetail == detail) return
        lastState = state
        lastDetail = detail
        emitStatus(active.id, state, detail)
    }
    private fun emitStatus(id: String, state: String, detail: String) {
        PortalState.screenStatus = when (state) {
            "streaming" -> "共享中"
            "permission_required" -> "等待系统录屏授权"
            "blocked" -> "画面已阻止"
            "stopped" -> "已停止"
            else -> "共享错误"
        }
        socket?.send(JSONObject().put("type", "screen.status").put("stream_id", id)
            .put("state", state).put("detail", detail.take(200)).toString())
    }
}
