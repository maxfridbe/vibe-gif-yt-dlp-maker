package com.maxfridbe.youtubegifmaker

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private var currentWebView: WebView? = null
  private var pendingSharedUrl: String? = null

  companion object {
    private val YOUTUBE_URL_REGEX = Regex("""https?://(?:[a-zA-Z0-9-]+\.)*(?:youtube\.com|youtu\.be)/[^\s"'<>]+""")

    fun extractYoutubeUrl(text: String?): String? {
      if (text.isNullOrBlank()) return null
      val match = YOUTUBE_URL_REGEX.find(text)?.value ?: return null
      return match.trimEnd('.', ',', ';', '!', '?', ')', ']')
    }

    fun extractUrlFromIntent(intent: Intent?): String? {
      if (intent == null) return null
      // 1. Data URI (e.g. ACTION_VIEW)
      intent.dataString?.let { extractYoutubeUrl(it) }?.let { return it }

      // 2. EXTRA_TEXT (e.g. ACTION_SEND from YouTube app)
      intent.getStringExtra(Intent.EXTRA_TEXT)?.let { extractYoutubeUrl(it) }?.let { return it }

      // 3. ClipData
      val clipData = intent.clipData
      if (clipData != null && clipData.itemCount > 0) {
        for (i in 0 until clipData.itemCount) {
          val item = clipData.getItemAt(i)
          item.text?.toString()?.let { extractYoutubeUrl(it) }?.let { return it }
          item.uri?.toString()?.let { extractYoutubeUrl(it) }?.let { return it }
        }
      }
      return null
    }
  }

  inner class AndroidShareBridge {
    @JavascriptInterface
    fun getPendingUrl(): String? {
      val url = pendingSharedUrl
      pendingSharedUrl = null
      return url
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    extractUrlFromIntent(intent)?.let {
      pendingSharedUrl = it
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
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    val url = extractUrlFromIntent(intent) ?: return
    pendingSharedUrl = url

    currentWebView?.let { wv ->
      val jsonUrl = JSONObject.quote(url)
      wv.post {
        wv.evaluateJavascript("window.onSharedUrl && window.onSharedUrl($jsonUrl);", null)
      }
    }
  }
}
