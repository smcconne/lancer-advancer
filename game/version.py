"""Build identifier used to tell clients when to reload.

In production the build id is fixed for the life of the process (a deploy
restarts the process and rehashes static assets), so the start-time value from
settings is enough. In DEBUG we additionally fold in the newest modification
time of the front-end source trees so that editing a template or a static
JS/CSS file - which does *not* restart ``runserver`` - still bumps the id and
kicks open clients back to the lobby with fresh assets.
"""
from __future__ import annotations

from pathlib import Path

from django.conf import settings

_BASE = Path(settings.BASE_DIR)
# Source trees whose edits should invalidate open clients during development.
_WATCH_DIRS = (
    _BASE / "game" / "static",
    _BASE / "game" / "templates",
)


def _latest_mtime() -> int:
    latest = 0.0
    for root in _WATCH_DIRS:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            try:
                mtime = path.stat().st_mtime
            except OSError:
                continue
            if mtime > latest:
                latest = mtime
    return int(latest)


def current_build_id() -> str:
    """Return the build id to advertise to clients right now."""
    if not settings.DEBUG:
        return settings.BUILD_ID
    return f"{settings.BUILD_ID}-{_latest_mtime()}"
