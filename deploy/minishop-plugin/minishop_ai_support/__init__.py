"""Service-token support API for the AI Support MiniShop connector."""

from __future__ import annotations

import os
import secrets
from functools import wraps
from typing import Any

from aiohttp import web

from bot.app.web.message_image_responses import message_image_response
from bot.app.web.support_schemas import (
    AdminSupportMessageOut,
    AdminSupportUserOut,
    SupportTicketOut,
)
from bot.plugins.spec import Plugin, PluginContext, WEB_SCOPE_WEBAPP, WEB_SCOPE_WEBHOOKS
from bot.services.message_image_service import (
    MessageImageError,
    UploadedMessageImage,
    load_message_image,
    prepare_message_image,
)
from bot.services.support_message_body import SupportBodyError
from bot.services.support_service import SupportService, TicketNotFound
from db.dal import support_dal, user_dal

PREFIX = "/api/plugins/ai-support/v1"
VALID_STATUSES = {"open", "awaiting_user", "awaiting_admin", "resolved", "closed"}
FILTER_STATUSES = VALID_STATUSES | {"active", "all", "any"}


def _ok(data: dict[str, Any] | None = None) -> web.Response:
    return web.json_response({"ok": True, **(data or {})})


def _error(status: int, code: str, message: str) -> web.Response:
    return web.json_response(
        {"ok": False, "error": code, "message": message},
        status=status,
    )


def _ticket_payload(ticket: Any) -> dict[str, Any]:
    return SupportTicketOut.from_orm_ticket(ticket).model_dump(mode="json")


def _user_payload(user: Any) -> dict[str, Any]:
    return AdminSupportUserOut.from_orm_user(user).model_dump(mode="json") if user else {}


def _message_payload(message: Any, author_name: str | None = None) -> dict[str, Any]:
    return AdminSupportMessageOut.from_orm_message(
        message,
        author_name=author_name,
    ).model_dump(mode="json")


class AiSupportPlugin(Plugin):
    name = "ai_support"
    version = "1.0.0"
    plugin_api_min_version = 1
    plugin_api_max_version = 1

    def setup_web(self, ctx: PluginContext, app: web.Application, *, scope: str) -> None:
        # MiniShop exposes two HTTP planes: webhook/backend on 8080 and WebApp
        # API on 8081. Installations commonly publish them under different
        # domains, so the service-token API must be reachable through either
        # documented public base URL.
        if scope not in {WEB_SCOPE_WEBAPP, WEB_SCOPE_WEBHOOKS}:
            return
        token = os.getenv("MINISHOP_AI_SUPPORT_TOKEN", "").strip()
        if len(token) < 24:
            raise RuntimeError("MINISHOP_AI_SUPPORT_TOKEN must contain at least 24 characters")

        session_factory = ctx.require_session_factory()
        support_service = ctx.require_service("support_service", SupportService)

        def protected(handler: Any) -> Any:
            @wraps(handler)
            async def wrapped(request: web.Request) -> web.StreamResponse:
                supplied = request.headers.get("X-API-Key", "")
                if not secrets.compare_digest(supplied, token):
                    return _error(401, "unauthorized", "Invalid service token")
                return await handler(request)

            return wrapped

        routes = web.RouteTableDef()

        async def resolve_admin_id() -> int:
            configured = os.getenv("MINISHOP_AI_SUPPORT_ADMIN_TELEGRAM_ID", "").strip()
            telegram_ids = [int(configured)] if configured.isdigit() else list(ctx.settings.ADMIN_IDS)
            if not telegram_ids:
                raise RuntimeError(
                    "Set MINISHOP_AI_SUPPORT_ADMIN_TELEGRAM_ID or configure MiniShop ADMIN_IDS"
                )
            async with session_factory() as session:
                admin = await user_dal.get_user_by_telegram_id(session, telegram_ids[0])
            if admin is None:
                raise RuntimeError(
                    f"MiniShop admin Telegram user {telegram_ids[0]} has no database account"
                )
            return int(admin.user_id)

        @routes.get(f"{PREFIX}/health")
        @protected
        async def health(_request: web.Request) -> web.Response:
            try:
                admin_id = await resolve_admin_id()
            except RuntimeError as exc:
                return _error(503, "admin_unavailable", str(exc))
            return _ok({"plugin": self.name, "version": self.version, "admin_id": admin_id})

        @routes.get(f"{PREFIX}/support/tickets")
        @protected
        async def list_tickets(request: web.Request) -> web.Response:
            try:
                limit = max(1, min(100, int(request.query.get("limit", "100"))))
                offset = max(0, int(request.query.get("offset", "0")))
            except ValueError:
                return _error(400, "invalid_pagination", "limit and offset must be integers")
            status = request.query.get("status") or None
            if status and status not in FILTER_STATUSES:
                return _error(400, "invalid_status", "Unknown ticket status")
            async with session_factory() as session:
                tickets = await support_dal.list_admin_tickets(
                    session,
                    status=status,
                    limit=limit,
                    offset=offset,
                )
            return _ok(
                {
                    "tickets": [
                        {
                            **_ticket_payload(ticket),
                            "user": _user_payload(getattr(ticket, "user", None)),
                        }
                        for ticket in tickets
                    ]
                }
            )

        @routes.get(PREFIX + r"/support/tickets/{id:\d+}")
        @protected
        async def ticket_detail(request: web.Request) -> web.Response:
            ticket_id = int(request.match_info["id"])
            async with session_factory() as session:
                ticket, messages = await support_dal.get_ticket(
                    session,
                    ticket_id,
                    include_internal=True,
                )
                if ticket is None:
                    return _error(404, "not_found", "Ticket not found")
                user = await user_dal.get_user_by_id(session, ticket.user_id)
                snapshot = (
                    await support_service.build_user_snapshot(user, session=session) if user else {}
                )
                author_ids = {m.author_user_id for m in messages if m.author_user_id is not None}
                authors = {
                    author_id: author
                    for author_id in author_ids
                    if (author := await user_dal.get_user_by_id(session, author_id)) is not None
                }
            return _ok(
                {
                    "ticket": {**_ticket_payload(ticket), "user": _user_payload(user)},
                    "messages": [
                        _message_payload(
                            message,
                            " ".join(
                                filter(
                                    None,
                                    [
                                        getattr(authors.get(message.author_user_id), "first_name", None),
                                        getattr(authors.get(message.author_user_id), "last_name", None),
                                    ],
                                )
                            )
                            or getattr(authors.get(message.author_user_id), "username", None),
                        )
                        for message in messages
                    ],
                    "user_snapshot": snapshot,
                    "peer_typing": False,
                }
            )

        @routes.post(PREFIX + r"/support/tickets/{id:\d+}/messages")
        @protected
        async def reply(request: web.Request) -> web.Response:
            ticket_id = int(request.match_info["id"])
            body = ""
            body_format = "text"
            image = None
            try:
                if request.content_type.startswith("multipart/"):
                    reader = await request.multipart()
                    async for field in reader:
                        if field.name == "image":
                            upload = UploadedMessageImage(
                                data=await field.read(decode=False),
                                filename=field.filename or "image",
                                content_type=field.headers.get("Content-Type", ""),
                            )
                            image = await prepare_message_image(upload)
                        elif field.name == "body":
                            body = await field.text()
                        elif field.name == "body_format":
                            body_format = await field.text()
                else:
                    payload = await request.json()
                    body = str(payload.get("body", ""))
                    body_format = str(payload.get("body_format", "text"))
            # Pillow may raise SyntaxError for a container with a valid image
            # signature but a broken chunk checksum. Treat it as bad input,
            # not as an unhandled server failure.
            except (ValueError, MessageImageError, SyntaxError) as exc:
                return _error(400, "invalid_request", str(exc))
            if body_format not in {"text", "html"}:
                return _error(400, "invalid_body_format", "body_format must be text or html")
            if not body.strip() and image is None:
                return _error(400, "empty_text", "Message is empty")
            try:
                admin_id = await resolve_admin_id()
                ticket, message = await support_service.reply_as_admin(
                    admin_id,
                    ticket_id,
                    body,
                    body_format=body_format,
                    image=image,
                )
            except SupportBodyError:
                return _error(400, "invalid_body", "Message body is invalid")
            except TicketNotFound:
                return _error(404, "not_found", "Ticket not found")
            except RuntimeError as exc:
                return _error(503, "admin_unavailable", str(exc))
            return _ok(
                {
                    "ticket": _ticket_payload(ticket),
                    "message": _message_payload(message),
                }
            )

        @routes.patch(PREFIX + r"/support/tickets/{id:\d+}")
        @protected
        async def patch_ticket(request: web.Request) -> web.Response:
            ticket_id = int(request.match_info["id"])
            try:
                payload = await request.json()
            except ValueError:
                return _error(400, "invalid_request", "Expected a JSON object")
            status = payload.get("status")
            if status not in VALID_STATUSES:
                return _error(400, "invalid_status", "Unknown ticket status")
            try:
                admin_id = await resolve_admin_id()
                ticket = (
                    await support_service.close_ticket(admin_id, ticket_id)
                    if status == "closed"
                    else await support_service.change_status(admin_id, ticket_id, status)
                )
            except TicketNotFound:
                return _error(404, "not_found", "Ticket not found")
            except RuntimeError as exc:
                return _error(503, "admin_unavailable", str(exc))
            return _ok({"ticket": _ticket_payload(ticket)})

        @routes.post(PREFIX + r"/support/tickets/{id:\d+}/read")
        @protected
        async def mark_read(request: web.Request) -> web.Response:
            await support_service.mark_read_as_admin(int(request.match_info["id"]))
            return _ok()

        @routes.get(PREFIX + r"/message-images/{image_id:[0-9a-fA-F]{32}}")
        @protected
        async def message_image(request: web.Request) -> web.StreamResponse:
            async with session_factory() as session:
                stored = await load_message_image(session, request.match_info["image_id"].lower())
            if stored is None:
                raise web.HTTPNotFound()
            return await message_image_response(stored)

        app.add_routes(routes)


plugin = AiSupportPlugin()
