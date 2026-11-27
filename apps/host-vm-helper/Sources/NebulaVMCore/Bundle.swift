import Foundation

/// On-disk VM bundle layout:
///   <bundle>/config.json      VM configuration (this struct)
///   <bundle>/disk.img         raw sparse disk (APFS clone of verified base image)
///   <bundle>/efi-vars.bin     EFI variable store
///   <bundle>/seed.iso         cloud-init NoCloud seed (optional, removed after provisioning)
///   <bundle>/console.log      virtio console output
///   <bundle>/run/control.sock control socket (while running)
///   <bundle>/run/control.token random token every control request must carry (0600, while running)
///   <bundle>/run/vsock-<port>.sock  host-side unix socket bridged to guest vsock port
///   <bundle>/run/state.json   runtime state written by the running helper
public struct VMConfig: Codable, Equatable {
    public var version: Int = 1
    public var name: String
    public var cpuCount: Int
    public var memoryMB: UInt64
    public var diskSizeGB: UInt64
    public var macAddress: String
    public var seedISO: String?          // relative to bundle
    public var vsockBridges: [UInt32]
    public var createdAt: String
    public var runDir: String?           // absolute; keeps unix socket paths < 104 bytes

    public init(name: String, cpuCount: Int, memoryMB: UInt64, diskSizeGB: UInt64,
                macAddress: String, seedISO: String?, vsockBridges: [UInt32], createdAt: String) {
        self.name = name
        self.cpuCount = cpuCount
        self.memoryMB = memoryMB
        self.diskSizeGB = diskSizeGB
        self.macAddress = macAddress
        self.seedISO = seedISO
        self.vsockBridges = vsockBridges
        self.createdAt = createdAt
    }
}

public enum VMError: Error, CustomStringConvertible {
    case invalidArgument(String)
    case bundleExists(String)
    case bundleMissing(String)
    case io(String)
    case unsupported(String)
    case notRunning
    case alreadyRunning(Int32)

    public var description: String {
        switch self {
        case .invalidArgument(let s): return "invalid_argument: \(s)"
        case .bundleExists(let s): return "bundle_exists: \(s)"
        case .bundleMissing(let s): return "bundle_missing: \(s)"
        case .io(let s): return "io_error: \(s)"
        case .unsupported(let s): return "unsupported: \(s)"
        case .notRunning: return "not_running"
        case .alreadyRunning(let pid): return "already_running: pid \(pid)"
        }
    }

    public var code: String {
        switch self {
        case .invalidArgument: return "invalid_argument"
        case .bundleExists: return "bundle_exists"
        case .bundleMissing: return "bundle_missing"
        case .io: return "io_error"
        case .unsupported: return "unsupported"
        case .notRunning: return "not_running"
        case .alreadyRunning: return "already_running"
        }
    }
}

public struct VMBundle {
    public let root: URL

    public init(path: String) {
        self.root = URL(fileURLWithPath: path).standardizedFileURL
    }

    public var configURL: URL { root.appendingPathComponent("config.json") }
    public var diskURL: URL { root.appendingPathComponent("disk.img") }
    public var efiVarsURL: URL { root.appendingPathComponent("efi-vars.bin") }
    public var consoleLogURL: URL { root.appendingPathComponent("console.log") }
    public var runDir: URL {
        if let cfg = try? loadConfig(), let r = cfg.runDir { return URL(fileURLWithPath: r) }
        return root.appendingPathComponent("run")
    }
    public var controlSocketURL: URL { runDir.appendingPathComponent("control.sock") }
    public var controlTokenURL: URL { runDir.appendingPathComponent(ControlAuth.tokenFileName) }
    public var stateURL: URL { runDir.appendingPathComponent("state.json") }
    public var pidURL: URL { runDir.appendingPathComponent("helper.pid") }
    public func vsockSocketURL(port: UInt32) -> URL { runDir.appendingPathComponent("vsock-\(port).sock") }
    public func seedURL(_ cfg: VMConfig) -> URL? {
        guard let s = cfg.seedISO else { return nil }
        return root.appendingPathComponent(s)
    }

    public var exists: Bool { FileManager.default.fileExists(atPath: configURL.path) }

    public func loadConfig() throws -> VMConfig {
        guard exists else { throw VMError.bundleMissing(root.path) }
        let data = try Data(contentsOf: configURL)
        return try JSONDecoder().decode(VMConfig.self, from: data)
    }

    public func saveConfig(_ cfg: VMConfig) throws {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try enc.encode(cfg)
        let tmp = root.appendingPathComponent("config.json.tmp")
        try data.write(to: tmp, options: .atomic)
        _ = try FileManager.default.replaceItemAt(configURL, withItemAt: tmp)
    }
}

public enum Validation {
    /// Hard bounds; the host API applies stricter, measured profiles.
    public static func validate(cpu: Int, memoryMB: UInt64, diskGB: UInt64, hostCPUs: Int, hostMemoryMB: UInt64) throws {
        if cpu < 1 || cpu > max(1, hostCPUs) {
            throw VMError.invalidArgument("cpu_count must be between 1 and \(hostCPUs)")
        }
        if memoryMB < 1024 {
            throw VMError.invalidArgument("memory_mb must be >= 1024")
        }
        // Leave at least 4 GiB for macOS + host services.
        if hostMemoryMB > 0 && memoryMB + 4096 > hostMemoryMB {
            throw VMError.invalidArgument("memory_mb \(memoryMB) leaves less than 4096 MB for the host (\(hostMemoryMB) MB)")
        }
        if diskGB < 8 || diskGB > 2048 {
            throw VMError.invalidArgument("disk_gb must be between 8 and 2048")
        }
    }

    public static func isValidMAC(_ mac: String) -> Bool {
        let parts = mac.split(separator: ":")
        guard parts.count == 6 else { return false }
        for p in parts {
            guard p.count == 2, UInt8(p, radix: 16) != nil else { return false }
        }
        // must be locally administered unicast
        guard let first = UInt8(parts[0], radix: 16) else { return false }
        return (first & 0x02) == 0x02 && (first & 0x01) == 0
    }

    public static func randomLocalMAC() -> String {
        var bytes = (0..<6).map { _ in UInt8.random(in: 0...255) }
        bytes[0] = (bytes[0] & 0xFC) | 0x02  // locally administered, unicast
        return bytes.map { String(format: "%02x", $0) }.joined(separator: ":")
    }
}

public enum DiskOps {
    /// Copy-on-write clone (APFS clonefile) of the base raw image, falling back to a sparse copy,
    /// then grow (sparse) to `sizeGB`.
    public static func createDisk(from base: URL, to dest: URL, sizeGB: UInt64) throws {
        let fm = FileManager.default
        guard fm.fileExists(atPath: base.path) else { throw VMError.io("base image not found: \(base.path)") }
        if fm.fileExists(atPath: dest.path) { throw VMError.bundleExists(dest.path) }
        if clonefile(base.path, dest.path, 0) != 0 {
            // Not APFS or cross-volume: regular copy (FileManager preserves holes on APFS).
            try fm.copyItem(at: base, to: dest)
        }
        let target = sizeGB * 1024 * 1024 * 1024
        let attrs = try fm.attributesOfItem(atPath: dest.path)
        let current = (attrs[.size] as? NSNumber)?.uint64Value ?? 0
        if target > current {
            let fh = try FileHandle(forWritingTo: dest)
            try fh.truncate(atOffset: target)
            try fh.close()
        }
    }

    /// Consistent disk backup — only allowed when the VM is stopped (enforced by caller).
    public static func backupDisk(_ disk: URL, to dest: URL) throws {
        if FileManager.default.fileExists(atPath: dest.path) { throw VMError.bundleExists(dest.path) }
        if clonefile(disk.path, dest.path, 0) != 0 {
            try FileManager.default.copyItem(at: disk, to: dest)
        }
    }

    public static func allocatedBytes(_ url: URL) -> UInt64 {
        var st = stat()
        guard stat(url.path, &st) == 0 else { return 0 }
        return UInt64(st.st_blocks) * 512
    }
}

public func isoNow() -> String {
    let f = ISO8601DateFormatter()
    return f.string(from: Date())
}

public func jsonLine(_ obj: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
          let s = String(data: data, encoding: .utf8) else { return "{}" }
    return s
}
