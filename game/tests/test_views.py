"""HTTP view tests: lobby page, room creation, game page."""
import json

from django.test import SimpleTestCase

from game.store import store


class ViewTests(SimpleTestCase):
    def setUp(self):
        store.reset()

    def test_lobby_renders(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Lancer Advancer")

    def test_host_creates_room(self):
        response = self.client.post("/host", {"token": "host-token"})
        self.assertEqual(response.status_code, 200)
        room_id = json.loads(response.content)["room_id"]

        room = store.get(room_id)
        self.assertIsNotNone(room)
        self.assertEqual(room.host_token, "host-token")
        self.assertEqual(room.status, "waiting")

    def test_host_requires_token(self):
        response = self.client.post("/host", {})
        self.assertEqual(response.status_code, 400)

    def test_host_rejects_get(self):
        response = self.client.get("/host")
        self.assertEqual(response.status_code, 405)

    def test_game_page_renders(self):
        response = self.client.get("/abc123")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "abc123")
        self.assertContains(response, "<canvas")
