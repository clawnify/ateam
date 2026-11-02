// A capsule of Liquid Glass behind the app's floating pills (src/GlassPill.tsx).
// expo-glass-effect is the general version, but its views are Fabric-only since
// 0.1.3 and this app runs React Native's legacy architecture. Once it moves to
// the New Architecture, expo-glass-effect replaces this module.
import ExpoModulesCore
import UIKit

public final class GlassPillModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoGlassPill")

    Constant("available") { GlassPillView.supported }

    View(GlassPillView.self) {
      Prop("dissolved") { (view: GlassPillView, dissolved: Bool) in
        view.setDissolved(dissolved)
      }
    }
  }
}

public final class GlassPillView: ExpoView {
  /// iOS 26 with the API there: some iOS 26 betas lacked it and crashed creating
  /// one (expo/expo#40911).
  static var supported: Bool {
    #if compiler(>=6.2)
    if #available(iOS 26.0, *) {
      guard let glass = NSClassFromString("UIGlassEffect") as? NSObject.Type else { return false }
      return glass.responds(to: Selector(("effectWithStyle:")))
    }
    #endif
    return false
  }

  private let effectView = UIVisualEffectView()
  private var dissolved = false
  private var laidOut = false

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    effectView.frame = bounds
    effectView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    // The pill's React children sit over it and take the touches.
    effectView.isUserInteractionEnabled = false
    // The app is dark whatever the system's setting.
    effectView.overrideUserInterfaceStyle = .dark
    insertSubview(effectView, at: 0)
    #if compiler(>=6.2)
    if #available(iOS 26.0, *) {
      effectView.cornerConfiguration = .capsule()
    }
    #endif
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    // The effect only renders on a view that has been laid out (expo/expo#41024).
    if !laidOut {
      laidOut = true
      apply(animated: false)
    }
  }

  func setDissolved(_ value: Bool) {
    guard value != dissolved else { return }
    dissolved = value
    if laidOut { apply(animated: true) }
  }

  /// Dissolving animates the glass away, the way UIKit dematerializes it; the
  /// pill's contents fade on the React side.
  private func apply(animated: Bool) {
    guard Self.supported else { return }
    #if compiler(>=6.2)
    if #available(iOS 26.0, *) {
      // An empty effect rather than nil, which expo-glass-effect found unreliable.
      let effect = dissolved ? UIVisualEffect() : UIGlassEffect(style: .regular)
      if animated {
        UIView.animate(withDuration: dissolved ? 0.12 : 0.2) { self.effectView.effect = effect }
      } else {
        effectView.effect = effect
      }
    }
    #endif
  }
}
