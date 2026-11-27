"""Voice Agent 2.0: voice command understanding (English by default, Czech when the text is Czech), spoken status
summaries, per-agent voice settings.

Deterministic intent parsing (no AI request needed for status/pause/resume/stop/screenshot/team/company status):
"Developere, jak pokračuje ten projekt?" -> agent=Developer, intent=status (answered from real task data, spoken).
Anything else becomes a normal task for the addressed agent; the orchestrator already includes the recent
conversation, so follow-ups like "Tak dokonči backend a pak mi pošli výsledek" keep their context.
High-impact actions inside tasks still go through approvals.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from sqlalchemy import and_, select

from nebula_host import db, models

REPLY_MODES = ("text", "voice", "text_voice", "auto")
DEFAULTS = {"reply_mode": "auto", "provider": "macos", "voice": None, "language": "auto", "rate": 1.0}

STATUS_RE = re.compile(r"(jak (to )?(pokra[cč]uj|jde|vypad)|jak[yý] je stav|stav (projektu|[uú]kolu|pr[aá]ce)|"
                       r"\bstatus\b|\bprogress\b|how('s| is) .{0,40}going|what'?s the status|co d[eě]l[aá][sš]?\b)", re.I)
PAUSE_RE = re.compile(r"^(pozastav|pauza|zastav se na chv|pause)\b", re.I)
RESUME_RE = re.compile(r"^(pokra[cč]uj( d[aá]l)?|obnov|resume|continue)\b[.!]?$", re.I)
STOP_RE = re.compile(r"^(zastav|stop|zru[sš]|ukon[cč]i|cancel)\b", re.I)
SHOT_RE = re.compile(r"(screenshot|sn[ií]mek obrazovky|uk[aá][zž] (mi )?(obrazovku|plochu)|show (me )?(the )?screen)", re.I)
TEAM_RE = re.compile(r"(stav t[yý]mu|t[yý]m(ov[yý])? stav|team status|how is the team)", re.I)
COMPANY_RE = re.compile(r"(stav (firmy|spole[cč]nosti|company)|company status|how is the company)", re.I)


def _fold(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s.lower()) if unicodedata.category(c) != "Mn")


def agent_voice(agent: dict[str, Any]) -> dict[str, Any]:
    v = {**DEFAULTS, **((agent.get("config") or {}).get("voice") or {})}
    if v["reply_mode"] not in REPLY_MODES:
        v["reply_mode"] = "auto"
    return v


# Letters only Czech uses (of the languages NEBULA speaks): one of them settles it.
_CS_LETTERS = re.compile(r"[ěščřžůťďň]")
# Acute vowels are Czech too, but also French, Spanish, ... ("café", "résumé"): they only support other evidence.
_ACUTE = re.compile(r"[áéíóúý]")
_WORD = re.compile(r"[^\W\d_]+")
# Czech function words and common command words, written without diacritics, that are NOT English words. Words that
# are both ("a", "i", "to", "do", "on", "my", "ten", "pro", "no", "ve" as in "I've") count for neither language.
_CS_WORDS = frozenset("""
    jak jaky jaka jake jakou co kdo kde kdy proc je jsem jsi jsou jste jsme byl byla bylo byli bude budu budes budou
    se si mi mne na ze ke od za pri nad bez mezi nebo jako ktery ktera ktere kdyz aby jestli protoze potom tak taky
    jeste uz toho tomu neni ano prosim prosimte dekuji dekuju diky ahoj muj moje tvuj tvoje jeho jeji jejich ja ona
    oni vy dnes zitra vcera tady vse vsechno neco nekdo muzes muzu chci chces potrebuji potrebuju jde delas dela
    delat udelej dokonci posli zjisti napis otevri zkontroluj priprav najdi ukaz spust zastav pokracuj pokracuje shrn
    vytvor oprav prihlas stav ukol ukolu ukoly vysledek souhrn shrnuti prehled hotovo firma firmy tym tymu projekt
    projektu obrazovku
""".split())
_EN_WORDS = frozenset("""
    the and or of in for with is are was were be been it its this that these those please what how why when where
    who which can could would should will you your we our they their he she his her at from by about all any some
    not yes does did have has had get go send write open log show run stop check find make tell give let an if then
    than there here up out into over after before now just also summary report site browser task email file
""".split())


def detect_language(text: str) -> str:
    """"cs" or "en". English is the default; Czech needs evidence (P4): a letter only Czech uses (ě š č ř ž ů ť ď
    ň), every word a Czech-only word ("ahoj", "stav?"), or Czech-only words (helped by words with acute vowels)
    that clearly outnumber the English ones. Common English words never make a text Czech."""
    t = (text or "").lower()
    if _CS_LETTERS.search(t):
        return "cs"
    words = _WORD.findall(t)
    if not words:
        return "en"
    cs_words = sum(1 for w in words if _fold(w) in _CS_WORDS)
    acute = sum(1 for w in words if _fold(w) not in _CS_WORDS and _ACUTE.search(w))
    en_words = sum(1 for w in words if w in _EN_WORDS)
    if cs_words == len(words):
        return "cs"
    score = cs_words + acute
    if cs_words >= 1 and score >= 2 and score > 2 * en_words:
        return "cs"
    return "en"


def parse(text: str, agents: list[dict[str, Any]], default_agent: str | None) -> dict[str, Any]:
    """-> {intent, agent_id, text, addressed}"""
    raw = (text or "").strip()
    agent_id, addressed, rest = default_agent, False, raw
    m = re.match(r"^\s*([\wÀ-ž][\wÀ-ž .-]{1,40}?)\s*[,:!]\s*(.+)$", raw, re.S)
    if m:
        cand = _fold(m.group(1)).strip()
        for a in agents:
            name = _fold(a["name"]).strip()
            # vocative tolerance: "Developere" / "Researchere" / "Novaku" address "Developer" / "Researcher" / "Novák"
            if cand == name or (len(name) >= 4 and cand.startswith(name[: max(4, len(name) - 1)])
                                and len(cand) - len(name) <= 3):
                agent_id, addressed, rest = a["id"], True, m.group(2).strip()
                break
    body = rest.strip()
    if COMPANY_RE.search(body):
        intent = "company_status"
    elif TEAM_RE.search(body):
        intent = "team_status"
    elif SHOT_RE.search(body):
        intent = "screenshot"
    elif STATUS_RE.search(body) and len(body) < 160:
        intent = "status"
    elif PAUSE_RE.search(body):
        intent = "pause"
    elif RESUME_RE.search(body):
        intent = "resume"
    elif STOP_RE.search(body) and len(body) < 60:
        intent = "stop"
    else:
        intent = "task"
    return {"intent": intent, "agent_id": agent_id, "text": body, "addressed": addressed}


def _t(lang: str, cs: str, en: str) -> str:
    return cs if lang == "cs" else en


STATE_CS = {"QUEUED": "ve frontě", "RECEIVED": "přijatý", "PLANNING": "přemýšlí", "EXECUTING": "pracuje",
            "VERIFYING": "ověřuje výsledek", "WAITING_APPROVAL": "čeká na tvé schválení", "PAUSED": "pozastavený",
            "WAITING_CONTROL": "čeká, až vrátíš ovládání", "WAITING_PROVIDER": "čeká na AI poskytovatele",
            "COMPLETED": "dokončený", "FAILED": "selhal", "CANCELLED": "zrušený", "PAUSING": "pozastavuje se"}


def status_summary(agent_id: str, lang: str = "en") -> str:
    with db.engine().connect() as c:
        a = db.row(c.execute(select(models.agents).where(models.agents.c.id == agent_id)).first())
        cur = db.row(c.execute(select(models.tasks).where(and_(
            models.tasks.c.agent_id == agent_id, models.tasks.c.state.notin_(["COMPLETED", "FAILED", "CANCELLED"])))
            .order_by(models.tasks.c.created_at.desc())).first())
        last = db.row(c.execute(select(models.tasks).where(and_(
            models.tasks.c.agent_id == agent_id, models.tasks.c.state.in_(["COMPLETED", "FAILED", "CANCELLED"])))
            .order_by(models.tasks.c.finished_at.desc())).first())
        step = None
        if cur:
            step = db.row(c.execute(select(models.task_steps).where(models.task_steps.c.task_id == cur["id"])
                                    .order_by(models.task_steps.c.seq.desc())).first())
    if not a:
        return _t(lang, "Tohoto agenta neznám.", "I don't know this agent.")
    name = a["name"]
    if cur:
        st = STATE_CS.get(cur["state"], cur["state"]) if lang == "cs" else cur["state"].lower().replace("_", " ")
        s = _t(lang, f"{name}: aktuální úkol je {st}. ", f"{name}: the current task is {st}. ")
        s += _t(lang, f"Zadání: {cur['prompt'][:140]}. ", f"Task: {cur['prompt'][:140]}. ")
        s += _t(lang, f"Hotovo {cur['current_step']} z maximálně {cur['max_steps']} kroků.",
                f"{cur['current_step']} of at most {cur['max_steps']} steps done.")
        if step:
            s += _t(lang, f" Poslední krok: {step['tool_type']} ({step['result_status']}).",
                    f" Last step: {step['tool_type']} ({step['result_status']}).")
        return s
    if last:
        res = (last.get("result") or {}).get("summary") or last.get("failure_reason") or ""
        st = STATE_CS.get(last["state"], last["state"]) if lang == "cs" else last["state"].lower()
        return _t(lang, f"{name} teď nemá žádný běžící úkol. Poslední úkol je {st}: {res[:400]}",
                  f"{name} has no running task. The last task {st}: {res[:400]}")
    return _t(lang, f"{name} zatím nemá žádné úkoly.", f"{name} has no tasks yet.")


def team_summary(lang: str = "en") -> str:
    with db.engine().connect() as c:
        runs = db.rows(c.execute(select(models.team_runs, models.teams.c.name).join(
            models.teams, models.teams.c.id == models.team_runs.c.team_id)
            .order_by(models.team_runs.c.created_at.desc()).limit(3)))
    if not runs:
        return _t(lang, "Žádný tým zatím nepracoval.", "No team has run yet.")
    parts = [f"{r['name']}: {r['state'].lower()}" for r in runs]
    return _t(lang, "Poslední týmové běhy: ", "Latest team runs: ") + "; ".join(parts) + "."


def company_summary(lang: str = "en", company_id: str | None = None) -> str:
    from nebula_host import companies as cosvc

    cos = cosvc.list_companies()
    if company_id:
        cos = [c for c in cos if c["id"] == company_id]
    if not cos:
        return _t(lang, "Zatím nemáš žádnou AI firmu.", "You have no AI company yet.")
    parts = []
    for co in cos[:3]:
        d = cosvc.get_company(co["id"])
        st = d["stats"]
        parts.append(_t(lang, f"{co['name']}: {st['members']} zaměstnanců, {st['runs_active']} aktivních běhů, "
                              f"{st['running_items']} právě běžících úkolů",
                        f"{co['name']}: {st['members']} employees, {st['runs_active']} active runs, "
                        f"{st['running_items']} work items running"))
    return "; ".join(parts) + "."


def should_speak(mode: str, input_was_voice: bool) -> tuple[bool, bool]:
    """-> (send_text, send_voice)"""
    if mode == "text":
        return True, False
    if mode == "voice":
        return False, True
    if mode == "text_voice":
        return True, True
    return True, input_was_voice  # auto: answer voice with voice (+ text for readability)
