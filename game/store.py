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
PHASE_ROLL = "roll"  # active player can roll the die
PHASE_SELECT = "select"  # active player must choose a piece to move


@dataclass
class Room:
    id: str
    host_token: str
    guest_token: str | None = None
    status: str = WAITING
    turn: str | None = None  # gl.HOST or gl.GUEST while PLAYING
    phase: str = PHASE_ROLL
    host_indices: list[int] = field(
        default_factory=lambda: list(gl.START_INDICES)
    )
    guest_indices: list[int] = field(
        default_factory=lambda: list(gl.START_INDICES)
    )
    pending_roll: int | None = None
    last_roll: int | None = None
    last_mover: str | None = None
    last_moved_piece: int | None = None
    no_legal_move: bool = False
    winner: str | None = None  # gl.HOST or gl.GUEST once OVER
    state_version: int = 0  # Monotonic version for client stale-state guards.
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
                room.state_version += 1
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
    def roll_die(self, room_id: str, role: str) -> Room | None:
        """Roll for ``role`` and enter piece-selection, or auto-pass if blocked."""
        with self._lock:
            room = self._rooms.get(room_id)
            if (
                room is None
                or room.status != PLAYING
                or room.turn != role
                or room.phase != PHASE_ROLL
            ):
                return None

            roll = gl.roll_die()
            indices = self._indices_for_role(room, role)
            legal_moves = gl.legal_piece_moves(indices, roll)

            room.last_roll = roll
            room.last_mover = role
            room.last_moved_piece = None
            room.pending_roll = None
            room.no_legal_move = False

            if legal_moves:
                room.phase = PHASE_SELECT
                room.pending_roll = roll
            else:
                room.phase = PHASE_ROLL
                room.turn = gl.GUEST if role == gl.HOST else gl.HOST
                room.no_legal_move = True

            room.state_version += 1
            return room

    def confirm_move(self, room_id: str, role: str, piece: int) -> Room | None:
        """Commit the selected piece move and pass turn."""
        with self._lock:
            room = self._rooms.get(room_id)
            if (
                room is None
                or room.status != PLAYING
                or room.turn != role
                or room.phase != PHASE_SELECT
                or not isinstance(room.pending_roll, int)
                or not isinstance(piece, int)
            ):
                return None

            indices = self._indices_for_role(room, role)
            if piece < 0 or piece >= len(indices):
                return None

            legal_moves = gl.legal_piece_moves(indices, room.pending_roll)
            if piece not in legal_moves:
                return None

            indices[piece] = gl.advance(indices[piece], room.pending_roll)

            room.phase = PHASE_ROLL
            room.turn = gl.GUEST if role == gl.HOST else gl.HOST
            room.last_roll = room.pending_roll
            room.last_mover = role
            room.last_moved_piece = piece
            room.pending_roll = None
            room.no_legal_move = False
            room.state_version += 1
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
            room.phase = PHASE_ROLL
            room.pending_roll = None
            room.state_version += 1
            return room

    # -- serialization -----------------------------------------------------
    @staticmethod
    def state_dict(room: Room) -> dict:
        """Shared game state broadcast to both clients (canonical coords)."""
        host_disks = [
            list(gl.canonical_position(gl.HOST, idx))
            for idx in room.host_indices
        ]
        guest_disks = [
            list(gl.canonical_position(gl.GUEST, idx))
            for idx in room.guest_indices
        ]

        path: list[list[int]] = []
        move_from: list[int] | None = None
        if (
            room.last_mover
            and room.last_roll
            and isinstance(room.last_moved_piece, int)
        ):
            mover_indices = (
                room.host_indices
                if room.last_mover == gl.HOST
                else room.guest_indices
            )
            if 0 <= room.last_moved_piece < len(mover_indices):
                mover_idx = mover_indices[room.last_moved_piece]
                from_idx = gl.advance(mover_idx, -room.last_roll)
                from_r, from_c = gl.canonical_position(room.last_mover, from_idx)
                move_from = [from_r, from_c]
                path = [
                    [r, c]
                    for (r, c) in gl.loop_path(
                        room.last_mover, from_idx, room.last_roll
                    )
                ]

        previews: list[dict] = []
        if (
            room.status == PLAYING
            and room.phase == PHASE_SELECT
            and room.turn in (gl.HOST, gl.GUEST)
            and isinstance(room.pending_roll, int)
        ):
            turn_indices = (
                room.host_indices if room.turn == gl.HOST else room.guest_indices
            )
            legal = set(gl.legal_piece_moves(turn_indices, room.pending_roll))
            for piece, idx in enumerate(turn_indices):
                previews.append(
                    {
                        "legal": piece in legal,
                        "path": [
                            [r, c]
                            for (r, c) in gl.loop_path(
                                room.turn, idx, room.pending_roll
                            )
                        ],
                    }
                )

        roll = room.pending_roll if room.phase == PHASE_SELECT else room.last_roll

        return {
            "version": room.state_version,
            "status": room.status,
            "turn": room.turn,
            "phase": room.phase,
            "winner": room.winner,
            "roll": roll,
            "last_mover": room.last_mover,
            "moved_piece": room.last_moved_piece,
            "no_legal_move": room.no_legal_move,
            "previews": previews,
            "move_from": move_from,
            "path": path,
            "disks": {
                "host": host_disks,
                "guest": guest_disks,
            },
        }

    @staticmethod
    def _indices_for_role(room: Room, role: str) -> list[int]:
        return room.host_indices if role == gl.HOST else room.guest_indices

    # -- internals ---------------------------------------------------------
    def _new_id(self) -> str:
        while True:
            room_id = secrets.token_urlsafe(6)
            if room_id not in self._rooms:
                return room_id


# Process-wide singleton.
store = GameStore()
