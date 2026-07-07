import ExpoModulesCore

public class ExpoSwifttermModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoSwiftterm")

    View(ExpoSwifttermView.self) {
      Events("onInput", "onSizeChange")

      // Stream PTY bytes into the terminal. A view function (imperative) — not a
      // prop — so no chunk is ever dropped by RN prop-diffing.
      AsyncFunction("feed") { (view: ExpoSwifttermView, text: String) in
        view.feed(text)
      }
      AsyncFunction("blurKeyboard") { (view: ExpoSwifttermView) in
        view.blurKeyboard()
      }
      AsyncFunction("focusKeyboard") { (view: ExpoSwifttermView) in
        view.focusKeyboard()
      }
    }
  }
}
