package com.maxfridbe.youtubegifmaker

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private var currentWebView: WebView? = null
  private var pendingSharedUrl: String? = null
  private val mainHandler = Handler(Looper.getMainLooper())

  companion object {
    private const val TAG = "YouTubeGifMaker"

    init {
      try {
        System.loadLibrary("app_lib")
      } catch (e: Throwable) {
        Log.w(TAG, "Could not pre-load app_lib in MainActivity: $e")
      }
    }

    @JvmStatic
    external fun nativeSetSharedUrl(url: String)

    @JvmStatic
    external fun nativeRegisterActivity(activity: MainActivity)

    private val YOUTUBE_URL_REGEX = Regex("""(?:https?://)?(?:[a-zA-Z0-9-]+\.)*(?:youtube\.com|youtu\.be)/[^\s"'<>]+""")
    private val GENERIC_URL_REGEX = Regex("""https?://[^\s"'<>]+""")

    fun extractAnyUrl(text: String?): String? {
      if (text.isNullOrBlank()) return null
      val ytMatch = YOUTUBE_URL_REGEX.find(text)?.value
      if (ytMatch != null) {
        var clean = cleanUrl(ytMatch)
        if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
          clean = "https://$clean"
        }
        return clean
      }
      val genMatch = GENERIC_URL_REGEX.find(text)?.value
      if (genMatch != null) {
        return cleanUrl(genMatch)
      }
      return null
    }

    private fun cleanUrl(url: String): String {
      return url.trim().trimEnd('.', ',', ';', '!', '?', ')', ']', '>', '"', '\'')
    }

    fun extractUrlFromIntent(intent: Intent?): String? {
      if (intent == null) return null
      Log.i(TAG, "extractUrlFromIntent: action=${intent.action}, data=${intent.dataString}, type=${intent.type}")

      // 1. Data URI (e.g. ACTION_VIEW)
      intent.dataString?.let { extractAnyUrl(it) }?.let {
        Log.i(TAG, "Found URL from dataString: $it")
        return it
      }
      intent.data?.toString()?.let { extractAnyUrl(it) }?.let {
        Log.i(TAG, "Found URL from data URI: $it")
        return it
      }

      // 2. EXTRA_TEXT (as CharSequence and String)
      intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.let { extractAnyUrl(it) }?.let {
        Log.i(TAG, "Found URL from EXTRA_TEXT (CharSequence): $it")
        return it
      }

      // 3. EXTRA_SUBJECT
      intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.toString()?.let { extractAnyUrl(it) }?.let {
        Log.i(TAG, "Found URL from EXTRA_SUBJECT: $it")
        return it
      }

      // 4. ClipData
      val clipData = intent.clipData
      if (clipData != null && clipData.itemCount > 0) {
        for (i in 0 until clipData.itemCount) {
          val item = clipData.getItemAt(i)
          item.text?.toString()?.let { extractAnyUrl(it) }?.let {
            Log.i(TAG, "Found URL from clipData text: $it")
            return it
          }
          item.uri?.toString()?.let { extractAnyUrl(it) }?.let {
            Log.i(TAG, "Found URL from clipData uri: $it")
            return it
          }
          item.htmlText?.let { extractAnyUrl(it) }?.let {
            Log.i(TAG, "Found URL from clipData htmlText: $it")
            return it
          }
        }
      }

      // 5. Inspect all extras in bundle
      val extras = intent.extras
      if (extras != null) {
        for (key in extras.keySet()) {
          val v = extras.get(key)
          if (v != null) {
            extractAnyUrl(v.toString())?.let {
              Log.i(TAG, "Found URL from extra [$key]: $it")
              return it
            }
          }
        }
      }

      Log.w(TAG, "No URL found in intent")
      return null
    }
  }

  inner class AndroidShareBridge {
    @JavascriptInterface
    fun getPendingUrl(): String? {
      val url = pendingSharedUrl
      Log.i(TAG, "AndroidShareBridge.getPendingUrl() called, returning: $url")
      return url
    }

    @JavascriptInterface
    fun clearPendingUrl() {
      Log.i(TAG, "AndroidShareBridge.clearPendingUrl() called")
      pendingSharedUrl = null
    }

    @JavascriptInterface
    fun canShare(): Boolean = true

    @JavascriptInterface
    fun shareFile(filePath: String, mimeType: String, title: String): Boolean {
      Log.i(TAG, "AndroidShareBridge.shareFile($filePath, $mimeType, $title)")
      return shareFileInternal(filePath, mimeType, title)
    }

    @JavascriptInterface
    fun notifySaved(filePath: String, timeStr: String): Boolean {
      Log.i(TAG, "AndroidShareBridge.notifySaved($filePath, $timeStr)")
      return notifySavedInternal(filePath, timeStr)
    }
  }

  fun notifySavedInternal(filePath: String, timeStr: String): Boolean {
    return try {
      val srcFile = java.io.File(filePath)
      val displayTime = timeStr.ifBlank {
        java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault()).format(java.util.Date())
      }
      // Index in Android MediaStore so Downloads / Gallery apps see it immediately
      try {
        android.media.MediaScannerConnection.scanFile(this, arrayOf(filePath), null, null)
      } catch (e: Throwable) {
        Log.w(TAG, "MediaScannerConnection failed: $e")
      }

      mainHandler.post {
        try {
          android.widget.Toast.makeText(
            this,
            "Saved at $displayTime to:\n$filePath",
            android.widget.Toast.LENGTH_LONG
          ).show()
        } catch (e: Throwable) {
          Log.w(TAG, "Toast failed: $e")
        }

        try {
          val nm = getSystemService(android.content.Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
          val channelId = "saved_clips_channel"
          if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            val channel = android.app.NotificationChannel(
              channelId,
              "Saved Clips",
              android.app.NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
              description = "Notifications when clips or GIFs are saved"
            }
            nm.createNotificationChannel(channel)
          }

          val builder = androidx.core.app.NotificationCompat.Builder(this, channelId)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle("Saved ${srcFile.name} ($displayTime)")
            .setContentText(filePath)
            .setStyle(
              androidx.core.app.NotificationCompat.BigTextStyle()
                .bigText("Saved at $displayTime to:\n$filePath")
            )
            .setAutoCancel(true)
            .setPriority(androidx.core.app.NotificationCompat.PRIORITY_DEFAULT)

          if (srcFile.exists()) {
            try {
              val authority = "${applicationContext.packageName}.fileprovider"
              val uri = androidx.core.content.FileProvider.getUriForFile(this, authority, srcFile)
              val mime = when (srcFile.extension.lowercase()) {
                "gif" -> "image/gif"
                "webp" -> "image/webp"
                "mp4" -> "video/mp4"
                "webm" -> "video/webm"
                "srt" -> "text/plain"
                else -> "*/*"
              }
              val viewIntent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mime)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
              }
              val pendingFlags = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
              } else {
                android.app.PendingIntent.FLAG_UPDATE_CURRENT
              }
              val pi = android.app.PendingIntent.getActivity(this, filePath.hashCode(), viewIntent, pendingFlags)
              builder.setContentIntent(pi)
            } catch (e: Throwable) {
              Log.w(TAG, "Could not attach view intent to notification: $e")
            }
          }

          nm.notify(filePath.hashCode(), builder.build())
        } catch (e: Throwable) {
          Log.w(TAG, "System notification failed: $e")
        }
      }
      true
    } catch (e: Throwable) {
      Log.e(TAG, "notifySavedInternal failed: $e", e)
      false
    }
  }

  fun shareFileInternal(filePath: String, mimeType: String, title: String): Boolean {
    return try {
      val srcFile = java.io.File(filePath)
      if (!srcFile.exists()) {
        Log.e(TAG, "shareFileInternal: file does not exist: $filePath")
        return false
      }
      val authority = "${applicationContext.packageName}.fileprovider"
      val uri = try {
        androidx.core.content.FileProvider.getUriForFile(this, authority, srcFile)
      } catch (e: IllegalArgumentException) {
        val shareDir = java.io.File(cacheDir, "shared")
        shareDir.mkdirs()
        val dstFile = java.io.File(shareDir, srcFile.name)
        srcFile.copyTo(dstFile, overwrite = true)
        androidx.core.content.FileProvider.getUriForFile(this, authority, dstFile)
      }
      val resolvedMime = mimeType.ifBlank {
        when (srcFile.extension.lowercase()) {
          "gif" -> "image/gif"
          "webp" -> "image/webp"
          "mp4" -> "video/mp4"
          "webm" -> "video/webm"
          "srt" -> "text/plain"
          else -> "*/*"
        }
      }
      val displayTitle = title.ifBlank { srcFile.name }
      mainHandler.post {
        try {
          val sendIntent = Intent(Intent.ACTION_SEND).apply {
            type = resolvedMime
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_TITLE, displayTitle)
            clipData = android.content.ClipData.newRawUri(displayTitle, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          }
          val chooser = Intent.createChooser(sendIntent, displayTitle)
          startActivity(chooser)
        } catch (e: Throwable) {
          Log.e(TAG, "Failed to launch share chooser: $e", e)
        }
      }
      true
    } catch (e: Throwable) {
      Log.e(TAG, "shareFileInternal failed: $e", e)
      false
    }
  }

  private fun findWebView(view: View?): WebView? {
    if (view == null) return null
    if (view is WebView) return view
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) {
        val child = findWebView(view.getChildAt(i))
        if (child != null) return child
      }
    }
    return null
  }

  fun getOrCreateWebView(): WebView? {
    if (currentWebView != null) return currentWebView
    val root = findViewById<View>(android.R.id.content)
    val wv = findWebView(root)
    if (wv != null) {
      currentWebView = wv
      wv.addJavascriptInterface(AndroidShareBridge(), "_AndroidShare")
      Log.i(TAG, "Found WebView dynamically, bridge injected")
    }
    return currentWebView
  }

  fun deliverPendingUrl() {
    val url = pendingSharedUrl ?: return
    val wv = getOrCreateWebView() ?: return
    val jsonUrl = JSONObject.quote(url)
    val js = """
      (function() {
        try {
          console.log('[Native] Delivering shared URL: ' + $jsonUrl);
          if (typeof window.onSharedUrl === 'function') {
            window.onSharedUrl($jsonUrl);
          } else {
            window._pendingSharedUrls = window._pendingSharedUrls || [];
            window._pendingSharedUrls.push($jsonUrl);
          }
        } catch(e) {
          console.error('[Native] Error delivering URL:', e);
        }
      })();
    """.trimIndent()

    wv.post {
      wv.evaluateJavascript(js, null)
    }
  }

  private fun scheduleDeliveryRetries() {
    val delays = longArrayOf(100L, 300L, 600L, 1000L, 1800L, 2800L, 4200L, 6000L)
    for (delay in delays) {
      mainHandler.postDelayed({
        if (pendingSharedUrl != null) {
          deliverPendingUrl()
        }
      }, delay)
    }
  }

  private fun onUrlReceived(url: String, source: String) {
    Log.i(TAG, "[$source] detected shared URL: $url")
    pendingSharedUrl = url
    try {
      nativeSetSharedUrl(url)
      Log.i(TAG, "[$source] forwarded URL to native backend: $url")
    } catch (e: Throwable) {
      Log.w(TAG, "nativeSetSharedUrl call failed: $e")
    }
    deliverPendingUrl()
    scheduleDeliveryRetries()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    try {
      nativeRegisterActivity(this)
    } catch (e: Throwable) {
      Log.w(TAG, "nativeRegisterActivity failed: $e")
    }

    if (android.os.Build.VERSION.SDK_INT >= 33) {
      if (checkSelfPermission("android.permission.POST_NOTIFICATIONS") != android.content.pm.PackageManager.PERMISSION_GRANTED) {
        requestPermissions(arrayOf("android.permission.POST_NOTIFICATIONS"), 1001)
      }
    }

    extractUrlFromIntent(intent)?.let {
      onUrlReceived(it, "onCreate")
    }

    // Edge-to-edge draws the WebView under the status/navigation bars, so the page
    // header ends up beneath the status bar and taps there hit the system UI.
    // Pad the content by the system-bar / cutout / keyboard insets instead.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime()
      )
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    currentWebView = webView
    webView.addJavascriptInterface(AndroidShareBridge(), "_AndroidShare")
    Log.i(TAG, "onWebViewCreate called, bridge injected")
    if (pendingSharedUrl != null) {
      deliverPendingUrl()
      scheduleDeliveryRetries()
    }
  }

  override fun onResume() {
    super.onResume()
    getOrCreateWebView()
    extractUrlFromIntent(intent)?.let {
      if (it != pendingSharedUrl) {
        onUrlReceived(it, "onResume")
      }
    }
    if (pendingSharedUrl != null) {
      deliverPendingUrl()
    }
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus && pendingSharedUrl != null) {
      deliverPendingUrl()
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    extractUrlFromIntent(intent)?.let {
      onUrlReceived(it, "onNewIntent")
    }
  }
}
