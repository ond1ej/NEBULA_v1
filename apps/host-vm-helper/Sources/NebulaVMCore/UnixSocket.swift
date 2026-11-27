import Foundation

public enum UnixSocket {
    /// Create a listening unix stream socket at `path` with mode 0600.
    public static func listen(path: String, backlog: Int32 = 64) throws -> Int32 {
        unlink(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw VMError.io("socket(): \(String(cString: strerror(errno)))") }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path) - 1
        guard path.utf8.count <= maxLen else {
            close(fd)
            throw VMError.invalidArgument("socket path too long (\(path.utf8.count) > \(maxLen)): \(path)")
        }
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: maxLen + 1) { cptr in
                _ = path.withCString { strncpy(cptr, $0, maxLen) }
            }
        }
        let oldMask = umask(0o177)
        defer { umask(oldMask) }
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard rc == 0 else {
            let msg = String(cString: strerror(errno))
            close(fd)
            throw VMError.io("bind(\(path)): \(msg)")
        }
        chmod(path, 0o600)
        guard Darwin.listen(fd, backlog) == 0 else {
            close(fd)
            throw VMError.io("listen(): \(String(cString: strerror(errno)))")
        }
        return fd
    }

    public static func connect(path: String) throws -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw VMError.io("socket()") }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path) - 1
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: maxLen + 1) { cptr in
                _ = path.withCString { strncpy(cptr, $0, maxLen) }
            }
        }
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard rc == 0 else {
            close(fd)
            throw VMError.notRunning
        }
        return fd
    }

    public static func writeAll(_ fd: Int32, _ data: Data) -> Bool {
        var offset = 0
        return data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Bool in
            guard let base = raw.baseAddress else { return true }
            while offset < data.count {
                let n = Darwin.write(fd, base.advanced(by: offset), data.count - offset)
                if n < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                offset += n
            }
            return true
        }
    }

    /// Read until newline (exclusive) or EOF; bounded to `limit` bytes.
    public static func readLine(_ fd: Int32, limit: Int = 65536) -> String? {
        var buf = [UInt8]()
        var byte: UInt8 = 0
        while buf.count < limit {
            let n = Darwin.read(fd, &byte, 1)
            if n == 0 { break }
            if n < 0 { if errno == EINTR { continue }; return nil }
            if byte == 0x0A { break }
            buf.append(byte)
        }
        return String(bytes: buf, encoding: .utf8)
    }
}

/// Bidirectional byte pump between two file descriptors, one thread per direction.
/// `onClose` fires once after both directions finished; fds are closed by the caller's closure.
public final class FDBridge {
    private let a: Int32
    private let b: Int32
    private let lock = NSLock()
    private var finished = 0
    private let onClose: () -> Void

    public init(_ a: Int32, _ b: Int32, onClose: @escaping () -> Void) {
        self.a = a
        self.b = b
        self.onClose = onClose
    }

    public static func noSigPipe(_ fd: Int32) {
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    }

    public func start() {
        FDBridge.noSigPipe(a)
        FDBridge.noSigPipe(b)
        let t1 = Thread { [self] in self.pump(from: self.a, to: self.b) }
        let t2 = Thread { [self] in self.pump(from: self.b, to: self.a) }
        t1.stackSize = 256 * 1024
        t2.stackSize = 256 * 1024
        t1.start()
        t2.start()
    }

    private func pump(from src: Int32, to dst: Int32) {
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let n = buffer.withUnsafeMutableBytes { Darwin.read(src, $0.baseAddress, $0.count) }
            if n < 0 && errno == EINTR { continue }
            if n <= 0 { break }
            var off = 0
            var ok = true
            while off < n {
                let w = buffer.withUnsafeBytes { Darwin.write(dst, $0.baseAddress!.advanced(by: off), n - off) }
                if w < 0 { if errno == EINTR { continue }; ok = false; break }
                off += w
            }
            if !ok { break }
        }
        // Half-close so the peer sees EOF; full close happens in onClose.
        shutdown(dst, SHUT_WR)
        shutdown(src, SHUT_RD)
        lock.lock()
        finished += 1
        let done = finished == 2
        lock.unlock()
        if done { onClose() }
    }
}
