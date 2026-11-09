import ExpoModulesCore
import Foundation
import Security
import Crypto

// Only references and public keys cross into JS. Secrets stay in the device-only
// Keychain. Removing a reference here does not revoke authorized_keys on a server.
private enum SSHSecrets {
    enum Missing: LocalizedError {
        case item
        var errorDescription: String? { "SSH credential is missing on this device. Edit the box to restore access." }
    }
    static func query(_ id: String, _ kind: String) throws -> [String: Any] {
        guard UUID(uuidString: id) != nil else { throw SSHFailure("Invalid SSH identity") }
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: "com.clawnify.ateam.ssh." + kind,
                kSecAttrAccount as String: id]
    }
    static func read(_ id: String, _ kind: String) throws -> Data {
        var q = try query(id, kind)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &value)
        if status == errSecItemNotFound { throw Missing.item }
        guard status == errSecSuccess, let data = value as? Data else {
            throw SSHFailure("SSH credential unavailable on this device (Keychain \(status)). Edit the box to restore access.")
        }
        return data
    }
    static func save(_ id: String, _ kind: String, _ data: Data) throws {
        let q = try query(id, kind)
        var add = q
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let updated = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            guard updated == errSecSuccess else { throw SSHFailure("Could not save SSH credential (\(updated))") }
        } else if status != errSecSuccess { throw SSHFailure("Could not save SSH credential (\(status))") }
    }
    static func remove(_ id: String, kinds: [String] = ["key", "password"]) throws {
        for kind in kinds {
            let status = SecItemDelete(try query(id, kind) as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw SSHFailure("Could not remove SSH credential (\(status))")
            }
        }
    }
}

private actor Sessions {
    var pending: [String: Task<SSHSession, Error>] = [:]
    func open(_ id: String, host: String, port: Int, user: String,
              credential: SSHCredential, hostKey: String?) async throws {
        guard pending[id] == nil else { throw SSHFailure("SSH connection already exists") }
        let task = Task { try await SSHSession.open(host: host, port: port, user: user,
            credential: credential, hostKey: hostKey) }
        pending[id] = task
        do { _ = try await task.value }
        catch { pending.removeValue(forKey: id); throw error }
    }
    func get(_ id: String) async throws -> SSHSession {
        guard let task = pending[id] else { throw SSHFailure("SSH connection is closed") }
        return try await task.value
    }
    func close(_ id: String) async {
        guard let task = pending.removeValue(forKey: id) else { return }
        task.cancel()
        if let session = try? await task.value { await session.close() }
    }
    func closeAll() async { for id in Array(pending.keys) { await close(id) } }
}

public final class SSHModule: Module {
    private let sessions = Sessions()
    public func definition() -> ModuleDefinition {
        Name("ExpoSSH")
        Events("line", "closed")
        AsyncFunction("createKey") { (id: String) throws -> String in
            // Never replace an existing identity while provisioning a retry.
            do { return try sshPublicKey(seed: SSHSecrets.read(id, "key")) }
            catch SSHSecrets.Missing.item { /* Generate only when the identity does not exist. */ }
            let seed = Curve25519.Signing.PrivateKey().rawRepresentation
            try SSHSecrets.save(id, "key", seed)
            return try sshPublicKey(seed: seed)
        }
        AsyncFunction("savePassword") { (id: String, password: String) throws in
            guard !password.isEmpty else { throw SSHFailure("Enter the SSH password") }
            try SSHSecrets.save(id, "password", Data(password.utf8))
        }
        AsyncFunction("removeIdentity") { (id: String) throws in try SSHSecrets.remove(id) }
        // Keeps the identity's key: setup drops root's password once the box logs in by key.
        AsyncFunction("removePassword") { (id: String) throws in try SSHSecrets.remove(id, kinds: ["password"]) }
        AsyncFunction("fingerprint") { (key: String) throws -> String in try sshFingerprint(key) }
        AsyncFunction("open") { (id: String, host: String, port: Int, user: String,
                                  identity: String, auth: String, hostKey: String?) async throws in
            guard !host.isEmpty, !user.isEmpty, (1...65535).contains(port),
                  auth == "key" || auth == "password" else { throw SSHFailure("Invalid SSH connection") }
            let credential: SSHCredential
            if auth == "key" { credential = .key(try SSHSecrets.read(identity, "key")) }
            else { credential = .password(String(decoding: try SSHSecrets.read(identity, "password"), as: UTF8.self)) }
            try await self.sessions.open(id, host: host, port: port, user: user,
                credential: credential, hostKey: hostKey)
        }
        AsyncFunction("exec") { (id: String, command: String) async throws -> [String: Any] in
            let session = try await self.sessions.get(id)
            let r = try await session.exec(command)
            return ["stdout": r.stdout, "stderr": r.stderr, "code": r.code]
        }
        AsyncFunction("attach") { (id: String) async throws in
            let session = try await self.sessions.get(id)
            try await session.attach(onLine: { [weak self] line in
                self?.sendEvent("line", ["id": id, "line": line])
            }, onClose: { [weak self] message in
                self?.sendEvent("closed", ["id": id, "message": message])
            })
        }
        AsyncFunction("write") { (id: String, line: String) async throws in
            let session = try await self.sessions.get(id)
            try await session.write(line)
        }
        AsyncFunction("forward") { (id: String, port: Int) async throws -> Int in
            let session = try await self.sessions.get(id)
            return try await session.forward(port)
        }
        AsyncFunction("close") { (id: String) async in await self.sessions.close(id) }
        OnDestroy { Task { await self.sessions.closeAll() } }
    }
}
