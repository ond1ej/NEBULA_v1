import XCTest
@testable import NebulaVMCore

final class CoreTests: XCTestCase {
    func testRandomMACIsLocalUnicast() {
        for _ in 0..<200 {
            let mac = Validation.randomLocalMAC()
            XCTAssertTrue(Validation.isValidMAC(mac), mac)
        }
        XCTAssertFalse(Validation.isValidMAC("01:00:00:00:00:00"))
        XCTAssertFalse(Validation.isValidMAC("zz:00:00:00:00:00"))
        XCTAssertFalse(Validation.isValidMAC("02:00:00:00:00"))
    }

    func testValidationBounds() {
        XCTAssertNoThrow(try Validation.validate(cpu: 4, memoryMB: 6144, diskGB: 32, hostCPUs: 10, hostMemoryMB: 16384))
        XCTAssertThrowsError(try Validation.validate(cpu: 0, memoryMB: 6144, diskGB: 32, hostCPUs: 10, hostMemoryMB: 16384))
        XCTAssertThrowsError(try Validation.validate(cpu: 11, memoryMB: 6144, diskGB: 32, hostCPUs: 10, hostMemoryMB: 16384))
        XCTAssertThrowsError(try Validation.validate(cpu: 4, memoryMB: 14000, diskGB: 32, hostCPUs: 10, hostMemoryMB: 16384))
        XCTAssertThrowsError(try Validation.validate(cpu: 4, memoryMB: 512, diskGB: 32, hostCPUs: 10, hostMemoryMB: 16384))
        XCTAssertThrowsError(try Validation.validate(cpu: 4, memoryMB: 6144, diskGB: 4, hostCPUs: 10, hostMemoryMB: 16384))
    }

    func testBundleConfigRoundTripAndSparseDisk() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("nebula-vm-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let base = dir.appendingPathComponent("base.img")
        try Data(repeating: 0xAB, count: 1024 * 1024).write(to: base)
        let bundle = VMBundle(path: dir.appendingPathComponent("vm").path)
        try FileManager.default.createDirectory(at: bundle.root, withIntermediateDirectories: true)
        try DiskOps.createDisk(from: base, to: bundle.diskURL, sizeGB: 8)
        let size = (try FileManager.default.attributesOfItem(atPath: bundle.diskURL.path)[.size] as! NSNumber).uint64Value
        XCTAssertEqual(size, 8 * 1024 * 1024 * 1024)
        // Sparse: allocated far below logical size
        XCTAssertLessThan(DiskOps.allocatedBytes(bundle.diskURL), 64 * 1024 * 1024)
        XCTAssertThrowsError(try DiskOps.createDisk(from: base, to: bundle.diskURL, sizeGB: 8))

        let cfg = VMConfig(name: "t", cpuCount: 2, memoryMB: 2048, diskSizeGB: 8, macAddress: Validation.randomLocalMAC(),
                           seedISO: nil, vsockBridges: [7000, 7001], createdAt: isoNow())
        try bundle.saveConfig(cfg)
        XCTAssertEqual(try bundle.loadConfig(), cfg)
        XCTAssertTrue(bundle.vsockSocketURL(port: 7000).path.hasSuffix("run/vsock-7000.sock"))
    }

    func testUnixSocketBridgePumpsBytes() throws {
        var pairA: [Int32] = [0, 0]
        var pairB: [Int32] = [0, 0]
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &pairA), 0)
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &pairB), 0)
        let closed = expectation(description: "closed")
        let bridge = FDBridge(pairA[1], pairB[0]) {
            close(pairA[1]); close(pairB[0]); closed.fulfill()
        }
        bridge.start()
        let msg = "hello-vsock\n".data(using: .utf8)!
        XCTAssertTrue(UnixSocket.writeAll(pairA[0], msg))
        XCTAssertEqual(UnixSocket.readLine(pairB[1]), "hello-vsock")
        XCTAssertTrue(UnixSocket.writeAll(pairB[1], "pong\n".data(using: .utf8)!))
        XCTAssertEqual(UnixSocket.readLine(pairA[0]), "pong")
        close(pairA[0]); close(pairB[1])
        wait(for: [closed], timeout: 5)
    }

    func testControlTokenIsRandomHexAndRoundTripsWithOwnerOnlyMode() throws {
        let a = ControlAuth.generateToken(), b = ControlAuth.generateToken()
        XCTAssertEqual(a.count, 64)
        XCTAssertNotEqual(a, b)
        XCTAssertTrue(a.allSatisfy { $0.isHexDigit })
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("nebula-tok-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent(ControlAuth.tokenFileName)
        try ControlAuth.writeToken(a, to: url)
        let mode = (try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as! NSNumber).intValue
        XCTAssertEqual(mode & 0o777, 0o600)
        XCTAssertEqual(ControlAuth.readToken(from: url), a)
        try ControlAuth.writeToken(b, to: url)  // replaces an existing file
        XCTAssertEqual(ControlAuth.readToken(from: url), b)
        chmod(url.path, 0o644)  // readable by others: never trusted
        XCTAssertNil(ControlAuth.readToken(from: url))
        XCTAssertNil(ControlAuth.readToken(from: dir.appendingPathComponent("missing")))
    }

    func testControlTokenWriteDoesNotFollowSymlink() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("nebula-tok-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let victim = dir.appendingPathComponent("victim")
        try "keep".write(to: victim, atomically: true, encoding: .utf8)
        let url = dir.appendingPathComponent(ControlAuth.tokenFileName)
        try FileManager.default.createSymbolicLink(at: url, withDestinationURL: victim)
        XCTAssertNil(ControlAuth.readToken(from: url))  // O_NOFOLLOW
        try ControlAuth.writeToken("t", to: url)       // replaces the link itself
        XCTAssertEqual(try String(contentsOf: victim, encoding: .utf8), "keep")
        XCTAssertEqual(ControlAuth.readToken(from: url), "t")
    }

    func testControlTokenVerifyAndPeerCheck() throws {
        XCTAssertTrue(ControlAuth.verify("abc", expected: "abc"))
        XCTAssertFalse(ControlAuth.verify("abd", expected: "abc"))
        XCTAssertFalse(ControlAuth.verify("ab", expected: "abc"))
        XCTAssertFalse(ControlAuth.verify(nil, expected: "abc"))
        XCTAssertFalse(ControlAuth.verify(42, expected: "abc"))
        XCTAssertFalse(ControlAuth.verify("", expected: ""))
        var pair: [Int32] = [0, 0]
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair), 0)
        defer { close(pair[0]); close(pair[1]) }
        XCTAssertEqual(ControlAuth.peerUID(pair[0]), getuid())
        XCTAssertTrue(ControlAuth.authorize(fd: pair[0], request: ["cmd": "stop", "token": "t"], expected: "t"))
        XCTAssertFalse(ControlAuth.authorize(fd: pair[0], request: ["cmd": "stop"], expected: "t"))
        XCTAssertFalse(ControlAuth.authorize(fd: pair[0], request: ["cmd": "stop", "token": "x"], expected: "t"))
        XCTAssertNil(ControlAuth.peerUID(-1))
    }

    /// Regression (hardware E2E-07): a viewer disconnecting while frame data is in flight raised SIGPIPE in the
    /// bridge thread and killed the helper together with the VM. With SO_NOSIGPIPE the write fails with EPIPE.
    func testBridgeSurvivesPeerCloseMidStream() throws {
        var pairA: [Int32] = [0, 0]
        var pairB: [Int32] = [0, 0]
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &pairA), 0)
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &pairB), 0)
        let closed = expectation(description: "closed")
        let bridge = FDBridge(pairA[1], pairB[0]) { close(pairA[1]); close(pairB[0]); closed.fulfill() }
        bridge.start()
        FDBridge.noSigPipe(pairA[0])  // the simulated guest writer itself must not die either
        close(pairB[1])  // the viewer side goes away
        let chunk = Data(repeating: 0x42, count: 1 << 20)
        for _ in 0..<16 { _ = UnixSocket.writeAll(pairA[0], chunk) }  // guest keeps sending frames
        close(pairA[0])
        wait(for: [closed], timeout: 10)  // reaching this line means the process survived
    }
}
