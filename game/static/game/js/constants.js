// Shared game constants for board rendering, dice, and networking.
(function () {
  "use strict";

  const Game = (window.Game = window.Game || {});

  Game.constants = {
    COLORS: {
      red: "#dc2626",
      blue: "#2563eb",
      promotedRed: "#eda324",
      promotedBlue: "#6e22b6",
      grid: "rgba(255, 255, 255, 0.12)",
      disk: "#ffffff",
      diskGuest: "#111827",
      diskOutline: "#111827",
      diskGuestOutline: "#ffffff",
      youRing: "#38bdf8",
      selectedRing: "#f59e0b",
      illegalX: "#ef4444",
    },
    COLS: 6,
    ROWS: 4,
    CELL: 80,
    LOGICAL_W: 6 * 80,
    LOGICAL_H: 4 * 80,
    HEARTBEAT_MS: 15000,
    MAX_RECONNECT: 40,
    BASE_FACE_NORMALS: {
      1: { x: 0, y: 0, z: 1 },
      2: { x: 1, y: 0, z: 0 },
      3: { x: 0, y: -1, z: 0 },
      4: { x: 0, y: 1, z: 0 },
      5: { x: -1, y: 0, z: 0 },
      6: { x: 0, y: 0, z: -1 },
    },
    FACE_ORIENTATION: {
      1: { x: 0, y: 0 },
      2: { x: 0, y: -90 },
      3: { x: -90, y: 0 },
      4: { x: 90, y: 0 },
      5: { x: 0, y: 90 },
      6: { x: 0, y: -180 },
    },
    PIP_LAYOUT: {
      1: [[1, 1]],
      2: [[2, 0], [0, 2]],
      3: [[2, 0], [1, 1], [0, 2]],
      4: [[0, 0], [2, 0], [0, 2], [2, 2]],
      5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
      6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
    },
    DIE_DOT_CLASSES: {
      1: ["center"],
      2: ["dtop dleft", "dbottom dright"],
      3: ["dtop dleft", "center", "dbottom dright"],
      4: ["dtop dleft", "dtop dright", "dbottom dleft", "dbottom dright"],
      5: ["center", "dtop dleft", "dtop dright", "dbottom dleft", "dbottom dright"],
      6: ["dtop dleft", "dtop dright", "dbottom dleft", "dbottom dright", "center dleft", "center dright"],
    },
  };
})();
