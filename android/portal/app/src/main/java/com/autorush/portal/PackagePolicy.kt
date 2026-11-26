package com.autorush.portal

// Define which Android apps the paired server may inspect and control.
object PackagePolicy {
    private val packagePattern = Regex("(?:[A-Za-z_][A-Za-z0-9_]*\\.)+[A-Za-z_][A-Za-z0-9_]*")

    // Validate the allowlist against the wildcard value that will be saved with it.
    fun parseAllowedPackages(raw: String, own: String, anyApp: Boolean): List<String> {
        val names = raw.split(',', '\n').map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        require(names.isNotEmpty() || anyApp) { "请至少填写一个测试应用包名" }
        require(names.all { packagePattern.matches(it) }) { "包名格式不正确" }
        require(own !in names) { "不能把 Portal 自身加入允许列表" }
        return names
    }

    // Reject missing package names and Portal itself before applying the allowlist or wildcard setting.
    fun allows(pkg: String, own: String, anyApp: Boolean, allowed: Set<String>): Boolean =
        pkg.isNotBlank() && pkg != own && (anyApp || pkg in allowed)
}
