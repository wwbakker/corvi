// The IWE window.
//
// A real application: a Dock icon you can quit, a window whose title bar is the same colour as
// the page, and the server inside it — click the icon and IWE is there, quit it and it is not.
//
// AppKit and WebKit are in the system, so this costs a compile at install time and nothing at
// runtime: no Electron, no Rust, no second browser. It is a window onto the same HTTP server any
// browser can open, which is deliberate — the app is a convenience, not the product.

import AppKit
import WebKit

/// Where the code is and which port it serves on: written into Info.plist at install time, so the
/// binary is not rebuilt when either changes.
let root = Bundle.main.object(forInfoDictionaryKey: "IWERoot") as? String ?? ""
/// What this copy is called, so a sandbox copy says so in its own title bar and menu rather than
/// looking exactly like the app you use.
let name = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String
    ?? "Integrated Work Environment"
/// Its own port, five digits, so the app never meets `bun run dev` on 4000: the app is the
/// production build of whatever is checked out, and the dev server is for editing it.
let port = Bundle.main.object(forInfoDictionaryKey: "IWEPort") as? String ?? "43117"
let url = URL(string: "http://127.0.0.1:\(port)/")!
let logPath = ("~/Library/Logs/iwe.log" as NSString).expandingTildeInPath

/// The page's own background, so the window, the title bar and the gap before the first paint are
/// all one colour instead of a white flash.
let background = NSColor(srgbRed: 0x14 / 255, green: 0x16 / 255, blue: 0x1a / 255, alpha: 1)

final class App: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    /// The server, when this app started it — which on the app's own port is every time. A
    /// server that was somehow already there belongs to whoever started it and is left alone on
    /// quit.
    var server: Process?

    func applicationDidFinishLaunching(_ note: Notification) {
        // WKWebView keeps the page's accessibility tree to itself until an assistive client asks
        // for it, and a script driving the app is not recognised as one. Without this the window
        // has a single anonymous group where the buttons should be, so the app cannot be tested
        // the way it is used — and neither can it be used by VoiceOver.
        NSApp.setAccessibilityEnabled(true)
        buildMenu()
        buildWindow()
        if answers() {
            web.load(URLRequest(url: url))
        } else {
            show(message: "Starting IWE…")
            start()
        }
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
