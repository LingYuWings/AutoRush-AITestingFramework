package com.autorush.portal

/** ContentProvider.call requires its own caller check, independent of manifest read permission. */
internal object IdentityPolicy {
    fun authorize(callerUid: Int, method: String) {
        if (callerUid != 2000 && callerUid != 0) throw SecurityException("Only ADB shell may identify this device")
        if (method != "identify") throw UnsupportedOperationException("Unsupported identity method")
    }
}
