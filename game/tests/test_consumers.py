"""WebSocket consumer tests: seating, random first turn, moves, resignation.

These wrap ``URLRouter`` directly (bypassing the origin validator used in
production) and run on a single event loop so the in-memory channel layer can
route messages between the two players.
"""
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch

from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator

from game import game_logic as gl
from game.routing import websocket_urlpatterns
from game.store import store


def build_app():
    return URLRouter(websocket_urlpatterns)


async def recv_until(comm, msg_type, timeout=2):
    """Read messages until one of ``msg_type`` arrives."""
    while True:
        msg = await comm.receive_json_from(timeout=timeout)
        if msg.get("type") == msg_type:
            return msg


class GameConsumerTests(IsolatedAsyncioTestCase):
    def setUp(self):
        store.reset()

    async def _connect(self, room_id, token):
        comm = WebsocketCommunicator(
            build_app(), f"/ws/room/{room_id}/?token={token}"
        )
        connected, _ = await comm.connect()
        self.assertTrue(connected)
        return comm

    async def _start_game(self):
        """Create a room, connect host + guest, return (host, guest, playing
        state as seen on the guest socket)."""
        room = store.create_room("host-token")
        host = await self._connect(room.id, "host-token")
        # Host: welcome + waiting state.
        self.assertEqual((await recv_until(host, "welcome"))["role"], "host")
        await recv_until(host, "state")

        guest = await self._connect(room.id, "guest-token")
        self.assertEqual((await recv_until(guest, "welcome"))["role"], "guest")
        playing = await recv_until(guest, "state")
        # Host also receives the game-start broadcast.
        await recv_until(host, "state")
        return room, host, guest, playing

    async def test_host_then_guest_starts_game(self):
        _, host, guest, playing = await self._start_game()
        self.assertEqual(playing["status"], "playing")
        self.assertIn(playing["turn"], ("host", "guest"))
        self.assertEqual(playing["phase"], "roll")
        self.assertIsNone(playing["roll"])
        self.assertIsNone(playing["last_mover"])
        self.assertIsNone(playing["moved_piece"])
        self.assertFalse(playing["no_legal_move"])
        self.assertIsNone(playing["move_from"])
        self.assertEqual(playing["previews"], [])
        self.assertEqual(playing["path"], [])
        # Both sides start with four disks along their own bottom-right row.
        self.assertEqual(
            playing["disks"]["host"],
            [[3, 5], [3, 4], [3, 3], [3, 2]],
        )
        self.assertEqual(
            playing["disks"]["guest"],
            [[0, 0], [0, 1], [0, 2], [0, 3]],
        )
        await host.disconnect()
        await guest.disconnect()

    async def test_roll_die_enters_selection_phase(self):
        _, host, guest, playing = await self._start_game()
        mover = playing["turn"]
        comm = host if mover == "host" else guest

        with patch("game.game_logic.roll_die", return_value=4):
            await comm.send_json_to({"action": "roll_die"})
            state = await recv_until(host, "state")
            await recv_until(guest, "state")  # opponent sees it too

        self.assertEqual(state["turn"], mover)
        self.assertEqual(state["phase"], "select")
        self.assertEqual(state["roll"], 4)
        self.assertEqual(state["last_mover"], mover)
        self.assertIsNone(state["moved_piece"])
        self.assertFalse(state["no_legal_move"])
        self.assertIsNone(state["move_from"])
        self.assertEqual(state["path"], [])
        self.assertEqual(len(state["previews"]), 4)
        self.assertTrue(all(p["legal"] for p in state["previews"]))
        self.assertTrue(all(len(p["path"]) == 4 for p in state["previews"]))

        await host.disconnect()
        await guest.disconnect()

    async def test_confirm_move_advances_and_alternates(self):
        _, host, guest, playing = await self._start_game()
        mover = playing["turn"]
        comm = host if mover == "host" else guest

        with patch("game.game_logic.roll_die", return_value=4):
            await comm.send_json_to({"action": "roll_die"})
            await recv_until(host, "state")
            await recv_until(guest, "state")

        await comm.send_json_to({"action": "confirm_move", "piece": 1})
        state = await recv_until(host, "state")
        await recv_until(guest, "state")

        self.assertEqual(state["phase"], "roll")
        self.assertEqual(state["turn"], "guest" if mover == "host" else "host")
        self.assertEqual(state["roll"], 4)
        self.assertEqual(state["last_mover"], mover)
        self.assertEqual(state["moved_piece"], 1)
        self.assertFalse(state["no_legal_move"])

        expected_indices = list(gl.START_INDICES)
        expected_indices[1] = gl.advance(expected_indices[1], 4)
        expected_disks = [
            list(gl.canonical_position(mover, idx))
            for idx in expected_indices
        ]
        self.assertEqual(state["disks"][mover], expected_disks)
        self.assertEqual(
            state["move_from"],
            list(gl.canonical_position(mover, gl.START_INDICES[1])),
        )
        self.assertEqual(len(state["path"]), 4)
        self.assertEqual(state["path"][-1], expected_disks[1])

        await host.disconnect()
        await guest.disconnect()

    async def test_state_version_increases_each_accepted_turn(self):
        _, host, guest, playing = await self._start_game()
        first_version = playing["version"]
        self.assertIsInstance(first_version, int)

        mover = playing["turn"]
        comm = host if mover == "host" else guest

        with patch("game.game_logic.roll_die", return_value=2):
            await comm.send_json_to({"action": "roll_die"})
            state_after_roll = await recv_until(host, "state")
            await recv_until(guest, "state")

        self.assertGreater(state_after_roll["version"], first_version)
        self.assertEqual(state_after_roll["phase"], "select")

        await comm.send_json_to({"action": "confirm_move", "piece": 0})
        state_after_confirm = await recv_until(host, "state")
        await recv_until(guest, "state")

        self.assertGreater(state_after_confirm["version"], state_after_roll["version"])

        await host.disconnect()
        await guest.disconnect()

    async def test_out_of_turn_roll_is_ignored(self):
        _, host, guest, playing = await self._start_game()
        waiter = "guest" if playing["turn"] == "host" else "host"
        comm = host if waiter == "host" else guest

        await comm.send_json_to({"action": "roll_die"})
        # Nothing should be broadcast for an illegal move.
        self.assertTrue(await comm.receive_nothing(timeout=0.3))

        await host.disconnect()
        await guest.disconnect()

    async def test_confirm_before_roll_is_ignored(self):
        _, host, guest, playing = await self._start_game()
        mover = playing["turn"]
        comm = host if mover == "host" else guest

        await comm.send_json_to({"action": "confirm_move", "piece": 0})
        self.assertTrue(await comm.receive_nothing(timeout=0.3))

        await host.disconnect()
        await guest.disconnect()

    async def test_illegal_piece_confirm_is_ignored(self):
        _, host, guest, playing = await self._start_game()
        mover = playing["turn"]
        comm = host if mover == "host" else guest

        with patch("game.game_logic.roll_die", return_value=1):
            await comm.send_json_to({"action": "roll_die"})
            await recv_until(host, "state")
            await recv_until(guest, "state")

        # From [0,11,10,9] with roll=1 only piece 0 is legal.
        await comm.send_json_to({"action": "confirm_move", "piece": 1})
        self.assertTrue(await comm.receive_nothing(timeout=0.3))

        await host.disconnect()
        await guest.disconnect()

    async def test_roll_during_select_is_ignored(self):
        _, host, guest, playing = await self._start_game()
        mover = playing["turn"]
        comm = host if mover == "host" else guest

        with patch("game.game_logic.roll_die", return_value=4):
            await comm.send_json_to({"action": "roll_die"})
            await recv_until(host, "state")
            await recv_until(guest, "state")

        await comm.send_json_to({"action": "roll_die"})
        self.assertTrue(await comm.receive_nothing(timeout=0.3))

        await host.disconnect()
        await guest.disconnect()

    async def test_no_legal_move_auto_passes_turn(self):
        room, host, guest, playing = await self._start_game()
        mover = playing["turn"]
        comm = host if mover == "host" else guest

        state = store.get(room.id)
        blocked = [0, 3, 6, 9]
        if mover == "host":
            state.host_indices = blocked[:]
        else:
            state.guest_indices = blocked[:]

        with patch("game.game_logic.roll_die", return_value=3):
            await comm.send_json_to({"action": "roll_die"})
            after = await recv_until(host, "state")
            await recv_until(guest, "state")

        self.assertEqual(after["phase"], "roll")
        self.assertEqual(after["turn"], "guest" if mover == "host" else "host")
        self.assertEqual(after["roll"], 3)
        self.assertEqual(after["last_mover"], mover)
        self.assertIsNone(after["moved_piece"])
        self.assertTrue(after["no_legal_move"])
        self.assertEqual(after["previews"], [])
        self.assertIsNone(after["move_from"])
        self.assertEqual(after["path"], [])

        expected = [list(gl.canonical_position(mover, idx)) for idx in blocked]
        self.assertEqual(after["disks"][mover], expected)

        await host.disconnect()
        await guest.disconnect()

    async def test_resign_sets_winner_to_opponent(self):
        room, host, guest, _ = await self._start_game()

        await host.send_json_to({"action": "resign"})

        host_over = await recv_until(host, "game_over")
        guest_over = await recv_until(guest, "game_over")
        # Opponent (guest) wins when host resigns.
        self.assertEqual(host_over["winner"], "guest")
        self.assertEqual(guest_over["winner"], "guest")

        state = store.get(room.id)
        self.assertEqual(state.status, "over")
        self.assertEqual(state.winner, "guest")

        await host.disconnect()
        await guest.disconnect()

    async def test_unknown_room_is_rejected(self):
        comm = await self._connect("does-not-exist", "tok")
        err = await recv_until(comm, "error")
        self.assertEqual(err["message"], "room not found")
        await comm.disconnect()

    async def test_third_player_is_rejected(self):
        room, host, guest, _ = await self._start_game()
        third = await self._connect(room.id, "third-token")
        err = await recv_until(third, "error")
        self.assertEqual(err["message"], "room full")
        await third.disconnect()
        await host.disconnect()
        await guest.disconnect()

    async def test_missing_token_is_rejected(self):
        room = store.create_room("host-token")
        comm = WebsocketCommunicator(build_app(), f"/ws/room/{room.id}/")
        connected, _ = await comm.connect()
        self.assertTrue(connected)
        err = await recv_until(comm, "error")
        self.assertEqual(err["message"], "missing token")
        await comm.disconnect()


class LobbyConsumerTests(IsolatedAsyncioTestCase):
    def setUp(self):
        store.reset()

    async def test_lobby_lists_waiting_room(self):
        room = store.create_room("host-token")
        comm = WebsocketCommunicator(build_app(), "/ws/lobby/")
        connected, _ = await comm.connect()
        self.assertTrue(connected)

        msg = await recv_until(comm, "rooms")
        ids = [r["id"] for r in msg["rooms"]]
        self.assertIn(room.id, ids)

        await comm.disconnect()
