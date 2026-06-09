// Game room: render the board from this player's perspective and drive turns.
(function () {
  "use strict";

  const COLORS = {
    red: "#dc2626",
    blue: "#2563eb",
    grid: "rgba(255, 255, 255, 0.12)",
    disk: "#ffffff",
    diskOutline: "#0f172a",
    youRing: "#38bdf8",
  };
  const COLS = 6;
  const ROWS = 4;
  const CELL = 80; // canvas is 480x320 in its own coordinate space

  function getToken() {
    let token = localStorage.getItem("la_token");
    if (!token) {
      token =
        (crypto.randomUUID && crypto.randomUUID()) ||
        String(Date.now()) + Math.random().toString(16).slice(2);
      localStorage.setItem("la_token", token);
    }
    return token;
  }

  function wsUrl(path) {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    return scheme + "://" + location.host + path;
  }

  const token = getToken();
  const roomId = window.ROOM_ID;

  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d");
  const statusEl = document.getElementById("status");
  const turnBtn = document.getElementById("turn-btn");
  const resignBtn = document.getElementById("resign-btn");
  const overlay = document.getElementById("overlay");
  const overlayTitle = document.getElementById("overlay-title");
  const overlayText = document.getElementById("overlay-text");

  let myRole = null; // "host" | "guest"
  let lastState = null;
  let socket = null;

  // Canonical (server) coordinates -> this player's local view. The host sees
  // canonical coordinates directly; the guest sees the board rotated 180deg.
  function toLocal(r, c) {
    if (myRole === "guest") {
      return [ROWS - 1 - r, COLS - 1 - c];
    }
    return [r, c];
  }

  function drawBoard() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const bottomColor = myRole === "guest" ? COLORS.blue : COLORS.red;
    const topColor = myRole === "guest" ? COLORS.red : COLORS.blue;

    // Host view: bottom red / top blue.
    // Guest view: bottom blue / top red.
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        ctx.fillStyle = r >= 2 ? bottomColor : topColor;
        ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
      }
    }

    // Grid lines.
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 2;
    for (let c = 0; c <= COLS; c++) {
      ctx.beginPath();
      ctx.moveTo(c * CELL, 0);
      ctx.lineTo(c * CELL, ROWS * CELL);
      ctx.stroke();
    }
    for (let r = 0; r <= ROWS; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * CELL);
      ctx.lineTo(COLS * CELL, r * CELL);
      ctx.stroke();
    }

    if (lastState && lastState.disks) {
      drawDisk(lastState.disks.host, "host");
      drawDisk(lastState.disks.guest, "guest");
    }
  }

  function drawDisk(pos, who) {
    if (!pos) return;
    const [lr, lc] = toLocal(pos[0], pos[1]);
    const cx = lc * CELL + CELL / 2;
    const cy = lr * CELL + CELL / 2;

    ctx.beginPath();
    ctx.arc(cx, cy, CELL * 0.32, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.disk;
    ctx.fill();
    ctx.lineWidth = 4;
    // Your own disk gets a cyan ring so you can tell the two apart.
    ctx.strokeStyle = who === myRole ? COLORS.youRing : COLORS.diskOutline;
    ctx.stroke();
  }

  function updateStatus() {
    if (!lastState) {
      statusEl.textContent = "Connecting…";
      return;
    }
    const s = lastState.status;
    if (s === "waiting") {
      statusEl.textContent = "Waiting for an opponent to join…";
    } else if (s === "playing") {
      statusEl.textContent =
        lastState.turn === myRole ? "Your turn" : "Opponent's turn";
    } else if (s === "over") {
      statusEl.textContent = "Game over";
    }

    const myTurn = s === "playing" && lastState.turn === myRole;
    turnBtn.disabled = !myTurn;
    resignBtn.disabled = s !== "playing";
  }

  function showOverlay(title, text) {
    overlayTitle.textContent = title;
    overlayText.textContent = text || "";
    overlay.classList.remove("hidden");
  }

  function handleMessage(data) {
    switch (data.type) {
      case "welcome":
        myRole = data.role;
        drawBoard();
        updateStatus();
        break;
      case "state":
        lastState = data;
        drawBoard();
        updateStatus();
        break;
      case "game_over":
        turnBtn.disabled = true;
        resignBtn.disabled = true;
        if (data.winner === myRole) {
          showOverlay("You Win", "Your opponent resigned.");
        } else {
          showOverlay("You Lose", "You resigned the game.");
        }
        break;
      case "error":
        showOverlay("Unavailable", messageForError(data.message));
        break;
    }
  }

  function messageForError(code) {
    if (code === "room not found") return "This room no longer exists.";
    if (code === "room full") return "This room already has two players.";
    return "Could not join this room.";
  }

  function connect() {
    socket = new WebSocket(
      wsUrl("/ws/room/" + encodeURIComponent(roomId) + "/?token=" +
        encodeURIComponent(token))
    );
    socket.onmessage = function (event) {
      handleMessage(JSON.parse(event.data));
    };
  }

  function send(action) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ action: action }));
    }
  }

  turnBtn.addEventListener("click", function () {
    send("take_turn");
  });
  resignBtn.addEventListener("click", function () {
    send("resign");
  });

  drawBoard();
  connect();
})();
