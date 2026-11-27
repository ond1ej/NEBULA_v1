import Foundation

/// Authentication of the helper's control socket (`<run>/control.sock`: status, stop, force stop).
///
/// Any process of the owner's account could otherwise connect and force-stop the VM, including a command an agent
/// runs natively on the Mac inside the Seatbelt sandbox (unix-socket connects are network operations there, not
/// file reads; audit VM-03). Two checks, both required:
///   1. the peer is the same uid as the helper (getpeereid), so other local users are refused;
///   2. every request carries the random token the running helper wrote to `<run>/control.token` (0600, inside the
///      0700 run directory under the NEBULA data dir, which the host sandbox cannot read).
/// The `nebula-vm` CLI (the only client; the host API always shells out to it) reads the token file itself.
public enum ControlAuth {
    public static let tokenFileName = "control.token"

    /// 32 random bytes, hex encoded.
    public static func generateToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        arc4random_buf(&bytes, bytes.count)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    /// Write the token with mode 0600, never following a symlink at `url` (an existing entry is replaced).
    public static func writeToken(_ token: String, to url: URL) throws {
        let path = url.path
        unlink(path)
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw VMError.io("create \(path): \(String(cString: strerror(errno)))") }
        defer { close(fd) }
        fchmod(fd, 0o600)
        guard UnixSocket.writeAll(fd, Data(token.utf8)) else {
            throw VMError.io("write \(path): \(String(cString: strerror(errno)))")
        }
    }

    /// The token, or nil when the file is missing, not a regular file, or readable by others.
    public static func readToken(from url: URL) -> String? {
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var st = stat()
        guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_uid == getuid(),
              (st.st_mode & 0o077) == 0 else { return nil }
        var buf = [UInt8](repeating: 0, count: 128)
        let n = read(fd, &buf, buf.count)
        guard n > 0 else { return nil }
        let s = String(decoding: buf[0..<n], as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return s.isEmpty ? nil : s
    }

    /// Constant-time comparison; a missing or non-string token never matches.
    public static func verify(_ provided: Any?, expected: String) -> Bool {
        guard let p = provided as? String, !expected.isEmpty else { return false }
        let a = Array(p.utf8), b = Array(expected.utf8)
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count { diff |= a[i] ^ b[i] }
        return diff == 0
    }

    /// uid of the process on the other end of a connected unix socket, or nil.
    public static func peerUID(_ fd: Int32) -> uid_t? {
        var uid: uid_t = 0
        var gid: gid_t = 0
        guard getpeereid(fd, &uid, &gid) == 0 else { return nil }
        return uid
    }

    /// Whole-request check used by the control server.
    public static func authorize(fd: Int32, request: [String: Any], expected: String) -> Bool {
        guard let uid = peerUID(fd), uid == getuid() else { return false }
        return verify(request["token"], expected: expected)
    }
}
