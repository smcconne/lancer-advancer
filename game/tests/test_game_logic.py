"""Geometry tests: loop shape, counter-clockwise order, perspective symmetry."""
from unittest.mock import patch

from django.test import SimpleTestCase

from game import game_logic as gl


class GameLogicTests(SimpleTestCase):
    def test_loop_basics(self):
        self.assertEqual(gl.LOOP_LEN, 12)
        self.assertEqual(gl.LOCAL_LOOP[0], (3, 5))  # bottom-right start
        self.assertEqual(gl.START_INDICES, [0, 11, 10, 9])
        self.assertEqual(gl.NUM_PIECES, 4)
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
        # Each player's four disks start along their own bottom-right row.
        self.assertEqual(
            [
                gl.canonical_position(gl.HOST, idx)
                for idx in gl.START_INDICES
            ],
            [(3, 5), (3, 4), (3, 3), (3, 2)],
        )
        self.assertEqual(
            [
                gl.canonical_position(gl.GUEST, idx)
                for idx in gl.START_INDICES
            ],
            [(0, 0), (0, 1), (0, 2), (0, 3)],
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

    def test_advance_multi_step(self):
        self.assertEqual(gl.advance(0, 4), 4)
        self.assertEqual(gl.advance(10, 4), 2)

    def test_roll_die_maps_randbelow_values(self):
        with patch("game.game_logic.secrets.randbelow", side_effect=[0, 1, 2, 3, 4, 5]):
            self.assertEqual([gl.roll_die() for _ in range(6)], [1, 2, 3, 4, 5, 6])

    def test_loop_path_wraps_and_includes_final_cell(self):
        path = gl.loop_path(gl.HOST, 10, 4)
        self.assertEqual(path, [(3, 4), (3, 5), (2, 5), (2, 4)])

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

    def test_legal_piece_moves_single_legal_from_start(self):
        # Roll=1 from [0,11,10,9] only allows piece 0 -> index 1.
        self.assertEqual(gl.legal_piece_moves([0, 11, 10, 9], 1), [0])

    def test_legal_piece_moves_three_legal_from_start(self):
        # Roll=3 targets [3,2,1,0]; last target is occupied by piece 0.
        self.assertEqual(gl.legal_piece_moves([0, 11, 10, 9], 3), [0, 1, 2])

    def test_legal_piece_moves_none_legal(self):
        # Every target is occupied by another own piece.
        self.assertEqual(gl.legal_piece_moves([0, 3, 6, 9], 3), [])

    def test_roll_dice_returns_two_values(self):
        with patch("game.game_logic.secrets.randbelow", side_effect=[2, 5]):
            self.assertEqual(gl.roll_dice(), [3, 6])

    def test_can_stage_blocks_same_die_or_piece(self):
        indices = [0, 11, 10, 9]
        dice = [2, 4]
        # First assignment is fine.
        self.assertTrue(gl.can_stage(indices, dice, {}, 0, 0))
        # Same die can't be reused; same piece can't take two dice.
        self.assertFalse(gl.can_stage(indices, dice, {0: 0}, 1, 0))
        self.assertFalse(gl.can_stage(indices, dice, {0: 0}, 0, 1))

    def test_second_piece_may_land_on_first_piece_start(self):
        # Piece 0 at idx 0 takes die0=2 -> idx2. Piece 1 at idx10 takes die1=2
        # -> idx0 (piece 0's vacated start) which is now free, so it is legal.
        indices = [0, 11, 10, 9]
        dice = [2, 2]
        self.assertTrue(gl.can_stage(indices, dice, {0: 0}, 2, 1))

    def test_unstage_first_makes_second_collide(self):
        # With both staged the pair is collision-free, but if piece 0 is
        # removed, piece 2's destination (idx0) collides with piece 0's start.
        indices = [0, 11, 10, 9]
        dice = [2, 2]
        staged = {0: 0, 2: 1}
        self.assertEqual(gl.staged_collisions(indices, dice, staged), set())
        del staged[0]
        self.assertEqual(gl.staged_collisions(indices, dice, staged), {2})

    def test_has_any_legal_assignment(self):
        self.assertTrue(gl.has_any_legal_assignment([0, 11, 10, 9], [1, 2], {}))
        self.assertFalse(gl.has_any_legal_assignment([0, 3, 6, 9], [3, 3], {}))

