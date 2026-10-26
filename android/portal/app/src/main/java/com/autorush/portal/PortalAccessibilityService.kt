package com.autorush.portal

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.ArrayDeque
import java.util.UUID

/** Device-side execution boundary. Every read and action checks the current allowlisted app. */
class PortalAccessibilityService : AccessibilityService() {
    private data class NodeRef(val path: List<Int>, val className: String, val viewId: String, val bounds: Rect)
    private var snapshotId = ""
    private var snapshotGeneration = -1L
    private var snapshotNodes: List<NodeRef> = emptyList()
    private var generation = 0L
    private val mainHandler = Handler(Looper.getMainLooper())
    private val screenshotSlot = ScreenshotSlot()
    private var capturePackage = ""
    private var captureWindow = -1
    private var captureWindows = emptyList<CaptureWindow>()
    internal var captureEpochNs = System.nanoTime()
        private set

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        PortalState.accessibilityConnected = true
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        generation++
        refreshCaptureBoundary()
        ScreenStreamer.policyChanged()
        val pkg = event?.packageName?.toString() ?: return
        if (!PortalConfig.isPackageAllowed(this, pkg)) return
        val root = rootInActiveWindow ?: return
        if (root.packageName?.toString() != pkg) return
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var count = 0
        while (queue.isNotEmpty() && count < MAX_NODES) {
            val node = queue.removeFirst()
            count++
            for (index in 0 until node.childCount) node.getChild(index)?.let(queue::addLast)
        }
        PortalState.lastPackage = pkg
        PortalState.visibleNodeCount = count
        PortalState.lastObservedAt = System.currentTimeMillis()
    }

    override fun onInterrupt() {
        PortalState.accessibilityConnected = false
        ScreenStreamer.policyChanged()
    }

    override fun onDestroy() {
        mainHandler.removeCallbacksAndMessages(null)
        if (instance === this) instance = null
        PortalState.accessibilityConnected = false
        ScreenStreamer.policyChanged()
        super.onDestroy()
    }

    /** Called on the main thread by the connection service. Callback may complete asynchronously. */
    fun execute(method: String, params: JSONObject, complete: (Result<JSONObject>) -> Unit) {
        try {
            when (method) {
                "device.info" -> complete(Result.success(deviceInfo()))
                "ui.snapshot" -> complete(Result.success(snapshot()))
                "ui.tap_element" -> tapElement(params, complete)
                "ui.tap" -> {
                    actionRoot(params)
                    gesture(params.getInt("x"), params.getInt("y"), params.getInt("x"), params.getInt("y"), 80L, complete)
                }
                "ui.long_press" -> {
                    actionRoot(params)
                    val duration = params.optLong("duration_ms", 800L)
                    require(duration in 500..3000) { "长按时长必须在 500–3000 ms" }
                    gesture(params.getInt("x"), params.getInt("y"), params.getInt("x"), params.getInt("y"), duration, complete)
                }
                "ui.swipe" -> {
                    actionRoot(params)
                    val duration = params.optLong("duration_ms", 400L)
                    require(duration in 100..2000) { "滑动时长必须在 100–2000 ms" }
                    gesture(params.getInt("from_x"), params.getInt("from_y"), params.getInt("to_x"), params.getInt("to_y"), duration, complete)
                }
                "ui.input_text" -> complete(Result.success(inputText(params)))
                "ui.back" -> {
                    actionRoot(params)
                    complete(Result.success(JSONObject().put("performed", performGlobalAction(GLOBAL_ACTION_BACK))))
                }
                "app.launch" -> launchApp(params, complete)
                "ui.screenshot" -> screenshot(params, complete)
                else -> complete(Result.failure(IllegalArgumentException("不支持的操作")))
            }
        } catch (error: Exception) {
            complete(Result.failure(error))
        }
    }

    private fun allowedRoot(): AccessibilityNodeInfo {
        val root = rootInActiveWindow ?: error("当前没有可访问的界面")
        val pkg = root.packageName?.toString().orEmpty()
        check(PortalConfig.isPackageAllowed(this, pkg)) { "当前应用不在允许操作范围中" }
        return root
    }

    private fun actionRoot(params: JSONObject): AccessibilityNodeInfo {
        val root = allowedRoot()
        ActionGuard.validate(
            root.packageName?.toString().orEmpty(),
            if (params.has("expected_package")) params.getString("expected_package") else null,
            if (params.has("snapshot_id")) params.getString("snapshot_id") else null,
            snapshotId, snapshotGeneration, generation,
        )
        return root
    }

    private fun deviceInfo(): JSONObject {
        val display = resources.displayMetrics
        return JSONObject().put("device_id", PortalConfig.deviceId(this))
            .put("manufacturer", Build.MANUFACTURER).put("model", Build.MODEL)
            .put("sdk_int", Build.VERSION.SDK_INT).put("width", display.widthPixels)
            .put("height", display.heightPixels).put("density_dpi", display.densityDpi)
            .put("accessibility_enabled", true)
            .put("screenshot_allowed", PortalConfig.screenshotAllowed(this))
            .put("allow_any_package", PortalConfig.anyPackageAllowed(this))
            .put("allowed_packages", JSONArray(PortalConfig.allowedPackages(this).toList()))
    }

    private fun snapshot(): JSONObject {
        val root = allowedRoot()
        val nodes = JSONArray()
        val refs = mutableListOf<NodeRef>()
        val queue = ArrayDeque<Pair<AccessibilityNodeInfo, List<Int>>>()
        queue.add(root to emptyList())
        while (queue.isNotEmpty() && refs.size < MAX_NODES) {
            val (node, path) = queue.removeFirst()
            val bounds = Rect().also(node::getBoundsInScreen)
            val index = refs.size
            refs += NodeRef(path, node.className?.toString().orEmpty(), node.viewIdResourceName.orEmpty(), bounds)
            val password = PasswordPolicy.isSecret(node.isPassword, node.inputType)
            nodes.put(JSONObject().put("index", index)
                .put("class", node.className?.toString().orEmpty())
                .put("resource_id", node.viewIdResourceName.orEmpty())
                .put("text", if (password) "" else node.text?.toString().orEmpty().take(200))
                .put("description", if (password) "" else node.contentDescription?.toString().orEmpty().take(200))
                .put("clickable", node.isClickable).put("editable", node.isEditable)
                .put("visible", node.isVisibleToUser).put("enabled", node.isEnabled)
                .put("password", password)
                .put("bounds", JSONArray(listOf(bounds.left, bounds.top, bounds.right, bounds.bottom))))
            for (i in 0 until node.childCount) node.getChild(i)?.let { queue.add(it to (path + i)) }
        }
        snapshotNodes = refs
        snapshotId = UUID.randomUUID().toString()
        snapshotGeneration = generation
        return JSONObject().put("package", root.packageName?.toString().orEmpty())
            .put("snapshot_id", snapshotId).put("nodes", nodes).put("truncated", queue.isNotEmpty())
    }

    private fun tapElement(params: JSONObject, complete: (Result<JSONObject>) -> Unit) {
        val root = actionRoot(params)
        check(params.getString("snapshot_id") == snapshotId && snapshotGeneration == generation) {
            "界面已变化，请重新读取快照"
        }
        val ref = snapshotNodes.getOrNull(params.getInt("index")) ?: error("节点索引不存在")
        val node = nodeAtPath(root, ref.path) ?: error("节点已经消失")
        val now = Rect().also(node::getBoundsInScreen)
        check(node.className?.toString().orEmpty() == ref.className &&
            node.viewIdResourceName.orEmpty() == ref.viewId && now == ref.bounds) {
            "节点已经变化，请重新读取快照"
        }
        var clickable: AccessibilityNodeInfo? = node
        repeat(4) {
            if (clickable?.isClickable == true) {
                complete(Result.success(JSONObject().put("performed", clickable!!.performAction(AccessibilityNodeInfo.ACTION_CLICK))))
                return
            }
            clickable = clickable?.parent
        }
        gesture(now.centerX(), now.centerY(), now.centerX(), now.centerY(), 80L, complete)
    }

    private fun inputText(params: JSONObject): JSONObject {
        val root = actionRoot(params)
        val value = params.getString("text")
        require(value.length <= 2000) { "输入文本过长" }
        val node = if (params.has("index")) {
            check(params.getString("snapshot_id") == snapshotId && snapshotGeneration == generation) {
                "界面已变化，请重新读取快照"
            }
            val ref = snapshotNodes.getOrNull(params.getInt("index")) ?: error("节点索引不存在")
            val current = nodeAtPath(root, ref.path) ?: error("节点已经消失")
            val now = Rect().also(current::getBoundsInScreen)
            check(current.className?.toString().orEmpty() == ref.className &&
                current.viewIdResourceName.orEmpty() == ref.viewId && now == ref.bounds) {
                "节点已经变化，请重新读取快照"
            }
            current
        } else root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: error("没有已聚焦输入框")
        check(node.isEditable) { "目标节点不可编辑" }
        val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value) }
        return JSONObject().put("performed", node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args))
            .put("length", value.length)
    }

    private fun launchApp(params: JSONObject, complete: (Result<JSONObject>) -> Unit) {
        val pkg = params.getString("package")
        check(PortalConfig.isPackageAllowed(this, pkg)) { "目标应用不在允许操作范围中" }
        val intent = packageManager.getLaunchIntentForPackage(pkg)
            ?: error("目标应用没有可启动的主界面")
        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        startActivity(intent)
        // startActivity returns before the target window becomes available.
        fun awaitWindow(remaining: Int) {
            if (!PortalConfig.isPackageAllowed(this, pkg)) {
                complete(Result.failure(IllegalStateException("目标应用授权已撤销")))
            } else if (rootInActiveWindow?.packageName?.toString() == pkg) {
                complete(Result.success(JSONObject().put("launched", pkg)))
            } else if (remaining == 0) {
                complete(Result.failure(IllegalStateException("启动后未观察到目标应用界面")))
            } else {
                mainHandler.postDelayed({ awaitWindow(remaining - 1) }, 250)
            }
        }
        awaitWindow(20)
    }

    private fun nodeAtPath(root: AccessibilityNodeInfo, path: List<Int>): AccessibilityNodeInfo? {
        var node: AccessibilityNodeInfo? = root
        for (part in path) node = node?.getChild(part) ?: return null
        return node
    }

    private fun gesture(x1: Int, y1: Int, x2: Int, y2: Int, duration: Long, complete: (Result<JSONObject>) -> Unit) {
        val display = resources.displayMetrics
        require(listOf(x1, x2).all { it in 0 until display.widthPixels } &&
            listOf(y1, y2).all { it in 0 until display.heightPixels }) { "手势坐标超出屏幕" }
        val path = Path().apply { moveTo(x1.toFloat(), y1.toFloat()); lineTo(x2.toFloat(), y2.toFloat()) }
        val description = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, duration)).build()
        val accepted = dispatchGesture(description, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
                complete(Result.success(JSONObject().put("performed", true)))
            }
            override fun onCancelled(gestureDescription: GestureDescription?) {
                complete(Result.failure(IllegalStateException("手势被系统取消")))
            }
        }, null)
        if (!accepted) complete(Result.failure(IllegalStateException("系统拒绝手势")))
    }

    private fun refreshCaptureBoundary() {
        val root = rootInActiveWindow
        val pkg = root?.packageName?.toString().orEmpty()
        val window = root?.windowId ?: -1
        val visible = windows.map { current ->
            val bounds = Rect().also(current::getBoundsInScreen)
            CaptureWindow(current.id, current.layer, current.root?.packageName?.toString(),
                CaptureBounds(bounds.left, bounds.top, bounds.right, bounds.bottom), current.type)
        }.sortedBy { it.id }
        if (pkg != capturePackage || window != captureWindow || visible != captureWindows) {
            capturePackage = pkg
            captureWindow = window
            captureWindows = visible
            captureEpochNs = System.nanoTime()
        }
    }

    internal fun currentCapturePackage(expected: String? = null): String {
        check(PortalState.accessibilityConnected) { "无障碍服务未启用" }
        check(PortalConfig.screenshotAllowed(this)) { "设备端未授权截图" }
        refreshCaptureBoundary()
        val root = allowedRoot()
        val pkg = root.packageName?.toString().orEmpty()
        check(CapturePolicy.accepts(PortalConfig.screenshotAllowed(this), packageName, PortalConfig.anyPackageAllowed(this),
            PortalConfig.allowedPackages(this), pkg, pkg, expected, System.nanoTime(), captureEpochNs)) { "当前应用与截图目标包名不一致" }
        val target = captureWindows.firstOrNull { it.id == root.windowId } ?: error("无法确认应用窗口边界")
        check(target.pkg == pkg && CaptureSurface.isIsolated(target, captureWindows)) { "应用画面被其他窗口遮挡，已暂停截图" }
        return pkg
    }

    internal fun currentCaptureBounds(expected: String): CaptureBounds {
        currentCapturePackage(expected)
        return CaptureSurface.isolatedBounds(captureWindows.first { it.id == captureWindow }, captureWindows)
            ?: error("应用画面被其他窗口遮挡，已暂停截图")
    }

    internal fun invalidateCapture() { captureEpochNs = System.nanoTime() }

    private fun screenshot(params: JSONObject, complete: (Result<JSONObject>) -> Unit) {
        val options = ScreenshotOptions.fromJson(params)
        captureScreenshot(options.expectedPackage, options.maxWidth, options.quality) { result ->
            complete(result.mapCatching { image ->
                JSONObject().put("mime_type", "image/jpeg")
                    .put("data_base64", Base64.encodeToString(image.jpeg, Base64.NO_WRAP))
                    .put("package", image.pkg).put("captured_at", image.capturedAt)
                    .put("width", image.width).put("height", image.height)
                    .also { payload -> image.sourceBounds?.let { bounds ->
                        payload.put("source_bounds", JSONArray(listOf(bounds.left, bounds.top, bounds.right, bounds.bottom)))
                    } }
                    .also { check(it.toString().toByteArray(Charsets.UTF_8).size < 1_000_000) { "截图超过 1 MB 限额" } }
            })
        }
    }

    /** Preview and step evidence share Android's screenshot interval and in-flight slot. */
    internal fun captureScreenshot(expected: String?, maxWidth: Int, quality: Int,
                                   complete: (Result<CapturedScreen>) -> Unit) {
        var completed = false
        var acquired = false
        lateinit var timeout: Runnable
        fun finish(result: Result<CapturedScreen>) {
            if (completed) return
            completed = true
            mainHandler.removeCallbacks(timeout)
            if (acquired) screenshotSlot.release()
            complete(result)
        }
        timeout = Runnable { finish(Result.failure(IllegalStateException("截图超时"))) }
        mainHandler.postDelayed(timeout, 5000)
        fun start() {
            if (completed) return
            try {
                ScreenshotOptions(expected, maxWidth, quality)
                val pkg = currentCapturePackage(expected)
                if (Build.VERSION.SDK_INT < 30) error("截图需要 Android 11 或更高版本")
                if (!screenshotSlot.acquire(SystemClock.elapsedRealtime())) {
                    mainHandler.postDelayed({ start() }, screenshotSlot.delay(SystemClock.elapsedRealtime()).coerceAtLeast(1))
                    return
                }
                acquired = true
                val epoch = captureEpochNs
                val window = allowedRoot().windowId
                val bounds = currentCaptureBounds(pkg)
                val windowBounds = captureWindows.first { it.id == window }.bounds
                val callback = object : TakeScreenshotCallback {
                    override fun onSuccess(result: ScreenshotResult) {
                        var bitmap: Bitmap? = null
                        var cropped: Bitmap? = null
                        var scaled: Bitmap? = null
                        try {
                            if (completed) return
                            check(currentCapturePackage(expected) == pkg && captureEpochNs == epoch) { "截图期间应用已变化" }
                            val hardware = Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace) ?: error("截图无法解码")
                            try { bitmap = hardware.copy(Bitmap.Config.ARGB_8888, false) ?: error("截图无法复制") }
                            finally { hardware.recycle() }
                            val raw = bitmap
                            val crop = if (Build.VERSION.SDK_INT >= 34) {
                                val relative = CaptureBounds(bounds.left - windowBounds.left, bounds.top - windowBounds.top,
                                    bounds.right - windowBounds.left, bounds.bottom - windowBounds.top)
                                CaptureSurface.crop(relative, windowBounds.width, windowBounds.height, raw.width, raw.height)
                            } else CaptureSurface.crop(bounds, raw.width, raw.height, raw.width, raw.height)
                            cropped = Bitmap.createBitmap(raw, crop.left, crop.top, crop.width, crop.height)
                            val source = cropped
                            val fit = ScreenFrames.dimensions(source.width, source.height)
                            val ratio = minOf(1.0, maxWidth.toDouble() / fit.first)
                            val width = (fit.first * ratio).toInt().coerceAtLeast(1)
                            val height = (fit.second * ratio).toInt().coerceAtLeast(1)
                            scaled = Bitmap.createScaledBitmap(source, width, height, true)
                            val stream = ByteArrayOutputStream()
                            check(scaled.compress(Bitmap.CompressFormat.JPEG, quality, stream)) { "截图编码失败" }
                            val bytes = stream.toByteArray()
                            check(bytes.size <= ScreenFrames.MAX_JPEG) { "截图超过 JPEG 限额" }
                            check(currentCapturePackage(expected) == pkg && captureEpochNs == epoch) { "截图期间应用或权限已变化" }
                            finish(Result.success(CapturedScreen(bytes, pkg, System.currentTimeMillis(), width, height, bounds)))
                        } catch (error: Exception) {
                            finish(Result.failure(error))
                        } finally {
                            if (scaled !== cropped && scaled !== bitmap) scaled?.recycle()
                            if (cropped !== bitmap) cropped?.recycle()
                            bitmap?.recycle()
                            result.hardwareBuffer.close()
                        }
                    }
                    override fun onFailure(errorCode: Int) {
                        finish(Result.failure(IllegalStateException("系统截图失败：$errorCode")))
                    }
                }
                if (Build.VERSION.SDK_INT >= 34) takeScreenshotOfWindow(window, mainExecutor, callback)
                else takeScreenshot(0, mainExecutor, callback)
            } catch (error: Exception) { finish(Result.failure(error)) }
        }
        start()
    }

    companion object {
        private const val MAX_NODES = 250
        @Volatile var instance: PortalAccessibilityService? = null
            private set
    }
}
