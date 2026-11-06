// A call with the Lead as a system call (CallKit), so it behaves like a phone
// or WhatsApp call: the green pill, mute and end in the system call screen and
// on the lock screen, the earpiece, the speaker or AirPods, and a real phone
// call that holds it. Outgoing only: the Lead never rings the phone (that needs
// VoIP push from a server, and Ateam has none).
//
// The call itself runs in JS (@ateam/protocol lead-call.ts, on
// react-native-webrtc). This gives it the system call; the audio session's
// hand-off, which JS passes on to WebRTC (RTCAudioSession.audioSessionDidActivate,
// react-native-webrtc's CallKit hook); the mic's level while the call is on
// hold, when no WebRTC session holds the mic; the speaker; and the chime.
//
// Calls are off in mainland China, where CallKit isn't allowed (the user's
// decision, 2026-11-06): `available` says so before anything starts.
import AVFoundation
import CallKit
import ExpoModulesCore
import StoreKit
import UIKit

public final class LeadCallModule: Module {
  private lazy var call = SystemCall(module: self)
  let meter = LevelMeter()
  private var chimePlayer: AVAudioPlayer?

  public func definition() -> ModuleDefinition {
    Name("ExpoLeadCall")

    Events("onActivate", "onDeactivate", "onEnd", "onMute", "onHold", "onSpeaker")

    AsyncFunction("available") { () async -> Bool in
      let china = await LeadCallModule.inChina()
      return !china
    }

    AsyncFunction("requestMic") { (promise: Promise) in
      if #available(iOS 17.0, *) {
        AVAudioApplication.requestRecordPermission { promise.resolve($0) }
      } else {
        AVAudioSession.sharedInstance().requestRecordPermission { promise.resolve($0) }
      }
    }

    // The system call, resolved once its audio session is active (CallKit's
    // didActivate): only then may WebRTC start its audio.
    AsyncFunction("start") { (name: String, promise: Promise) in
      self.call.start(name: name, promise: promise)
    }.runOnQueue(.main)

    Function("connected") {
      DispatchQueue.main.async { self.call.connected() }
    }
    Function("end") {
      DispatchQueue.main.async { self.call.end() }
    }
    Function("setMuted") { (muted: Bool) in
      DispatchQueue.main.async { self.call.setMuted(muted) }
    }
    Function("setSpeaker") { (on: Bool) in
      DispatchQueue.main.async { self.call.setSpeaker(on) }
    }

    Function("startMeter") {
      try self.meter.start()
    }
    Function("stopMeter") {
      self.meter.stop()
    }
    Function("level") { () -> Double in
      Double(self.meter.level)
    }

    Function("chime") {
      DispatchQueue.main.async { self.chime() }
    }

    OnDestroy {
      self.meter.stop()
    }
  }

  /// Where CallKit isn't allowed: the phone's region, or its App Store, is
  /// mainland China.
  static func inChina() async -> Bool {
    let region: String?
    if #available(iOS 16, *) {
      region = Locale.current.region?.identifier
    } else {
      region = Locale.current.regionCode
    }
    if region == "CN" { return true }
    // The storefront can be slow to come or absent (no App Store account).
    return await withTaskGroup(of: Bool?.self) { group in
      group.addTask { await Storefront.current?.countryCode == "CHN" }
      group.addTask {
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        return nil
      }
      let first = await group.next() ?? nil
      group.cancelAll()
      return first ?? false
    }
  }

  /// Two short notes, the desktop's (660 then 880 Hz): the call hears you again.
  private func chime() {
    let rate = 24_000
    var pcm: [Int16] = []
    for f in [660.0, 880.0] {
      let n = rate * 12 / 100
      for k in 0..<n {
        let t = Double(k) / Double(rate)
        let envelope = t < 0.02 ? t / 0.02 : max(0, 1 - (t - 0.02) / 0.09)
        pcm.append(Int16(sin(2 * .pi * f * t) * envelope * 0.3 * 32_767))
      }
    }
    chimePlayer = try? AVAudioPlayer(data: wav(pcm, rate: rate))
    chimePlayer?.play()
  }

  private func wav(_ samples: [Int16], rate: Int) -> Data {
    var d = Data()
    func ascii(_ s: String) { d.append(contentsOf: Array(s.utf8)) }
    func u32(_ v: Int) { withUnsafeBytes(of: UInt32(v).littleEndian) { d.append(contentsOf: $0) } }
    func u16(_ v: Int) { withUnsafeBytes(of: UInt16(v).littleEndian) { d.append(contentsOf: $0) } }
    let bytes = samples.count * 2
    ascii("RIFF"); u32(36 + bytes); ascii("WAVE")
    ascii("fmt "); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
    ascii("data"); u32(bytes)
    for s in samples { withUnsafeBytes(of: s.littleEndian) { d.append(contentsOf: $0) } }
    return d
  }
}

/// The system call (CallKit): one at a time, outgoing. Main queue only.
final class SystemCall: NSObject, CXProviderDelegate {
  private weak var module: LeadCallModule?
  private let controller = CXCallController()
  private lazy var provider: CXProvider = {
    let config = CXProviderConfiguration()
    config.supportsVideo = false
    // Apple's default, 2: at 1 the phone refused the Lead's call while another
    // call was on (CallKit's maximumCallGroupsReached, live 2026-11-06), and a
    // real call coming in needs its own group to hold this one.
    config.maximumCallGroups = 2
    config.maximumCallsPerCallGroup = 1
    config.supportedHandleTypes = [.generic]
    // Recents would offer to call the Lead back from the Phone app, which
    // Ateam Go doesn't handle.
    config.includesCallsInRecents = false
    let p = CXProvider(configuration: config)
    p.setDelegate(self, queue: nil)
    return p
  }()
  private var id: UUID?
  private var name = "Lead"
  /// start's promise, until the call's audio session is active.
  private var starting: Promise?
  private var startTimer: DispatchWorkItem?
  /// The app ended it (end()): not news for JS.
  private var endingHere = false
  /// The speaker instead of the earpiece (setSpeaker).
  private var speaker = false
  private var routeObserver: NSObjectProtocol?

  init(module: LeadCallModule) {
    self.module = module
  }

  func start(name: String, promise: Promise) {
    if id != nil {
      promise.reject("ERR_CALL_ON", "A call is already on.")
      return
    }
    _ = provider
    let id = UUID()
    self.id = id
    self.name = name
    speaker = false
    starting = promise
    let action = CXStartCallAction(call: id, handle: CXHandle(type: .generic, value: name))
    action.isVideo = false
    controller.request(CXTransaction(action: action)) { [weak self] error in
      guard let error else { return }
      DispatchQueue.main.async {
        guard let self, self.id == id else { return }
        self.id = nil
        self.failStart(SystemCall.words(error))
      }
    }
    let timer = DispatchWorkItem { [weak self] in
      self?.failStart("The call didn't start.")
      self?.end()
    }
    startTimer = timer
    DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: timer)
  }

  /// Why the phone refused the call, in the user's words where we know them.
  static func words(_ error: Error) -> String {
    if let refused = error as? CXErrorCodeRequestTransactionError,
      refused.code == .maximumCallGroupsReached
    {
      return "Another call is on, so the phone can't start this one. End it, then call again."
    }
    return "The phone didn't start the call: \(error.localizedDescription)"
  }

  private func failStart(_ message: String) {
    startTimer?.cancel()
    startTimer = nil
    guard let promise = starting else { return }
    starting = nil
    promise.reject("ERR_CALL_START", message)
  }

  func connected() {
    guard let id else { return }
    provider.reportOutgoingCall(with: id, connectedAt: Date())
  }

  func end() {
    guard let id else { return }
    endingHere = true
    controller.request(CXTransaction(action: CXEndCallAction(call: id))) { [weak self] error in
      guard error != nil else { return }
      // The system has no such call any more: forget it here too.
      DispatchQueue.main.async {
        guard let self, self.id == id else { return }
        self.ended()
        self.endingHere = false
      }
    }
  }

  func setMuted(_ muted: Bool) {
    guard let id else {
      module?.sendEvent("onMute", ["muted": muted])
      return
    }
    controller.request(CXTransaction(action: CXSetMutedCallAction(call: id, muted: muted))) {
      [weak self] error in
      guard error != nil else { return }
      // Not through the system call: the app mutes all the same.
      DispatchQueue.main.async { self?.module?.sendEvent("onMute", ["muted": muted]) }
    }
  }

  /// The speaker, or back to the earpiece (or whatever headset is on): set
  /// once, here, when the user asks.
  func setSpeaker(_ on: Bool) {
    speaker = on
    try? AVAudioSession.sharedInstance().overrideOutputAudioPort(on ? .speaker : .none)
    proximity()
  }

  /// At the ear on the earpiece: the screen goes dark, so a cheek taps nothing.
  private func proximity() {
    let receiver = AVAudioSession.sharedInstance().currentRoute.outputs.contains {
      $0.portType == .builtInReceiver
    }
    UIDevice.current.isProximityMonitoringEnabled = id != nil && !speaker && receiver
  }

  /// Route changes only ever put the speaker back after something else
  /// dropped it, never touch the route otherwise: re-applying the route on
  /// every change fed WebRTC's own route handling, a click every half second
  /// when AirPods connected (live 2026-11-06). A headset that connects wins.
  private func watchRoute(_ on: Bool) {
    if let routeObserver {
      NotificationCenter.default.removeObserver(routeObserver)
      self.routeObserver = nil
    }
    guard on else { return }
    routeObserver = NotificationCenter.default.addObserver(
      forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
    ) { [weak self] note in
      guard let self, self.id != nil else { return }
      let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
      let reason = raw.flatMap { AVAudioSession.RouteChangeReason(rawValue: $0) }
      let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
      if self.speaker && reason == .newDeviceAvailable
        && !outputs.contains(where: { $0.portType == .builtInSpeaker })
      {
        self.speaker = false
        self.module?.sendEvent("onSpeaker", ["on": false])
      } else if self.speaker && outputs.contains(where: { $0.portType == .builtInReceiver }) {
        try? AVAudioSession.sharedInstance().overrideOutputAudioPort(.speaker)
      }
      self.proximity()
    }
  }

  private func ended() {
    id = nil
    module?.meter.stop()
    failStart("The call ended.")
    watchRoute(false)
    speaker = false
    UIDevice.current.isProximityMonitoringEnabled = false
  }

  // MARK: CXProviderDelegate

  func providerDidReset(_ provider: CXProvider) {
    let had = id != nil
    ended()
    endingHere = false
    if had { module?.sendEvent("onEnd") }
  }

  func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    // Set up before the system activates the session; WebRTC uses the same.
    try? AVAudioSession.sharedInstance().setCategory(
      .playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
    action.fulfill()
    provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
    let update = CXCallUpdate()
    update.remoteHandle = action.handle
    update.localizedCallerName = name
    update.hasVideo = false
    // A real call coming in can hold this one (Hold & Accept), as with WhatsApp.
    update.supportsHolding = true
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false
    provider.reportCall(with: action.callUUID, updated: update)
  }

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    watchRoute(true)
    proximity()
    if let promise = starting {
      // JS passes this activation on to WebRTC itself, then opens the mic.
      startTimer?.cancel()
      startTimer = nil
      starting = nil
      promise.resolve(nil)
    } else {
      module?.sendEvent("onActivate")
    }
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    module?.meter.stop()
    module?.sendEvent("onDeactivate")
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    action.fulfill()
    let byApp = endingHere
    endingHere = false
    ended()
    if !byApp { module?.sendEvent("onEnd") }
  }

  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    action.fulfill()
    module?.sendEvent("onMute", ["muted": action.isMuted])
  }

  func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
    action.fulfill()
    if action.isOnHold { module?.meter.stop() }
    module?.sendEvent("onHold", ["held": action.isOnHold])
  }
}

/// The mic's level while the call is on hold, when WebRTC holds no mic: speech
/// then wakes the call (lead-call.ts reads it every 50 ms).
final class LevelMeter {
  private let stateLock = NSLock()
  private let valueLock = NSLock()
  private var engine: AVAudioEngine?
  private var observer: NSObjectProtocol?
  /// Started and not stopped since: a device change starts it again.
  private var wanted = false
  private var retries = 0
  private var value: Float = 0

  var level: Float {
    valueLock.lock()
    defer { valueLock.unlock() }
    return value
  }

  private func set(_ v: Float) {
    valueLock.lock()
    value = v
    valueLock.unlock()
  }

  func start() throws {
    stateLock.lock()
    defer { stateLock.unlock() }
    wanted = true
    retries = 0
    if engine != nil { return }
    do {
      try open()
    } catch {
      wanted = false
      throw error
    }
  }

  func stop() {
    stateLock.lock()
    wanted = false
    let engine = detach()
    stateLock.unlock()
    shut(engine)
  }

  /// A device came or went (AirPods in or out) and the engine stopped itself:
  /// without this, speech stopped waking the call (live 2026-11-06). The new
  /// device's input can take a moment to be ready, so it tries a few times.
  private func restart() {
    stateLock.lock()
    let old = detach()
    stateLock.unlock()
    shut(old)
    stateLock.lock()
    defer { stateLock.unlock() }
    guard wanted, engine == nil else { return }
    do {
      try open()
      retries = 0
    } catch {
      retries += 1
      if retries <= 10 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.restart() }
      }
    }
  }

  /// Under stateLock: let go of the engine and its observer; shut it outside.
  private func detach() -> AVAudioEngine? {
    let engine = self.engine
    self.engine = nil
    if let observer {
      NotificationCenter.default.removeObserver(observer)
      self.observer = nil
    }
    return engine
  }

  private func shut(_ engine: AVAudioEngine?) {
    guard let engine else { return }
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    set(0)
  }

  /// Under stateLock.
  private func open() throws {
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else { throw NoMicLevel() }
    // The tap only takes the value's lock, never the state's: stop() can
    // wait on a tap in flight without a deadlock.
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      guard let samples = buffer.floatChannelData?[0] else { return }
      let n = Int(buffer.frameLength)
      guard n > 0 else { return }
      var sum: Float = 0
      for i in 0..<n { sum += samples[i] * samples[i] }
      self?.set((sum / Float(n)).squareRoot())
    }
    engine.prepare()
    do {
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      throw error
    }
    self.engine = engine
    observer = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
    ) { [weak self] _ in self?.restart() }
  }
}

final class NoMicLevel: Exception {
  override var reason: String {
    "The microphone can't be measured right now."
  }
}
