package com.autorush.portal

object PackagePolicy {
    fun allows(pkg: String, own: String, anyApp: Boolean, allowed: Set<String>): Boolean =
        pkg.isNotBlank() && pkg != own && (anyApp || pkg in allowed)
}
