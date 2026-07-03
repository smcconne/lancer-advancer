"""Geometry tests: loop shape, counter-clockwise order, perspective symmetry."""
from unittest.mock import patch

from django.test import SimpleTestCase

from game import game_logic as gl


class GameLogicTests(SimpleTestCase):
    def test_loop_basics(self):
        self.assertEqual(gl.LOOP_LEN, 12)
        self.assertEqual(gl.LOCAL_LOOP[0], (3, 5))  # bottom-right start
        self.assertEqual(gl.START_INDICES, [7, 8, 9, 10])
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
        # Each player's four disks start along their own bottom-left row.
        self.assertEqual(
            [
                gl.canonical_position(gl.HOST, idx)
                for idx in gl.START_INDICES
            ],
            [(3, 0), (3, 1), (3, 2), (3, 3)],
        )
        self.assertEqual(
            [
                gl.canonical_position(gl.GUEST, idx)
                for idx in gl.START_INDICES
            ],
            [(0, 5), (0, 4), (0, 3), (0, 2)],
        )

    def test_guest_start_is_bottom_left_in_local_view(self):
        # Canonical (0,5) should map to the guest's local bottom-left (3,0).
        r, c = gl.canonical_position(gl.GUEST, gl.START_INDEX)
        self.assertEqual(gl.to_local(gl.GUEST, r, c), (3, 0))

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

    def test_crosses_promotion(self):
        # The threshold is the seam between index 6 (own top-left cell) and
        # index 7 (own bottom-left cell); visiting index 7 crosses it.
        self.assertTrue(gl.crosses_promotion(6, 1))  # lands exactly on it
        self.assertTrue(gl.crosses_promotion(5, 3))  # passes through it
        self.assertTrue(gl.crosses_promotion(3, 4))  # reaches it on last step
        self.assertTrue(gl.crosses_promotion(1, 6))  # max roll reaches it
        self.assertFalse(gl.crosses_promotion(7, 6))  # starts just past it
        self.assertFalse(gl.crosses_promotion(8, 3))
        self.assertFalse(gl.crosses_promotion(10, 6))  # wraps but stops short
        self.assertFalse(gl.crosses_promotion(6, 0))  # no movement, no cross

    def test_promotion_step(self):
        # 1-based offset of the step that lands on the threshold cell.
        self.assertEqual(gl.promotion_step(6, 1), 1)
        self.assertEqual(gl.promotion_step(5, 3), 2)
        self.assertEqual(gl.promotion_step(3, 4), 4)
        self.assertEqual(gl.promotion_step(1, 6), 6)
        self.assertIsNone(gl.promotion_step(7, 6))
        self.assertIsNone(gl.promotion_step(8, 3))

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
        # Roll=1 from [7,8,9,10] only allows piece 3 -> index 11.
        self.assertEqual(gl.legal_piece_moves([7, 8, 9, 10], 1), [3])

    def test_legal_piece_moves_three_legal_from_start(self):
        # Roll=3 targets [10,11,0,1]; first target is occupied by piece 3.
        self.assertEqual(gl.legal_piece_moves([7, 8, 9, 10], 3), [1, 2, 3])

    def test_legal_piece_moves_none_legal(self):
        # Every target is occupied by another own piece.
        self.assertEqual(gl.legal_piece_moves([0, 3, 6, 9], 3), [])

    def test_roll_dice_returns_two_values(self):
        with patch("game.game_logic.secrets.randbelow", side_effect=[2, 5]):
            self.assertEqual(gl.roll_dice(), [3, 6])

    def test_can_stage_blocks_same_die_or_piece(self):
        indices = [7, 8, 9, 10]
        dice = [2, 4]
        # First assignment is fine.
        self.assertTrue(gl.can_stage(indices, dice, {}, 3, 0))
        # Same die can't be reused; same piece can't take two dice.
        self.assertFalse(gl.can_stage(indices, dice, {3: 0}, 1, 0))
        self.assertFalse(gl.can_stage(indices, dice, {3: 0}, 3, 1))

    def test_second_piece_may_land_on_first_piece_start(self):
        # Piece 3 at idx10 takes die0=2 -> idx0. Piece 1 at idx8 takes die1=2
        # -> idx10 (piece 3's vacated start) which is now free, so it is legal.
        indices = [7, 8, 9, 10]
        dice = [2, 2]
        self.assertTrue(gl.can_stage(indices, dice, {3: 0}, 1, 1))

    def test_unstage_first_makes_second_collide(self):
        # With both staged the pair is collision-free, but if piece 3 is
        # removed, piece 1's destination (idx10) collides with piece 3's start.
        indices = [7, 8, 9, 10]
        dice = [2, 2]
        staged = {3: 0, 1: 1}
        self.assertEqual(gl.staged_collisions(indices, dice, staged), set())
        del staged[3]
        self.assertEqual(gl.staged_collisions(indices, dice, staged), {1})

    def test_has_any_legal_assignment(self):
        self.assertTrue(gl.has_any_legal_assignment([7, 8, 9, 10], [1, 2], {}))
        self.assertFalse(gl.has_any_legal_assignment([0, 3, 6, 9], [3, 3], {}))

    def test_fight_dice_regular_and_promoted(self):
        with patch("game.game_logic.roll_die", side_effect=[2, 5, 6]):
            self.assertEqual(gl.fight_dice(False), [2])
            self.assertEqual(gl.fight_dice(True), [5, 6])
        self.assertEqual(gl.fight_value([4]), 4)
        self.assertEqual(gl.fight_value([2, 6]), 6)

    def test_detect_fights_host_and_guest(self):
        host_fights = gl.detect_fights(
            gl.HOST,
            [1, 8, 9, 10],
            [6, 8, 9, 10],
            [0],
        )
        self.assertEqual(
            host_fights,
            [{"attacker_piece": 0, "defender_piece": 0, "column": 5}],
        )

        guest_fights = gl.detect_fights(
            gl.GUEST,
            [1, 8, 9, 10],
            [6, 8, 9, 10],
            [0],
        )
        self.assertEqual(
            guest_fights,
            [{"attacker_piece": 0, "defender_piece": 0, "column": 0}],
        )

    def test_detect_fights_only_checks_moved_pieces(self):
        fights = gl.detect_fights(
            gl.HOST,
            [1, 8, 9, 10],
            [6, 8, 9, 10],
            [1],
        )
        self.assertEqual(fights, [])

    def test_apply_knockback_backward_push(self):
        # Landing on 9 pushes 9->8 and 8->7 (7 is free).
        indices = [0, 8, 9, 10]
        new_indices, pushes = gl.apply_knockback(indices, loser_piece=3, landing_idx=9)
        self.assertEqual(new_indices, [0, 7, 8, 9])
        self.assertEqual(pushes, [(1, 8, 7), (2, 9, 8)])

    def test_apply_knockback_flips_to_forward_at_center_boundary(self):
        # Backward chain 9->8->7 would force 7->6, so flip to forward.
        indices = [7, 8, 9, 10]
        new_indices, pushes = gl.apply_knockback(indices, loser_piece=3, landing_idx=9)
        self.assertEqual(new_indices, [7, 8, 10, 9])
        self.assertEqual(pushes, [(2, 9, 10)])

