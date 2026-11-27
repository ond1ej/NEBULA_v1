"""Minimal official Telegram Bot API client (long polling only; no webhook)."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any

import httpx


class TelegramError(Exception):
    def __init__(self, code: int, description: str, retry_after: int | None = None):
        super().__init__(f"{code}: {description}")
        self.code = code
        self.description = description
        self.retry_after = retry_after


class BotAPI:
    def __init__(self, token_getter: Callable[[], str | None], base: str = "https://api.telegram.org") -> None:
        self._token = token_getter
        self.base = base.rstrip("/")
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(15, read=70))

    async def close(self) -> None:
        await self._client.aclose()

    def _url(self, method: str) -> str:
        tok = self._token()
        if not tok:
            raise TelegramError(401, "bot token not configured")
        return f"{self.base}/bot{tok}/{method}"

    async def call(self, method: str, params: dict[str, Any] | None = None, *, files: dict | None = None,
                   retries: int = 3, timeout: float | None = None) -> Any:
        for attempt in range(retries + 1):
            try:
                if files:
                    data = {k: (json.dumps(v) if isinstance(v, (dict, list)) else str(v))
                            for k, v in (params or {}).items() if v is not None}
                    r = await self._client.post(self._url(method), data=data, files=files, timeout=timeout or 60)
                else:
                    r = await self._client.post(self._url(method),
                                                json={k: v for k, v in (params or {}).items() if v is not None},
                                                timeout=timeout or httpx.USE_CLIENT_DEFAULT)
            except httpx.HTTPError as e:
                if attempt >= retries:
                    raise TelegramError(0, f"network error: {type(e).__name__}") from e
                await asyncio.sleep(2 ** attempt)
                continue
            try:
                body = r.json()
            except ValueError:
                body = {"ok": False, "error_code": r.status_code, "description": r.text[:200]}
            if body.get("ok"):
                return body.get("result")
            code = int(body.get("error_code", r.status_code))
            retry_after = (body.get("parameters") or {}).get("retry_after")
            if code == 429 and retry_after and attempt < retries:
                await asyncio.sleep(min(int(retry_after), 30))
                continue
            if code >= 500 and attempt < retries:
                await asyncio.sleep(2 ** attempt)
                continue
            raise TelegramError(code, str(body.get("description", "")), retry_after)
        raise TelegramError(0, "unreachable")

    async def get_me(self) -> dict[str, Any]:
        return await self.call("getMe", retries=1)

    async def get_updates(self, offset: int, timeout: int) -> list[dict[str, Any]]:
        return await self.call("getUpdates", {"offset": offset, "timeout": timeout, "limit": 50,
                                              "allowed_updates": ["message", "callback_query"]},
                               retries=0, timeout=timeout + 15)

    async def send_message(self, chat_id: int, text: str, thread_id: int | None = None,
                           reply_markup: dict | None = None, silent: bool = False) -> dict[str, Any]:
        return await self.call("sendMessage", {"chat_id": chat_id, "text": text[:4096],
                                               "message_thread_id": thread_id, "reply_markup": reply_markup,
                                               "disable_notification": True if silent else None,
                                               "link_preview_options": {"is_disabled": True}})

    async def edit_message_text(self, chat_id: int, message_id: int, text: str, reply_markup: dict | None = None) -> Any:
        return await self.call("editMessageText", {"chat_id": chat_id, "message_id": message_id, "text": text[:4096],
                                                   "reply_markup": reply_markup}, retries=1)

    async def send_document(self, chat_id: int, name: str, data: bytes, caption: str = "",
                            thread_id: int | None = None) -> Any:
        return await self.call("sendDocument", {"chat_id": chat_id, "caption": caption[:1024],
                                                "message_thread_id": thread_id},
                               files={"document": (name[:120] or "file", data, "application/octet-stream")})

    async def send_photo(self, chat_id: int, png: bytes, caption: str = "", thread_id: int | None = None) -> Any:
        return await self.call("sendPhoto", {"chat_id": chat_id, "caption": caption[:1024],
                                             "message_thread_id": thread_id},
                               files={"photo": ("screenshot.png", png, "image/png")})

    async def answer_callback(self, callback_id: str, text: str = "", alert: bool = False) -> Any:
        try:
            return await self.call("answerCallbackQuery", {"callback_query_id": callback_id, "text": text[:200],
                                                           "show_alert": True if alert else None}, retries=1)
        except TelegramError as e:
            if e.code == 400:  # query too old / already answered: harmless
                return None
            raise

    async def send_voice(self, chat_id: int, audio: bytes, caption: str = "", thread_id: int | None = None,
                         duration: float | None = None, mime: str = "audio/ogg") -> Any:
        name = "voice.ogg" if mime == "audio/ogg" else "voice.m4a"
        return await self.call("sendVoice", {"chat_id": chat_id, "caption": caption[:1024] or None,
                                             "message_thread_id": thread_id,
                                             "duration": int(duration) if duration else None},
                               files={"voice": (name, audio, mime)})

    async def delete_message(self, chat_id: int, message_id: int) -> Any:
        return await self.call("deleteMessage", {"chat_id": chat_id, "message_id": message_id}, retries=0)

    async def set_chat_menu_button(self, url: str | None, text: str = "NEBULA") -> Any:
        btn = {"type": "web_app", "text": text[:64], "web_app": {"url": url}} if url else {"type": "commands"}
        return await self.call("setChatMenuButton", {"menu_button": btn}, retries=1)

    async def set_my_commands(self, commands: list[dict[str, str]]) -> Any:
        return await self.call("setMyCommands", {"commands": commands[:100]}, retries=1)

    async def set_my_name(self, name: str) -> Any:
        return await self.call("setMyName", {"name": name[:64]}, retries=0)

    async def set_my_description(self, description: str) -> Any:
        return await self.call("setMyDescription", {"description": description[:512]}, retries=0)

    async def set_my_short_description(self, text: str) -> Any:
        return await self.call("setMyShortDescription", {"short_description": text[:120]}, retries=0)

    async def create_forum_topic(self, chat_id: int, name: str) -> dict[str, Any]:
        return await self.call("createForumTopic", {"chat_id": chat_id, "name": name[:128], "icon_color": 9367192},
                               retries=1)

    async def edit_forum_topic(self, chat_id: int, thread_id: int, name: str) -> Any:
        return await self.call("editForumTopic", {"chat_id": chat_id, "message_thread_id": thread_id,
                                                  "name": name[:128]}, retries=1)

    async def get_file(self, file_id: str) -> dict[str, Any]:
        return await self.call("getFile", {"file_id": file_id})

    async def download_file(self, file_path: str, max_bytes: int) -> bytes:
        tok = self._token()
        url = f"{self.base}/file/bot{tok}/{file_path}"
        buf = bytearray()
        async with self._client.stream("GET", url, timeout=60) as r:
            if r.status_code != 200:
                raise TelegramError(r.status_code, "file download failed")
            async for chunk in r.aiter_bytes():
                buf += chunk
                if len(buf) > max_bytes:
                    raise TelegramError(413, "file too large")
        return bytes(buf)
