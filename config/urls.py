"""Root URL configuration."""
from django.urls import path

from game import views

urlpatterns = [
    path("", views.lobby, name="lobby"),
    path("host", views.host, name="host"),
    # Catch-all single segment -> a game room. Keep this last so the literal
    # routes above take precedence.
    path("<str:room_id>", views.game, name="game"),
]
