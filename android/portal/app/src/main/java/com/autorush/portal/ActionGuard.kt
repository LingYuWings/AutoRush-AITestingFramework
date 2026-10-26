package com.autorush.portal

/** Check plan context immediately before the device invokes a mutating action. */
internal object ActionGuard {
    fun validate(
        currentPackage: String,
        expectedPackage: String?,
        expectedSnapshotId: String?,
        currentSnapshotId: String,
        snapshotGeneration: Long,
        currentGeneration: Long,
    ) {
        if (expectedPackage != null) {
            check(expectedPackage.isNotBlank() && currentPackage == expectedPackage) {
                "当前应用与测试计划包名不一致"
            }
            check(expectedSnapshotId != null) { "计划动作缺少界面快照" }
        }
        if (expectedSnapshotId != null) {
            check(expectedSnapshotId.isNotEmpty() && expectedSnapshotId == currentSnapshotId &&
                snapshotGeneration == currentGeneration) {
                "界面已变化，请重新读取快照"
            }
        }
    }
}
