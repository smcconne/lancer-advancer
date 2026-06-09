"""WebSocket consumers for the lobby and individual game rooms.

Realtime fan-out uses the in-memory channel layer. Two groups exist:

* ``lobby``         - every client on the landing page; receives the list of
                      rooms that are waiting for an opponent.
* ``room_<id>``     - the (up to) two players in a single game; receives shared
                      game state and the game-over signal.

The server is authoritative: clients only send intents (``take_turn`` /
``resign``) and render whatever canonical state the server broadcasts back.
"""
from __future__ import annotations

import json
from urllib.parse import parse_qs

from channels.generic.websocket import AsyncWebsocketConsumer

from .store import store

LOBBY_GROUP = "lobby"


class LobbyConsumer(AsyncWebsocketConsumer):
    """Pushes the live list of joinable rooms to the landing page."""

    async def connect(self):
        await self.channel_layer.group_add(LOBBY_GROUP, self.channel_name)
        await self.accept()
        await self._send_rooms()

    async def disconnect(self, code):
        await self.channel_layer.group_discard(LOBBY_GROUP, self.channel_name)

    # Group event: something changed, re-read and push the fresh list.
    async def rooms_update(self, event):
        await self._send_rooms()

    async def _send_rooms(self):
        await self.send(
            text_data=json.dumps(
                {"type": "rooms", "rooms": store.waiting_rooms()}
            )
        )


class GameConsumer(AsyncWebsocketConsumer):
    """Drives a single room: seating, turns, resignation."""

    async def connect(self):
        self.room_id = self.scope["url_route"]["kwargs"]["room_id"]
        self.group = f"room_{self.room_id}"
        self.role = None

        params = parse_qs(self.scope["query_string"].decode())
        self.token = (params.get("token") or [""])[0]

        await self.accept()

        if not self.token:
            await self._send_error("missing token")
            await self.close()
            return

        result = store.attach(self.room_id, self.token)
        if result.room is None:
            await self._send_error("room not found")
            await self.close()
            return
        if result.role is None:
            await self._send_error("room full")
            await self.close()
            return

        self.role = result.role
        await self.channel_layer.group_add(self.group, self.channel_name)

        # Private message so this client learns which side it is playing.
        await self.send(
            text_data=json.dumps(
                {"type": "welcome", "role": self.role, "room_id": self.room_id}
            )
        )

        if result.just_started:
            # A guest just filled the room: drop it from the lobby and tell both
            # players the game has begun.
            await self.channel_layer.group_send(
                LOBBY_GROUP, {"type": "rooms_update"}
            )
            await self._broadcast_state()
        else:
            # Host (or a reconnect): send the current state to this client only.
            await self._send_state_to_self()

    async def disconnect(self, code):
        if not getattr(self, "role", None):
            return
        await self.channel_layer.group_discard(self.group, self.channel_name)
        if store.handle_disconnect(self.room_id, self.role):
            await self.channel_layer.group_send(
                LOBBY_GROUP, {"type": "rooms_update"}
            )

    async def receive(self, text_data=None, bytes_data=None):
        if not self.role or not text_data:
            return
        try:
            data = json.loads(text_data)
        except json.JSONDecodeError:
            return
        action = data.get("action")

        if action == "take_turn":
            if store.take_turn(self.room_id, self.role) is not None:
                await self._broadcast_state()
        elif action == "resign":
            room = store.resign(self.room_id, self.role)
            if room is not None:
                await self._broadcast_state()
                await self.channel_layer.group_send(
                    self.group, {"type": "game_over", "winner": room.winner}
                )

    # -- group event handlers ---------------------------------------------
    async def state_msg(self, event):
        await self.send(
            text_data=json.dumps({"type": "state", **event["state"]})
        )

    async def game_over(self, event):
        await self.send(
            text_data=json.dumps(
                {"type": "game_over", "winner": event["winner"]}
            )
        )

    # -- helpers -----------------------------------------------------------
    async def _broadcast_state(self):
        room = store.get(self.room_id)
        if room is None:
            return
        await self.channel_layer.group_send(
            self.group, {"type": "state_msg", "state": store.state_dict(room)}
        )

    async def _send_state_to_self(self):
        room = store.get(self.room_id)
        if room is None:
            return
        await self.send(
            text_data=json.dumps(
                {"type": "state", **store.state_dict(room)}
            )
        )

    async def _send_error(self, message):
        await self.send(
            text_data=json.dumps({"type": "error", "message": message})
        )
