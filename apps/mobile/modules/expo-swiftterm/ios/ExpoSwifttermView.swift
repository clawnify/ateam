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

  required init(appContext: AppContext? = nil) {
    terminal = TerminalView(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black
    terminal.terminalDelegate = self
    terminal.nativeBackgroundColor = .black
    terminal.nativeForegroundColor = UIColor(white: 0.9, alpha: 1)
    terminal.backgroundColor = .black
    // Drop SwiftTerm's built-in accessory bar (esc/tab/arrows) — we render our own
    // shortcut toolbar in RN, so this is just the plain iPhone keyboard.
    terminal.inputAccessoryView = nil

    // Auto Layout (not a hand-set frame) so the terminal's own layoutSubviews fires
    // with real bounds → processSizeChange computes the grid + renders.
    terminal.translatesAutoresizingMaskIntoConstraints = false
    addSubview(terminal)
    NSLayoutConstraint.activate([
      terminal.topAnchor.constraint(equalTo: topAnchor),
      terminal.bottomAnchor.constraint(equalTo: bottomAnchor),
      terminal.leadingAnchor.constraint(equalTo: leadingAnchor),
      terminal.trailingAnchor.constraint(equalTo: trailingAnchor),
    ])
  }

  // Called from JS (via the module's `feed` function) with raw PTY text.
  func feed(_ text: String) {
    terminal.feed(text: text)
  }

  // Keyboard control (SwiftTerm is a first responder; it has no keyboard-avoidance
  // of its own, so the RN side resizes the view and toggles focus).
  func blurKeyboard() { _ = terminal.resignFirstResponder() }
  func focusKeyboard() { _ = terminal.becomeFirstResponder() }

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
