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
PHASE_FIGHT = "fight"  # queued center-row fights are being resolved


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
    host_promoted: list[bool] = field(
        default_factory=lambda: [False] * gl.NUM_PIECES
    )
    guest_promoted: list[bool] = field(
        default_factory=lambda: [False] * gl.NUM_PIECES
    )
    pending_dice: list[int] | None = None  # two values while choosing moves
    staged: dict[int, int] = field(default_factory=dict)  # piece -> die index
    last_roll: int | None = None
    last_mover: str | None = None
    last_moved_piece: int | None = None
    last_move_from: list[int] | None = None
    last_path: list[list[int]] = field(default_factory=list)
    first_roll: int | None = None  # first of two committed moves, for grey arrow
    first_moved_piece: int | None = None
    first_move_from: list[int] | None = None
    first_path: list[list[int]] = field(default_factory=list)
    no_legal_move: bool = False
    fights: list[dict] = field(default_factory=list)
    fight_attacker_dice: list[int] | None = None
    fight_defender_dice: list[int] | None = None
    fight_result: dict | None = None
    previous_fight_result: dict | None = None
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
            room.last_move_from = None
            room.last_path = []
            room.first_moved_piece = None
            room.first_roll = None
            room.first_move_from = None
            room.first_path = []
            room.no_legal_move = not gl.has_any_legal_assignment(
                self._indices_for_role(room, role), room.pending_dice, {}
            )
            room.fights = []
            room.fight_attacker_dice = None
            room.fight_defender_dice = None
            room.fight_result = None
            room.previous_fight_result = None
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
            last_move_from = None
            last_path: list[list[int]] = []
            promoted = self._promoted_for_role(room, role)
            moves = list(room.staged.items())  # insertion order: first .. last
            first_move_from = None
            first_path: list[list[int]] = []
            for piece, die_index in moves:
                steps = room.pending_dice[die_index]
                from_idx = indices[piece]
                from_r, from_c = gl.canonical_position(role, from_idx)
                path_cells = [
                    [r, c] for (r, c) in gl.loop_path(role, from_idx, steps)
                ]
                if gl.crosses_promotion(indices[piece], steps):
                    promoted[piece] = True
                indices[piece] = gl.advance(indices[piece], steps)
                if first_move_from is None:
                    first_move_from = [from_r, from_c]
                    first_path = path_cells
                last_move_from = [from_r, from_c]
                last_path = path_cells
                last_piece = piece
                last_die = steps

            if len(moves) >= 2:
                first_piece, first_die_index = moves[0]
                room.first_moved_piece = first_piece
                room.first_roll = room.pending_dice[first_die_index]
                room.first_move_from = first_move_from
                room.first_path = first_path
            else:
                room.first_moved_piece = None
                room.first_roll = None
                room.first_move_from = None
                room.first_path = []

            room.last_roll = last_die
            room.last_mover = role
            room.last_moved_piece = last_piece
            room.last_move_from = last_move_from
            room.last_path = last_path
            room.pending_dice = None
            room.staged = {}
            room.no_legal_move = False
            room.fight_result = None
            room.previous_fight_result = None
            if all(promoted):
                room.status = OVER
                room.winner = role
                room.turn = None
                room.phase = PHASE_ROLL
                room.fights = []
                room.fight_attacker_dice = None
                room.fight_defender_dice = None
            else:
                opponent = gl.GUEST if role == gl.HOST else gl.HOST
                fights = gl.detect_fights(
                    role,
                    indices,
                    self._indices_for_role(room, opponent),
                    [piece for piece, _ in moves],
                )
                if fights:
                    room.phase = PHASE_FIGHT
                    room.turn = role
                    room.fights = [
                        {
                            "attacker_role": role,
                            "defender_role": opponent,
                            **fight,
                        }
                        for fight in fights
                    ]
                    room.fight_attacker_dice = None
                    room.fight_defender_dice = None
                else:
                    room.phase = PHASE_ROLL
                    room.turn = opponent
                    room.fights = []
                    room.fight_attacker_dice = None
                    room.fight_defender_dice = None
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
            promoted = self._promoted_for_role(room, role)
            moves = list(room.staged.items())
            last_move_from = None
            last_path: list[list[int]] = []
            for piece, die_index in moves:
                steps = room.pending_dice[die_index]
                from_idx = indices[piece]
                from_r, from_c = gl.canonical_position(role, from_idx)
                path_cells = [
                    [r, c] for (r, c) in gl.loop_path(role, from_idx, steps)
                ]
                if gl.crosses_promotion(indices[piece], steps):
                    promoted[piece] = True
                indices[piece] = gl.advance(indices[piece], steps)
                last_move_from = [from_r, from_c]
                last_path = path_cells
            room.last_mover = role
            # Passing with exactly one staged move means the other die was
            # unplayable. Surface that move so both clients keep showing its
            # arrow until the next roll.
            if len(moves) == 1:
                piece, die_index = moves[0]
                room.last_moved_piece = piece
                room.last_roll = room.pending_dice[die_index]
                room.last_move_from = last_move_from
                room.last_path = last_path
            else:
                room.last_moved_piece = None
                room.last_roll = None
                room.last_move_from = None
                room.last_path = []
            room.first_moved_piece = None
            room.first_roll = None
            room.first_move_from = None
            room.first_path = []
            room.pending_dice = None
            room.staged = {}
            room.fight_result = None
            room.previous_fight_result = None
            if all(promoted):
                room.status = OVER
                room.winner = role
                room.turn = None
                room.phase = PHASE_ROLL
                room.no_legal_move = False
                room.fights = []
                room.fight_attacker_dice = None
                room.fight_defender_dice = None
            else:
                opponent = gl.GUEST if role == gl.HOST else gl.HOST
                fights = gl.detect_fights(
                    role,
                    indices,
                    self._indices_for_role(room, opponent),
                    [piece for piece, _ in moves],
                )
                if fights:
                    room.phase = PHASE_FIGHT
                    room.turn = role
                    room.no_legal_move = False
                    room.fights = [
                        {
                            "attacker_role": role,
                            "defender_role": opponent,
                            **fight,
                        }
                        for fight in fights
                    ]
                    room.fight_attacker_dice = None
                    room.fight_defender_dice = None
                else:
                    room.phase = PHASE_ROLL
                    room.turn = opponent
                    room.no_legal_move = True
                    room.fights = []
                    room.fight_attacker_dice = None
                    room.fight_defender_dice = None
            room.state_version += 1
            return room

    def fight_roll(self, room_id: str, role: str) -> Room | None:
        """Roll combat dice for one side of the active fight.

        When both sides have rolled, resolves the fight immediately.
        """
        with self._lock:
            room = self._rooms.get(room_id)
            if (
                room is None
                or room.status != PLAYING
                or room.phase != PHASE_FIGHT
                or not room.fights
            ):
                return None

            fight = room.fights[0]
            attacker_role = fight["attacker_role"]
            defender_role = fight["defender_role"]
            attacker_piece = fight["attacker_piece"]
            defender_piece = fight["defender_piece"]

            attacker_promoted_flags = self._promoted_for_role(room, attacker_role)
            defender_promoted_flags = self._promoted_for_role(room, defender_role)
            attacker_promoted = bool(attacker_promoted_flags[attacker_piece])
            defender_promoted = bool(defender_promoted_flags[defender_piece])

            if role == attacker_role:
                if room.fight_attacker_dice is not None:
                    return None
                room.fight_attacker_dice = gl.fight_dice(attacker_promoted)
            elif role == defender_role:
                if room.fight_defender_dice is not None:
                    return None
                room.fight_defender_dice = gl.fight_dice(defender_promoted)
            else:
                return None

            if room.fight_attacker_dice is None or room.fight_defender_dice is None:
                room.state_version += 1
                return room

            attacker_value = gl.fight_value(room.fight_attacker_dice)
            defender_value = gl.fight_value(room.fight_defender_dice)
            attacker_wins = attacker_value >= defender_value

            winner_role = attacker_role if attacker_wins else defender_role
            loser_role = defender_role if attacker_wins else attacker_role
            winner_piece = attacker_piece if attacker_wins else defender_piece
            loser_piece = defender_piece if attacker_wins else attacker_piece

            demoted = False
            if attacker_wins and (not attacker_promoted) and defender_promoted:
                defender_promoted_flags[defender_piece] = False
                demoted = True

            loser_indices = self._indices_for_role(room, loser_role)
            loser_from_idx = loser_indices[loser_piece]
            loser_r, loser_c = gl.canonical_position(loser_role, loser_from_idx)
            _, loser_local_col = gl.to_local(loser_role, loser_r, loser_c)
            landing_idx = gl.fight_landing_index(loser_local_col)
            loser_to_r, loser_to_c = gl.canonical_position(loser_role, landing_idx)

            new_loser_indices, pushes = gl.apply_knockback(
                loser_indices, loser_piece, landing_idx
            )
            if loser_role == gl.HOST:
                room.host_indices = new_loser_indices
            else:
                room.guest_indices = new_loser_indices

            push_events = []
            for pushed_piece, from_idx, to_idx in pushes:
                from_r, from_c = gl.canonical_position(loser_role, from_idx)
                to_r, to_c = gl.canonical_position(loser_role, to_idx)
                push_events.append(
                    {
                        "piece": pushed_piece,
                        "from": [from_r, from_c],
                        "to": [to_r, to_c],
                    }
                )

            room.fight_result = {
                "attacker": attacker_role,
                "defender": defender_role,
                "column": fight["column"],
                "winner": winner_role,
                "winner_piece": winner_piece,
                "loser": loser_role,
                "loser_piece": loser_piece,
                "attacker_value": attacker_value,
                "defender_value": defender_value,
                "attacker_dice": list(room.fight_attacker_dice),
                "defender_dice": list(room.fight_defender_dice),
                "loser_from": [loser_r, loser_c],
                "loser_to": [loser_to_r, loser_to_c],
                "pushes": push_events,
                "demoted": demoted,
            }

            room.fights.pop(0)
            if room.fights:
                room.previous_fight_result = room.fight_result
                room.phase = PHASE_FIGHT
                room.turn = attacker_role
                room.fight_attacker_dice = None
                room.fight_defender_dice = None
            else:
                room.phase = PHASE_ROLL
                room.turn = gl.GUEST if attacker_role == gl.HOST else gl.HOST
                room.fights = []
                room.fight_attacker_dice = None
                room.fight_defender_dice = None
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
            room.pending_dice = None
            room.staged = {}
            room.last_move_from = None
            room.last_path = []
            room.first_move_from = None
            room.first_path = []
            room.fights = []
            room.fight_attacker_dice = None
            room.fight_defender_dice = None
            room.fight_result = None
            room.previous_fight_result = None
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

        move_from = list(room.last_move_from) if room.last_move_from else None
        path = [list(cell) for cell in room.last_path]

        first_move_from = (
            list(room.first_move_from) if room.first_move_from else None
        )
        first_path = [list(cell) for cell in room.first_path]

        previews: list[dict] = []
        dice = room.pending_dice if isinstance(room.pending_dice, list) else None
        staged = [[piece, die] for piece, die in room.staged.items()]
        can_confirm = False
        can_pass = False
        can_fight_roll = {gl.HOST: False, gl.GUEST: False}
        fight_payload = None
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
                    promo_step = gl.promotion_step(idx, die)
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
                            "promotes": promo_step is not None,
                            # 0-based index into ``path`` of the threshold
                            # cell, so the client can flip the piece to red
                            # mid-animation exactly when it crosses.
                            "promotes_at": (
                                None if promo_step is None else promo_step - 1
                            ),
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

        if (
            room.status == PLAYING
            and room.phase == PHASE_FIGHT
            and room.fights
        ):
            current_fight = room.fights[0]
            attacker_role = current_fight["attacker_role"]
            defender_role = current_fight["defender_role"]
            attacker_piece = current_fight["attacker_piece"]
            defender_piece = current_fight["defender_piece"]
            attacker_promoted = (
                room.host_promoted[attacker_piece]
                if attacker_role == gl.HOST
                else room.guest_promoted[attacker_piece]
            )
            defender_promoted = (
                room.host_promoted[defender_piece]
                if defender_role == gl.HOST
                else room.guest_promoted[defender_piece]
            )
            can_fight_roll = {
                gl.HOST: False,
                gl.GUEST: False,
            }
            can_fight_roll[attacker_role] = room.fight_attacker_dice is None
            can_fight_roll[defender_role] = room.fight_defender_dice is None
            fight_payload = {
                "attacker": attacker_role,
                "defender": defender_role,
                "attacker_piece": attacker_piece,
                "defender_piece": defender_piece,
                "column": current_fight["column"],
                "attacker_die_count": 2 if attacker_promoted else 1,
                "defender_die_count": 2 if defender_promoted else 1,
                "attacker_dice": room.fight_attacker_dice,
                "defender_dice": room.fight_defender_dice,
                "attacker_value": (
                    None
                    if room.fight_attacker_dice is None
                    else gl.fight_value(room.fight_attacker_dice)
                ),
                "defender_value": (
                    None
                    if room.fight_defender_dice is None
                    else gl.fight_value(room.fight_defender_dice)
                ),
                "remaining": len(room.fights),
                "can_roll": can_fight_roll,
                "result": None,
            }

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
            "fight": fight_payload,
            "fight_result": room.fight_result,
            "previous_fight_result": room.previous_fight_result,
            "can_fight_roll": can_fight_roll,
            "disks": {
                "host": host_disks,
                "guest": guest_disks,
            },
            "promoted": {
                "host": list(room.host_promoted),
                "guest": list(room.guest_promoted),
            },
        }

    @staticmethod
    def _indices_for_role(room: Room, role: str) -> list[int]:
        return room.host_indices if role == gl.HOST else room.guest_indices

    @staticmethod
    def _promoted_for_role(room: Room, role: str) -> list[bool]:
        return room.host_promoted if role == gl.HOST else room.guest_promoted

    # -- internals ---------------------------------------------------------
    def _new_id(self) -> str:
        while True:
            room_id = secrets.token_urlsafe(6)
            if room_id not in self._rooms:
                return room_id


# Process-wide singleton.
store = GameStore()
