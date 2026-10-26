package com.autorush.portal

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** A visible, user-started reverse WebSocket. Never auto-starts after reboot. */
class PortalConnectionService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS).connectTimeout(10, TimeUnit.SECONDS).build()
    private var socket: WebSocket? = null
    private var stopped = true
    private var attempt = 0
    private var accepted = false
    private val busy = AtomicBoolean(false)
    private val reconnect = Runnable { connect() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "AutoRush 设备连接", NotificationManager.IMPORTANCE_LOW))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            shutdown()
            return START_NOT_STICKY
        }
        if (intent?.action != ACTION_CONNECT) return START_NOT_STICKY
        startForeground(NOTIFICATION_ID, notification("正在连接测试服务器"))
        stopped = false
        attempt = 0
        accepted = false
        main.removeCallbacks(reconnect)
        socket?.let(ScreenStreamer::detach)
        socket?.close(1000, "reconfigure")
        connect()
        return START_NOT_STICKY
    }

    private fun connect() {
        if (stopped) return
        val url = try { PortalConfig.validateServerUrl(PortalConfig.serverUrl(this)) } catch (_: Exception) { "" }
        val token = PortalConfig.token(this)
        if (url.isEmpty() || token == null || (PortalConfig.allowedPackages(this).isEmpty() && !PortalConfig.anyPackageAllowed(this))) {
            shutdown("连接配置不完整")
            return
        }
        PortalState.serverStatus = "连接中"
        updateNotification("连接中")
        val request = Request.Builder().url(url).header("Authorization", "Bearer $token").build()
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                main.post {
                    if (stopped || socket !== webSocket) return@post
                    accepted = false
                    val hello = JSONObject().put("type", "hello").put("protocol", 1)
                        .put("device_id", PortalConfig.deviceId(this@PortalConnectionService))
                        .put("app_version", "0.5.1")
                    webSocket.send(hello.toString())
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (text.length > 16_384) {
                    webSocket.close(1009, "message too large")
                    return
                }
                main.post {
                    if (stopped || socket !== webSocket) return@post
                    val message = try { JSONObject(text) } catch (_: Exception) { return@post }
                    if (message.optString("type") == "hello.ack" && message.optInt("protocol") == 1) {
                        accepted = true
                        ScreenStreamer.bind(this@PortalConnectionService, webSocket)
                        attempt = 0
                        PortalState.serverStatus = "已连接"
                        updateNotification("已连接测试服务器")
                    } else if (accepted && message.optString("type") == "command") {
                        dispatch(webSocket, message)
                    }
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                main.post { if (socket === webSocket) disconnected(code in listOf(1008, 4001)) }
            }

            override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
                main.post {
                    if (socket === webSocket) disconnected(response?.code in listOf(401, 403))
                }
            }
        }
        val configured = PinnedTls.configure(client.newBuilder().followRedirects(false).followSslRedirects(false), PortalConfig.tlsPin(this)).build()
        socket = configured.newWebSocket(request, listener)
    }

    private fun dispatch(webSocket: WebSocket, message: JSONObject) {
        val id = message.optString("id")
        if (id.length !in 1..100 || !id.all { it.isLetterOrDigit() || it in "-_" }) return
        val method = message.optString("method")
        val params = message.optJSONObject("params") ?: JSONObject()
        // Viewing lifecycle coexists with an exclusive action or asynchronous launch/screenshot.
        if (method == "screen.start" || method == "screen.stop") {
            reply(webSocket, id, runCatching {
                if (method == "screen.start") ScreenStreamer.start(this, webSocket, params)
                else ScreenStreamer.stop(params)
            })
            return
        }
        if (!busy.compareAndSet(false, true)) {
            reply(webSocket, id, Result.failure(IllegalStateException("设备正在执行另一条命令")))
            return
        }
        val completed = AtomicBoolean(false)
        lateinit var timeout: Runnable
        val finish: (Result<JSONObject>) -> Unit = { result ->
            if (completed.compareAndSet(false, true)) {
                main.removeCallbacks(timeout)
                busy.set(false)
                reply(webSocket, id, result)
            }
        }
        timeout = Runnable { finish(Result.failure(IllegalStateException("操作超时"))) }
        main.postDelayed(timeout, 15_000)
        val service = PortalAccessibilityService.instance
        if (service == null || !PortalState.accessibilityConnected) {
            finish(Result.failure(IllegalStateException("无障碍服务未启用")))
            return
        }
        service.execute(method, params, finish)
    }

    private fun reply(webSocket: WebSocket, id: String, result: Result<JSONObject>) {
        if (socket !== webSocket || stopped) return
        val body = JSONObject().put("type", "response").put("id", id)
        result.fold(
            onSuccess = { body.put("ok", true).put("result", it) },
            onFailure = { body.put("ok", false).put("error", it.message?.take(200) ?: "操作失败") },
        )
        webSocket.send(body.toString())
    }

    private fun disconnected(terminal: Boolean) {
        socket?.let(ScreenStreamer::detach)
        socket = null
        accepted = false
        if (stopped) return
        if (terminal) {
            PortalState.serverStatus = "令牌被拒绝；请检查配对配置"
            updateNotification("连接被拒绝")
            stopped = true
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }
        attempt = (attempt + 1).coerceAtMost(6)
        val delay = (1_000L shl attempt).coerceAtMost(30_000L)
        PortalState.serverStatus = "已断开，${delay / 1000} 秒后重连"
        updateNotification(PortalState.serverStatus)
        main.removeCallbacks(reconnect)
        main.postDelayed(reconnect, delay)
    }

    private fun notification(content: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1,
            Intent(this, PortalConnectionService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("AutoRush Portal")
            .setContentText(content)
            .setContentIntent(open)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "断开", stop)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(content: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(content))
    }

    private fun shutdown(finalStatus: String = "未连接") {
        stopped = true
        accepted = false
        main.removeCallbacks(reconnect)
        socket?.let(ScreenStreamer::detach)
        socket?.close(1000, "user disconnect")
        socket = null
        PortalState.serverStatus = finalStatus
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        stopped = true
        main.removeCallbacksAndMessages(null)
        socket?.let(ScreenStreamer::detach)
        socket?.cancel()
        client.dispatcher.executorService.shutdown()
        super.onDestroy()
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        shutdown("已达到系统后台运行时限")
    }

    companion object {
        const val ACTION_CONNECT = "com.autorush.portal.CONNECT"
        const val ACTION_STOP = "com.autorush.portal.STOP"
        private const val CHANNEL_ID = "portal_connection"
        private const val NOTIFICATION_ID = 1001
    }
}
