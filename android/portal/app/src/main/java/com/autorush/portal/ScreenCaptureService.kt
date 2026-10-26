@file:Suppress("DEPRECATION") // Real display metrics are needed on Android 8–10.

package com.autorush.portal

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.util.DisplayMetrics
import android.view.WindowManager
import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicBoolean

/** One explicit system grant, one projection, and an independently stoppable foreground service. */
class ScreenCaptureService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private val workerThread = HandlerThread("portal-jpeg")
    private lateinit var worker: Handler
    private val processing = AtomicBoolean(false)
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var width = 0
    private var height = 0
    private var density = 1
    private var sourceWidth = 1
    private var sourceHeight = 1
    @Volatile private var stopping = false
    private var projectionVisible = true
    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() { stopSharing("系统已停止录屏") }
        override fun onCapturedContentResize(width: Int, height: Int) { resize(width, height) }
        override fun onCapturedContentVisibilityChanged(isVisible: Boolean) {
            projectionVisible = isVisible
            if (!isVisible) ScreenStreamer.projectionBlocked("系统录屏画面不可见")
        }
    }
    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) {}
        override fun onDisplayRemoved(displayId: Int) { if (displayId == 0) stopSharing("屏幕已移除") }
        override fun onDisplayChanged(displayId: Int) {
            if (displayId == 0 && Build.VERSION.SDK_INT < 34) {
                val metrics = metrics()
                resize(metrics.widthPixels, metrics.heightPixels)
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate()
        workerThread.start()
        worker = Handler(workerThread.looper)
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "AutoRush 屏幕共享", NotificationManager.IMPORTANCE_LOW))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            ScreenStreamer.stopByUser()
            stopSharing("手机已停止共享")
            return START_NOT_STICKY
        }
        if (intent?.action != ACTION_GRANT || projection != null) return START_NOT_STICKY
        // A delayed result from an obsolete consent dialog must not stop or change a new stream.
        if (!ScreenStreamer.isAuthorizationCurrent(intent.getLongExtra(EXTRA_EPOCH, -1L))) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        try {
            require(intent.getIntExtra(EXTRA_RESULT, Activity.RESULT_CANCELED) == Activity.RESULT_OK)
            val grant = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(EXTRA_DATA, Intent::class.java)
                else intent.getParcelableExtra(EXTRA_DATA)
            requireNotNull(grant)
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
            else startForeground(NOTIFICATION, notification())
            val manager = getSystemService(MediaProjectionManager::class.java)
            val active = manager.getMediaProjection(Activity.RESULT_OK, grant) ?: error("无法取得系统录屏授权")
            projection = active
            active.registerCallback(projectionCallback, main)
            val metrics = metrics()
            density = metrics.densityDpi
            sourceWidth = metrics.widthPixels
            sourceHeight = metrics.heightPixels
            val dimensions = ScreenFrames.dimensions(metrics.widthPixels, metrics.heightPixels)
            width = dimensions.first
            height = dimensions.second
            reader = newReader(width, height)
            display = active.createVirtualDisplay("AutoRush shared screen", width, height, density,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader!!.surface, null, main)
            instance = this
            PortalState.projectionAuthorized = true
            getSystemService(DisplayManager::class.java).registerDisplayListener(displayListener, main)
            ScreenStreamer.projectionAvailable()
        } catch (error: Exception) {
            ScreenStreamer.projectionError(error.message ?: "录屏启动失败")
            stopSharing("录屏启动失败")
        }
        return START_NOT_STICKY
    }

    private fun metrics() = DisplayMetrics().also { getSystemService(WindowManager::class.java).defaultDisplay.getRealMetrics(it) }

    private fun newReader(width: Int, height: Int): ImageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2).also {
        it.setOnImageAvailableListener({ source ->
            val image = runCatching { source.acquireLatestImage() }.getOrNull() ?: return@setOnImageAvailableListener
            if (stopping || !processing.compareAndSet(false, true)) {
                image.close()
                return@setOnImageAvailableListener
            }
            main.post {
                val ticket = ScreenStreamer.smoothTicket()
                try {
                    check(!stopping && instance === this && ticket != null) { "画面流已停止" }
                    check(projectionVisible) { "系统录屏画面不可见" }
                    val accessibility = PortalAccessibilityService.instance ?: error("无障碍服务未启用")
                    val pkg = accessibility.currentCapturePackage()
                    val bounds = accessibility.currentCaptureBounds(pkg)
                    val epoch = accessibility.captureEpochNs
                    check(CapturePolicy.accepts(PortalConfig.screenshotAllowed(this), packageName, PortalConfig.anyPackageAllowed(this),
                        PortalConfig.allowedPackages(this), pkg, pkg, null, image.timestamp, epoch)) { "正在等待新应用的画面" }
                    val capturedAt = System.currentTimeMillis()
                    val screenWidth = sourceWidth
                    val screenHeight = sourceHeight
                    worker.post {
                        try {
                            val captured = encode(image, pkg, capturedAt, bounds, screenWidth, screenHeight)
                            main.post {
                                if (instance === this && !stopping && projectionVisible && ScreenStreamer.isCurrent(ticket)) {
                                    ScreenStreamer.send(ticket, captured, epoch)
                                }
                            }
                        } catch (error: Exception) {
                            main.post { if (ScreenStreamer.isCurrent(ticket)) ScreenStreamer.blocked(ticket, error.message ?: "画面编码失败") }
                        } finally {
                            image.close()
                            processing.set(false)
                        }
                    }
                } catch (error: Exception) {
                    ticket?.let { ScreenStreamer.blocked(it, error.message ?: "当前画面已阻止") }
                    image.close()
                    processing.set(false)
                }
            }
        }, worker)
    }

    private fun encode(image: Image, pkg: String, capturedAt: Long, bounds: CaptureBounds, screenWidth: Int, screenHeight: Int): CapturedScreen {
        var padded: Bitmap? = null
        var cropped: Bitmap? = null
        try {
            val plane = image.planes[0]
            require(plane.pixelStride == 4) { "录屏像素格式不受支持" }
            val paddedWidth = plane.rowStride / plane.pixelStride
            padded = Bitmap.createBitmap(paddedWidth, image.height, Bitmap.Config.ARGB_8888)
            plane.buffer.rewind()
            padded.copyPixelsFromBuffer(plane.buffer)
            val crop = CaptureSurface.crop(bounds, screenWidth, screenHeight, image.width, image.height)
            cropped = Bitmap.createBitmap(padded, crop.left, crop.top, crop.width, crop.height)
            val stream = ByteArrayOutputStream()
            check(cropped.compress(Bitmap.CompressFormat.JPEG, ScreenFrames.QUALITY, stream)) { "JPEG 编码失败" }
            val bytes = stream.toByteArray()
            check(bytes.size <= ScreenFrames.MAX_JPEG) { "画面超过 JPEG 限额" }
            return CapturedScreen(bytes, pkg, capturedAt, crop.width, crop.height, bounds)
        } finally {
            if (cropped !== padded) cropped?.recycle()
            padded?.recycle()
        }
    }

    private fun resize(sourceWidth: Int, sourceHeight: Int) {
        if (stopping || sourceWidth <= 0 || sourceHeight <= 0) return
        val dimensions = ScreenFrames.dimensions(sourceWidth, sourceHeight)
        if (sourceWidth != this.sourceWidth || sourceHeight != this.sourceHeight) {
            PortalAccessibilityService.instance?.invalidateCapture()
            this.sourceWidth = sourceWidth
            this.sourceHeight = sourceHeight
        }
        if (dimensions == width to height) return
        val currentDisplay = display ?: return
        val previous = reader
        width = dimensions.first
        height = dimensions.second
        reader = newReader(width, height)
        currentDisplay.resize(width, height, density)
        currentDisplay.surface = reader!!.surface
        previous?.setOnImageAvailableListener(null, null)
        previous?.close()
    }

    internal fun stopSharing(detail: String) {
        if (stopping) return
        stopping = true
        val ownedProjection = instance === this || projection != null
        if (instance === this) instance = null
        if (ownedProjection) {
            PortalState.projectionAuthorized = false
            ScreenStreamer.projectionStopped(detail)
        }
        getSystemService(DisplayManager::class.java).unregisterDisplayListener(displayListener)
        reader?.setOnImageAvailableListener(null, null)
        display?.release()
        display = null
        reader?.close()
        reader = null
        projection?.unregisterCallback(projectionCallback)
        projection?.stop()
        projection = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun notification(): Notification {
        val open = PendingIntent.getActivity(this, 21, Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 22, Intent(this, ScreenCaptureService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentTitle("AutoRush 屏幕共享已授权").setContentText("仅共享允许的测试应用；点击停止可结束系统录屏")
            .setContentIntent(open).addAction(android.R.drawable.ic_menu_close_clear_cancel, "停止共享", stop).setOngoing(true).build()
    }

    override fun onDestroy() {
        stopSharing("录屏服务已结束")
        workerThread.quitSafely()
        super.onDestroy()
    }

    companion object {
        @Volatile internal var instance: ScreenCaptureService? = null
            private set
        const val ACTION_GRANT = "com.autorush.portal.SCREEN_GRANT"
        const val ACTION_STOP = "com.autorush.portal.SCREEN_STOP"
        const val EXTRA_RESULT = "projection_result"
        const val EXTRA_DATA = "projection_data"
        const val EXTRA_EPOCH = "projection_epoch"
        private const val CHANNEL = "portal_screen"
        private const val NOTIFICATION = 1002
    }
}
