@file:Suppress("DEPRECATION") // ZXing's native Activity bridge preserves the existing activity stack.

package com.autorush.portal

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import com.google.zxing.integration.android.IntentIntegrator
import java.text.DateFormat
import java.util.Date
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var status: TextView
    private lateinit var observation: TextView
    private lateinit var packages: EditText
    private lateinit var server: EditText
    private lateinit var token: EditText
    private lateinit var screenshot: CheckBox
    private lateinit var scanButton: Button
    private val pairingClient = PairingClient()
    private val pairingExecutor = Executors.newSingleThreadExecutor()
    private val pairingAttempt = PairingAttempt()
    private val refresh = object : Runnable {
        override fun run() {
            updateStatus()
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val background = Color.rgb(246, 249, 252)
        val ink = Color.rgb(22, 39, 57)
        val muted = Color.rgb(98, 116, 132)
        val mint = Color.rgb(17, 181, 139)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(30), dp(24), dp(24))
            setBackgroundColor(background)
        }
        root.addView(TextView(this).apply {
            text = "AUTORUSH  /  PORTAL"
            textSize = 12f
            setTextColor(mint)
            letterSpacing = 0.18f
        })
        root.addView(TextView(this).apply {
            text = "Android 测试助手"
            textSize = 28f
            setTextColor(ink)
            setPadding(0, dp(12), 0, dp(4))
        })
        root.addView(TextView(this).apply {
            text = "仅连接您信任的测试服务器。连接后，服务器可读取允许应用的界面并执行测试操作；截图需另行勾选。"
            textSize = 14f
            setTextColor(muted)
            setPadding(0, 0, 0, dp(24))
        })
        status = card(ink, 16f)
        root.addView(status, LinearLayout.LayoutParams(-1, -2))
        scanButton = button("扫描二维码快速配对", mint) { scanPairing() }
        root.addView(scanButton)
        root.addView(sectionLabel("手工配对"))
        root.addView(CheckBox(this).apply {
            text = "允许操作任意应用（Portal 自身除外）"
            isChecked = PortalConfig.anyPackageAllowed(this@MainActivity)
            setTextColor(ink)
            setOnCheckedChangeListener { _, allowed -> PortalConfig.setAnyPackageAllowed(this@MainActivity, allowed) }
        })
        root.addView(TextView(this).apply {
            text = "默认关闭。开启后，已配对服务器可测试其他应用；关闭后立即恢复下方允许列表。截图仍需单独允许。"
            textSize = 12f
            setTextColor(muted)
        })
        root.addView(sectionLabel("允许操作的测试应用包名（逗号分隔）"))
        packages = EditText(this).apply {
            minLines = 2
            hint = "com.example.testapp"
            textSize = 14f
            setPadding(dp(12), dp(12), dp(12), dp(12))
            setBackgroundColor(Color.WHITE)
            setText(PortalConfig.allowedPackages(this@MainActivity).joinToString(","))
        }
        root.addView(packages, LinearLayout.LayoutParams(-1, -2))
        root.addView(button("保存应用允许列表", mint) { savePackages() })
        root.addView(sectionLabel("服务器 WebSocket 地址"))
        server = EditText(this).apply {
            setSingleLine(true)
            hint = "wss://qa.example.com/api/v1/devices/ws"
            textSize = 14f
            setPadding(dp(12), dp(12), dp(12), dp(12))
            setBackgroundColor(Color.WHITE)
            setText(PortalConfig.serverUrl(this@MainActivity))
        }
        root.addView(server, LinearLayout.LayoutParams(-1, -2))
        root.addView(sectionLabel("设备令牌（保存在 Android Keystore 加密存储中）"))
        token = EditText(this).apply {
            setSingleLine(true)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            hint = if (PortalConfig.hasToken(this@MainActivity)) "已保存；重新配对时输入新令牌" else "粘贴服务器生成的设备令牌"
            textSize = 14f
            setPadding(dp(12), dp(12), dp(12), dp(12))
            setBackgroundColor(Color.WHITE)
        }
        root.addView(token, LinearLayout.LayoutParams(-1, -2))
        screenshot = CheckBox(this).apply {
            text = "允许测试服务器截取当前测试应用画面"
            isChecked = PortalConfig.screenshotAllowed(this@MainActivity)
            setTextColor(ink)
            setOnCheckedChangeListener { _, allowed -> PortalConfig.setScreenshotAllowed(this@MainActivity, allowed) }
        }
        root.addView(screenshot)
        root.addView(button("保存配对并连接", mint) { connect() })
        root.addView(button("断开连接", ink) { disconnect() })
        root.addView(TextView(this).apply {
            text = "流畅投屏由管理台通过已配对 ADB 连接，无需系统录屏授权；远程截图需开启截图许可。ADB 整屏投屏请在管理台停止或拔出 USB。"
            textSize = 12f
            setTextColor(muted)
            setPadding(0, dp(10), 0, 0)
        })
        root.addView(button("停止远程截图预览", ink) { ScreenStreamer.stopByUser() })
        root.addView(button("打开无障碍设置", ink) {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        })
        root.addView(sectionLabel("最近一次观察"))
        observation = card(muted, 13f)
        root.addView(observation, LinearLayout.LayoutParams(-1, -2))
        root.addView(TextView(this).apply {
            text = "设备 ID：${PortalConfig.deviceId(this@MainActivity)}\n仅可操作允许列表中的应用。可通过“断开连接”、通知栏断开按钮或系统无障碍设置立即停止。开发环境可通过 adb reverse 使用 ws://127.0.0.1；其他地址必须使用 wss://。"
            textSize = 12f
            setTextColor(muted)
            setPadding(0, dp(25), 0, 0)
        })
        setContentView(ScrollView(this).apply { addView(root) })
        updateStatus()
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    private fun card(color: Int, size: Float) = TextView(this).apply {
        textSize = size
        setTextColor(color)
        setPadding(dp(17), dp(18), dp(17), dp(18))
        setBackgroundColor(Color.WHITE)
    }

    private fun sectionLabel(label: String) = TextView(this).apply {
        text = label
        textSize = 13f
        setTextColor(Color.rgb(50, 72, 91))
        setPadding(0, dp(23), 0, dp(8))
    }

    private fun button(label: String, color: Int, action: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setTextColor(Color.WHITE)
        setBackgroundColor(color)
        gravity = Gravity.CENTER
        setOnClickListener { action() }
        layoutParams = LinearLayout.LayoutParams(-1, dp(48)).apply { topMargin = dp(10) }
    }

    private fun savePackages(): Boolean {
        if (pairingAttempt.active) {
            Toast.makeText(this, "正在配对，可通过断开连接取消", Toast.LENGTH_SHORT).show()
            return false
        }
        return try {
            packages.setText(PortalConfig.saveAllowedPackages(this, packages.text.toString()))
            Toast.makeText(this, "允许列表已保存", Toast.LENGTH_SHORT).show()
            true
        } catch (error: IllegalArgumentException) {
            Toast.makeText(this, error.message, Toast.LENGTH_LONG).show()
            false
        }
    }

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

    @Suppress("OVERRIDE_DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val scan = IntentIntegrator.parseActivityResult(requestCode, resultCode, data) ?: return
        val contents = scan.contents ?: return
        confirmPairing(contents)
    }

    private fun confirmPairing(contents: String) {
        if (pairingAttempt.active) return
        val pairing = try { PairingQr.parse(contents) } catch (error: IllegalArgumentException) {
            Toast.makeText(this, error.message, Toast.LENGTH_LONG).show()
            return
        }
        AlertDialog.Builder(this)
            .setTitle("确认配对")
            .setMessage("服务器：\n${pairing.serverUrl}\n\n允许列表：\n${pairing.allowedPackages.joinToString("\n")}${if (pairing.tlsSha256 != null) "\n\n本地服务器证书 SHA-256：\n${pairing.tlsSha256}" else ""}\n\n${if (PortalConfig.anyPackageAllowed(this)) "本机已开启任意应用权限。" else "服务器只能操作允许列表应用。"}截图沿用您在本机的选择。")
            .setNegativeButton("取消", null)
            .setPositiveButton("确认并连接") { _, _ -> claimPairing(pairing) }
            .show()
    }

    private fun claimPairing(pairing: PairingQr) {
        val attempt = pairingAttempt.begin() ?: return
        setPairingBusy(true)
        val context = applicationContext
        val device = PairingDevice(PortalConfig.deviceId(context), Build.MANUFACTURER, Build.MODEL, Build.VERSION.SDK_INT)
        val allowScreenshot = screenshot.isChecked
        pairingExecutor.execute {
            val result = runCatching {
                pairingClient.claim(pairing, device)
            }
            handler.post {
                if (isDestroyed || isFinishing) return@post
                if (!pairingAttempt.complete(attempt)) return@post
                setPairingBusy(false)
                result.fold(onSuccess = { claimed ->
                    try {
                        PortalConfig.savePairing(context, claimed.serverUrl, claimed.deviceToken, claimed.allowedPackages, claimed.tlsSha256)
                        PortalConfig.setScreenshotAllowed(context, allowScreenshot)
                        server.setText(PortalConfig.serverUrl(this))
                        packages.setText(PortalConfig.allowedPackages(this).joinToString(","))
                        token.setText("")
                        token.hint = "已保存；重新配对时输入新令牌"
                        startForegroundService(Intent(this, PortalConnectionService::class.java)
                            .setAction(PortalConnectionService.ACTION_CONNECT))
                        Toast.makeText(this, "配对已保存，正在连接", Toast.LENGTH_SHORT).show()
                    } catch (_: Exception) {
                        Toast.makeText(this, "无法保存或连接配对，请重新扫描", Toast.LENGTH_LONG).show()
                    }
                }, onFailure = {
                    Toast.makeText(this, "配对未完成，请检查服务器连接或重新生成二维码", Toast.LENGTH_LONG).show()
                })
            }
        }
    }

    private fun setPairingBusy(busy: Boolean) {
        scanButton.isEnabled = !busy
        scanButton.text = if (busy) "正在配对…" else "扫描二维码快速配对"
        listOf(server, packages, token, screenshot).forEach { it.isEnabled = !busy }
    }

    private fun connect() {
        if (!savePackages()) return
        try {
            val newToken = token.text.toString().trim()
            if (newToken.isNotEmpty()) {
                PortalConfig.savePairing(this, server.text.toString(), newToken)
                token.setText("")
                token.hint = "已保存；重新配对时输入新令牌"
            } else {
                require(PortalConfig.hasToken(this) && server.text.toString().trim() == PortalConfig.serverUrl(this)) {
                    "请输入设备令牌后保存配对"
                }
            }
            PortalConfig.setScreenshotAllowed(this, screenshot.isChecked)
            val intent = Intent(this, PortalConnectionService::class.java).setAction(PortalConnectionService.ACTION_CONNECT)
            startForegroundService(intent)
        } catch (error: Exception) {
            Toast.makeText(this, error.message ?: "连接失败", Toast.LENGTH_LONG).show()
        }
    }

    private fun disconnect() {
        pairingAttempt.cancel()
        pairingClient.cancel()
        setPairingBusy(false)
        startService(Intent(this, PortalConnectionService::class.java).setAction(PortalConnectionService.ACTION_STOP))
    }

    private fun updateStatus() {
        status.text = "无障碍：${if (PortalState.accessibilityConnected) "已启用" else "未启用"}\n服务器：${PortalState.serverStatus}\n画面：${PortalState.screenStatus}${if (PortalState.projectionAuthorized) "（系统录屏已授权）" else ""}"
        observation.text = if (PortalState.lastObservedAt == 0L) "尚无允许应用的界面事件"
        else "应用：${PortalState.lastPackage}\n节点数：${PortalState.visibleNodeCount}\n时间：${DateFormat.getDateTimeInstance().format(Date(PortalState.lastObservedAt))}"
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    override fun onResume() {
        super.onResume()
        handler.post(refresh)
    }

    override fun onPause() {
        handler.removeCallbacks(refresh)
        super.onPause()
    }

    override fun onDestroy() {
        pairingAttempt.cancel()
        pairingClient.close()
        pairingExecutor.shutdownNow()
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }
}
