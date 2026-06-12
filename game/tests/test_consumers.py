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
        self.assertIsNone(playing["roll"])
        self.assertIsNone(playing["last_mover"])
        self.assertIsNone(playing["move_from"])
        self.assertEqual(playing["path"], [])
        # Both disks start in their own bottom-right corner (canonical coords).
        self.assertEqual(playing["disks"]["host"], [3, 5])
        self.assertEqual(playing["disks"]["guest"], [0, 0])
        await host.disconnect()
        await guest.disconnect()

    async def test_take_turn_advances_and_alternates(self):
        _, host, guest, playing = await self._start_game()
        mover = playing["turn"]
        comm = host if mover == "host" else guest

        with patch("game.game_logic.roll_die", return_value=4):
            await comm.send_json_to({"action": "take_turn"})
            state = await recv_until(host, "state")
            await recv_until(guest, "state")  # opponent sees it too

        # Turn passed to the other player.
        self.assertEqual(state["turn"], "guest" if mover == "host" else "host")
        # The mover's disk advanced by the rolled value.
        expected = list(gl.canonical_position(mover, 4))
        self.assertEqual(state["disks"][mover], expected)
        self.assertEqual(state["roll"], 4)
        self.assertEqual(state["last_mover"], mover)
        self.assertEqual(state["move_from"], list(gl.canonical_position(mover, 0)))
        self.assertEqual(len(state["path"]), 4)
        self.assertEqual(state["path"][-1], state["disks"][mover])

        await host.disconnect()
        await guest.disconnect()

    async def test_out_of_turn_move_is_ignored(self):
        _, host, guest, playing = await self._start_game()
        waiter = "guest" if playing["turn"] == "host" else "host"
        comm = host if waiter == "host" else guest

        await comm.send_json_to({"action": "take_turn"})
        # Nothing should be broadcast for an illegal move.
        self.assertTrue(await comm.receive_nothing(timeout=0.3))

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
