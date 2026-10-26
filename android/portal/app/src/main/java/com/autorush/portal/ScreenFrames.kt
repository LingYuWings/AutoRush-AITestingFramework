package com.autorush.portal

import org.json.JSONObject
import java.nio.ByteBuffer
import java.util.UUID
import kotlin.math.roundToInt
import kotlin.math.max
import kotlin.math.min

internal object ScreenFrames {
    const val MAX_JPEG = 600_000
    const val QUALITY = 60
    fun validateId(id: String) {
        require(runCatching { UUID.fromString(id).toString() == id.lowercase() }.getOrDefault(false)) { "无效的画面流 ID" }
    }
    fun encode(id: String, sequence: Long, width: Int, height: Int, pkg: String, capturedAt: Long, jpeg: ByteArray): ByteArray {
        validateId(id)
        require(sequence >= 1 && width in 1..1280 && height in 1..1280 && pkg.length in 1..200 && capturedAt > 0)
        require(jpeg.size in 4..MAX_JPEG && jpeg[0] == 0xff.toByte() && jpeg[1] == 0xd8.toByte() &&
            jpeg[jpeg.lastIndex - 1] == 0xff.toByte() && jpeg.last() == 0xd9.toByte()) { "无效或过大的 JPEG" }
        val metadata = JSONObject().put("stream_id", id).put("sequence", sequence).put("width", width)
            .put("height", height).put("package", pkg).put("captured_at", capturedAt).toString().toByteArray(Charsets.UTF_8)
        require(metadata.size <= 2048)
        return ByteBuffer.allocate(8 + metadata.size + jpeg.size).put(byteArrayOf(65, 82, 70, 49))
            .putInt(metadata.size).put(metadata).put(jpeg).array()
    }
    fun dimensions(width: Int, height: Int): Pair<Int, Int> {
        require(width > 0 && height > 0)
        val scale = min(1.0, min(1280.0 / max(width, height), 720.0 / min(width, height)))
        return max(1, (width * scale).roundToInt()) to max(1, (height * scale).roundToInt())
    }
}
