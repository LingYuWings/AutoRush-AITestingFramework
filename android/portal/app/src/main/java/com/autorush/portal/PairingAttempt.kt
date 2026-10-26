package com.autorush.portal

/** Main-thread guard for claim results arriving after the user cancelled or started another scan. */
internal class PairingAttempt {
    private var generation = 0L
    var active = false
        private set

    fun begin(): Long? {
        if (active) return null
        active = true
        generation += 1
        return generation
    }

    fun complete(attempt: Long): Boolean {
        if (!active || attempt != generation) return false
        active = false
        return true
    }

    fun cancel() { active = false }
}
