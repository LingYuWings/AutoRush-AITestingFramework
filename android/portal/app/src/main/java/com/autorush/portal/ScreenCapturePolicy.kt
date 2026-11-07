package com.autorush.portal

// Track the active stream and invalidate consent from earlier stream generations.
internal class ScreenSession {
    var authorizationEpoch = 0L
        private set
    // The current stream identity, viewing mode, and last frame sequence.
    class Active(val id: String, val mode: String) { var sequence = 0L }
    var active: Active? = null
        private set
    // Advance the epoch so any outstanding consent result becomes stale.
    fun invalidateAuthorization() { authorizationEpoch++ }
    // Reset the active stream and consent when the connection changes.
    fun bind() { active = null; invalidateAuthorization() }
    // Validate the request and replace the active stream with a fresh identity.
    fun start(id: String, mode: String): Active {
        ScreenFrames.validateId(id)
        require(mode in setOf("preview", "smooth")) { "不支持的画面模式" }
        invalidateAuthorization()
        return Active(id, mode).also { active = it }
    }
    // Stop the stream only if the requested ID is still active.
    fun stop(id: String): Active? {
        val current = active ?: return null
        if (current.id != id) return null
        active = null
        invalidateAuthorization()
        return current
    }
    // Match the active object by identity so callbacks from replaced streams are rejected.
    fun isCurrent(active: Active) = this.active === active
    // Allocate the next frame sequence for the current stream.
    fun nextSequence(active: Active): Long {
        check(isCurrent(active)) { "画面流已结束" }
        return ++active.sequence
    }
}
// Limit frame production by rate and WebSocket backlog.
internal class FramePacer(fps: Int) {
    private val intervalMs = (1000L + fps - 1) / fps.also { require(it in 1..30) }
    private var nextMs = Long.MIN_VALUE
    // Reserve a frame interval when the rate and queue limits allow it.
    fun acquire(nowMs: Long, queuedBytes: Long): Boolean {
        if (queuedBytes > 512 * 1024 || nowMs < nextMs) return false
        nextMs = nowMs + intervalMs
        return true
    }
}
// Serialize screenshots and enforce a minimum interval between starts.
internal class ScreenshotSlot {
    private var busy = false
    private var nextMs = Long.MIN_VALUE
    // Claim the screenshot slot if it is free and the cooldown has passed.
    fun acquire(nowMs: Long): Boolean {
        if (busy || nowMs < nextMs) return false
        busy = true
        nextMs = nowMs + 350
        return true
    }
    // Free the in-flight slot while keeping the cooldown in effect.
    fun release() { busy = false }
    // Estimate when a pending request can try the screenshot slot again.
    fun delay(nowMs: Long) = if (busy) 50L else (nextMs - nowMs).coerceAtLeast(0)
}
// Check whether captured pixels still belong to an authorized app.
internal object CapturePolicy {
    // Require screenshot permission, a matching allowed app, and a frame from the current capture boundary.
    fun accepts(flag: Boolean, own: String, any: Boolean, allowed: Set<String>, before: String, after: String,
                expected: String?, imageNs: Long, allowedSinceNs: Long): Boolean =
        flag && PackagePolicy.allows(before, own, any, allowed) && before == after &&
            (expected == null || (expected.isNotBlank() && expected == before)) && imageNs >= allowedSinceNs
}

// A cropped JPEG with its package, capture time, and image dimensions.
internal data class CapturedScreen(val jpeg: ByteArray, val pkg: String, val capturedAt: Long, val width: Int, val height: Int,
                                   val sourceBounds: CaptureBounds? = null)

// The package, maximum width, and JPEG quality requested for a screenshot.
internal data class ScreenshotOptions(val expectedPackage: String?, val maxWidth: Int, val quality: Int) {
    init {
        require(maxWidth in 1..1280 && quality in 1..85) { "截图尺寸或质量参数超出范围" }
        require(expectedPackage == null || (expectedPackage.isNotBlank() && expectedPackage.length <= 200)) { "截图目标包名无效" }
    }
    companion object {
        // Read and validate screenshot options, using defaults for width and quality.
        fun fromJson(params: org.json.JSONObject) = ScreenshotOptions(
            if (params.has("expected_package")) params.getString("expected_package") else null,
            params.optInt("max_width", 1280), params.optInt("quality", 70))
    }
}
