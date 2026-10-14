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
    private val YOUTUBE_URL_REGEX = Regex("""https?://(?:[a-zA-Z0-9-]+\.)*(?:youtube\.com|youtu\.be)/[^\s"'<>]+""")
    private val GENERIC_URL_REGEX = Regex("""https?://[^\s"'<>]+""")

    fun extractAnyUrl(text: String?): String? {
      if (text.isNullOrBlank()) return null
      val ytMatch = YOUTUBE_URL_REGEX.find(text)?.value
      if (ytMatch != null) {
        return cleanUrl(ytMatch)
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
    val delays = longArrayOf(100L, 400L, 800L, 1500L, 2500L, 4000L)
    for (delay in delays) {
      mainHandler.postDelayed({
        if (pendingSharedUrl != null) {
          deliverPendingUrl()
        }
      }, delay)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    extractUrlFromIntent(intent)?.let {
      Log.i(TAG, "onCreate detected shared URL: $it")
      pendingSharedUrl = it
      scheduleDeliveryRetries()
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
    val url = extractUrlFromIntent(intent) ?: return
    Log.i(TAG, "onNewIntent detected shared URL: $url")
    pendingSharedUrl = url
    deliverPendingUrl()
    scheduleDeliveryRetries()
  }
}
