"""Geometry tests: loop shape, counter-clockwise order, perspective symmetry."""
from django.test import SimpleTestCase

from game import game_logic as gl


class GameLogicTests(SimpleTestCase):
    def test_loop_basics(self):
        self.assertEqual(gl.LOOP_LEN, 12)
        self.assertEqual(gl.LOCAL_LOOP[0], (3, 5))  # bottom-right start
        # No duplicate cells in the loop.
        self.assertEqual(len(set(gl.LOCAL_LOOP)), 12)

    def test_host_loop_is_canonical_identity(self):
        self.assertEqual(gl.canonical_loop(gl.HOST), gl.LOCAL_LOOP)

    def test_host_loop_is_counter_clockwise(self):
        # From bottom-right: up the right edge, left across the top, down the
        # left edge, right along the bottom.
        expected = [
            (3, 5), (2, 5), (2, 4), (2, 3), (2, 2), (2, 1),
            (2, 0), (3, 0), (3, 1), (3, 2), (3, 3), (3, 4),
        ]
        self.assertEqual(gl.canonical_loop(gl.HOST), expected)

    def test_guest_loop_is_180_rotation(self):
        expected = [
            (0, 0), (1, 0), (1, 1), (1, 2), (1, 3), (1, 4),
            (1, 5), (0, 5), (0, 4), (0, 3), (0, 2), (0, 1),
        ]
        self.assertEqual(gl.canonical_loop(gl.GUEST), expected)

    def test_start_positions(self):
        # Each player's disk starts in their own bottom-right corner.
        self.assertEqual(
            gl.canonical_position(gl.HOST, gl.START_INDEX), (3, 5)
        )
        self.assertEqual(
            gl.canonical_position(gl.GUEST, gl.START_INDEX), (0, 0)
        )

    def test_guest_start_is_bottom_right_in_local_view(self):
        # Canonical (0,0) should map to the guest's local bottom-right (3,5).
        r, c = gl.canonical_position(gl.GUEST, gl.START_INDEX)
        self.assertEqual(gl.to_local(gl.GUEST, r, c), (3, 5))

    def test_transform_is_involution(self):
        for r in range(gl.ROWS):
            for c in range(gl.COLS):
                self.assertEqual(gl.transform(*gl.transform(r, c)), (r, c))

    def test_advance_wraps(self):
        self.assertEqual(gl.advance(0), 1)
        self.assertEqual(gl.advance(gl.LOOP_LEN - 1), 0)

    def test_full_lap_returns_to_start(self):
        for role in (gl.HOST, gl.GUEST):
            idx = gl.START_INDEX
            start = gl.canonical_position(role, idx)
            for _ in range(gl.LOOP_LEN):
                idx = gl.advance(idx)
            self.assertEqual(gl.canonical_position(role, idx), start)

    def test_loop_cells_are_adjacent(self):
        # Each counter-clockwise step moves to an orthogonally adjacent cell.
        loop = gl.canonical_loop(gl.HOST)
        for i in range(gl.LOOP_LEN):
            r1, c1 = loop[i]
            r2, c2 = loop[(i + 1) % gl.LOOP_LEN]
            self.assertEqual(abs(r1 - r2) + abs(c1 - c2), 1)
