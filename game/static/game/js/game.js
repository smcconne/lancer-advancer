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
  let lastMove = null;
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

  const PIP_LAYOUT = {
    1: [[1, 1]],
    2: [[0, 0], [2, 2]],
    3: [[0, 0], [1, 1], [2, 2]],
    4: [[0, 0], [2, 0], [0, 2], [2, 2]],
    5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
    6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
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

    if (lastMove && Array.isArray(lastMove.track) && lastMove.track.length > 1) {
      drawMoveArrowShaft(lastMove.track, lastMove.mover);
    }

    if (lastState && lastState.disks) {
      const hostPos =
        hopPos && hopPos.role === "host" ? hopPos.pos : lastState.disks.host;
      const guestPos =
        hopPos && hopPos.role === "guest" ? hopPos.pos : lastState.disks.guest;
      drawDisk(hostPos, "host");
      drawDisk(guestPos, "guest");
    }

    if (lastMove && Array.isArray(lastMove.track) && lastMove.track.length > 1) {
      drawMoveArrowHead(lastMove.track, lastMove.mover);
      drawTrackDie(lastMove.track[0], lastMove.roll);
    }
  }

  function drawDisk(pos, who) {
    if (!pos) return;
    const [lr, lc] = toLocal(pos[0], pos[1]);
    const cx = lc * CELL + CELL / 2;
    const cy = lr * CELL + CELL / 2;

    const highlightedMover =
      lastMove && (lastMove.mover === "host" || lastMove.mover === "guest")
        ? lastMove.mover
        : lastState &&
            (lastState.last_mover === "host" || lastState.last_mover === "guest")
          ? lastState.last_mover
          : null;

    ctx.beginPath();
    ctx.arc(cx, cy, CELL * 0.32, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.disk;
    ctx.fill();
    ctx.lineWidth = 4;
    // Highlight the most recently moved piece with the cyan ring.
    ctx.strokeStyle = who === highlightedMover ? COLORS.youRing : COLORS.diskOutline;
    ctx.stroke();
  }

  function isCell(pos) {
    return (
      Array.isArray(pos) &&
      pos.length === 2 &&
      typeof pos[0] === "number" &&
      typeof pos[1] === "number"
    );
  }

  function cellCenter(pos) {
    const [lr, lc] = toLocal(pos[0], pos[1]);
    return {
      x: lc * CELL + CELL / 2,
      y: lr * CELL + CELL / 2,
    };
  }

  function roundedRectPath(x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  function moverColor(role) {
    return role === "host" ? COLORS.red : COLORS.blue;
  }

  function arrowTrackPoints(track) {
    return track.filter(isCell).map(cellCenter);
  }

  function drawMoveArrowShaft(track, mover) {
    const points = arrowTrackPoints(track);
    if (points.length < 2) return;

    const tip = points[points.length - 1];
    const prev = points[points.length - 2];
    const angle = Math.atan2(tip.y - prev.y, tip.x - prev.x);
    const headBaseX = tip.x - Math.cos(angle) * 48;
    const headBaseY = tip.y - Math.sin(angle) * 48;

    const pathPoints = points.slice();
    pathPoints[pathPoints.length - 1] = { x: headBaseX, y: headBaseY };

    if (pathPoints.length < 2) return;

    const moverStroke = moverColor(mover);
    const strokeLayers = [
      { width: 20, color: "#0b1220" },
      { width: 16, color: "#ffffff" },
      { width: 12, color: moverStroke },
    ];

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    strokeLayers.forEach(function (layer) {
      ctx.beginPath();
      ctx.moveTo(pathPoints[0].x, pathPoints[0].y);
      for (let i = 1; i < pathPoints.length; i++) {
        ctx.lineTo(pathPoints[i].x, pathPoints[i].y);
      }
      ctx.strokeStyle = layer.color;
      ctx.lineWidth = layer.width;
      ctx.stroke();
    });

    ctx.restore();
  }

  function drawMoveArrowHead(track, mover) {
    const points = track.filter(isCell).map(cellCenter);
    if (points.length < 2) return;

    const tip = points[points.length - 1];
    let prev = points[points.length - 2];
    for (let i = points.length - 2; i >= 0; i--) {
      if (points[i].x !== tip.x || points[i].y !== tip.y) {
        prev = points[i];
        break;
      }
    }

    const angle = Math.atan2(tip.y - prev.y, tip.x - prev.x);

    // 2x larger than the previous head dimensions.
    const headLength = 48;
    const headWidth = 36;
    const halfW = headWidth / 2;
    const moverStroke = moverColor(mover);
    const baseX = tip.x - Math.cos(angle) * headLength;
    const baseY = tip.y - Math.sin(angle) * headLength;
    const leftX = baseX + Math.cos(angle + Math.PI / 2) * halfW;
    const leftY = baseY + Math.sin(angle + Math.PI / 2) * halfW;
    const rightX = baseX + Math.cos(angle - Math.PI / 2) * halfW;
    const rightY = baseY + Math.sin(angle - Math.PI / 2) * halfW;
    const leftBaseThirdX = leftX + (rightX - leftX) / 12;
    const leftBaseThirdY = leftY + (rightY - leftY) / 12;
    const rightBaseThirdX = rightX + (leftX - rightX) / 12;
    const rightBaseThirdY = rightY + (leftY - rightY) / 12;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(leftX, leftY);
    ctx.lineTo(rightX, rightY);
    ctx.closePath();
    ctx.fillStyle = moverStroke;
    ctx.fill();

    // Draw both sides plus one-third of each base edge, leaving the center
    // third open so there is no middle seam where head and shaft meet.
    [
      { width: 9, color: "#0b1220" },
      { width: 4.5, color: "#ffffff" },
    ].forEach(function (layer) {
      ctx.beginPath();
      ctx.moveTo(leftX, leftY);
      ctx.lineTo(tip.x, tip.y);
      ctx.lineTo(rightX, rightY);
      ctx.lineTo(rightBaseThirdX, rightBaseThirdY);
      ctx.moveTo(leftX, leftY);
      ctx.lineTo(leftBaseThirdX, leftBaseThirdY);
      ctx.strokeStyle = layer.color;
      ctx.lineWidth = layer.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
    });

    // Final fill pass keeps the head visibly solid (never hollow-looking).
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(leftX, leftY);
    ctx.lineTo(rightX, rightY);
    ctx.closePath();
    ctx.fillStyle = moverStroke;
    ctx.fill();

    ctx.restore();
  }

  function drawTrackDie(origin, value) {
    if (!isCell(origin) || typeof value !== "number" || !PIP_LAYOUT[value]) return;

    const center = cellCenter(origin);
    const size = CELL * 0.52;
    const x = center.x - size / 2;
    const y = center.y - size / 2;
    const radius = size * 0.18;

    ctx.save();
    roundedRectPath(x, y, size, size, radius);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#0b1220";
    ctx.stroke();

    const anchors = [0.28, 0.5, 0.72];
    const pipRadius = size * 0.065;
    const pips = PIP_LAYOUT[value];
    pips.forEach(function (pip) {
      const px = x + size * anchors[pip[0]];
      const py = y + size * anchors[pip[1]];
      ctx.beginPath();
      ctx.arc(px, py, pipRadius, 0, Math.PI * 2);
      ctx.fillStyle = "#0b1220";
      ctx.fill();
    });
    ctx.restore();
  }

  function getMoveOverlay(data, previousState) {
    const hasPath = Array.isArray(data.path) && data.path.length > 0;
    const hasRoll = typeof data.roll === "number" && data.roll >= 1 && data.roll <= 6;
    const hasMover = data.last_mover === "host" || data.last_mover === "guest";
    if (!hasPath || !hasRoll || !hasMover) return null;

    const origin = isCell(data.move_from)
      ? data.move_from
      : previousState &&
          previousState.disks &&
          isCell(previousState.disks[data.last_mover])
        ? previousState.disks[data.last_mover]
        : null;
    if (!origin) return null;

    return {
      mover: data.last_mover,
      roll: data.roll,
      track: [origin].concat(data.path.filter(isCell)),
    };
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
    dieEl.classList.remove("die--rolling-geometry");
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
    dieEl.classList.remove("die--rolling-geometry");
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
    dieEl.classList.add("die--rolling-geometry");

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
      dieEl.classList.remove("die--rolling-geometry");
      if (onDone) onDone();
    };
    dieCubeEl.addEventListener("transitionend", dieTransitionHandler);

    dieTransitionFallbackId = setTimeout(function () {
      clearDieAnimation();
      dieCubeEl.style.transition = "none";
      setCubeRotation(finalOrientation.x, finalOrientation.y);
      updateDepthShading();
      stopDepthShading();
      dieEl.classList.remove("die--rolling-geometry");
      if (onDone) onDone();
    }, 1300);

    dieCubeEl.style.transition = "transform 1.1s cubic-bezier(0.2, 0.7, 0.2, 1)";
    setCubeRotation(targetX, targetY);
  }

  function hopPiece(role, path, onDone) {
    const hops = Array.isArray(path) ? path : [];
    if (hops.length === 0) {
      if (onDone) onDone();
      return;
    }

    let step = 0;
    function nextHop() {
      hopPos = { role: role, pos: hops[step] };
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
        lastMove = null;
        drawBoard();
        updateStatus();
        break;
      case "state":
        {
          const previousState = lastState;
          const moveOverlay = getMoveOverlay(data, previousState);
          if (moveOverlay) {
            lastMove = moveOverlay;
          } else if (!data.last_mover) {
            lastMove = null;
          }

          const shouldAnimateMine =
            awaitingRoll &&
            data.last_mover === myRole &&
            typeof data.roll === "number" &&
            data.roll >= 1 &&
            data.roll <= 6 &&
            Array.isArray(data.path) &&
            data.path.length > 0;

          const mover = data.last_mover;
          const moverChanged =
            (mover === "host" || mover === "guest") &&
            previousState &&
            previousState.disks &&
            data.disks &&
            Array.isArray(previousState.disks[mover]) &&
            Array.isArray(data.disks[mover]) &&
            (previousState.disks[mover][0] !== data.disks[mover][0] ||
              previousState.disks[mover][1] !== data.disks[mover][1]);

          const shouldAnimateOpponent =
            !awaitingRoll &&
            moverChanged &&
            mover !== myRole &&
            Array.isArray(data.path) &&
            data.path.length > 0;

          if (shouldAnimateMine) {
            const finalState = data;
            lastState = previousState || data;
            statusEl.textContent = "Rolling die...";
            turnBtn.disabled = true;
            resignBtn.disabled = true;

            animateRoll(finalState.roll, function () {
              hopPiece(finalState.last_mover, finalState.path, function () {
                awaitingRoll = false;
                hopPos = null;
                lastState = finalState;
                hideDie();
                drawBoard();
                updateStatus();
              });
            });
          } else if (shouldAnimateOpponent) {
            const finalState = data;
            lastState = previousState;
            turnBtn.disabled = true;
            resignBtn.disabled = true;

            hopPiece(finalState.last_mover, finalState.path, function () {
              awaitingRoll = false;
              hopPos = null;
              hideDie();
              lastState = finalState;
              drawBoard();
              updateStatus();
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
