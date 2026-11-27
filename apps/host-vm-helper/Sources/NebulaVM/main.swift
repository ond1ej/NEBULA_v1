import Foundation
import Virtualization
import NebulaVMCore

let VERSION = "0.1.0"

func out(_ obj: [String: Any]) {
    print(jsonLine(obj))
}

func fail(_ err: Error) -> Never {
    if let e = err as? VMError {
        out(["ok": false, "error": e.code, "message": e.description])
    } else {
        out(["ok": false, "error": "error", "message": "\(err)"])
    }
    exit(2)
}

func arg(_ name: String, _ args: [String]) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func hostMemoryMB() -> UInt64 { ProcessInfo.processInfo.physicalMemory / 1024 / 1024 }

func controlRequest(_ bundle: VMBundle, _ obj: [String: Any], timeout: Int = 5) throws -> [String: Any] {
    let fd = try UnixSocket.connect(path: bundle.controlSocketURL.path)
    defer { close(fd) }
    var tv = timeval(tv_sec: timeout, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    var req = obj
    if let token = ControlAuth.readToken(from: bundle.controlTokenURL) { req["token"] = token }
    guard UnixSocket.writeAll(fd, (jsonLine(req) + "\n").data(using: .utf8)!) else { throw VMError.notRunning }
    guard let line = UnixSocket.readLine(fd),
          let data = line.data(using: .utf8),
          let reply = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw VMError.io("no reply from helper")
    }
    return reply
}

// A peer closing a bridged socket mid-write must surface as EPIPE, never kill the process (and with it the VM).
signal(SIGPIPE, SIG_IGN)

let argv = Array(CommandLine.arguments.dropFirst())
guard let command = argv.first else {
    print("""
    nebula-vm \(VERSION) — NEBULA native VM helper (Apple Virtualization.framework)
    usage:
      nebula-vm doctor
      nebula-vm create --bundle DIR --base-image RAW --cpus N --memory-mb N --disk-gb N [--seed ISO] [--name NAME]
      nebula-vm start  --bundle DIR          (foreground; host service runs it detached)
      nebula-vm status --bundle DIR
      nebula-vm stop   --bundle DIR [--force]
      nebula-vm config --bundle DIR [--cpus N] [--memory-mb N] [--remove-seed]
      nebula-vm snapshot --bundle DIR --dest FILE   (stopped VM only: consistent disk clone)
    """)
    exit(1)
}
let rest = Array(argv.dropFirst())

do {
    switch command {
    case "version":
        out(["ok": true, "version": VERSION])

    case "doctor":
        var d: [String: Any] = [
            "ok": true,
            "version": VERSION,
            "virtualization_supported": VZVirtualMachine.isSupported,
            "arch": "arm64",
            "host_memory_mb": hostMemoryMB(),
            "host_cpus": ProcessInfo.processInfo.processorCount,
            "max_cpu": VZVirtualMachineConfiguration.maximumAllowedCPUCount,
            "os": ProcessInfo.processInfo.operatingSystemVersionString,
        ]
        // Entitlement probe: a minimal configuration validates only if the process is entitled.
        let probe = VZVirtualMachineConfiguration()
        probe.platform = VZGenericPlatformConfiguration()
        probe.bootLoader = VZEFIBootLoader()
        probe.cpuCount = 1
        probe.memorySize = 512 * 1024 * 1024
        do {
            try probe.validate()
            d["entitlement_ok"] = true
        } catch {
            let msg = "\(error)"
            // Missing variable store is expected; a missing entitlement produces a distinct error.
            d["entitlement_ok"] = !msg.lowercased().contains("entitlement")
            d["probe_message"] = msg
        }
        out(d)

    case "create":
        guard let b = arg("--bundle", rest), let base = arg("--base-image", rest) else {
            throw VMError.invalidArgument("--bundle and --base-image are required")
        }
        let cpus = Int(arg("--cpus", rest) ?? "4") ?? 4
        let mem = UInt64(arg("--memory-mb", rest) ?? "6144") ?? 6144
        let disk = UInt64(arg("--disk-gb", rest) ?? "32") ?? 32
        try Validation.validate(cpu: cpus, memoryMB: mem, diskGB: disk,
                                hostCPUs: ProcessInfo.processInfo.processorCount, hostMemoryMB: hostMemoryMB())
        let bundle = VMBundle(path: b)
        if bundle.exists { throw VMError.bundleExists(bundle.root.path) }
        try FileManager.default.createDirectory(at: bundle.root, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        var seedRel: String? = nil
        if let seed = arg("--seed", rest) {
            let dest = bundle.root.appendingPathComponent("seed.iso")
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.copyItem(at: URL(fileURLWithPath: seed), to: dest)
            seedRel = "seed.iso"
        }
        try DiskOps.createDisk(from: URL(fileURLWithPath: base), to: bundle.diskURL, sizeGB: disk)
        _ = try VZEFIVariableStore(creatingVariableStoreAt: bundle.efiVarsURL, options: [.allowOverwrite])
        let cfg = VMConfig(name: arg("--name", rest) ?? "nebula-shared", cpuCount: cpus, memoryMB: mem,
                           diskSizeGB: disk, macAddress: Validation.randomLocalMAC(), seedISO: seedRel,
                           vsockBridges: [7000, 7001], createdAt: isoNow())
        var cfgMut = cfg
        cfgMut.runDir = arg("--run-dir", rest)
        try bundle.saveConfig(cfgMut)
        out(["ok": true, "bundle": bundle.root.path, "mac_address": cfg.macAddress,
             "disk_allocated_bytes": DiskOps.allocatedBytes(bundle.diskURL)])

    case "start":
        guard let b = arg("--bundle", rest) else { throw VMError.invalidArgument("--bundle required") }
        let bundle = VMBundle(path: b)
        let cfg = try bundle.loadConfig()
        if let reply = try? controlRequest(bundle, ["cmd": "ping"]), (reply["ok"] as? Bool) == true {
            throw VMError.alreadyRunning(Int32((try? controlRequest(bundle, ["cmd": "status"]))?["pid"] as? Int ?? 0))
        }
        guard VZVirtualMachine.isSupported else { throw VMError.unsupported("virtualization not supported on this host") }
        let runner = VMRunner(bundle: bundle, config: cfg)
        try FileManager.default.createDirectory(at: bundle.runDir, withIntermediateDirectories: true)
        try "\(getpid())".write(to: bundle.pidURL, atomically: true, encoding: .utf8)
        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)
        let termSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termSrc.setEventHandler { _ = runner.requestStop(force: false) }
        termSrc.resume()
        let intSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        intSrc.setEventHandler { _ = runner.requestStop(force: false) }
        intSrc.resume()
        DispatchQueue.main.async {
            do { try runner.start() } catch {
                runner.log("start failed: \(error)")
                runner.state = "error"
                runner.lastError = "\(error)"
                runner.cleanupAndExit(code: 3)
            }
        }
        withExtendedLifetime([termSrc, intSrc]) { dispatchMain() }

    case "status":
        guard let b = arg("--bundle", rest) else { throw VMError.invalidArgument("--bundle required") }
        let bundle = VMBundle(path: b)
        let cfg = try bundle.loadConfig()
        if let reply = try? controlRequest(bundle, ["cmd": "status"]) {
            out(reply)
        } else {
            out(["ok": true, "state": "stopped", "name": cfg.name, "cpu_count": cfg.cpuCount,
                 "memory_mb": cfg.memoryMB, "disk_size_gb": cfg.diskSizeGB,
                 "disk_allocated_bytes": DiskOps.allocatedBytes(bundle.diskURL),
                 "mac_address": cfg.macAddress])
        }

    case "stop":
        guard let b = arg("--bundle", rest) else { throw VMError.invalidArgument("--bundle required") }
        let bundle = VMBundle(path: b)
        _ = try bundle.loadConfig()
        let reply = try controlRequest(bundle, ["cmd": "stop", "force": rest.contains("--force")])
        out(reply)

    case "config":
        guard let b = arg("--bundle", rest) else { throw VMError.invalidArgument("--bundle required") }
        let bundle = VMBundle(path: b)
        var cfg = try bundle.loadConfig()
        if let c = arg("--cpus", rest), let n = Int(c) { cfg.cpuCount = n }
        if let m = arg("--memory-mb", rest), let n = UInt64(m) { cfg.memoryMB = n }
        if rest.contains("--remove-seed") {
            if let seed = bundle.seedURL(cfg) { try? FileManager.default.removeItem(at: seed) }
            cfg.seedISO = nil
        }
        try Validation.validate(cpu: cfg.cpuCount, memoryMB: cfg.memoryMB, diskGB: cfg.diskSizeGB,
                                hostCPUs: ProcessInfo.processInfo.processorCount, hostMemoryMB: hostMemoryMB())
        try bundle.saveConfig(cfg)
        out(["ok": true, "cpu_count": cfg.cpuCount, "memory_mb": cfg.memoryMB, "seed_iso": cfg.seedISO ?? NSNull(),
             "note": "takes effect on next VM start"])

    case "snapshot":
        guard let b = arg("--bundle", rest), let dest = arg("--dest", rest) else {
            throw VMError.invalidArgument("--bundle and --dest required")
        }
        let bundle = VMBundle(path: b)
        _ = try bundle.loadConfig()
        if (try? controlRequest(bundle, ["cmd": "ping"])) != nil {
            throw VMError.unsupported("live snapshot is not supported in V1; stop the VM for a consistent disk backup")
        }
        try DiskOps.backupDisk(bundle.diskURL, to: URL(fileURLWithPath: dest))
        out(["ok": true, "dest": dest, "kind": "stopped_disk_clone"])

    default:
        throw VMError.invalidArgument("unknown command \(command)")
    }
} catch {
    fail(error)
}
