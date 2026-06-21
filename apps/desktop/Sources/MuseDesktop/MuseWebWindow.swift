import AppKit
import WebKit

/// The full Muse app window: the complete web UI (every panel — Chat, Today,
/// Tasks, Calendar, Notes, Memory, Tools, …) hosted in a native window via
/// WKWebView, so the desktop app alone reaches all of Muse. Points at the local
/// Muse web server (configurable in Settings); if it can't reach it, shows a
/// friendly card with the one command to start the local servers.
final class MuseWebWindowController: NSObject, WKNavigationDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?

    func show() {
        if window == nil { build() }
        load()
        window?.makeKeyAndOrderFront(nil)
    }

    private func build() {
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false
        )
        win.title = "Muse"
        win.titlebarAppearsTransparent = true
        win.titleVisibility = .hidden
        win.isReleasedWhenClosed = false
        win.minSize = NSSize(width: 720, height: 520)
        win.center()

        let web = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        web.navigationDelegate = self
        web.allowsBackForwardNavigationGestures = true
        win.contentView = web

        window = win
        webView = web
    }

    private func load() {
        guard let url = URL(string: PrefsStore.load().resolvedMuseURL) else { return }
        webView?.load(URLRequest(url: url))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showUnreachable()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showUnreachable()
    }

    private func showUnreachable() {
        let url = PrefsStore.load().resolvedMuseURL
        let html = """
        <html><head><meta charset="utf-8"><style>
          :root { color-scheme: dark; }
          body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
                 font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
                 background:radial-gradient(120% 120% at 50% 0%, #1b1730 0%, #0d0b16 60%, #070610 100%); color:#e7e3f5; }
          .card { max-width:560px; padding:40px; text-align:center; }
          h1 { font-size:22px; font-weight:700; margin:0 0 8px; letter-spacing:.2px; }
          p { color:#a59ec9; line-height:1.6; margin:0 0 22px; font-size:14px; }
          code { display:block; background:#17132a; border:1px solid #2c2550; border-radius:12px;
                 padding:14px 16px; color:#c9b8ff; font-size:13px; user-select:all; }
          button { margin-top:22px; background:linear-gradient(135deg,#7c5cff,#9ed1ff); border:0;
                   color:#0d0b16; font-weight:600; padding:11px 22px; border-radius:11px; font-size:14px; cursor:pointer; }
        </style></head><body><div class="card">
          <h1>Muse isn't running yet</h1>
          <p>The full app loads Muse's local web server. Start it once, then press Retry — everything (chat, tasks, calendar, notes, memory, tools) appears here.</p>
          <code>pnpm --filter @muse/api dev &amp; pnpm --filter @muse/web dev</code>
          <p style="margin-top:18px;font-size:12px;opacity:.7">Trying to reach \(url)</p>
          <button onclick="location.reload()">Retry</button>
        </div></body></html>
        """
        webView?.loadHTMLString(html, baseURL: nil)
    }
}
