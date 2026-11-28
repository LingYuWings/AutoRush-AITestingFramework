@file:Suppress("DEPRECATION") // ZXing returns through Activity's legacy result callback.

package com.autorush.portal

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.google.zxing.integration.android.IntentIntegrator
import java.text.DateFormat
import java.util.Date
import java.util.concurrent.Executors

/** Shows the connection and local test permissions on the Portal home screen. */
class MainActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private val pairingClient = PairingClient()
    private val pairingExecutor = Executors.newSingleThreadExecutor()
    private val pairingAttempt = PairingAttempt()
    private lateinit var ui: PortalViews
    private lateinit var status: TextView
    private lateinit var connectionDetail: TextView
    private lateinit var connectionHelp: TextView
    private lateinit var retryNow: Button
    private lateinit var primary: Button
    private lateinit var scanAgain: Button
    private lateinit var manualPair: Button
    private lateinit var accessibilityStatus: TextView
    private lateinit var accessibilityAction: Button
    private lateinit var scopeDetail: TextView
    private lateinit var screenshotDetail: TextView
    private lateinit var stopPreview: Button
    private lateinit var autoReconnect: Switch
    private lateinit var reconnectDetail: TextView
    private var hasPairing = false
    private val refresh = object : Runnable {
        // Refresh visible settings as Android services report state.
        override fun run() {
            updateHome()
            handler.postDelayed(this, 750)
        }
    }

    // Assemble the connection, permissions, and secondary settings cards.
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ui = PortalViews(this)
        hasPairing = PortalConfig.hasToken(this)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }
        val root = ui.column().apply { setPadding(ui.dp(20), ui.dp(22), ui.dp(20), ui.dp(24)) }
        root.addView(ui.label("AutoRush Portal", 25f, bold = true))
        root.addView(connectionCard(), ui.spaced(top = 18))
        root.addView(ui.heading("测试权限"), ui.spaced(top = 26, bottom = 10))
        root.addView(permissionsCard())
        root.addView(ui.heading("连接设置"), ui.spaced(top = 26, bottom = 10))
        root.addView(settingsCard())
        val frame = FrameLayout(this)
        val width = if (resources.configuration.screenWidthDp >= 600) ui.dp(600) else -1
        frame.addView(root, FrameLayout.LayoutParams(width, -2, Gravity.TOP or Gravity.CENTER_HORIZONTAL))
        val scroll = ScrollView(this).apply {
            isFillViewport = true
            setBackgroundColor(ui.background)
            addView(frame)
        }
        ViewCompat.setOnApplyWindowInsetsListener(scroll) { view, insets ->
            val safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
            insets
        }
        setContentView(scroll)
        ViewCompat.requestApplyInsets(scroll)
        updateHome()
    }

    // Put the current connection and its primary action first.
    private fun connectionCard() = ui.card(dark = true).apply {
        addView(ui.label("测试服务器", 13f, ui.heroMuted))
        status = ui.label("", 28f, ui.white, bold = true).apply {
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        addView(status, ui.spaced(top = 8))
        connectionDetail = ui.label("", 14f, ui.heroMuted)
        addView(connectionDetail, ui.spaced(top = 7))
        connectionHelp = ui.label("", 14f, ui.white)
        addView(connectionHelp, ui.spaced(top = 7))
        primary = ui.action("", primary = true, action = ::runPrimaryAction)
        addView(primary, ui.spaced(top = 18))
        retryNow = ui.action("立即重试") {
            if (PortalState.connection.secondsUntilRetry(SystemClock.uptimeMillis()) != null) {
                startService(connectionIntent(PortalConnectionService.ACTION_RETRY_NOW))
            }
        }
        addView(retryNow, ui.spaced(top = 8))
    }

    // Keep accessibility, app scope, and screenshot permission together.
    private fun permissionsCard() = ui.card().apply {
        val accessibility = ui.column()
        accessibility.addView(ui.label("无障碍服务", 16f, bold = true))
        accessibilityStatus = ui.label("", 13f, ui.muted)
        accessibility.addView(accessibilityStatus, ui.spaced(top = 4))
        accessibilityAction = ui.action("去开启") { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        addView(ui.row(accessibility, accessibilityAction))
        addView(ui.divider(), ui.spaced(top = 12, bottom = 12))

        val scope = ui.column()
        scope.addView(ui.label("可测试的应用", 16f, bold = true))
        scopeDetail = ui.label("", 13f, ui.muted)
        scope.addView(scopeDetail, ui.spaced(top = 4))
        addView(ui.row(scope, ui.action("管理", action = ::editScope)))
        addView(ui.divider(), ui.spaced(top = 12, bottom = 10))

        addView(ui.toggle("允许测试应用截图", PortalConfig.screenshotAllowed(this@MainActivity)) { allowed ->
            PortalConfig.setScreenshotAllowed(this@MainActivity, allowed)
            updateHome()
        })
        screenshotDetail = ui.label("", 13f, ui.muted)
        addView(screenshotDetail)
        stopPreview = ui.action("停止远程预览") {
            ScreenStreamer.stopByUser()
            updateHome()
        }
        addView(stopPreview, ui.spaced(top = 10))
    }

    // Keep infrequent pairing and diagnostic actions below everyday controls.
    private fun settingsCard() = ui.card().apply {
        autoReconnect = ui.toggle("自动回连", PortalConfig.lanReconnectEnabled(this@MainActivity), ::changeReconnect)
        reconnectDetail = ui.label("", 13f, ui.muted)
        addView(autoReconnect)
        addView(reconnectDetail)
        addView(ui.divider(), ui.spaced(top = 13, bottom = 10))
        scanAgain = ui.action("扫码配对新后端", action = ::scanPairing)
        addView(scanAgain, ui.spaced(bottom = 8))
        manualPair = ui.action("手工配对", action = ::editManualPairing)
        addView(manualPair)
        addView(ui.action("设备详情", action = ::showDeviceDetails), ui.spaced(top = 8))
    }

    // Derive the interface from the current connection and local permissions.
    private fun updateHome() {
        val connection = PortalState.connection
        val phase = connection.phase
        val claiming = pairingAttempt.active
        val savedUrl = PortalConfig.serverUrl(this)
        val appCount = PortalConfig.allowedPackages(this).size
        status.updateText(when {
            claiming -> "正在配对"
            !hasPairing -> "尚未配对"
            else -> phase.label
        })
        status.setTextColor(if (!claiming && phase == ConnectionPhase.ONLINE) ui.heroAccent else ui.white)
        connectionDetail.updateText(when {
            claiming -> "正在向测试服务器领取设备凭据"
            !hasPairing -> "在 AutoRush 管理台打开「Android 设备」，生成配对二维码。"
            phase == ConnectionPhase.INVALID -> "检查已保存的配对和可测试应用范围。"
            else -> savedUrl
        })
        val seconds = connection.secondsUntilRetry(SystemClock.uptimeMillis())
        val help = if (!claiming && hasPairing) describeConnection(connection, savedUrl, seconds) else ""
        connectionHelp.updateText(help)
        connectionHelp.visibility = if (help.isNotEmpty()) View.VISIBLE else View.GONE
        retryNow.visibility = if (!claiming && hasPairing && seconds != null) View.VISIBLE else View.GONE
        primary.updateText(when {
            claiming -> "取消配对"
            phase.active -> if (phase == ConnectionPhase.ONLINE) "断开连接" else "停止连接"
            !hasPairing || phase == ConnectionPhase.REJECTED -> "扫描二维码"
            else -> "连接已配对的后端"
        })
        scanAgain.visibility = if (hasPairing && phase != ConnectionPhase.REJECTED) View.VISIBLE else View.GONE
        scanAgain.isEnabled = !claiming
        manualPair.isEnabled = !claiming
        val access = PortalState.accessibilityConnected
        accessibilityStatus.updateText(if (access) "已启用" else "开启后才能执行界面测试")
        accessibilityStatus.setTextColor(if (access) ui.success else ui.muted)
        accessibilityAction.updateText(if (access) "设置" else "去开启")
        scopeDetail.updateText(when {
            PortalConfig.anyPackageAllowed(this) -> "任意应用（Portal 自身除外）"
            appCount == 0 -> "尚未添加应用"
            else -> "允许列表 · $appCount 个应用"
        })
        val previewActive = ScreenStreamer.hasActiveStream()
        val screenStatus = if (PortalState.projectionAuthorized) " · 系统录屏已授权" else ""
        screenshotDetail.updateText(if (previewActive) PortalState.screenStatus + screenStatus else "用于远程预览和运行截图")
        stopPreview.visibility = if (previewActive) View.VISIBLE else View.GONE
        autoReconnect.isEnabled = !claiming
        reconnectDetail.updateText(when {
            !hasPairing -> "完成配对后生效，支持 USB、局域网和远程 WSS。"
            !PortalConfig.lanReconnectEnabled(this) -> "已关闭。可以随时手动连接。"
            PortalConfig.lanReconnectPaused(this) -> "已暂停。手动连接后恢复。"
            else -> "打开 Portal 或连接中断后，会自动重连已配对的后端。"
        })
    }

    // Give the user an actionable hint without exposing raw network exceptions.
    private fun describeConnection(connection: ConnectionStatus, savedUrl: String, seconds: Long?): String = buildList {
        connection.failure?.let { failure ->
            if (connection.phase != ConnectionPhase.REJECTED) add(failure.label)
            add(failure.hint ?: when {
                savedUrl.startsWith("ws://") -> "请检查 USB 数据线、手机的调试授权和 PC 后端。"
                LanPairing.from(savedUrl, PortalConfig.tlsPin(this@MainActivity)) != null ->
                    "请确认手机和 PC 在同一局域网，并检查 PC 的本地 WSS 服务。"
                else -> "请检查当前网络以及远程 WSS 服务。"
            })
        }
        seconds?.let { add("${it} 秒后重试") }
    }.joinToString("\n")

    // Keep live-region announcements and text selection stable when the value is unchanged.
    private fun TextView.updateText(value: String) {
        if (text.toString() != value) text = value
    }

    // Run the action matching the visible connection state.
    private fun runPrimaryAction() {
        val phase = PortalState.connection.phase
        when {
            pairingAttempt.active -> {
                pairingAttempt.cancel()
                pairingClient.cancel()
                updateHome()
            }
            phase.active -> {
                PortalConfig.setLanReconnectPaused(this, true)
                startService(connectionIntent(PortalConnectionService.ACTION_STOP))
            }
            !hasPairing || phase == ConnectionPhase.REJECTED -> scanPairing()
            else -> startConnection()
        }
    }

    // Update discovery for the running service or start it from the visible home.
    private fun changeReconnect(enabled: Boolean) {
        PortalConfig.setLanReconnectEnabled(this, enabled)
        if (PortalState.connection.phase.active) {
            startService(connectionIntent(PortalConnectionService.ACTION_RECONNECT_SETTINGS))
        } else if (enabled) {
            maybeReconnect()
        }
        updateHome()
    }

    // Resume an eligible saved pairing when the activity becomes visible.
    private fun maybeReconnect() {
        if (PortalState.connection.phase.active || pairingAttempt.active || !hasPairing ||
            !PortalConfig.mayReconnect(this)) return
        startConnection(automatic = true)
    }

    // Launch the QR-only pairing scanner.
    private fun scanPairing() {
        if (pairingAttempt.active) return
        IntentIntegrator(this)
            .setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
            .setPrompt("扫描管理台生成的 AutoRush 配对二维码")
            .setBeepEnabled(false)
            .setBarcodeImageEnabled(false)
            .setOrientationLocked(false)
            .initiateScan()
    }

    // Pass a completed scan to pairing confirmation.
    @Suppress("OVERRIDE_DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val contents = IntentIntegrator.parseActivityResult(requestCode, resultCode, data)?.contents ?: return
        confirmPairing(contents)
    }

    // Show the server and app scope before claiming the scanned code.
    private fun confirmPairing(contents: String) {
        if (pairingAttempt.active) return
        val pairing = try {
            PairingQr.parse(contents)
        } catch (error: IllegalArgumentException) {
            showMessage(error.message ?: "二维码无效")
            return
        }
        val scope = if (PortalConfig.anyPackageAllowed(this)) "当前允许测试任意应用（Portal 自身除外）"
            else pairing.allowedPackages.joinToString("\n")
        AlertDialog.Builder(this).setTitle("确认配对")
            .setMessage(buildString {
                append("测试服务器\n${pairing.serverUrl}\n\n可测试的应用\n$scope")
                pairing.tlsSha256?.let { append("\n\n服务器证书 SHA-256\n$it") }
            })
            .setNegativeButton("取消", null)
            .setPositiveButton("确认并连接") { _, _ -> claimPairing(pairing) }
            .showPortalDialog()
    }

    // Claim the code off the UI thread and store credentials for the current attempt.
    private fun claimPairing(pairing: PairingQr) {
        val attempt = pairingAttempt.begin() ?: return
        updateHome()
        val context = applicationContext
        val device = PairingDevice(PortalConfig.deviceId(context), Build.MANUFACTURER, Build.MODEL, Build.VERSION.SDK_INT)
        pairingExecutor.execute {
            val result = runCatching { pairingClient.claim(pairing, device) }
            handler.post {
                if (isDestroyed || isFinishing || !pairingAttempt.complete(attempt)) return@post
                result.fold(onSuccess = { claimed ->
                    try {
                        PortalConfig.savePairing(context, claimed.serverUrl, claimed.deviceToken, claimed.allowedPackages,
                            claimed.tlsSha256, claimed.tlsKeySha256)
                        hasPairing = true
                        startConnection()
                    } catch (_: Exception) {
                        showMessage("无法保存配对，请重新扫描")
                    }
                }, onFailure = { showMessage("配对未完成，请检查连接或重新生成二维码") })
                updateHome()
            }
        }
    }

    // Keep scope edits as a draft until both settings are validated and saved.
    private fun editScope() {
        if (pairingAttempt.active) {
            showMessage("请等待当前配对完成")
            return
        }
        val form = ui.dialogForm()
        var allowAny = PortalConfig.anyPackageAllowed(this)
        form.addView(ui.toggle("允许测试任意应用", allowAny) { allowAny = it })
        form.addView(ui.label("保存后生效。开启时，已配对的服务器可操作其他应用（Portal 自身除外）。", 13f, ui.muted))
        val packages = ui.input("每行一个包名，也可用逗号分隔", PortalConfig.allowedPackages(this).joinToString("\n"),
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE)
        packages.id = View.generateViewId()
        form.addView(ui.label("应用允许列表", 15f, bold = true).apply { labelFor = packages.id }, ui.spaced(top = 16, bottom = 4))
        form.addView(packages)
        val dialog = formDialog("可测试的应用", form, "保存")
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            try {
                PortalConfig.saveAppScope(this, packages.text.toString(), allowAny)
                dialog.dismiss()
                updateHome()
            } catch (error: IllegalArgumentException) {
                packages.error = error.message
            }
        }
    }

    // Collect settings for the existing manual pairing path.
    private fun editManualPairing() {
        val form = ui.dialogForm()
        val url = ui.input("wss://qa.example.com/api/v1/devices/ws", PortalConfig.serverUrl(this),
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        val token = ui.input(if (hasPairing) "原地址可沿用已保存令牌" else "粘贴设备令牌", "",
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD).apply {
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        }
        val packages = ui.input("com.example.testapp", PortalConfig.allowedPackages(this).joinToString("\n"),
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE)
        listOf("服务器地址" to url, "设备令牌" to token, "应用允许列表" to packages).forEach { (label, field) ->
            field.id = View.generateViewId()
            form.addView(ui.label(label, 14f, bold = true).apply { labelFor = field.id }, ui.spaced(top = 10, bottom = 4))
            form.addView(field)
        }
        form.addView(ui.label("每行一个包名，也可用逗号分隔。USB 调试可用 adb reverse 的本机地址。", 13f, ui.muted),
            ui.spaced(top = 8))
        val dialog = formDialog("手工配对", form, "保存并连接")
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            try {
                val server = PortalConfig.validateServerUrl(url.text.toString())
                val newToken = token.text.toString().trim()
                val allowed = packages.text.toString()
                if (newToken.isNotEmpty()) {
                    PortalConfig.savePairing(this, server, newToken, PortalConfig.parseAllowedPackages(this, allowed))
                } else {
                    require(hasPairing && server == PortalConfig.serverUrl(this)) { "请输入此服务器的设备令牌" }
                    PortalConfig.saveAllowedPackages(this, allowed)
                }
                hasPairing = true
                token.text.clear()
                dialog.dismiss()
                startConnection()
            } catch (error: IllegalArgumentException) {
                showMessage(error.message ?: "检查服务器地址、令牌和应用范围")
            } catch (_: Exception) {
                showMessage("无法保存配对配置")
            }
        }
    }

    // Keep settings forms usable on small screens and with the keyboard visible.
    private fun formDialog(title: String, form: LinearLayout, submit: String): AlertDialog =
        AlertDialog.Builder(this).setTitle(title)
            .setView(ScrollView(this).apply { addView(form) })
            .setNegativeButton("取消", null).setPositiveButton(submit, null).showPortalDialog()

    // Keep dialog actions legible when the device theme uses a pale accent color.
    private fun AlertDialog.Builder.showPortalDialog(): AlertDialog = show().apply {
        getButton(AlertDialog.BUTTON_POSITIVE)?.setTextColor(ui.success)
        getButton(AlertDialog.BUTTON_NEGATIVE)?.setTextColor(ui.success)
    }

    // Show the device ID, last observation, and ADB sharing help on demand.
    private fun showDeviceDetails() {
        val id = PortalConfig.deviceId(this)
        val observed = if (PortalState.lastObservedAt == 0L) "尚无测试应用的界面事件"
            else "${PortalState.lastPackage} · ${PortalState.visibleNodeCount} 个节点\n" +
                DateFormat.getDateTimeInstance().format(Date(PortalState.lastObservedAt))
        AlertDialog.Builder(this).setTitle("设备详情")
            .setMessage("设备 ID\n$id\n\n最近一次观察\n$observed\n\nADB 整屏投屏可在管理台停止，也可拔出 USB。")
            .setNegativeButton("关闭", null)
            .setPositiveButton("复制设备 ID") { _, _ ->
                getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("AutoRush device ID", id))
                if (Build.VERSION.SDK_INT < 33) showMessage("已复制设备 ID")
            }.showPortalDialog()
    }

    // Construct an intent targeting the app-private connection service.
    private fun connectionIntent(action: String) = Intent(this, PortalConnectionService::class.java).setAction(action)

    // Start a visible connection session from the activity.
    private fun startConnection(automatic: Boolean = false) {
        val action = if (automatic) PortalConnectionService.ACTION_AUTO_CONNECT else PortalConnectionService.ACTION_CONNECT
        try {
            startForegroundService(connectionIntent(action))
        } catch (_: IllegalStateException) {
            if (!automatic) showMessage("请在 Portal 前台重试连接")
            return
        }
        val discovering = automatic && LanPairing.from(PortalConfig.serverUrl(this), PortalConfig.tlsPin(this)) != null
        PortalState.connection = ConnectionStatus(if (discovering) ConnectionPhase.SEARCHING else ConnectionPhase.CONNECTING)
        updateHome()
        if (!automatic) requestConnectionNotifications()
    }

    // Ask once for notification access after an explicit connection.
    private fun requestConnectionNotifications() {
        val settings = getPreferences(MODE_PRIVATE)
        if (Build.VERSION.SDK_INT >= 33 && !settings.getBoolean("asked_notifications", false) &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            settings.edit().putBoolean("asked_notifications", true).apply()
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    // Surface a validation or connection message.
    private fun showMessage(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    // Resume rendering and discover an eligible saved LAN server.
    override fun onResume() {
        super.onResume()
        handler.post(refresh)
        maybeReconnect()
    }

    // Pause UI refreshes while the foreground service manages the connection.
    override fun onPause() {
        handler.removeCallbacks(refresh)
        super.onPause()
    }

    // Cancel the screen's pending pairing work and release its client.
    override fun onDestroy() {
        pairingAttempt.cancel()
        pairingClient.close()
        pairingExecutor.shutdownNow()
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }
}
