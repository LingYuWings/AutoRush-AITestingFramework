package com.autorush.portal

// Identify fields whose contents must be hidden from accessibility snapshots.
object PasswordPolicy {
    // Use the password flag and Android input type variations to recognize secret fields.
    fun isSecret(passwordFlag: Boolean, inputType: Int): Boolean {
        val type = inputType and 0xf
        val variation = inputType and 0xff0
        return passwordFlag || (type == 1 && variation in setOf(0x80, 0x90, 0xe0)) || (type == 2 && variation == 0x10)
    }
}
