@file:Suppress("DEPRECATION") // Explicit native consent result is forwarded only to our non-exported service.

package com.autorush.portal

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.widget.Toast

/** Opened only by the phone user; a server command never launches system consent. */
class ScreenConsentActivity : Activity() {
    private var authorizationEpoch = -1L
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        authorizationEpoch = savedInstanceState?.getLong("authorization_epoch", -1L) ?: ScreenStreamer.authorizationEpoch
        if (!ScreenStreamer.canAuthorize() || PortalState.projectionAuthorized) {
            Toast.makeText(this, "请先连接服务器并允许截图；已有授权可直接查看", Toast.LENGTH_LONG).show()
            finish()
            return
        }
        if (savedInstanceState == null) {
            val manager = getSystemService(MediaProjectionManager::class.java)
            // Full-display capture permits tracking the current foreground app with Accessibility.
            // Per-app projection can otherwise keep showing an old app after the foreground changes.
            val request = if (Build.VERSION.SDK_INT >= 34) manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
                else manager.createScreenCaptureIntent()
            startActivityForResult(request, REQUEST)
        }
    }

    @Suppress("OVERRIDE_DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST) return
        if (resultCode == RESULT_OK && data != null && ScreenStreamer.isAuthorizationCurrent(authorizationEpoch)) {
            startForegroundService(Intent(this, ScreenCaptureService::class.java).setAction(ScreenCaptureService.ACTION_GRANT)
                .putExtra(ScreenCaptureService.EXTRA_RESULT, resultCode).putExtra(ScreenCaptureService.EXTRA_DATA, data)
                .putExtra(ScreenCaptureService.EXTRA_EPOCH, authorizationEpoch))
        } else ScreenStreamer.consentDeclined()
        finish()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putLong("authorization_epoch", authorizationEpoch)
        super.onSaveInstanceState(outState)
    }

    companion object { private const val REQUEST = 70 }
}
