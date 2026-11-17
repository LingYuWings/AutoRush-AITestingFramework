@file:Suppress("DEPRECATION") // The resolveService API also works on Android 8–13.

package com.autorush.portal

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import java.net.Inet4Address

/** Resolves AutoRush services while a connection is looking for its paired backend. */
internal class LanServiceDiscovery(context: Context) {
    private val manager = context.getSystemService(NsdManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private var session: Scan? = null
    private var resolving = false

    // Start one scan, using the current pairing to filter resolved services.
    fun start(pairing: LanPairing, found: (String) -> Unit, lost: (String) -> Unit) {
        if (session != null) return
        val scan = Scan(pairing, found, lost)
        session = scan
        if (runCatching { manager.discoverServices("_autorush._tcp.", NsdManager.PROTOCOL_DNS_SD, scan) }.isFailure) {
            session = null
        }
    }

    // Stop scanning and ignore callbacks from the old scan.
    fun stop() {
        val scan = session ?: return
        session = null
        runCatching { manager.stopServiceDiscovery(scan) }
    }

    // Serialize platform resolutions, including those still finishing from a stopped scan.
    private fun resolveNext() {
        val scan = session ?: return
        if (resolving) return
        val service = scan.pending.entries.firstOrNull()?.let { scan.pending.remove(it.key) } ?: return
        resolving = true
        val listener = object : NsdManager.ResolveListener {
            // Continue with the next candidate after a failed resolution.
            override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) = resolved(null)

            // Check the resolved address and TXT fingerprints against the saved pairing.
            override fun onServiceResolved(info: NsdServiceInfo) = resolved(info)

            // Release the shared resolver and deliver results only to the still-current scan.
            private fun resolved(info: NsdServiceInfo?) {
                main.post {
                    resolving = false
                    if (session === scan && info != null && scan.known.contains(service.serviceName)) {
                        val host = (info.host as? Inet4Address)?.hostAddress
                        val endpoint = scan.pairing.endpoint(host, info.port,
                            info.attributes["cert"]?.decodeToString(), info.attributes["key"]?.decodeToString())
                        if (endpoint != null) {
                            scan.endpoints[service.serviceName] = endpoint
                            scan.found(endpoint)
                        }
                    }
                    resolveNext()
                }
            }
        }
        if (runCatching { manager.resolveService(service, listener) }.isFailure) {
            listener.onResolveFailed(service, NsdManager.FAILURE_INTERNAL_ERROR)
        }
    }

    // Track candidate names and endpoints for a single Android discovery session.
    private inner class Scan(val pairing: LanPairing, val found: (String) -> Unit, val lost: (String) -> Unit) :
        NsdManager.DiscoveryListener {
        val known = mutableSetOf<String>()
        val pending = linkedMapOf<String, NsdServiceInfo>()
        val endpoints = mutableMapOf<String, String>()

        // Discovery is now active; results arrive separately.
        override fun onDiscoveryStarted(serviceType: String) = Unit

        // Queue each AutoRush service once while it remains visible.
        override fun onServiceFound(service: NsdServiceInfo) {
            main.post {
                if (session !== this || !service.serviceName.startsWith("AutoRush-", ignoreCase = true)) return@post
                if (known.size < 64 && known.add(service.serviceName)) {
                    pending[service.serviceName] = service
                    resolveNext()
                }
            }
        }

        // Drop vanished endpoints and allow the service to be resolved when it returns.
        override fun onServiceLost(service: NsdServiceInfo) {
            main.post {
                if (session !== this) return@post
                known.remove(service.serviceName)
                pending.remove(service.serviceName)
                endpoints.remove(service.serviceName)?.let(lost)
            }
        }

        // Release a failed scan so the next connection attempt can start it again.
        override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
            main.post { if (session === this) stop() }
        }

        // Clear a stopped session if Android still associates it with this scan.
        override fun onDiscoveryStopped(serviceType: String) {
            main.post { if (session === this) session = null }
        }

        // Discard a scan whose system stop failed; its callbacks are no longer used.
        override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = onDiscoveryStopped(serviceType)
    }
}
