package com.autorush.portal

internal class ScreenSession {
    var authorizationEpoch = 0L
        private set
    class Active(val id: String, val mode: String) { var sequence = 0L }
    var active: Active? = null
        private set
    fun invalidateAuthorization() { authorizationEpoch++ }
    fun bind() { active = null; invalidateAuthorization() }
    fun start(id: String, mode: String): Active {
        ScreenFrames.validateId(id)
        require(mode in setOf("preview", "smooth")) { "不支持的画面模式" }
        invalidateAuthorization()
        return Active(id, mode).also { active = it }
    }
    fun stop(id: String): Active? {
        val current = active ?: return null
        if (current.id != id) return null
        active = null
        invalidateAuthorization()
        return current
    }
    fun isCurrent(active: Active) = this.active === active
    fun nextSequence(active: Active): Long {
        check(isCurrent(active)) { "画面流已结束" }
        return ++active.sequence
    }
}
internal class FramePacer(fps: Int) {
    private val intervalMs = (1000L + fps - 1) / fps.also { require(it in 1..30) }
    private var nextMs = Long.MIN_VALUE
    fun acquire(nowMs: Long, queuedBytes: Long): Boolean {
        if (queuedBytes > 512 * 1024 || nowMs < nextMs) return false
        nextMs = nowMs + intervalMs
        return true
    }
}
internal class ScreenshotSlot {
    private var busy = false
    private var nextMs = Long.MIN_VALUE
    fun acquire(nowMs: Long): Boolean {
        if (busy || nowMs < nextMs) return false
        busy = true
        nextMs = nowMs + 350
        return true
    }
    fun release() { busy = false }
    fun delay(nowMs: Long) = if (busy) 50L else (nextMs - nowMs).coerceAtLeast(0)
}
internal object CapturePolicy {
    fun accepts(flag: Boolean, own: String, any: Boolean, allowed: Set<String>, before: String, after: String,
                expected: String?, imageNs: Long, allowedSinceNs: Long): Boolean =
        flag && PackagePolicy.allows(before, own, any, allowed) && before == after &&
            (expected == null || (expected.isNotBlank() && expected == before)) && imageNs >= allowedSinceNs
}

internal data class CapturedScreen(val jpeg: ByteArray, val pkg: String, val capturedAt: Long, val width: Int, val height: Int,
                                   val sourceBounds: CaptureBounds? = null)

internal data class ScreenshotOptions(val expectedPackage: String?, val maxWidth: Int, val quality: Int) {
    init {
        require(maxWidth in 1..1280 && quality in 1..85) { "截图尺寸或质量参数超出范围" }
        require(expectedPackage == null || (expectedPackage.isNotBlank() && expectedPackage.length <= 200)) { "截图目标包名无效" }
    }
    companion object {
        fun fromJson(params: org.json.JSONObject) = ScreenshotOptions(
            if (params.has("expected_package")) params.getString("expected_package") else null,
            params.optInt("max_width", 1280), params.optInt("quality", 70))
    }
}
