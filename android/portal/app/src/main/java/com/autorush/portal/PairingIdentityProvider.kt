package com.autorush.portal

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Bundle

/** ADB can match a transport to its already-paired device UUID without reading app credentials. */
class PairingIdentityProvider : ContentProvider() {
    override fun onCreate() = true

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
        // ContentProvider.call does not consistently enforce manifest read permissions itself.
        IdentityPolicy.authorize(Binder.getCallingUid(), method)
        val appContext = context ?: error("Identity provider is not attached")
        return Bundle().apply { putString("device_id", PortalConfig.deviceId(appContext)) }
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?,
                       selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = unsupported()
    override fun getType(uri: Uri): String? = unsupported()
    override fun insert(uri: Uri, values: ContentValues?): Uri? = unsupported()
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = unsupported()
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = unsupported()

    private fun unsupported(): Nothing = throw UnsupportedOperationException("Only the identify call is supported")
}
