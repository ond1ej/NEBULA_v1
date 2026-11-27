# Live Desktop

Live Desktop shows an agent's real screen inside the VM and lets you take over mouse and keyboard. It works in the
web dashboard, in the Telegram Mini App and in the native iPhone and Mac apps.

## How it works

```text
Dashboard (noVNC)  ──WebSocket──>  Host API live broker  ──unix socket──>  nebula-vm helper  ──vsock──>  guest service
                    single-use      viewer session,                                                     │
                    token           control lease,                                                      ▼
                                    RFB input filter                                   Xvnc of that agent (unix socket only)
```

- Every agent has its own X display (`Xvnc` with XFCE) inside the VM. Xvnc listens **only on a Unix socket** in the
  agent's runtime directory; it has no TCP port and no VNC password.
- When you press **Connect**, the host API creates a viewer session and a **single-use token valid for 90 seconds**.
  The browser opens a WebSocket with that token; only then does the broker open a tunnel to exactly that agent's
  display through the guest service. No viewer means no tunnel and no frames.
- The protocol is plain RFB (VNC) carried over the authenticated WebSocket. The dashboard renders it with
  [noVNC](https://github.com/novnc/noVNC); the native apps use their own RFB client.
- The stream is **read-only by default**. The broker parses the client's RFB messages and drops keyboard, pointer,
  clipboard and resize messages unless the viewer holds the control lease. Read-only is enforced on the server, not
  in the browser.

## Controls

| Control | What happens |
|---|---|
| **Connect** / **Reconnect** | Starts the stream. Wakes a sleeping desktop if the resource policy allows it. |
| **Take Control** | Acquires the exclusive control lease (renewable, 300 seconds by default). The agent's GUI actions pause while you hold it. Your mouse and keyboard reach the desktop. |
| **Release Control** | Hands control back. The agent observes the screen again before it continues, so it notices what you changed. |
| **Disconnect** | Stops the stream and frees the tunnel. The agent keeps working. With the default `live.release_control_on_disconnect`, the lease is released too. |
| Pause / Resume, Stop task | Controls the agent's current task from the same screen. |
| Screenshot, Fullscreen | Saves the current frame; switches to full screen. |

On touch devices a tap is a click, a double tap a double-click, a long press a right-click and two fingers scroll;
pinch to zoom and pan, and open the on-screen keyboard for typing.

The stream ends on **Disconnect**, when you close the page or app, on network loss, when the lease or session expires,
when the agent stops or when the VM restarts. A reaper closes idle and never-opened sessions every few seconds.

## Remote viewing

Through the remote gateway (see [remote-access.md](remote-access.md)), Live Desktop works the same way. The WebSocket
additionally needs the gateway session and the `desktop` permission, and every remote stream is written to the audit
log. One control lease exists per desktop, shared by all viewers: whoever holds it controls, everyone else watches.

## Things to know

- **Anything you type in Live Desktop is visible to the agent's environment.** That includes text typed into a page.
  When Smart sign-in hands you a step (for example a CAPTCHA), do only that step there. Passwords belong in NEBULA's
  secure sign-in form, not in the agent's browser. NEBULA clears password and one-time-code fields in the agent's
  browser when a sign-in ends and never returns their values to the agent.
- **Host agents have no Live Desktop.** Agents that run natively on the Mac have no GUI; Live Desktop refuses to
  connect for them.
- **Desktops sleep.** An idle desktop may be put to sleep to save memory (never while you watch it or hold control).
  "Desktop unavailable" usually means it sleeps: wake it, or restart the desktop from the agent's settings.
- **Resolution** is per agent (default `1280x800`).
- **Performance.** Streams exist only while someone watches. A connected viewer costs CPU on the Mac and the VM;
  disconnect when you do not need to watch.
