import SwiftUI
import WebKit

struct VKAuthSheet: View {
    let authURL: URL
    let onSuccess: (String, String?, String?) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VKAuthWebView(authURL: authURL, onSuccess: onSuccess)
                .navigationTitle("VK Login")
                .navigationBarTitleDisplayModeCompat()
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                            .foregroundStyle(Color.textPrimary)
                    }
                }
        }
    }
}

#if os(iOS)
struct VKAuthWebView: UIViewRepresentable {
    let authURL: URL
    let onSuccess: (String, String?, String?) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onSuccess: onSuccess)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.load(URLRequest(url: authURL))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        private let onSuccess: (String, String?, String?) -> Void
        private var handled = false

        init(onSuccess: @escaping (String, String?, String?) -> Void) {
            self.onSuccess = onSuccess
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            inspectForToken(webView)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @MainActor @Sendable @escaping (WKNavigationActionPolicy) -> Void
        ) {
            if handleTokenURL(navigationAction.request.url) {
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
            inspectForToken(webView)
        }

        private func handleTokenURL(_ url: URL?) -> Bool {
            guard !handled, let url, url.absoluteString.contains("#access_token=") else { return false }
            guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
            let fragment = components.fragment ?? ""
            let params = URLComponents(string: "https://dummy?\(fragment)")?.queryItems ?? []
            guard let token = params.first(where: { $0.name == "access_token" })?.value else { return false }
            let userId = params.first(where: { $0.name == "user_id" })?.value
            let state = params.first(where: { $0.name == "state" })?.value
            handled = true
            onSuccess(token, userId, state)
            return true
        }

        private func inspectForToken(_ webView: WKWebView) {
            guard !handled else { return }

            webView.evaluateJavaScript("window.location.href") { [weak self] result, _ in
                guard let self, !self.handled else { return }
                guard let href = result as? String, href.contains("#access_token=") else { return }
                guard let components = URLComponents(string: href) else { return }
                let fragment = components.fragment ?? ""
                let params = URLComponents(string: "https://dummy?\(fragment)")?.queryItems ?? []
                guard let token = params.first(where: { $0.name == "access_token" })?.value else { return }
                let userId = params.first(where: { $0.name == "user_id" })?.value
                let state = params.first(where: { $0.name == "state" })?.value
                self.handled = true
                self.onSuccess(token, userId, state)
            }
        }
    }
}
#elseif os(macOS)
struct VKAuthWebView: NSViewRepresentable {
    let authURL: URL
    let onSuccess: (String, String?, String?) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onSuccess: onSuccess)
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.load(URLRequest(url: authURL))
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        private let onSuccess: (String, String?, String?) -> Void
        private var handled = false

        init(onSuccess: @escaping (String, String?, String?) -> Void) {
            self.onSuccess = onSuccess
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            inspectForToken(webView)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @MainActor @Sendable @escaping (WKNavigationActionPolicy) -> Void
        ) {
            if handleTokenURL(navigationAction.request.url) {
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
            inspectForToken(webView)
        }

        private func handleTokenURL(_ url: URL?) -> Bool {
            guard !handled, let url, url.absoluteString.contains("#access_token=") else { return false }
            guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
            let fragment = components.fragment ?? ""
            let params = URLComponents(string: "https://dummy?\(fragment)")?.queryItems ?? []
            guard let token = params.first(where: { $0.name == "access_token" })?.value else { return false }
            let userId = params.first(where: { $0.name == "user_id" })?.value
            let state = params.first(where: { $0.name == "state" })?.value
            handled = true
            onSuccess(token, userId, state)
            return true
        }

        private func inspectForToken(_ webView: WKWebView) {
            guard !handled else { return }

            webView.evaluateJavaScript("window.location.href") { [weak self] result, _ in
                guard let self, !self.handled else { return }
                guard let href = result as? String, href.contains("#access_token=") else { return }
                guard let components = URLComponents(string: href) else { return }
                let fragment = components.fragment ?? ""
                let params = URLComponents(string: "https://dummy?\(fragment)")?.queryItems ?? []
                guard let token = params.first(where: { $0.name == "access_token" })?.value else { return }
                let userId = params.first(where: { $0.name == "user_id" })?.value
                let state = params.first(where: { $0.name == "state" })?.value
                self.handled = true
                self.onSuccess(token, userId, state)
            }
        }
    }
}
#endif
