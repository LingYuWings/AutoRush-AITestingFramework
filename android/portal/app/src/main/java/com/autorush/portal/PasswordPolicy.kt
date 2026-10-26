package com.autorush.portal

object PasswordPolicy {
    fun isSecret(passwordFlag: Boolean, inputType: Int): Boolean {
        val type = inputType and 0xf
        val variation = inputType and 0xff0
        return passwordFlag || (type == 1 && variation in setOf(0x80, 0x90, 0xe0)) || (type == 2 && variation == 0x10)
    }
}
