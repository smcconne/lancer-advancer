"""In-memory game state for Lancer Advancer.

A single process holds every room (matching the single Fly.io machine + in-memory
channel layer). All mutations are guarded by a lock because Django HTTP views run
in a thread pool while the Channels consumers run on the event loop. The critical
sections are tiny and never ``await``, so a plain ``threading.Lock`` is safe.

Rooms live only in memory and are intentionally lost on redeploy.
"""
from __future__ import annotations

import secrets
import threading
import time
from dataclasses import dataclass, field

from . import game_logic as gl

# Room lifecycle states.
WAITING = "waiting"  # host created the room, no opponent yet
PLAYING = "playing"  # both players present, game in progress
OVER = "over"  # game finished (a player resigned)


@dataclass
class Room:
    id: str
    host_token: str
    guest_token: str | None = None
    status: str = WAITING
    turn: str | None = None  # gl.HOST or gl.GUEST while PLAYING
    host_idx: int = gl.START_INDEX
    guest_idx: int = gl.START_INDEX
    last_roll: int | None = None
    last_mover: str | None = None
    winner: str | None = None  # gl.HOST or gl.GUEST once OVER
    created_at: float = field(default_factory=time.time)


@dataclass
class AttachResult:
    """Outcome of a player connecting to a room."""

    room: Room | None
    role: str | None  # gl.HOST, gl.GUEST, or None when the connection is rejected
    just_started: bool = False  # True only when this connection started the game


class GameStore:
    def __init__(self) -> None:
        self._rooms: dict[str, Room] = {}
        self._lock = threading.Lock()

    # -- lifecycle ---------------------------------------------------------
    def reset(self) -> None:
        """Drop all rooms (used by tests)."""
        with self._lock:
            self._rooms.clear()

    def create_room(self, host_token: str) -> Room:
        with self._lock:
            room_id = self._new_id()
            room = Room(id=room_id, host_token=host_token)
            self._rooms[room_id] = room
            return room

    def get(self, room_id: str) -> Room | None:
        return self._rooms.get(room_id)

    def waiting_rooms(self) -> list[dict]:
        """Rooms still looking for an opponent, oldest first (for the lobby)."""
        with self._lock:
            rooms = [
                {"id": r.id, "created_at": r.created_at}
                for r in self._rooms.values()
                if r.status == WAITING and r.guest_token is None
            ]
        rooms.sort(key=lambda r: r["created_at"])
        return rooms

    # -- player connection -------------------------------------------------
    def attach(self, room_id: str, token: str) -> AttachResult:
        """Resolve a connecting player's role, assigning the guest seat and
        starting the game (with a random first turn) on a fresh join."""
        with self._lock:
            room = self._rooms.get(room_id)
            if room is None:
                return AttachResult(None, None)
            if token == room.host_token:
                return AttachResult(room, gl.HOST)
            if token == room.guest_token:
                return AttachResult(room, gl.GUEST)
            if room.guest_token is None and room.status == WAITING:
                room.guest_token = token
                room.status = PLAYING
                room.turn = secrets.choice((gl.HOST, gl.GUEST))
                return AttachResult(room, gl.GUEST, just_started=True)
            # Room is full and the token matches neither player.
            return AttachResult(room, None)

    def handle_disconnect(self, room_id: str, role: str) -> bool:
        """Clean up an abandoned, still-empty room. Returns True if the lobby
        list changed (so the caller can rebroadcast it)."""
        with self._lock:
            room = self._rooms.get(room_id)
            if room is None:
                return False
            if (
                role == gl.HOST
                and room.status == WAITING
                and room.guest_token is None
            ):
                del self._rooms[room_id]
                return True
        return False

    # -- moves -------------------------------------------------------------
    def take_turn(self, room_id: str, role: str) -> Room | None:
        """Roll a die, advance ``role`` by that many cells, then pass turn."""
        with self._lock:
            room = self._rooms.get(room_id)
            if room is None or room.status != PLAYING or room.turn != role:
                return None
            roll = gl.roll_die()
            if role == gl.HOST:
                room.host_idx = gl.advance(room.host_idx, roll)
                room.turn = gl.GUEST
            else:
                room.guest_idx = gl.advance(room.guest_idx, roll)
                room.turn = gl.HOST
            room.last_roll = roll
            room.last_mover = role
            return room

    def resign(self, room_id: str, role: str) -> Room | None:
        """End the game; the opponent of ``role`` wins."""
        with self._lock:
            room = self._rooms.get(room_id)
            if room is None or room.status == OVER:
                return None
            room.status = OVER
            room.winner = gl.GUEST if role == gl.HOST else gl.HOST
            room.turn = None
            return room

    # -- serialization -----------------------------------------------------
    @staticmethod
    def state_dict(room: Room) -> dict:
        """Shared game state broadcast to both clients (canonical coords)."""
        host_r, host_c = gl.canonical_position(gl.HOST, room.host_idx)
        guest_r, guest_c = gl.canonical_position(gl.GUEST, room.guest_idx)
        path: list[list[int]] = []
        if room.last_mover and room.last_roll:
            mover_idx = room.host_idx if room.last_mover == gl.HOST else room.guest_idx
            from_idx = gl.advance(mover_idx, -room.last_roll)
            path = [
                [r, c]
                for (r, c) in gl.loop_path(room.last_mover, from_idx, room.last_roll)
            ]
        return {
            "status": room.status,
            "turn": room.turn,
            "winner": room.winner,
            "roll": room.last_roll,
            "last_mover": room.last_mover,
            "path": path,
            "disks": {
                "host": [host_r, host_c],
                "guest": [guest_r, guest_c],
            },
        }

    # -- internals ---------------------------------------------------------
    def _new_id(self) -> str:
        while True:
            room_id = secrets.token_urlsafe(6)
            if room_id not in self._rooms:
                return room_id


# Process-wide singleton.
store = GameStore()
