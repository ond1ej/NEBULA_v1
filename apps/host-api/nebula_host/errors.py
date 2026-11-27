"""Typed JSON errors with request_id (spec §10.1)."""

from __future__ import annotations

import contextvars
import uuid

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, *, details: dict | None = None,
                 job_id: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}
        self.job_id = job_id


def error_body(code: str, message: str, details: dict | None = None, job_id: str | None = None) -> dict:
    body = {"error": {"code": code, "message": message, "details": details or {}},
            "request_id": request_id_var.get() or str(uuid.uuid4())}
    if job_id:
        body["job_id"] = job_id
    return body


def install_handlers(app) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_req: Request, exc: ApiError):
        return JSONResponse(error_body(exc.code, exc.message, exc.details, exc.job_id), status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def _validation(_req: Request, exc: RequestValidationError):
        errs = [{"loc": list(e.get("loc", [])), "msg": e.get("msg"), "type": e.get("type")} for e in exc.errors()]
        return JSONResponse(error_body("validation_error", "request validation failed", {"errors": errs}),
                            status_code=422)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_req: Request, exc: StarletteHTTPException):
        return JSONResponse(error_body(f"http_{exc.status_code}", str(exc.detail)), status_code=exc.status_code)

    @app.exception_handler(Exception)
    async def _unhandled(_req: Request, exc: Exception):
        import logging

        logging.getLogger("nebula").exception("unhandled error")
        return JSONResponse(error_body("internal_error", type(exc).__name__), status_code=500)
