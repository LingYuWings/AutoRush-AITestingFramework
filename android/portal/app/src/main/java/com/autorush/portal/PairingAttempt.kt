package com.autorush.portal

/** Main-thread guard for claim results arriving after the user cancelled or started another scan. */
internal class PairingAttempt {
    private var generation = 0L
    var active = false
        private set

    // Start a claim if one is idle and return its generation number.
    fun begin(): Long? {
        if (active) return null
        active = true
        generation += 1
        return generation
    }

    // Accept a result only while its generation is still active.
    fun complete(attempt: Long): Boolean {
        if (!active || attempt != generation) return false
        active = false
        return true
    }

    // Invalidate any pending result so a cancelled claim cannot update the activity.
    fun cancel() { active = false }
}
