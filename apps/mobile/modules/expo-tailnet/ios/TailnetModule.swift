// Whether this iPhone is on a tailnet right now. iOS gives an app no way to ask about
// another app's VPN, but its own network interfaces are public (getifaddrs): with
// Tailscale connected, a VPN interface (utun) has an address in Tailscale's range,
// 100.64.0.0/10. A cellular interface can carry that range too (carrier-grade NAT),
// so only VPN interfaces count.
import Darwin
import ExpoModulesCore

public final class TailnetModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoTailnet")

    Function("isUp") { () -> Bool in
      TailnetModule.onTailnet()
    }
  }

  static func onTailnet() -> Bool {
    var first: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&first) == 0, let head = first else { return false }
    defer { freeifaddrs(head) }
    var cursor: UnsafeMutablePointer<ifaddrs>? = head
    while let entry = cursor {
      cursor = entry.pointee.ifa_next
      let up = (Int32(entry.pointee.ifa_flags) & IFF_UP) != 0
      guard up, let addr = entry.pointee.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET),
        String(cString: entry.pointee.ifa_name).hasPrefix("utun")
      else { continue }
      let ip = addr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
        UInt32(bigEndian: $0.pointee.sin_addr.s_addr)
      }
      if ip & 0xFFC0_0000 == 0x6440_0000 { return true }
    }
    return false
  }
}
