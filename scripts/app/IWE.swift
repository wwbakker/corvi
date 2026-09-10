// The IWE window.
//
// A real application: a Dock icon you can quit, a window whose title bar is the same colour as
// the page, and the server inside it — click the icon and IWE is there, quit it and it is not.
//
// AppKit and WebKit are in the system, so this costs a compile at install time and nothing at
// runtime: no Electron, no Rust, no second browser. It is a window onto the same HTTP server any
// browser can open, which is deliberate — the app is a convenience, not the product.

import AppKit
import Darwin
import UserNotifications
import WebKit

/// Where the code is: written into Info.plist at install time, so the binary is not rebuilt
/// when it changes. (The port is not here any more — the app picks a fresh one at launch.)
let root = Bundle.main.object(forInfoDictionaryKey: "IWERoot") as? String ?? ""
/// What this copy is called, so a sandbox copy says so in its own title bar and menu rather than
/// looking exactly like the app you use.
let name = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String
    ?? "Integrated Work Environment"
/// A fresh port every launch, so the server behind this window is always one this window
/// started: there is nothing stale on a fixed port to attach to by mistake, and the app can
/// never meet `bun run dev` on 4000. Picked by binding to port 0 and reading what the kernel
/// gave — the fixed port this replaced did exactly the opposite, attaching to whatever was
/// already listening, stale code and all.
let port = freePort() ?? 43117
let url = URL(string: "http://127.0.0.1:\(port)/")!
let logPath = ("~/Library/Logs/iwe.log" as NSString).expandingTildeInPath

/// The first port the kernel hands out on the loopback: bind to 0, read, close. Closing the
/// socket leaves a moment in which another process could take the port, but the server binds it
/// back within the second it takes to start, and losing that race is visible — the window says
/// the server did not start — where attaching to a stranger on a fixed port was silent.
func freePort() -> Int? {
    var address = sockaddr_in()
    address.sin_family = sa_family_t(AF_INET)
    address.sin_addr = in_addr(s_addr: INADDR_LOOPBACK.bigEndian)
    address.sin_port = 0
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    let bound = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    guard bound == 0 else { return nil }
    var name = sockaddr_in()
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let named = withUnsafeMutablePointer(to: &name) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            getsockname(fd, $0, &length)
        }
    }
    guard named == 0 else { return nil }
    return Int(UInt16(bigEndian: name.sin_port))
}

/// The page's own background, so the window, the title bar and the gap before the first paint are
/// all one colour instead of a white flash.
let background = NSColor(srgbRed: 0x14 / 255, green: 0x16 / 255, blue: 0x1a / 255, alpha: 1)

final class App: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate,
    WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    var window: NSWindow!
    var web: WKWebView!
    /// The server this app started — which is every launch, the port being fresh. On quit it is
    /// stopped; a server somebody started themselves was never this app's to touch.
    var server: Process?

    func applicationDidFinishLaunching(_ note: Notification) {
        // WKWebView keeps the page's accessibility tree to itself until an assistive client asks
        // for it, and a script driving the app is not recognised as one. Without this the window
        // has a single anonymous group where the buttons should be, so the app cannot be tested
        // the way it is used — and neither can it be used by VoiceOver.
        NSApp.setAccessibilityEnabled(true)
        // Notifications are the page's, shown by the host: WKWebView has no notification API of
        // its own, so the bridge below is the only way in. Asked for at launch, so the prompt
        // arrives when the app is first opened rather than the first time something finishes —
        // and asked again per notification, which costs nothing when it is already granted.
        let notifications = UNUserNotificationCenter.current()
        notifications.delegate = self
        notifications.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        buildMenu()
        buildWindow()
        // No "attach to whatever is listening" branch: on a port picked this second, nothing is
        // listening, so the server is always this app's own.
        show(message: "Starting IWE…")
        start()
    }

    // MARK: the window

    func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            // No fullSizeContentView: the page has its own navigation running to the top edge,
            // and content under the traffic lights is content you cannot click.
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = name
        // Transparent so the bar takes the window's own colour, with no separator: a dark strip
        // above the page rather than a grey one against it.
        window.titlebarAppearsTransparent = true
        window.backgroundColor = background
        window.appearance = NSAppearance(named: .darkAqua)
        window.setFrameAutosaveName("iwe")
        window.isReleasedWhenClosed = false

        let configuration = WKWebViewConfiguration()
        // The terminal is an iframe from the same origin; nothing here needs a separate process.
        configuration.websiteDataStore = .default()
        // The page's way to ask for a notification; the handler is this object (see the
        // notifications section).
        configuration.userContentController.add(self, name: "iwe")
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        // Without this the page's confirm() silently returns false and alert() does nothing:
        // WKWebView has no dialogs of its own, so every question the app asks would go
        // unanswered and every action behind one would quietly not happen.
        web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        window.contentView = web
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func show(message: String) {
        let html = """
        <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
                     background:#14161a;color:#8b93a1;
                     font:14px ui-sans-serif,system-ui,-apple-system,sans-serif">\(message)</body>
        """
        web.loadHTMLString(html, baseURL: nil)
    }

    // MARK: the server

    /// Nothing is listening when the app opens — the port was picked this second — so this is
    /// only ever the readiness probe for a server this app itself started.
    func answers() -> Bool {
        var request = URLRequest(url: url)
        request.timeoutInterval = 1
        request.httpMethod = "HEAD"
        let waiting = DispatchSemaphore(value: 0)
        var ok = false
        URLSession.shared.dataTask(with: request) { _, response, _ in
            ok = (response as? HTTPURLResponse) != nil
            waiting.signal()
        }.resume()
        _ = waiting.wait(timeout: .now() + 2)
        return ok
    }

    /// An interactive login shell, because a bundle launched from the Dock inherits nothing and
    /// `bun` and `JIRA_API_TOKEN` are exported from `~/.zshrc`, which only interactive shells read.
    func start() {
        FileManager.default.createFile(atPath: logPath, contents: nil)
        let log = FileHandle(forWritingAtPath: logPath)
        log?.seekToEndOfFile()

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        // NODE_ENV=production: the app is for using IWE, so the page is built once and served
        // built. Watching files for changes is what `bun run dev` is for.
        process.arguments = [
            "-ilc",
            "cd '\(root)' && IWE_PORT='\(port)' NODE_ENV=production exec bun src/server.ts",
        ]
        process.standardOutput = log ?? FileHandle.nullDevice
        process.standardError = log ?? FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            show(message: "Could not start the server: \(error.localizedDescription)")
            return
        }
        server = process

        DispatchQueue.global().async { [weak self] in
            for _ in 0..<100 {
                guard let self else { return }
                if self.answers() {
                    DispatchQueue.main.async { self.web.load(URLRequest(url: url)) }
                    return
                }
                Thread.sleep(forTimeInterval: 0.1)
            }
            DispatchQueue.main.async {
                self?.show(message: "The server did not start — see ~/Library/Logs/iwe.log")
            }
        }
    }

    /// Quitting the window quits the server it started. Terminals are tmux's and survive it, which
    /// is the same promise a restart of the server has always made.
    func applicationWillTerminate(_ note: Notification) {
        server?.terminate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    // MARK: chrome

    /// Without a menu there is no cmd-C, cmd-V or cmd-Q: AppKit routes those through it.
    func buildMenu() {
        let menu = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(
            withTitle: "Hide \(name)",
            action: #selector(NSApplication.hide(_:)),
            keyEquivalent: "h"
        )
        appMenu.addItem(.separator())
        appMenu.addItem(
            withTitle: "Quit \(name)",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        appItem.submenu = appMenu
        menu.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        menu.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        view.addItem(
            withTitle: "Toggle Full Screen",
            action: #selector(NSWindow.toggleFullScreen(_:)),
            keyEquivalent: "f"
        )
        viewItem.submenu = view
        menu.addItem(viewItem)

        NSApp.mainMenu = menu
    }

    @objc func reload() {
        web.reload()
    }

    // MARK: the page's questions
    //
    // A browser draws alert(), confirm() and prompt() itself; a WKWebView does not, and does not
    // fail either — it answers "false" and carries on. Cancelling a change did nothing at all,
    // and neither did any other confirmation, which is a bad way for a window to behave.

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn)
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }

    // MARK: notifications
    //
    // The page asks, the host shows. A click comes back the other way: activate the window, then
    // call the page's own `window.iwe.openWindow(change, windowId)` — the same entry point a
    // notification in a browser uses, so the navigation itself lives in one place.

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let body = message.body as? [String: Any], body["kind"] as? String == "notify" else {
            return
        }
        notify(body)
    }

    private func notify(_ body: [String: Any]) {
        let content = UNMutableNotificationContent()
        content.title = body["title"] as? String ?? name
        if let subtitle = body["subtitle"] as? String, !subtitle.isEmpty {
            content.subtitle = subtitle
        }
        content.body = body["body"] as? String ?? ""
        if body["sound"] as? Bool ?? true {
            content.sound = .default
        }
        content.userInfo = [
            "change": body["change"] as? String ?? "",
            "window": body["window"] as? String ?? "",
        ]
        // A stable identifier per change and window: a repeat replaces the banner it belongs to
        // rather than stacking a second one for the same session.
        let id = body["id"] as? String ?? UUID().uuidString
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: id, content: content, trigger: nil)
        )
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // Shown even while the app is frontmost; the page has already decided that you are not
        // looking at the window that wants you.
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        let change = info["change"] as? String ?? ""
        let windowID = info["window"] as? String ?? ""
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        if !change.isEmpty, !windowID.isEmpty {
            open(change, windowID)
        }
        completionHandler()
    }

    /// Ask the page to open what the notice was about, retrying while it loads: a click can
    /// arrive before the page's own `window.iwe` exists — a fresh launch, a reload. The attempts
    /// are a parameter rather than a counter, so the closure that retries captures nothing that
    /// changes under it.
    private func open(_ change: String, _ windowID: String, attempt: Int = 0) {
        let quote = { (value: String) in
            value.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
        }
        let script =
            "window.iwe ? (window.iwe.openWindow('\(quote(change))', '\(quote(windowID))'), true) : false"
        web.evaluateJavaScript(script) { [weak self] result, _ in
            guard let self, (result as? Bool) != true, attempt < 9 else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                self.open(change, windowID, attempt: attempt + 1)
            }
        }
    }

    // Links to Jira, GitHub and Azure DevOps belong in the browser, not in this window.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let target = action.request.url else { return decisionHandler(.allow) }
        let mine = target.host == "127.0.0.1" || target.host == "localhost"
        if mine || action.navigationType != .linkActivated {
            decisionHandler(.allow)
        } else {
            NSWorkspace.shared.open(target)
            decisionHandler(.cancel)
        }
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
