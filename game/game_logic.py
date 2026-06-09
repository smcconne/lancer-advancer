"""Pure game geometry for Lancer Advancer.

The board is 4 rows tall and 6 columns wide. All server-side state is stored in
*canonical* coordinates, which are identical to what the **host** sees:

    row 0 = top, row 3 = bottom
    col 0 = left, col 5 = right

In the host's view the bottom two rows (2, 3) are RED (the host's own track) and
the top two rows (0, 1) are BLUE (the opponent). The guest sees the very same
board rotated 180 degrees, so the guest's own track also appears red along the
bottom of *their* screen and their disk starts in *their* bottom-right corner.

Each player's disk travels a 12-cell loop around their own two-row track,
advancing one cell counter-clockwise per turn. Starting from the bottom-right
corner, counter-clockwise means: up the right edge, left across the top of the
band, down the left edge, then right along the bottom back to the start.

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
START_INDEX = 0


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


def roll_die() -> int:
    """Return a uniformly random die roll in the inclusive range [1, 6]."""
    return secrets.randbelow(6) + 1


def loop_path(role: str, from_idx: int, steps: int) -> list[tuple[int, int]]:
    """Canonical cells visited after ``steps`` moves from ``from_idx``.

    The returned path has exactly ``steps`` cells and includes the final cell.
    """
    return [
        canonical_position(role, from_idx + offset)
        for offset in range(1, steps + 1)
    ]
