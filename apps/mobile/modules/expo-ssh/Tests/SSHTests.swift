import XCTest
@testable import AteamSSH

final class SSHTests: XCTestCase {
    func testFingerprintRejectsMalformedKey() {
        XCTAssertThrowsError(try sshFingerprint("invalid"))
    }
}
