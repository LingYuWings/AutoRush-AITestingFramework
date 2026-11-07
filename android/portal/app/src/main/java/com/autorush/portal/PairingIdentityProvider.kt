package com.autorush.portal

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Bundle

/** ADB can match a transport to its already-paired device UUID without reading app credentials. */
class PairingIdentityProvider : ContentProvider() {
    // Tell Android the provider is ready without any setup work.
    override fun onCreate() = true

    // Authorize the ADB caller and return the local device UUID.
    override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
        // ContentProvider.call does not consistently enforce manifest read permissions itself.
        IdentityPolicy.authorize(Binder.getCallingUid(), method)
        val appContext = context ?: error("Identity provider is not attached")
        return Bundle().apply { putString("device_id", PortalConfig.deviceId(appContext)) }
    }

    // Reject table queries because identity is exposed through call().
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?,
                       selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = unsupported()
    // Reject MIME lookups because the provider exposes no URI resources.
    override fun getType(uri: Uri): String? = unsupported()
    // Reject attempts to create records through the identity provider.
    override fun insert(uri: Uri, values: ContentValues?): Uri? = unsupported()
    // Reject attempts to change records through the identity provider.
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = unsupported()
    // Reject attempts to delete records through the identity provider.
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = unsupported()

    // Report that this provider supports only the identify call.
    private fun unsupported(): Nothing = throw UnsupportedOperationException("Only the identify call is supported")
}
