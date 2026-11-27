import Foundation
import Virtualization
import NebulaVMCore

/// Runs one VM in the foreground of this process. Must be driven from the main queue.
final class VMRunner: NSObject, VZVirtualMachineDelegate {
    let bundle: VMBundle
    let config: VMConfig
    var vm: VZVirtualMachine!
    var socketDevice: VZVirtioSocketDevice?
    var state: String = "starting"
    var startedAt = isoNow()
    var lastError: String?
    var listeners: [Int32] = []
    var activeBridges: [ObjectIdentifier: (VZVirtioSocketConnection, FDBridge)] = [:]
    var bridgeCount = 0
    let bridgeLock = NSLock()
    var stopRequestedAt: Date?
    /// Required in every control request (see ControlAuth); written to <run>/control.token while running.
    let controlToken = ControlAuth.generateToken()

    init(bundle: VMBundle, config: VMConfig) {
        self.bundle = bundle
        self.config = config
    }

    func buildConfiguration() throws -> VZVirtualMachineConfiguration {
        let c = VZVirtualMachineConfiguration()
        c.platform = VZGenericPlatformConfiguration()
        let boot = VZEFIBootLoader()
        if FileManager.default.fileExists(atPath: bundle.efiVarsURL.path) {
            boot.variableStore = VZEFIVariableStore(url: bundle.efiVarsURL)
        } else {
            boot.variableStore = try VZEFIVariableStore(creatingVariableStoreAt: bundle.efiVarsURL, options: [])
        }
        c.bootLoader = boot
        c.cpuCount = max(VZVirtualMachineConfiguration.minimumAllowedCPUCount,
                         min(config.cpuCount, VZVirtualMachineConfiguration.maximumAllowedCPUCount))
        c.memorySize = max(VZVirtualMachineConfiguration.minimumAllowedMemorySize,
                           min(config.memoryMB * 1024 * 1024, VZVirtualMachineConfiguration.maximumAllowedMemorySize))

        var storage: [VZStorageDeviceConfiguration] = []
        // .cached + .fsync: the combination other Virtualization.framework users (e.g. Lima) settled on after
        // ext4 corruption reports; .uncached hung the guest under provisioning I/O here (docs/decisions.md D31).
        let diskAttachment = try VZDiskImageStorageDeviceAttachment(
            url: bundle.diskURL, readOnly: false, cachingMode: .cached, synchronizationMode: .fsync)
        storage.append(VZVirtioBlockDeviceConfiguration(attachment: diskAttachment))
        if let seed = bundle.seedURL(config), FileManager.default.fileExists(atPath: seed.path) {
            let seedAttachment = try VZDiskImageStorageDeviceAttachment(url: seed, readOnly: true)
            storage.append(VZVirtioBlockDeviceConfiguration(attachment: seedAttachment))
        }
        c.storageDevices = storage

        let net = VZVirtioNetworkDeviceConfiguration()
        net.attachment = VZNATNetworkDeviceAttachment()   // private NAT, no inbound from LAN
        if let mac = VZMACAddress(string: config.macAddress) { net.macAddress = mac }
        c.networkDevices = [net]

        c.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        // No memory balloon: V1 never resizes guest RAM, and two guest kernel panics ("corrupted stack end
        // detected inside scheduler") occurred with the balloon attached (docs/decisions.md D30).
        c.memoryBalloonDevices = []
        c.socketDevices = [VZVirtioSocketDeviceConfiguration()]

        // Serial console -> console.log (append)
        // append (never truncate): the previous boot's console holds the evidence of a crash/panic;
        // the host rotates the file before starting the VM
        if !FileManager.default.fileExists(atPath: bundle.consoleLogURL.path) {
            FileManager.default.createFile(atPath: bundle.consoleLogURL.path, contents: nil)
        }
        if let out = FileHandle(forWritingAtPath: bundle.consoleLogURL.path) {
            out.seekToEndOfFile()
            let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
            serial.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: nil, fileHandleForWriting: out)
            c.serialPorts = [serial]
        }
        try c.validate()
        return c
    }

    func start() throws {
        try FileManager.default.createDirectory(at: bundle.runDir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let cfg = try buildConfiguration()
        vm = VZVirtualMachine(configuration: cfg)
        vm.delegate = self
        socketDevice = vm.socketDevices.first as? VZVirtioSocketDevice
        try ControlAuth.writeToken(controlToken, to: bundle.controlTokenURL)
        try startControlSocket()
        for port in config.vsockBridges { try startVsockBridge(port: port) }
        writeState()
        vm.start { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success:
                self.state = "running"
                self.log("vm started")
            case .failure(let err):
                self.state = "error"
                self.lastError = "\(err)"
                self.log("vm start failed: \(err)")
                self.writeState()
                self.cleanupAndExit(code: 3)
            }
            self.writeState()
        }
    }

    // MARK: delegate
    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        log("guest stopped")
        state = "stopped"
        writeState()
        cleanupAndExit(code: 0)
    }

    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        log("vm stopped with error: \(error)")
        state = "error"
        lastError = "\(error)"
        writeState()
        cleanupAndExit(code: 4)
    }

    // MARK: lifecycle
    func requestStop(force: Bool) -> [String: Any] {
        if force {
            vm.stop { [weak self] err in
                if let err = err { self?.log("force stop error: \(err)") }
                self?.state = "stopped"
                self?.writeState()
                self?.cleanupAndExit(code: 0)
            }
            return ["ok": true, "mode": "force"]
        }
        do {
            if vm.canRequestStop {
                try vm.requestStop()
                state = "stopping"
                stopRequestedAt = Date()
                writeState()
                // Graceful timeout -> hard stop after 60 s
                DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in
                    guard let self = self, self.state == "stopping" else { return }
                    self.log("graceful stop timed out, forcing")
                    _ = self.requestStop(force: true)
                }
                return ["ok": true, "mode": "graceful"]
            }
            return ["ok": false, "error": "cannot_request_stop", "state": state]
        } catch {
            return ["ok": false, "error": "\(error)"]
        }
    }

    func statusDict() -> [String: Any] {
        var d: [String: Any] = [
            "state": state,
            "pid": Int(getpid()),
            "name": config.name,
            "cpu_count": config.cpuCount,
            "memory_mb": config.memoryMB,
            "disk_size_gb": config.diskSizeGB,
            "disk_allocated_bytes": DiskOps.allocatedBytes(bundle.diskURL),
            "mac_address": config.macAddress,
            "started_at": startedAt,
            "vsock_bridges": config.vsockBridges.map { bundle.vsockSocketURL(port: $0).path },
            "active_bridges": activeBridgeCount(),
        ]
        if let e = lastError { d["last_error"] = e }
        if vm != nil {
            d["vz_state"] = vzStateName(vm.state)
        }
        return d
    }

    func vzStateName(_ s: VZVirtualMachine.State) -> String {
        switch s {
        case .stopped: return "stopped"
        case .running: return "running"
        case .paused: return "paused"
        case .error: return "error"
        case .starting: return "starting"
        case .pausing: return "pausing"
        case .resuming: return "resuming"
        case .stopping: return "stopping"
        case .saving: return "saving"
        case .restoring: return "restoring"
        @unknown default: return "unknown"
        }
    }

    func writeState() {
        let s = jsonLine(statusDict())
        try? s.write(to: bundle.stateURL, atomically: true, encoding: .utf8)
    }

    func cleanupAndExit(code: Int32) {
        for fd in listeners { close(fd) }
        try? FileManager.default.removeItem(at: bundle.controlSocketURL)
        try? FileManager.default.removeItem(at: bundle.controlTokenURL)
        for p in config.vsockBridges { try? FileManager.default.removeItem(at: bundle.vsockSocketURL(port: p)) }
        try? FileManager.default.removeItem(at: bundle.pidURL)
        writeState()
        exit(code)
    }

    func log(_ msg: String) {
        FileHandle.standardError.write("[nebula-vm \(isoNow())] \(msg)\n".data(using: .utf8)!)
    }

    func activeBridgeCount() -> Int {
        bridgeLock.lock(); defer { bridgeLock.unlock() }
        return activeBridges.count
    }

    // MARK: control socket
    func startControlSocket() throws {
        let fd = try UnixSocket.listen(path: bundle.controlSocketURL.path)
        listeners.append(fd)
        Thread.detachNewThread { [weak self] in
            while true {
                let c = accept(fd, nil, nil)
                if c < 0 { if errno == EINTR { continue }; return }
                guard let self = self else { close(c); return }
                Thread.detachNewThread {
                    var tv = timeval(tv_sec: 5, tv_usec: 0)  // a client that never sends a line cannot pin a thread
                    setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
                    let peerOK = ControlAuth.peerUID(c) == getuid()
                    let line = UnixSocket.readLine(c) ?? ""
                    var reply: [String: Any] = ["ok": false, "error": "bad_request"]
                    let sem = DispatchSemaphore(value: 0)
                    DispatchQueue.main.async {
                        reply = self.handleControl(line, peerOK: peerOK)
                        sem.signal()
                    }
                    sem.wait()
                    _ = UnixSocket.writeAll(c, (jsonLine(reply) + "\n").data(using: .utf8)!)
                    close(c)
                }
            }
        }
    }

    func handleControl(_ line: String, peerOK: Bool) -> [String: Any] {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cmd = obj["cmd"] as? String else {
            return ["ok": false, "error": "bad_request"]
        }
        guard peerOK, ControlAuth.verify(obj["token"], expected: controlToken) else {
            log("refused unauthenticated control request \(cmd)")
            return ["ok": false, "error": "unauthorized"]
        }
        switch cmd {
        case "status":
            var d = statusDict(); d["ok"] = true; return d
        case "stop":
            return requestStop(force: (obj["force"] as? Bool) ?? false)
        case "ping":
            return ["ok": true, "pong": true]
        default:
            return ["ok": false, "error": "unknown_command", "cmd": cmd]
        }
    }

    // MARK: vsock bridge (host unix socket -> guest vsock port)
    func startVsockBridge(port: UInt32) throws {
        let path = bundle.vsockSocketURL(port: port).path
        let fd = try UnixSocket.listen(path: path)
        listeners.append(fd)
        Thread.detachNewThread { [weak self] in
            while true {
                let c = accept(fd, nil, nil)
                if c < 0 { if errno == EINTR { continue }; return }
                guard let self = self else { close(c); return }
                DispatchQueue.main.async {
                    guard let dev = self.socketDevice, self.state == "running" else {
                        close(c); return
                    }
                    dev.connect(toPort: port) { result in
                        switch result {
                        case .success(let conn):
                            let guestFD = conn.fileDescriptor
                            var bridgeRef: FDBridge?
                            let bridge = FDBridge(c, guestFD) { [weak self] in
                                close(c)
                                DispatchQueue.main.async {
                                    conn.close()
                                    if let b = bridgeRef, let self = self {
                                        self.bridgeLock.lock()
                                        self.activeBridges.removeValue(forKey: ObjectIdentifier(b))
                                        self.bridgeLock.unlock()
                                    }
                                    bridgeRef = nil
                                }
                            }
                            bridgeRef = bridge
                            self.bridgeLock.lock()
                            self.activeBridges[ObjectIdentifier(bridge)] = (conn, bridge)
                            self.bridgeLock.unlock()
                            bridge.start()
                        case .failure(let err):
                            self.log("vsock connect port \(port) failed: \(err)")
                            close(c)
                        }
                    }
                }
            }
        }
    }
}
