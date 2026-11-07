package com.autorush.portal

// Define which Android apps the paired server may inspect and control.
object PackagePolicy {
    // Reject missing package names and Portal itself before applying the allowlist or wildcard setting.
    fun allows(pkg: String, own: String, anyApp: Boolean, allowed: Set<String>): Boolean =
        pkg.isNotBlank() && pkg != own && (anyApp || pkg in allowed)
}
