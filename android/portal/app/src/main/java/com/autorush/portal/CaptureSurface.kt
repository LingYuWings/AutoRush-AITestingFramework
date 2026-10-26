package com.autorush.portal

import kotlin.math.ceil
import kotlin.math.floor

internal data class CaptureBounds(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    val width get() = right - left
    val height get() = bottom - top
    fun intersects(other: CaptureBounds) = left < other.right && right > other.left && top < other.bottom && bottom > other.top
}
internal data class CaptureWindow(val id: Int, val layer: Int, val pkg: String?, val bounds: CaptureBounds, val type: Int = 1)
internal object CaptureSurface {
    /** Exclude narrow edge system strips from pixels, then check the complete remaining surface. */
    fun isolatedBounds(target: CaptureWindow, windows: List<CaptureWindow>): CaptureBounds? {
        if (target.pkg.isNullOrBlank() || target.bounds.width <= 0 || target.bounds.height <= 0 || target !in windows) return null
        val original = target.bounds
        val foreign = windows.filter { it.id != target.id && it.layer >= target.layer && it.pkg != target.pkg && it.bounds.intersects(original) }
        val maxStrip = (minOf(original.width, original.height) / 8).coerceAtLeast(1)
        var remaining = original
        for (window in foreign) {
            // TYPE_SYSTEM=3 is Android's own classification. Unknown application and IME windows
            // cannot qualify, even when they happen to have a bar-shaped rectangle.
            if (window.type != 3) continue
            val edge = window.bounds
            val spansWidth = edge.left <= original.left && edge.right >= original.right
            val spansHeight = edge.top <= original.top && edge.bottom >= original.bottom
            if (spansWidth && edge.top <= original.top && edge.bottom - original.top in 1..maxStrip)
                remaining = remaining.copy(top = maxOf(remaining.top, edge.bottom))
            if (spansWidth && edge.bottom >= original.bottom && original.bottom - edge.top in 1..maxStrip)
                remaining = remaining.copy(bottom = minOf(remaining.bottom, edge.top))
            if (spansHeight && edge.left <= original.left && edge.right - original.left in 1..maxStrip)
                remaining = remaining.copy(left = maxOf(remaining.left, edge.right))
            if (spansHeight && edge.right >= original.right && original.right - edge.left in 1..maxStrip)
                remaining = remaining.copy(right = minOf(remaining.right, edge.left))
        }
        if (remaining.width <= 0 || remaining.height <= 0 || foreign.any { it.bounds.intersects(remaining) }) return null
        return remaining
    }
    fun isIsolated(target: CaptureWindow, windows: List<CaptureWindow>) = isolatedBounds(target, windows) != null

    /** Round inward: pixels outside the app window must never enter a projection frame. */
    fun crop(bounds: CaptureBounds, screenWidth: Int, screenHeight: Int, imageWidth: Int, imageHeight: Int): CaptureBounds {
        require(screenWidth > 0 && screenHeight > 0 && imageWidth > 0 && imageHeight > 0)
        val scaleX = imageWidth.toDouble() / screenWidth
        val scaleY = imageHeight.toDouble() / screenHeight
        val crop = CaptureBounds(ceil(bounds.left * scaleX).toInt().coerceIn(0, imageWidth),
            ceil(bounds.top * scaleY).toInt().coerceIn(0, imageHeight),
            floor(bounds.right * scaleX).toInt().coerceIn(0, imageWidth),
            floor(bounds.bottom * scaleY).toInt().coerceIn(0, imageHeight))
        require(crop.width > 0 && crop.height > 0) { "应用窗口边界为空" }
        return crop
    }
}
