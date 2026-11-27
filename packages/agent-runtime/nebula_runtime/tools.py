"""Typed tool catalogue (spec §5.2). Wire names use underscores (provider-safe); guest names use dots."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from nebula_providers.base import ToolSpec


@dataclass(frozen=True)
class Tool:
    wire: str
    guest: str | None  # None = executed on the host
    description: str
    params: dict[str, Any]
    min_level: str  # READ_ONLY | STANDARD | ADVANCED
    gui: bool = False  # uses the agent's desktop (blocked while the user holds Take Control)
    side_effect: bool = False  # irreversible-ish; tracked as pending side effect across crashes
    skills: tuple[str, ...] = ()  # skills that provide this tool; () = core tool, always available
    always_approve: bool = False  # owner approval even when global approvals are relaxed
    context: str | None = None  # "team" = only inside a team run

    def spec(self) -> ToolSpec:
        return ToolSpec(self.wire, self.description, self.params)


def obj(props: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {"type": "object", "properties": props, "required": required, "additionalProperties": False}


S = {"type": "string"}
I = {"type": "integer"}  # noqa: E741
B = {"type": "boolean"}

C = ("computer",)
BR = ("browser", "web_research")
FS = ("filesystem",)
TERM = ("terminal",)
ARR = {"type": "array", "items": {"type": "string"}}

TOOLS: list[Tool] = [
    # ---- screen / desktop (skill: computer, screenshot)
    Tool("desktop_screenshot", "desktop.screenshot", "Capture the agent's real desktop. Returns size; image is "
         "attached for vision-capable models.", obj({}, []), "READ_ONLY", skills=("computer", "screenshot")),
    Tool("desktop_state", "desktop.state", "Describe the screen without an image: active window, visible windows "
         "(ids, titles, geometry), open browser tabs.", obj({}, []), "READ_ONLY", skills=C),
    Tool("desktop_windows", "desktop.windows", "List visible desktop windows with ids and titles.", obj({}, []),
         "READ_ONLY", skills=C),
    Tool("desktop_click", "desktop.click", "Click at pixel coordinates on the desktop (1280x800 by default). The "
         "result says whether the screen changed.",
         obj({"x": I, "y": I, "button": {"type": "string", "enum": ["left", "middle", "right"]}, "double": B}, ["x", "y"]),
         "STANDARD", gui=True, side_effect=True, skills=C),
    Tool("desktop_move", "desktop.move", "Move the mouse pointer (hover).", obj({"x": I, "y": I}, ["x", "y"]),
         "STANDARD", gui=True, skills=C),
    Tool("desktop_drag", "desktop.drag", "Drag and drop with the left mouse button.",
         obj({"from_x": I, "from_y": I, "to_x": I, "to_y": I}, ["from_x", "from_y", "to_x", "to_y"]),
         "STANDARD", gui=True, side_effect=True, skills=C),
    Tool("desktop_type", "desktop.type", "Type text into the focused desktop window.", obj({"text": S}, ["text"]),
         "STANDARD", gui=True, side_effect=True, skills=C),
    Tool("desktop_keypress", "desktop.keypress", "Press keys / shortcuts (xdotool keysyms, e.g. 'ctrl+l', 'alt+Tab', "
         "'Return').", obj({"keys": S}, ["keys"]), "STANDARD", gui=True, side_effect=True, skills=C),
    Tool("desktop_scroll", "desktop.scroll", "Scroll at a desktop position.",
         obj({"x": I, "y": I, "direction": {"type": "string", "enum": ["up", "down", "left", "right"]}, "amount": I},
             ["x", "y", "direction"]), "STANDARD", gui=True, skills=C),
    Tool("desktop_window", "desktop.window", "Focus, minimize, maximize or close a window (by id from desktop_windows "
         "or by title).", obj({"window_id": S, "title": S, "action": {"type": "string", "enum": [
             "focus", "minimize", "maximize", "close"]}}, ["action"]), "STANDARD", gui=True, skills=C),
    Tool("desktop_launch", "desktop.launch", "Open an application on the desktop: terminal, files, editor, browser.",
         obj({"app": {"type": "string", "enum": ["terminal", "files", "editor", "text-editor", "browser"]}}, ["app"]),
         "STANDARD", gui=True, skills=C),
    # ---- browser (skill: browser / web_research)
    Tool("browser_navigate", "browser.navigate", "Open a URL in the agent's visible Chromium window.",
         obj({"url": S}, ["url"]), "READ_ONLY", gui=True, skills=BR),
    Tool("browser_observe", "browser.observe", "Read the current page: URL, title, visible text and interactive "
         "elements with CSS selectors usable by browser_click/browser_type.", obj({}, []), "READ_ONLY", gui=True,
         skills=BR),
    Tool("browser_click", "browser.click", "Click an element by CSS selector (from browser_observe).",
         obj({"selector": S}, ["selector"]), "STANDARD", gui=True, side_effect=True, skills=BR),
    Tool("browser_type", "browser.type", "Fill an input by CSS selector; optional submit (Enter).",
         obj({"selector": S, "text": S, "submit": B}, ["selector", "text"]), "STANDARD", gui=True, side_effect=True,
         skills=BR),
    Tool("browser_tabs", "browser.tabs", "List open browser tabs.", obj({}, []), "READ_ONLY", gui=True, skills=BR),
    Tool("browser_tab", "browser.tab", "Open a new tab (optionally with url), switch to or close a tab by index.",
         obj({"action": {"type": "string", "enum": ["new", "switch", "close"]}, "index": I, "url": S}, ["action"]),
         "STANDARD", gui=True, skills=BR),
    Tool("browser_history", "browser.history", "Go back, forward or reload the current tab.",
         obj({"action": {"type": "string", "enum": ["back", "forward", "reload"]}}, ["action"]), "READ_ONLY", gui=True,
         skills=BR),
    Tool("browser_wait", "browser.wait", "Wait for a CSS selector to appear (or a fixed time in ms).",
         obj({"selector": S, "timeout_ms": I}, []), "READ_ONLY", gui=True, skills=BR),
    Tool("browser_download", "browser.download", "Download a file (by URL or by clicking a link selector) into "
         "workspace/Downloads.", obj({"url": S, "selector": S}, []), "STANDARD", gui=True, side_effect=True, skills=BR),
    Tool("web_search", "web.search", "Search the web with the agent's browser; returns titles, URLs and snippets.",
         obj({"query": S}, ["query"]), "READ_ONLY", gui=True, skills=("web_research",)),
    # ---- filesystem (skill: filesystem)
    Tool("files_list", "files.list", "List a directory inside the workspace (or a team directory "
         "/srv/nebula/shared/<team>).", obj({"path": S}, []), "READ_ONLY", skills=FS),
    Tool("files_read", "files.read", "Read a text file inside the workspace.", obj({"path": S}, ["path"]), "READ_ONLY",
         skills=FS),
    Tool("files_stat", "files.stat", "Size, type and modification time of a path.", obj({"path": S}, ["path"]),
         "READ_ONLY", skills=FS),
    Tool("files_search", "files.search", "Find files by name fragment and/or contained text.",
         obj({"path": S, "pattern": S, "contains": S}, []), "READ_ONLY", skills=FS),
    Tool("files_write", "files.write", "Write (or append to) a file inside the workspace.",
         obj({"path": S, "content": S, "append": B}, ["path", "content"]), "STANDARD", side_effect=True, skills=FS),
    Tool("files_edit", "files.edit", "Replace text in a file (exact match; all=true for every occurrence).",
         obj({"path": S, "find": S, "replace": S, "all": B}, ["path", "find", "replace"]), "STANDARD", side_effect=True,
         skills=FS),
    Tool("files_mkdir", "files.mkdir", "Create a directory.", obj({"path": S}, ["path"]), "STANDARD", skills=FS),
    Tool("files_move", "files.move", "Move or rename a file/directory.", obj({"src": S, "dst": S, "overwrite": B},
         ["src", "dst"]), "STANDARD", side_effect=True, skills=FS),
    Tool("files_copy", "files.copy", "Copy a file/directory.", obj({"src": S, "dst": S, "overwrite": B}, ["src", "dst"]),
         "STANDARD", side_effect=True, skills=FS),
    Tool("files_delete", "files.delete", "Delete a file or an empty directory (recursive=true deletes a tree and "
         "needs the owner's approval).", obj({"path": S, "recursive": B}, ["path"]), "STANDARD", side_effect=True,
         skills=FS),
    # ---- terminal & processes (skill: terminal)
    Tool("shell_execute", "shell.execute", "Run a bash command as the agent's unprivileged Linux user inside its "
         "workspace (no sudo). Returns exit code, stdout, stderr.",
         obj({"command": S, "timeout": I, "cwd": S}, ["command"]), "ADVANCED", side_effect=True, skills=TERM),
    Tool("process_list", "process.list", "List this agent's processes.", obj({}, []), "READ_ONLY", skills=TERM),
    Tool("process_start", "process.start", "Start a long-running background process (e.g. a local web server); "
         "returns an id for process_output.", obj({"command": S, "cwd": S}, ["command"]), "ADVANCED", side_effect=True,
         skills=TERM),
    Tool("process_output", "process.output", "Read the output log of a process started with process_start.",
         obj({"id": S}, ["id"]), "READ_ONLY", skills=TERM),
    Tool("process_kill", "process.kill", "Terminate one of this agent's processes.", obj({"pid": I}, ["pid"]),
         "ADVANCED", side_effect=True, skills=TERM),
    Tool("packages_install", None, "Install Ubuntu packages in the shared VM (always needs the owner's approval).",
         obj({"names": ARR, "reason": S}, ["names", "reason"]), "ADVANCED", side_effect=True, skills=TERM,
         always_approve=True),
    # ---- developer skills
    Tool("git_run", "git.run", "Run git with an argument list, e.g. [\"status\"], [\"clone\", url]. push needs "
         "approval.", obj({"args": ARR, "cwd": S}, ["args"]), "ADVANCED", side_effect=True, skills=("git",)),
    Tool("github_api", None, "Read GitHub's public REST API (GET), e.g. path='/repos/owner/name/issues'.",
         obj({"path": S, "method": {"type": "string", "enum": ["GET", "POST", "PATCH"]}, "body": S}, ["path"]),
         "READ_ONLY", skills=("github",)),
    Tool("python_run", "python.run", "Run Python 3 code (or a workspace .py file) as the agent's user.",
         obj({"code": S, "path": S, "args": ARR, "timeout": I}, []), "ADVANCED", side_effect=True, skills=("python",)),
    Tool("node_run", "node.run", "Run JavaScript with Node.js (code or a workspace .js file).",
         obj({"code": S, "path": S, "args": ARR, "timeout": I}, []), "ADVANCED", side_effect=True, skills=("nodejs",)),
    # ---- documents & data
    Tool("pdf_text", "pdf.text", "Extract text from a PDF in the workspace.",
         obj({"path": S, "first_page": I, "last_page": I}, ["path"]), "READ_ONLY", skills=("pdf",)),
    Tool("data_analyze", "data.analyze", "Basic analysis of a CSV/JSON file: rows, column types, numeric stats, top "
         "values, optional group_by + sum_column.", obj({"path": S, "format": S, "group_by": S, "sum_column": S},
                                                        ["path"]), "READ_ONLY", skills=("data_analysis", "csv_json")),
    Tool("data_convert", "data.convert", "Convert CSV <-> JSON files.", obj({"src": S, "dst": S}, ["src", "dst"]),
         "STANDARD", side_effect=True, skills=("csv_json",)),
    Tool("doc_convert", "doc.convert", "Convert documents: markdown/text -> HTML, HTML -> text.",
         obj({"src": S, "dst": S}, ["src", "dst"]), "STANDARD", side_effect=True, skills=("documents",)),
    # ---- core (always available)
    Tool("memory_search", None, "Search your long-term memory (notes, decisions, owner preferences, past tasks).",
         obj({"query": S, "kind": S}, ["query"]), "READ_ONLY"),
    Tool("memory_store", None, "Store a durable note in your long-term memory (never secrets or passwords).",
         obj({"key": S, "value": S, "tags": S, "kind": {"type": "string", "enum": ["fact", "note", "decision",
                                                                                  "project"]},
              "importance": I}, ["key", "value"]), "STANDARD"),
    Tool("team_delegate", None, "Team lead only: hand a subtask to a team member by role. Results come back to the "
         "team run automatically; do not wait for them.", obj({"role": S, "title": S, "prompt": S}, ["role", "prompt"]),
         "READ_ONLY", context="team"),
    Tool("company_plan", None, "CEO only: submit the project plan as work items for your company's roles. Each item: "
         "role (a role key of the organisation), title, prompt (concrete instructions), depends_on (indices of earlier "
         "items). NEBULA assigns agents, environments and dependencies, then runs the items.",
         obj({"summary": S, "items": {"type": "array", "items": obj({
             "role": S, "title": S, "prompt": S, "depends_on": {"type": "array", "items": I}},
             ["role", "title", "prompt"])}}, ["summary", "items"]), "READ_ONLY", context="company_plan"),
    Tool("ask_approval", None, "Ask the human owner to approve a risky action before doing it.",
         obj({"reason": S, "action_preview": S}, ["reason", "action_preview"]), "READ_ONLY"),
    Tool("task_complete", None, "Finish the task. Set success=false if you could not do it. List concrete artifacts "
         "(workspace files or the URL now open) so NEBULA can verify them.",
         obj({"summary": S, "success": B,
              "artifacts": {"type": "array", "items": obj({"type": {"type": "string", "enum": ["file", "url"]},
                                                           "value": S}, ["type", "value"])}},
             ["summary", "success"]), "READ_ONLY"),
]
BY_WIRE = {t.wire: t for t in TOOLS}
LEVELS = ["READ_ONLY", "STANDARD", "ADVANCED", "HOST_CONTROL"]
LEVEL_PERMISSIONS = {
    "READ_ONLY": ["browser_read", "files_workspace_read"],
    "STANDARD": ["browser", "desktop", "files_workspace"],
    "ADVANCED": ["browser", "desktop", "files_workspace", "shell_standard"],
    "HOST_CONTROL": ["browser", "desktop", "files_workspace", "shell_standard", "host_control"],
}


BUILTIN_SKILLS = ("computer", "browser", "filesystem", "terminal", "git", "github", "python", "nodejs", "pdf",
                  "csv_json", "web_research", "documents", "screenshot", "data_analysis")


def level_ok(tool: Tool, level: str) -> bool:
    level = level if level in LEVELS else "READ_ONLY"
    return LEVELS.index(tool.min_level) <= LEVELS.index(level)


HOST_CAPABLE = {"files_list", "files_read", "files_stat", "files_search", "files_write", "files_edit", "files_mkdir",
                "files_move", "files_copy", "files_delete", "shell_execute", "process_list", "process_start",
                "process_output", "process_kill", "git_run", "python_run", "node_run", "pdf_text"}
VM_ONLY_HOST_TOOLS = {"packages_install"}  # host-side helpers that act on the VM


def available_in(t: Tool, env: str) -> bool:
    if env != "host":
        return True
    if t.wire.startswith("plug_"):
        return False  # plugins are untrusted code: VM only
    if t.guest is None:
        return t.wire not in VM_ONLY_HOST_TOOLS
    return t.wire in HOST_CAPABLE


def allowed_tools(level: str, skills: set[str] | None = None, *, in_team: bool = False,
                  extra: list[Tool] | None = None, env: str = "vm", contexts: set[str] | None = None) -> list[Tool]:
    """Tools an agent may call: core tools + tools of its enabled skills (all built-ins when skills is None),
    filtered by permission level and execution environment; team tools only inside a team run; context tools
    (e.g. company_plan) only when requested; `extra` = plugin tools."""
    out = []
    ctx = set(contexts or ())
    if in_team:
        ctx.add("team")
    for t in [*TOOLS, *(extra or [])]:
        if not level_ok(t, level):
            continue
        if t.context and t.context not in ctx:
            continue
        if not available_in(t, env):
            continue
        if t.skills and skills is not None and not (set(t.skills) & skills):
            continue
        out.append(t)
    return out


def permission_matrix() -> list[dict[str, Any]]:
    from nebula_runtime.policy import TOOL_RISKS

    return [{"tool": t.wire, "description": t.description, "min_level": t.min_level,
             "levels": {lv: level_ok(t, lv) for lv in LEVELS[:3]}, "skills": list(t.skills), "gui": t.gui,
             "environments": [e for e in ("vm", "host") if available_in(t, e)],
             "side_effect": t.side_effect, "always_approve": t.always_approve,
             "approval_when": TOOL_RISKS.get(t.wire, "")} for t in TOOLS]
