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
  const dieEl = document.getElementById("die");
  const dieCubeEl = dieEl ? dieEl.querySelector(".die__cube") : null;
  const reduceMotionQuery = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;
  const overlay = document.getElementById("overlay");
  const overlayTitle = document.getElementById("overlay-title");
  const overlayText = document.getElementById("overlay-text");
  const BASE_FACE_NORMALS = {
    1: { x: 0, y: 0, z: 1 },
    2: { x: 1, y: 0, z: 0 },
    3: { x: 0, y: -1, z: 0 },
    4: { x: 0, y: 1, z: 0 },
    5: { x: -1, y: 0, z: 0 },
    6: { x: 0, y: 0, z: -1 },
  };
  const dieFaces = dieCubeEl
    ? Array.from(dieCubeEl.querySelectorAll(".die__face"))
    : [];
  const dieFaceData = dieFaces
    .map(function (faceEl) {
      const faceClass = Array.from(faceEl.classList).find(function (cls) {
        return cls.indexOf("die__face--") === 0;
      });
      if (!faceClass) return null;
      const faceNum = Number(faceClass.replace("die__face--", ""));
      const normal = BASE_FACE_NORMALS[faceNum];
      if (!normal) return null;
      return { element: faceEl, normal: normal };
    })
    .filter(Boolean);

  let myRole = null; // "host" | "guest"
  let lastState = null;
  let socket = null;
  let awaitingRoll = false;
  let hopPos = null;
  let dieTransitionHandler = null;
  let dieTransitionFallbackId = null;
  let depthRafId = null;

  const FACE_ORIENTATION = {
    1: { x: 0, y: 0 },
    2: { x: 0, y: -90 },
    3: { x: -90, y: 0 },
    4: { x: 90, y: 0 },
    5: { x: 0, y: 90 },
    6: { x: 0, y: -180 },
  };

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
      const hostPos = myRole === "host" && hopPos ? hopPos : lastState.disks.host;
      const guestPos = myRole === "guest" && hopPos ? hopPos : lastState.disks.guest;
      drawDisk(hostPos, "host");
      drawDisk(guestPos, "guest");
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

  function setCubeRotation(rotX, rotY) {
    if (!dieCubeEl) return;
    dieCubeEl.style.transform =
      "rotateX(" + rotX + "deg) rotateY(" + rotY + "deg)";
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function resetDepthShading() {
    dieFaceData.forEach(function (face) {
      face.element.style.setProperty("--face-brightness", "1");
    });
  }

  function getCubeMatrix() {
    if (!dieCubeEl) return new DOMMatrixReadOnly();
    const transformValue = getComputedStyle(dieCubeEl).transform;
    if (!transformValue || transformValue === "none") {
      return new DOMMatrixReadOnly();
    }
    return new DOMMatrixReadOnly(transformValue);
  }

  function updateDepthShading() {
    if (!dieCubeEl || dieFaceData.length === 0) return;

    const matrix = getCubeMatrix();
    const origin = matrix.transformPoint(new DOMPoint(0, 0, 0, 1));

    dieFaceData.forEach(function (face) {
      const normalEnd = matrix.transformPoint(
        new DOMPoint(face.normal.x, face.normal.y, face.normal.z, 1)
      );
      const zDepth = clamp(normalEnd.z - origin.z, -1, 1);
      const brightness = clamp(0.55 + ((zDepth + 1) * 0.5) * 0.7, 0.55, 1.25);
      face.element.style.setProperty(
        "--face-brightness",
        brightness.toFixed(3)
      );
    });
  }

  function depthShadingTick() {
    updateDepthShading();
    depthRafId = requestAnimationFrame(depthShadingTick);
  }

  function startDepthShading() {
    if (depthRafId !== null || dieFaceData.length === 0) return;
    depthShadingTick();
  }

  function stopDepthShading() {
    if (depthRafId !== null) {
      cancelAnimationFrame(depthRafId);
      depthRafId = null;
    }
  }

  function clearDieAnimation() {
    if (!dieCubeEl) return;
    if (dieTransitionHandler) {
      dieCubeEl.removeEventListener("transitionend", dieTransitionHandler);
      dieTransitionHandler = null;
    }
    if (dieTransitionFallbackId !== null) {
      clearTimeout(dieTransitionFallbackId);
      dieTransitionFallbackId = null;
    }
  }

  function hideDie() {
    if (!dieEl) return;
    clearDieAnimation();
    stopDepthShading();
    resetDepthShading();
    dieEl.classList.add("hidden");
    dieEl.setAttribute("aria-hidden", "true");
    if (dieCubeEl) {
      dieCubeEl.style.transition = "none";
      setCubeRotation(0, 0);
    }
  }

  function animateRoll(finalFace, onDone) {
    if (!dieEl || !dieCubeEl) {
      if (onDone) onDone();
      return;
    }
    clearDieAnimation();
    stopDepthShading();

    const finalOrientation = FACE_ORIENTATION[finalFace] || FACE_ORIENTATION[1];
    const shouldReduceMotion = reduceMotionQuery ? reduceMotionQuery.matches : false;

    dieEl.classList.remove("hidden");
    dieEl.setAttribute("aria-hidden", "false");

    if (shouldReduceMotion) {
      dieCubeEl.style.transition = "none";
      setCubeRotation(finalOrientation.x, finalOrientation.y);
      updateDepthShading();
      dieTransitionFallbackId = setTimeout(function () {
        dieTransitionFallbackId = null;
        if (onDone) onDone();
      }, 200);
      return;
    }

    const spinTurnsX = (2 + Math.floor(Math.random() * 2)) * 360;
    const spinTurnsY = (2 + Math.floor(Math.random() * 2)) * 360;
    const targetX = finalOrientation.x + spinTurnsX;
    const targetY = finalOrientation.y + spinTurnsY;

    dieCubeEl.style.transition = "none";
    setCubeRotation(0, 0);
    updateDepthShading();
    startDepthShading();
    void dieCubeEl.offsetWidth;

    dieTransitionHandler = function (event) {
      if (event.propertyName !== "transform") return;
      clearDieAnimation();
      dieCubeEl.style.transition = "none";
      setCubeRotation(finalOrientation.x, finalOrientation.y);
      updateDepthShading();
      stopDepthShading();
      if (onDone) onDone();
    };
    dieCubeEl.addEventListener("transitionend", dieTransitionHandler);

    dieTransitionFallbackId = setTimeout(function () {
      clearDieAnimation();
      dieCubeEl.style.transition = "none";
      setCubeRotation(finalOrientation.x, finalOrientation.y);
      updateDepthShading();
      stopDepthShading();
      if (onDone) onDone();
    }, 1300);

    dieCubeEl.style.transition = "transform 1.1s cubic-bezier(0.2, 0.7, 0.2, 1)";
    setCubeRotation(targetX, targetY);
  }

  function hopPiece(path, onDone) {
    const hops = Array.isArray(path) ? path : [];
    if (hops.length === 0) {
      if (onDone) onDone();
      return;
    }

    let step = 0;
    function nextHop() {
      hopPos = hops[step];
      drawBoard();
      step += 1;
      if (step >= hops.length) {
        setTimeout(function () {
          if (onDone) onDone();
        }, 150);
        return;
      }
      setTimeout(nextHop, 180);
    }

    nextHop();
  }

  function handleMessage(data) {
    switch (data.type) {
      case "welcome":
        myRole = data.role;
        drawBoard();
        updateStatus();
        break;
      case "state":
        {
          const shouldAnimateMine =
            awaitingRoll &&
            data.last_mover === myRole &&
            typeof data.roll === "number" &&
            data.roll >= 1 &&
            data.roll <= 6 &&
            Array.isArray(data.path) &&
            data.path.length > 0;

          if (shouldAnimateMine) {
            const previousState = lastState;
            const finalState = data;
            lastState = previousState || data;
            statusEl.textContent = "Rolling die...";
            turnBtn.disabled = true;
            resignBtn.disabled = true;

            animateRoll(finalState.roll, function () {
              hopPiece(finalState.path, function () {
                awaitingRoll = false;
                hopPos = null;
                lastState = finalState;
                hideDie();
                drawBoard();
                updateStatus();
              });
            });
          } else {
            awaitingRoll = false;
            hopPos = null;
            hideDie();
            lastState = data;
            drawBoard();
            updateStatus();
          }
        }
        break;
      case "game_over":
        awaitingRoll = false;
        hopPos = null;
        hideDie();
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
      return true;
    }
    return false;
  }

  turnBtn.addEventListener("click", function () {
    if (turnBtn.disabled || awaitingRoll) {
      return;
    }
    if (!send("take_turn")) {
      return;
    }
    awaitingRoll = true;
    turnBtn.disabled = true;
    statusEl.textContent = "Rolling die...";
  });
  resignBtn.addEventListener("click", function () {
    send("resign");
  });

  drawBoard();
  connect();
})();
