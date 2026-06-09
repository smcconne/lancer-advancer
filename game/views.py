"""HTTP views: the lobby page, room creation, and the game page."""
from __future__ import annotations

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.http import HttpResponseBadRequest, JsonResponse
from django.shortcuts import render
from django.views.decorators.http import require_GET, require_POST

from .consumers import LOBBY_GROUP
from .store import store


@require_GET
def lobby(request):
    """Landing page: Host button + live list of joinable rooms."""
    return render(request, "game/lobby.html")


@require_POST
def host(request):
    """Create a new room owned by the caller's token and announce it.

    The token identifies the anonymous player and is generated client-side. We
    create the room here (server-authoritative ids) and return its id so the
    browser can navigate to ``/<room_id>``.
    """
    token = (request.POST.get("token") or "").strip()
    if not token:
        return HttpResponseBadRequest("missing token")

    room = store.create_room(token)

    # Tell everyone on the landing page that a new room is available.
    async_to_sync(get_channel_layer().group_send)(
        LOBBY_GROUP, {"type": "rooms_update"}
    )

    return JsonResponse({"room_id": room.id})


@require_GET
def game(request, room_id: str):
    """Render the game board. Validity of the room is resolved over the
    WebSocket connection, so unknown ids still render and then show an error."""
    return render(request, "game/game.html", {"room_id": room_id})
