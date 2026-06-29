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
    pending_dice: list[int] | None = None  # two values while choosing moves
    staged: dict[int, int] = field(default_factory=dict)  # piece -> die index
    last_roll: int | None = None
    last_mover: str | None = None
    last_moved_piece: int | None = None
    first_roll: int | None = None  # first of two committed moves, for grey arrow
    first_moved_piece: int | None = None
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
    def roll_dice(self, room_id: str, role: str) -> Room | None:
        """Roll two dice for ``role`` and enter the assignment phase.

        Always enters PHASE_SELECT (even with no legal move) so the player can
        either drag dice onto pieces or press Pass.
        """
        with self._lock:
            room = self._rooms.get(room_id)
            if (
                room is None
                or room.status != PLAYING
                or room.turn != role
                or room.phase != PHASE_ROLL
            ):
                return None

            room.pending_dice = gl.roll_dice()
            room.staged = {}
            room.last_mover = role
            room.last_moved_piece = None
            room.first_moved_piece = None
            room.first_roll = None
            room.no_legal_move = not gl.has_any_legal_assignment(
                self._indices_for_role(room, role), room.pending_dice, {}
            )
            room.phase = PHASE_SELECT
            room.state_version += 1
            return room

    def stage_move(
        self, room_id: str, role: str, piece: int, die_index: int
    ) -> Room | None:
        """Assign a die to a piece without committing the move yet."""
        with self._lock:
            room = self._rooms.get(room_id)
            if (
                room is None
                or room.status != PLAYING
                or room.turn != role
                or room.phase != PHASE_SELECT
                or not isinstance(room.pending_dice, list)
                or not isinstance(piece, int)
                or not isinstance(die_index, int)
            ):
                return None

            indices = self._indices_for_role(room, role)
            # Dropping a die on a piece that already has one replaces it, so
            # ignore this piece's current assignment when checking legality.
            staged_without_piece = {
                p: d for p, d in room.staged.items() if p != piece
            }
            if not gl.can_stage(
                indices, room.pending_dice, staged_without_piece, piece, die_index
            ):
                return None

            staged_without_piece[piece] = die_index
            room.staged = staged_without_piece
            room.state_version += 1
            return room

    def unstage_move(self, room_id: str, role: str, piece: int) -> Room | None:
        """Drag a die back off a piece; auto-clear any move it now invalidates."""
        with self._lock:
            room = self._rooms.get(room_id)
            if (
                room is None
                or room.status != PLAYING
                or room.turn != role
                or room.phase != PHASE_SELECT
                or not isinstance(room.pending_dice, list)
                or piece not in room.staged
            ):
                return None

            del room.staged[piece]
            indices = self._indices_for_role(room, role)
            # Removing this piece may make a remaining staged move collide.
            collided = gl.staged_collisions(indices, room.pending_dice, room.staged)
            for other in collided:
                del room.staged[other]
            room.state_version += 1
            return room

    def confirm_moves(self, room_id: str, role: str) -> Room | None:
        """Commit every staged move at once and pass the turn."""
        with self._lock:
            room = self._rooms.get(room_id)
            if (
                room is None
                or room.status != PLAYING
                or room.turn != role
                or room.phase != PHASE_SELECT
                or not isinstance(room.pending_dice, list)
                or not room.staged
            ):
                return None

            indices = self._indices_for_role(room, role)
            if gl.staged_collisions(indices, room.pending_dice, room.staged):
                return None
            # Both dice must be used unless no further legal move exists.
            if len(room.staged) < len(room.pending_dice) and gl.has_any_legal_assignment(
                indices, room.pending_dice, room.staged
            ):
                return None

            last_piece = None
            last_die = None
            moves = list(room.staged.items())  # insertion order: first .. last
            for piece, die_index in moves:
                indices[piece] = gl.advance(indices[piece], room.pending_dice[die_index])
                last_piece = piece
                last_die = room.pending_dice[die_index]

            if len(moves) >= 2:
                first_piece, first_die_index = moves[0]
                room.first_moved_piece = first_piece
                room.first_roll = room.pending_dice[first_die_index]
            else:
                room.first_moved_piece = None
                room.first_roll = None

            room.phase = PHASE_ROLL
            room.turn = gl.GUEST if role == gl.HOST else gl.HOST
            room.last_roll = last_die
            room.last_mover = role
            room.last_moved_piece = last_piece
            room.pending_dice = None
            room.staged = {}
            room.no_legal_move = False
            room.state_version += 1
            return room

    def pass_turn(self, room_id: str, role: str) -> Room | None:
        """Forfeit any unused dice and hand the turn to the opponent."""
        with self._lock:
            room = self._rooms.get(room_id)
            if (
                room is None
                or room.status != PLAYING
                or room.turn != role
                or room.phase != PHASE_SELECT
                or not isinstance(room.pending_dice, list)
            ):
                return None

            indices = self._indices_for_role(room, role)
            # Passing is only legal when there is at least one unused die and no
            # remaining legal way to stage any unused die on any free piece.
            if len(room.staged) >= len(room.pending_dice) or gl.has_any_legal_assignment(
                indices, room.pending_dice, room.staged
            ):
                return None
            # Apply whatever was staged before passing.
            moves = list(room.staged.items())
            for piece, die_index in moves:
                indices[piece] = gl.advance(
                    indices[piece], room.pending_dice[die_index]
                )
            room.phase = PHASE_ROLL
            room.turn = gl.GUEST if role == gl.HOST else gl.HOST
            room.last_mover = role
            # Passing with exactly one staged move means the other die was
            # unplayable. Surface that move so both clients keep showing its
            # arrow until the next roll.
            if len(moves) == 1:
                piece, die_index = moves[0]
                room.last_moved_piece = piece
                room.last_roll = room.pending_dice[die_index]
            else:
                room.last_moved_piece = None
                room.last_roll = None
            room.first_moved_piece = None
            room.first_roll = None
            room.pending_dice = None
            room.staged = {}
            room.no_legal_move = True
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
            room.pending_dice = None
            room.staged = {}
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

        first_path: list[list[int]] = []
        first_move_from: list[int] | None = None
        if (
            room.last_mover
            and room.first_roll
            and isinstance(room.first_moved_piece, int)
        ):
            mover_indices = (
                room.host_indices
                if room.last_mover == gl.HOST
                else room.guest_indices
            )
            if 0 <= room.first_moved_piece < len(mover_indices):
                mover_idx = mover_indices[room.first_moved_piece]
                from_idx = gl.advance(mover_idx, -room.first_roll)
                from_r, from_c = gl.canonical_position(room.last_mover, from_idx)
                first_move_from = [from_r, from_c]
                first_path = [
                    [r, c]
                    for (r, c) in gl.loop_path(
                        room.last_mover, from_idx, room.first_roll
                    )
                ]

        previews: list[dict] = []
        dice = room.pending_dice if isinstance(room.pending_dice, list) else None
        staged = [[piece, die] for piece, die in room.staged.items()]
        can_confirm = False
        can_pass = False
        if (
            room.status == PLAYING
            and room.phase == PHASE_SELECT
            and room.turn in (gl.HOST, gl.GUEST)
            and dice is not None
        ):
            turn_indices = (
                room.host_indices if room.turn == gl.HOST else room.guest_indices
            )
            for piece, idx in enumerate(turn_indices):
                # Evaluate legality as if any die already on this piece were
                # removed first, so a die dropped onto a pending one can
                # replace it.
                staged_without_piece = {
                    p: d for p, d in room.staged.items() if p != piece
                }
                die_options = []
                for die_index, die in enumerate(dice):
                    die_options.append(
                        {
                            "die_index": die_index,
                            "legal": gl.can_stage(
                                turn_indices,
                                dice,
                                staged_without_piece,
                                piece,
                                die_index,
                            ),
                            "path": [
                                [r, c]
                                for (r, c) in gl.loop_path(room.turn, idx, die)
                            ],
                        }
                    )
                previews.append({"piece": piece, "dice": die_options})
            can_confirm = bool(room.staged) and not gl.staged_collisions(
                turn_indices, dice, room.staged
            )
            if len(room.staged) < len(dice) and gl.has_any_legal_assignment(
                turn_indices, dice, room.staged
            ):
                can_confirm = False
            can_pass = len(room.staged) < len(dice) and not gl.has_any_legal_assignment(
                turn_indices, dice, room.staged
            )

        return {
            "version": room.state_version,
            "status": room.status,
            "turn": room.turn,
            "phase": room.phase,
            "winner": room.winner,
            "dice": dice,
            "staged": staged,
            "can_confirm": can_confirm,
            "can_pass": can_pass,
            "last_mover": room.last_mover,
            "moved_piece": room.last_moved_piece,
            "no_legal_move": room.no_legal_move,
            "previews": previews,
            "move_from": move_from,
            "path": path,
            "first_moved_piece": room.first_moved_piece,
            "first_move_from": first_move_from,
            "first_path": first_path,
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
