import ExpoModulesCore
import UIKit

// Wraps SwiftTerm's UIKit TerminalView — which is itself a UIScrollView, so native
// touch scroll, text selection (with the magnifier loupe), and copy/paste come for
// free (the whole reason we move off xterm-in-a-webview). SwiftTerm is vendored
// into this pod, so its types are in-module (no `import SwiftTerm`).
class ExpoSwifttermView: ExpoView {
  private let terminal: TerminalView

  // Push events to JS.
  let onInput = EventDispatcher() // user keystrokes/selection → { data }
  let onSizeChange = EventDispatcher() // TUI needs cols/rows → { cols, rows }

  private var didFeedBanner = false

  required init(appContext: AppContext? = nil) {
    // Start with a real (non-zero) frame so the terminal computes a valid grid
    // immediately — feeding into a 0×0 terminal (frame .zero) renders nothing.
    terminal = TerminalView(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black
    terminal.terminalDelegate = self
    // Explicit dark theme so text is visible regardless of the default palette.
    terminal.nativeBackgroundColor = .black
    terminal.nativeForegroundColor = UIColor(white: 0.9, alpha: 1)
    terminal.backgroundColor = .black
    addSubview(terminal)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard bounds.width > 0, bounds.height > 0 else { return }
    terminal.frame = bounds
    // Feed the render-proof banner only once the view actually has a size (so it
    // lands in a real grid, not a 0×0 one). Removed once the live stream is trusted.
    if !didFeedBanner {
      didFeedBanner = true
      terminal.feed(text: "\u{1b}[32mSwiftTerm native ✓\u{1b}[0m\r\nnative scroll · select · copy\r\n$ ")
    }
  }

  // Called from JS (via the module's `feed` function) with raw PTY text.
  func feed(_ text: String) {
    terminal.feed(text: text)
  }

  var cols: Int { terminal.getTerminal().cols }
  var rows: Int { terminal.getTerminal().rows }
}

extension ExpoSwifttermView: TerminalViewDelegate {
  func send(source: TerminalView, data: ArraySlice<UInt8>) {
    onInput(["data": String(decoding: data, as: UTF8.self)])
  }
  func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
    onSizeChange(["cols": newCols, "rows": newRows])
  }
  func setTerminalTitle(source: TerminalView, title: String) {}
  func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
  func scrolled(source: TerminalView, position: Double) {}
  func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {}
  func bell(source: TerminalView) {}
  func clipboardCopy(source: TerminalView, content: Data) {
    // Native selection → Copy menu lands here; put it on the iOS clipboard.
    if let s = String(data: content, encoding: .utf8) { UIPasteboard.general.string = s }
  }
  func clipboardRead(source: TerminalView) -> Data? {
    UIPasteboard.general.string?.data(using: .utf8)
  }
  func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
  func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}
