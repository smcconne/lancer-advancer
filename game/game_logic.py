"""Pure game geometry for Lancer Advancer.

The board is 4 rows tall and 6 columns wide. All server-side state is stored in
*canonical* coordinates, which are identical to what the **host** sees:

    row 0 = top, row 3 = bottom
    col 0 = left, col 5 = right

In the host's view the bottom two rows (2, 3) are RED (the host's own track) and
the top two rows (0, 1) are BLUE (the opponent). The guest sees the very same
board rotated 180 degrees, so the guest's own track also appears red along the
bottom of *their* screen and their four disks start along *their* bottom-left
row.

Each player's 4 disks travel a shared 12-cell loop around their own two-row
track, advancing one cell counter-clockwise per move. Starting from the
bottom-right corner, counter-clockwise means: up the right edge, left across
the top of the band, down the left edge, then right along the bottom back to
the start.

Only the loop *shape* is defined once (`LOCAL_LOOP`, expressed in each player's
own view). Canonical coordinates are derived by applying that player's
perspective transform, so host and guest geometry can never drift apart.
"""
from __future__ import annotations

import secrets

ROWS = 4
COLS = 6

HOST = "host"
GUEST = "guest"

# The loop as every player sees it in their own view: index 0 is the
# bottom-right starting cell, then counter-clockwise (up the right edge first).
LOCAL_LOOP: list[tuple[int, int]] = [
    (3, 5),
    (2, 5),
    (2, 4),
    (2, 3),
    (2, 2),
    (2, 1),
    (2, 0),
    (3, 0),
    (3, 1),
    (3, 2),
    (3, 3),
    (3, 4),
]

LOOP_LEN = len(LOCAL_LOOP)
START_INDEX = 7
START_INDICES = [7, 8, 9, 10]
NUM_PIECES = len(START_INDICES)

# Crossing the seam between loop index 6 (a player's top-left cell, local
# (2, 0)) and index 7 (their bottom-left cell, local (3, 0)) promotes the
# moving piece. Landing on or passing through this index counts as crossing.
PROMOTION_INDEX = START_INDEX


def transform(r: int, c: int) -> tuple[int, int]:
    """Rotate a cell 180 degrees. This maps between canonical (host) space and
    guest space and is its own inverse."""
    return (ROWS - 1 - r, COLS - 1 - c)


def to_canonical(role: str, r: int, c: int) -> tuple[int, int]:
    """Convert a cell from ``role``'s local view into canonical coordinates."""
    if role == HOST:
        return (r, c)
    return transform(r, c)


def to_local(role: str, r: int, c: int) -> tuple[int, int]:
    """Convert a canonical cell into ``role``'s local view (inverse of
    :func:`to_canonical`; identical because the transform is an involution)."""
    if role == HOST:
        return (r, c)
    return transform(r, c)


def canonical_loop(role: str) -> list[tuple[int, int]]:
    """The player's 12-cell loop expressed in canonical coordinates."""
    return [to_canonical(role, r, c) for (r, c) in LOCAL_LOOP]


def canonical_position(role: str, idx: int) -> tuple[int, int]:
    """Canonical cell of ``role``'s disk at loop index ``idx``."""
    return canonical_loop(role)[idx % LOOP_LEN]


def advance(idx: int, steps: int = 1) -> int:
    """Index after moving ``steps`` cells counter-clockwise around the loop."""
    return (idx + steps) % LOOP_LEN


def promotion_step(from_idx: int, steps: int) -> int | None:
    """The 1-based step offset (1..steps) at which a move from ``from_idx``
    lands on :data:`PROMOTION_INDEX`, or ``None`` if it never does.

    A die is at most 6 (< LOOP_LEN), so the threshold cell is visited at most
    once per move.
    """
    for offset in range(1, steps + 1):
        if advance(from_idx, offset) == PROMOTION_INDEX:
            return offset
    return None


def crosses_promotion(from_idx: int, steps: int) -> bool:
    """Whether a move of ``steps`` cells from ``from_idx`` crosses the
    promotion threshold (visits :data:`PROMOTION_INDEX`).
    """
    return promotion_step(from_idx, steps) is not None


def roll_die() -> int:
    """Return a uniformly random die roll in the inclusive range [1, 6]."""
    return secrets.randbelow(6) + 1


def roll_dice() -> list[int]:
    """Return two independent uniformly random dice, each in [1, 6]."""
    return [roll_die(), roll_die()]


def staged_collisions(
    indices: list[int], dice: list[int], staged: dict[int, int]
) -> set[int]:
    """Pieces whose staged destination collides with another piece.

    ``staged`` maps a piece slot to the index of the die assigned to it. Staged
    pieces move to their final cell (their start cell is vacated); unstaged
    pieces stay put. A staged piece is colliding if its final cell matches any
    other piece's projected position.
    """
    finals: dict[int, int] = {}
    for piece, idx in enumerate(indices):
        die_index = staged.get(piece)
        finals[piece] = advance(idx, dice[die_index]) if die_index is not None else idx

    collisions: set[int] = set()
    for piece in staged:
        target = finals[piece]
        if any(other != piece and dest == target for other, dest in finals.items()):
            collisions.add(piece)
    return collisions


def can_stage(
    indices: list[int],
    dice: list[int],
    staged: dict[int, int],
    piece: int,
    die_index: int,
) -> bool:
    """Whether ``die_index`` may be assigned to ``piece`` given current staging.

    Each die and each piece may be used at most once, and the move must not
    collide once both dice are projected to their final cells.
    """
    if piece < 0 or piece >= len(indices):
        return False
    if die_index < 0 or die_index >= len(dice):
        return False
    if piece in staged or die_index in staged.values():
        return False
    trial = dict(staged)
    trial[piece] = die_index
    return piece not in staged_collisions(indices, dice, trial)


def has_any_legal_assignment(
    indices: list[int], dice: list[int], staged: dict[int, int]
) -> bool:
    """True if any unused die can still be staged on any free piece."""
    for die_index in range(len(dice)):
        if die_index in staged.values():
            continue
        for piece in range(len(indices)):
            if can_stage(indices, dice, staged, piece, die_index):
                return True
    return False


def loop_path(role: str, from_idx: int, steps: int) -> list[tuple[int, int]]:
    """Canonical cells visited after ``steps`` moves from ``from_idx``.

    The returned path has exactly ``steps`` cells and includes the final cell.
    """
    return [
        canonical_position(role, from_idx + offset)
        for offset in range(1, steps + 1)
    ]


def legal_piece_moves(indices: list[int], roll: int) -> list[int]:
    """Return piece slots that can move ``roll`` steps.

    A move is illegal if the destination cell is currently occupied by one of
    the player's other pieces.
    """
    if roll <= 0:
        return []

    legal: list[int] = []
    for piece, idx in enumerate(indices):
        target = advance(idx, roll)
        blocked = any(
            target == other_idx
            for (other_piece, other_idx) in enumerate(indices)
            if other_piece != piece
        )
        if not blocked:
            legal.append(piece)
    return legal
