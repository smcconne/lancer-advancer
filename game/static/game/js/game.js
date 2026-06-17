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
    selectedRing: "#f59e0b",
    illegalX: "#ef4444",
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
  let turnRollIndicatorEl = document.getElementById("turn-roll-indicator");
  if (!turnRollIndicatorEl && turnBtn && turnBtn.parentElement) {
    turnRollIndicatorEl = document.createElement("span");
    turnRollIndicatorEl.id = "turn-roll-indicator";
    turnRollIndicatorEl.className = "turn-roll-indicator hidden";
    turnRollIndicatorEl.setAttribute("aria-hidden", "true");
    turnBtn.parentElement.insertBefore(turnRollIndicatorEl, turnBtn);
  }
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
  let hopPos = null; // { role, pieceIndex, pos }
  let previewPos = null; // { role, pieceIndex, pos }
  let previewMove = null; // { mover, roll, track }
  let selectedPiece = null;
  let illegalOverlay = null; // { track }
  let lastMove = null;
  let dieTransitionHandler = null;
  let dieTransitionFallbackId = null;
  let depthRafId = null;
  let latestStateVersion = -1;
  let stateApplyToken = 0;
  let inputLocked = false;
  let transientStatusText = "";
  let transientStatusUntil = 0;
  let selectableFlashTimer = null;
  let rollCycleTimer = null;

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
  const DIE_DOT_CLASSES = {
    1: ["center"],
    2: ["dtop dleft", "dbottom dright"],
    3: ["dtop dleft", "center", "dbottom dright"],
    4: ["dtop dleft", "dtop dright", "dbottom dleft", "dbottom dright"],
    5: ["center", "dtop dleft", "dtop dright", "dbottom dleft", "dbottom dright"],
    6: ["dtop dleft", "dtop dright", "dbottom dleft", "dbottom dright", "center dleft", "center dright"],
  };

  // Canonical (server) coordinates -> this player's local view. The host sees
  // canonical coordinates directly; the guest sees the board rotated 180deg.
  function toLocal(r, c) {
    if (myRole === "guest") {
      return [ROWS - 1 - r, COLS - 1 - c];
    }
    return [r, c];
  }

  function toCanonical(r, c) {
    if (myRole === "guest") {
      return [ROWS - 1 - r, COLS - 1 - c];
    }
    return [r, c];
  }

  function isCell(pos) {
    return (
      Array.isArray(pos) &&
      pos.length === 2 &&
      typeof pos[0] === "number" &&
      typeof pos[1] === "number"
    );
  }

  function sameCell(a, b) {
    return isCell(a) && isCell(b) && a[0] === b[0] && a[1] === b[1];
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

  function roleDisks(state, role) {
    if (!state || !state.disks || !Array.isArray(state.disks[role])) {
      return [];
    }
    return state.disks[role];
  }

  function pieceCell(state, role, piece) {
    const disks = roleDisks(state, role);
    if (!Array.isArray(disks[piece])) {
      return null;
    }
    return disks[piece];
  }

  function clearSelection() {
    selectedPiece = null;
    previewPos = null;
    previewMove = null;
    illegalOverlay = null;
  }

  function currentArrowOverlay() {
    const selectingMine =
      !!lastState &&
      lastState.status === "playing" &&
      lastState.phase === "select" &&
      lastState.turn === myRole;
    if (
      selectingMine &&
      previewMove &&
      Array.isArray(previewMove.track) &&
      previewMove.track.length > 1
    ) {
      return previewMove;
    }
    if (lastMove && Array.isArray(lastMove.track) && lastMove.track.length > 1) {
      return lastMove;
    }
    return null;
  }

  function canSelectPieces() {
    return (
      !!lastState &&
      lastState.status === "playing" &&
      lastState.phase === "select" &&
      lastState.turn === myRole &&
      !inputLocked
    );
  }

  function waitingToConfirmSelection() {
    return canSelectPieces() && Number.isInteger(selectedPiece);
  }

  function waitingToSelectPiece() {
    return canSelectPieces() && !Number.isInteger(selectedPiece);
  }

  function waitingForOpponentToSelectPiece() {
    return (
      !!lastState &&
      lastState.status === "playing" &&
      lastState.phase === "select" &&
      (myRole === "host" || myRole === "guest") &&
      lastState.turn !== myRole
    );
  }

  function flashingSelectableStroke() {
    // Smoothly blend between established highlight and outline colors.
    const t = Date.now() / 1000;
    const mix = (Math.sin(t * Math.PI * 2) + 1) / 2;
    const start = { r: 56, g: 189, b: 248 }; // COLORS.youRing
    const end = { r: 0, g: 0, b: 0 }; // black
    const r = Math.round(start.r * mix + end.r * (1 - mix));
    const g = Math.round(start.g * mix + end.g * (1 - mix));
    const b = Math.round(start.b * mix + end.b * (1 - mix));
    return "rgb(" + r + ", " + g + ", " + b + ")";
  }

  function syncSelectableFlashLoop() {
    if (canSelectPieces() || waitingForOpponentToSelectPiece()) {
      if (selectableFlashTimer !== null) return;
      selectableFlashTimer = setInterval(function () {
        if (!canSelectPieces() && !waitingForOpponentToSelectPiece()) {
          clearInterval(selectableFlashTimer);
          selectableFlashTimer = null;
          return;
        }
        drawBoard();
      }, 33);
      return;
    }

    if (selectableFlashTimer !== null) {
      clearInterval(selectableFlashTimer);
      selectableFlashTimer = null;
    }
  }

  function setTransientStatus(text, durationMs) {
    transientStatusText = text;
    transientStatusUntil = Date.now() + durationMs;
    setTimeout(function () {
      if (Date.now() >= transientStatusUntil) {
        transientStatusText = "";
        updateStatus();
      }
    }, durationMs + 30);
  }

  function setTurnButtonText(label) {
    turnBtn.replaceChildren(document.createTextNode(label));
  }

  function hideTurnRollIndicator() {
    if (!turnRollIndicatorEl) return;
    turnRollIndicatorEl.classList.add("hidden");
    turnRollIndicatorEl.classList.remove("die--red", "die--blue");
    turnRollIndicatorEl.setAttribute("aria-hidden", "true");
    turnRollIndicatorEl.replaceChildren();
  }

  function setTurnRollIndicator(roll, role) {
    if (!turnRollIndicatorEl) return;

    const classes = DIE_DOT_CLASSES[roll];
    if (!classes) {
      hideTurnRollIndicator();
      return;
    }

    turnRollIndicatorEl.classList.remove("hidden", "die--red", "die--blue");
    turnRollIndicatorEl.classList.add(
      role === "host" ? "die--red" : "die--blue"
    );
    turnRollIndicatorEl.setAttribute("aria-hidden", "false");
    turnRollIndicatorEl.replaceChildren();

    classes.forEach(function (dotClasses) {
      const dot = document.createElement("span");
      dot.className = "dot " + dotClasses;
      turnRollIndicatorEl.appendChild(dot);
    });
  }

  function stopRollCycle() {
    if (rollCycleTimer !== null) {
      clearInterval(rollCycleTimer);
      rollCycleTimer = null;
    }
  }

  function startRollCycle(role) {
    if (!turnRollIndicatorEl) return;
    const showRandomFace = function () {
      setTurnRollIndicator(Math.floor(Math.random() * 6) + 1, role);
    };
    showRandomFace();
    if (rollCycleTimer !== null) {
      clearInterval(rollCycleTimer);
    }
    rollCycleTimer = setInterval(showRandomFace, 150);
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

    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(leftX, leftY);
    ctx.lineTo(rightX, rightY);
    ctx.closePath();
    ctx.fillStyle = moverStroke;
    ctx.fill();

    ctx.restore();
  }

  function drawTrackDie(origin, value, mover) {
    if (!isCell(origin) || typeof value !== "number" || !PIP_LAYOUT[value]) return;

    const center = cellCenter(origin);
    const size = CELL * 0.52;
    const x = center.x - size / 2;
    const y = center.y - size / 2;
    const radius = size * 0.18;

    ctx.save();
    roundedRectPath(x, y, size, size, radius);
    ctx.fillStyle = moverColor(mover);
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
      ctx.fillStyle = "#ffffff";
      ctx.fill();
    });
    ctx.restore();
  }

  function drawIllegalX(track) {
    if (!illegalOverlay || !Array.isArray(track) || track.length === 0) return;
    const points = track.filter(isCell).map(cellCenter);
    if (points.length === 0) return;

    let minX = points[0].x;
    let maxX = points[0].x;
    let minY = points[0].y;
    let maxY = points[0].y;
    points.forEach(function (p) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    });

    const pad = CELL * 0.25;
    minX -= pad;
    maxX += pad;
    minY -= pad;
    maxY += pad;

    ctx.save();
    ctx.lineCap = "round";
    [
      { width: 18, color: "#ffffff" },
      { width: 10, color: COLORS.illegalX },
    ].forEach(function (layer) {
      ctx.strokeStyle = layer.color;
      ctx.lineWidth = layer.width;
      ctx.beginPath();
      ctx.moveTo(minX, minY);
      ctx.lineTo(maxX, maxY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(maxX, minY);
      ctx.lineTo(minX, maxY);
      ctx.stroke();
    });
    ctx.restore();
  }

  function drawDisk(pos, who, opts) {
    if (!isCell(pos)) return;
    const [lr, lc] = toLocal(pos[0], pos[1]);
    const cx = lc * CELL + CELL / 2;
    const cy = lr * CELL + CELL / 2;

    const selected = !!(opts && opts.selected);
    const movedLast = !!(opts && opts.movedLast);
    const flashOutline = !!(opts && opts.flashOutline);
    const moving = !!(opts && opts.moving);
    const selectedStroke = moving ? COLORS.youRing : COLORS.selectedRing;
    const stroke = flashOutline
      ? flashingSelectableStroke()
      : selected
        ? selectedStroke
      : movedLast
        ? COLORS.youRing
        : COLORS.diskOutline;

    ctx.beginPath();
    ctx.arc(cx, cy, CELL * 0.32, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.disk;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = stroke;
    ctx.stroke();

    if (selected && !flashOutline && !moving) {
      ctx.beginPath();
      ctx.arc(cx, cy, CELL * 0.12, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.selectedRing;
      ctx.fill();
    }
  }

  function isPieceSelected(role, piece) {
    return (
      role === myRole &&
      selectedPiece === piece
    );
  }

  function drawRoleDisks(role, selectedOnly) {
    const disks = roleDisks(lastState, role);
    for (let piece = 0; piece < disks.length; piece++) {
      const basePos = disks[piece];
      if (!isCell(basePos)) continue;

      const selected = isPieceSelected(role, piece);
      if (selectedOnly === true && !selected) continue;
      if (selectedOnly === false && selected) continue;

      let drawPos = basePos;
      if (
        hopPos &&
        hopPos.role === role &&
        hopPos.pieceIndex === piece &&
        isCell(hopPos.pos)
      ) {
        drawPos = hopPos.pos;
      } else if (
        previewPos &&
        previewPos.role === role &&
        previewPos.pieceIndex === piece &&
        isCell(previewPos.pos)
      ) {
        drawPos = previewPos.pos;
      }

      const movedLast =
        !!lastState &&
        lastState.last_mover === role &&
        lastState.moved_piece === piece;
      const opponentSelecting =
        waitingForOpponentToSelectPiece() &&
        role !== myRole;
      const flashOutline =
        opponentSelecting ||
        (role === myRole &&
          canSelectPieces() &&
          (waitingToSelectPiece() ||
            (waitingToConfirmSelection() && selectedPiece === piece)));
      const moving =
        !!hopPos &&
        hopPos.role === role &&
        hopPos.pieceIndex === piece;
      drawDisk(drawPos, role, {
        selected: selected,
        movedLast: movedLast,
        flashOutline: flashOutline,
        moving: moving,
      });
    }
  }

  function drawBoard() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const bottomColor = myRole === "guest" ? COLORS.blue : COLORS.red;
    const topColor = myRole === "guest" ? COLORS.red : COLORS.blue;

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        ctx.fillStyle = r >= 2 ? bottomColor : topColor;
        ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
      }
    }

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

    const arrowOverlay = currentArrowOverlay();
    const movingSelectedPiece =
      Number.isInteger(selectedPiece) &&
      !!hopPos &&
      hopPos.role === myRole &&
      hopPos.pieceIndex === selectedPiece;

    if (lastState && lastState.disks) {
      drawRoleDisks("host", false);
      drawRoleDisks("guest", false);
    }

    if (movingSelectedPiece && arrowOverlay) {
      drawMoveArrowShaft(arrowOverlay.track, arrowOverlay.mover);
      drawMoveArrowHead(arrowOverlay.track, arrowOverlay.mover);
      drawTrackDie(arrowOverlay.track[0], arrowOverlay.roll, arrowOverlay.mover);
    }

    if (lastState && lastState.disks) {
      drawRoleDisks("host", true);
      drawRoleDisks("guest", true);
    }

    if (!movingSelectedPiece && arrowOverlay) {
      drawMoveArrowShaft(arrowOverlay.track, arrowOverlay.mover);
      drawMoveArrowHead(arrowOverlay.track, arrowOverlay.mover);
      drawTrackDie(arrowOverlay.track[0], arrowOverlay.roll, arrowOverlay.mover);
    }

    if (illegalOverlay && Array.isArray(illegalOverlay.track)) {
      drawIllegalX(illegalOverlay.track);
    }
  }

  function getMoveOverlay(data, previousState) {
    const hasPath = Array.isArray(data.path) && data.path.length > 0;
    const hasRoll = typeof data.roll === "number" && data.roll >= 1 && data.roll <= 6;
    const hasMover = data.last_mover === "host" || data.last_mover === "guest";
    const hasPiece = Number.isInteger(data.moved_piece);
    if (!hasPath || !hasRoll || !hasMover || !hasPiece) return null;

    const origin = isCell(data.move_from)
      ? data.move_from
      : pieceCell(previousState, data.last_mover, data.moved_piece);
    if (!origin) return null;

    return {
      mover: data.last_mover,
      piece: data.moved_piece,
      roll: data.roll,
      track: [origin].concat(data.path.filter(isCell)),
    };
  }

  function currentStatusText() {
    if (Date.now() < transientStatusUntil && transientStatusText) {
      return transientStatusText;
    }
    transientStatusText = "";

    if (!lastState) {
      return "Connecting…";
    }
    if (lastState.status === "waiting") {
      return "Waiting for an opponent to join…";
    }
    if (lastState.status === "over") {
      return "Game over";
    }
    if (lastState.phase === "select") {
      if (lastState.turn === myRole) {
        return Number.isInteger(selectedPiece)
          ? "Piece selected. Confirm to move."
          : "Select a piece to move.";
      }
      return "Opponent is choosing a piece...";
    }
    return lastState.turn === myRole ? "Your turn" : "Opponent's turn";
  }

  function updateStatus() {
    statusEl.textContent = currentStatusText();

    const canPlay =
      !!lastState &&
      lastState.status === "playing" &&
      lastState.turn === myRole;
    const inSelectPhase =
      !!lastState &&
      lastState.status === "playing" &&
      lastState.phase === "select";
    const selecting = canPlay && inSelectPhase;
    const selectingMineNoPick = waitingToSelectPiece();
    const selectingOpponent = waitingForOpponentToSelectPiece();
    const showRollIndicator =
      inSelectPhase &&
      typeof lastState.roll === "number" &&
      lastState.roll >= 1 &&
      lastState.roll <= 6 &&
      !!lastState.turn;

    const cycleRollIndicator =
      !!lastState &&
      lastState.status === "playing" &&
      lastState.phase === "roll" &&
      !!lastState.turn &&
      !isDieRolling();

    if (cycleRollIndicator) {
      if (rollCycleTimer === null) {
        startRollCycle(lastState.turn);
      }
    } else if (showRollIndicator) {
      stopRollCycle();
      setTurnRollIndicator(lastState.roll, lastState.turn);
    } else {
      stopRollCycle();
      hideTurnRollIndicator();
    }

    if (!canPlay) {
      turnBtn.disabled = true;
    } else if (selecting) {
      turnBtn.disabled = inputLocked || !Number.isInteger(selectedPiece);
    } else {
      turnBtn.disabled = inputLocked;
    }

    if (selectingOpponent) {
      setTurnButtonText("Wait");
    } else if (selectingMineNoPick) {
      setTurnButtonText("Pick");
    } else if (selecting) {
      setTurnButtonText("Confirm");
    } else {
      setTurnButtonText(turnBtn.disabled ? "Rolling" : "Roll Die");
    }

    resignBtn.disabled = !lastState || lastState.status !== "playing" || inputLocked;
    canvas.classList.toggle("board--selectable", canSelectPieces());
    syncSelectableFlashLoop();
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

  function setDieColor(role) {
    if (!dieEl) return;
    dieEl.classList.remove("die--red", "die--blue");
    if (role === "host") {
      dieEl.classList.add("die--red");
    } else if (role === "guest") {
      dieEl.classList.add("die--blue");
    }
  }

  function isDieRolling() {
    return !!dieEl && dieEl.classList.contains("die--rolling-geometry");
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
    stopRollCycle();
    hideTurnRollIndicator();

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

  function hopPiece(role, pieceIndex, path, onDone, applyToken, stepMs, settleMs) {
    const hops = Array.isArray(path) ? path.filter(isCell) : [];
    if (hops.length === 0) {
      if (onDone) onDone();
      return;
    }

    const baseStart = pieceCell(lastState, role, pieceIndex);
    const startPos = isCell(baseStart) ? baseStart : hops[0];
    const points = [startPos].concat(hops);
    const segmentCount = Math.max(1, points.length - 1);
    const durationMs = Math.max(stepMs * segmentCount, 180);
    const startTime = performance.now();

    function easeInOutCubic(t) {
      if (t < 0.5) {
        return 4 * t * t * t;
      }
      return 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    function frame(now) {
      if (applyToken !== stateApplyToken) {
        return;
      }

      const elapsed = now - startTime;
      const rawT = Math.min(1, Math.max(0, elapsed / durationMs));
      const easedT = easeInOutCubic(rawT);
      const pathT = easedT * segmentCount;
      const segment = Math.min(segmentCount - 1, Math.floor(pathT));
      const localT = Math.min(1, pathT - segment);

      const a = points[segment];
      const b = points[segment + 1];
      const pos = [
        a[0] + (b[0] - a[0]) * localT,
        a[1] + (b[1] - a[1]) * localT,
      ];

      hopPos = { role: role, pieceIndex: pieceIndex, pos: pos };
      drawBoard();

      if (rawT >= 1) {
        hopPos = {
          role: role,
          pieceIndex: pieceIndex,
          pos: points[points.length - 1],
        };
        drawBoard();
        setTimeout(function () {
          if (applyToken !== stateApplyToken) {
            return;
          }
          if (onDone) onDone();
        }, settleMs);
        return;
      }

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }

  function previewRebound(role, pieceIndex, path, onDone, applyToken) {
    const origin = pieceCell(lastState, role, pieceIndex);
    const forward = Array.isArray(path) ? path.filter(isCell) : [];
    if (!isCell(origin) || forward.length === 0) {
      if (onDone) onDone();
      return;
    }

    const reverse = forward.slice().reverse();
    const reboundPath = forward.concat(reverse, [origin]);
    illegalOverlay = { track: [origin].concat(forward) };
    hopPiece(
      role,
      pieceIndex,
      reboundPath,
      function () {
        if (applyToken !== stateApplyToken) {
          return;
        }
        illegalOverlay = null;
        hopPos = null;
        if (onDone) onDone();
      },
      applyToken,
      110,
      70
    );
  }

  function eventToCanonicalCell(event) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;

    const x = (event.clientX - rect.left) * (canvas.width / rect.width);
    const y = (event.clientY - rect.top) * (canvas.height / rect.height);
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) {
      return null;
    }

    const localCol = Math.floor(x / CELL);
    const localRow = Math.floor(y / CELL);
    return toCanonical(localRow, localCol);
  }

  function eventToCanvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  function eventHitsTrackDie(event) {
    const overlay = currentArrowOverlay();
    if (!overlay || !Array.isArray(overlay.track) || !isCell(overlay.track[0])) {
      return false;
    }
    const point = eventToCanvasPoint(event);
    if (!point) return false;
    const center = cellCenter(overlay.track[0]);
    const half = (CELL * 0.52) / 2;
    return (
      point.x >= center.x - half &&
      point.x <= center.x + half &&
      point.y >= center.y - half &&
      point.y <= center.y + half
    );
  }

  function shouldAnimateRoll(data) {
    if (data.status !== "playing") return false;
    if (typeof data.roll !== "number" || data.roll < 1 || data.roll > 6) {
      return false;
    }
    return data.phase === "select" || !!data.no_legal_move;
  }

  function shouldAnimateOpponentMove(data, previousState) {
    if (data.status !== "playing" || data.phase !== "roll") return false;
    if (data.last_mover !== "host" && data.last_mover !== "guest") return false;
    if (data.last_mover === myRole) return false;
    if (!Number.isInteger(data.moved_piece)) return false;
    if (!Array.isArray(data.path) || data.path.length === 0) return false;

    const before = pieceCell(previousState, data.last_mover, data.moved_piece);
    const after = pieceCell(data, data.last_mover, data.moved_piece);
    if (!isCell(before) || !isCell(after)) return false;
    return !sameCell(before, after);
  }

  function handleState(data) {
    const incomingVersion =
      typeof data.version === "number"
        ? data.version
        : latestStateVersion + 1;
    if (incomingVersion < latestStateVersion) {
      return;
    }

    latestStateVersion = incomingVersion;
    const applyToken = ++stateApplyToken;
    const previousState = lastState;

    clearSelection();

    const moveOverlay = getMoveOverlay(data, previousState);
    if (moveOverlay) {
      lastMove = moveOverlay;
    } else if (!data.last_mover) {
      lastMove = null;
    }

    if (shouldAnimateRoll(data)) {
      inputLocked = true;
      lastState = previousState || data;
      statusEl.textContent = "Rolling die...";
      turnBtn.disabled = true;
      resignBtn.disabled = true;
      setDieColor(data.turn);

      animateRoll(data.roll, function () {
        if (applyToken !== stateApplyToken) {
          return;
        }
        inputLocked = false;
        hopPos = null;
        lastState = data;
        hideDie();
        if (data.no_legal_move) {
          setTransientStatus("No legal move. Turn passed.", 1600);
        }
        drawBoard();
        updateStatus();
      });
      return;
    }

    if (shouldAnimateOpponentMove(data, previousState)) {
      inputLocked = true;
      lastState = previousState || data;
      turnBtn.disabled = true;
      resignBtn.disabled = true;

      hopPiece(
        data.last_mover,
        data.moved_piece,
        data.path,
        function () {
          if (applyToken !== stateApplyToken) {
            return;
          }
          inputLocked = false;
          hopPos = null;
          hideDie();
          lastState = data;
          drawBoard();
          updateStatus();
        },
        applyToken,
        180,
        150
      );
      return;
    }

    inputLocked = false;
    hopPos = null;
    hideDie();
    if (data.no_legal_move) {
      setTransientStatus("No legal move. Turn passed.", 1600);
    }
    lastState = data;
    drawBoard();
    updateStatus();
  }

  function handleBoardClick(event) {
    if (!canSelectPieces()) {
      return;
    }

    // Clicking the track die at the base of the arrow cancels the current
    // selection and returns to the "select a piece" phase.
    if (Number.isInteger(selectedPiece) && eventHitsTrackDie(event)) {
      clearSelection();
      drawBoard();
      updateStatus();
      return;
    }

    const cell = eventToCanonicalCell(event);
    if (!isCell(cell)) {
      return;
    }

    const myDisks = roleDisks(lastState, myRole);
    let piece = -1;
    for (let i = 0; i < myDisks.length; i++) {
      if (sameCell(myDisks[i], cell)) {
        piece = i;
        break;
      }
    }
    if (piece < 0) {
      return;
    }

    const previews = Array.isArray(lastState.previews) ? lastState.previews : [];
    const preview = previews[piece];
    if (!preview || !Array.isArray(preview.path) || preview.path.length === 0) {
      return;
    }

    const applyToken = stateApplyToken;
    if (preview.legal) {
      selectedPiece = piece;
      previewPos = null;
      previewMove = {
        mover: myRole,
        roll: lastState.roll,
        track: [myDisks[piece]].concat(preview.path.filter(isCell)),
      };
      illegalOverlay = null;
      hopPos = null;
      inputLocked = true;
      drawBoard();
      updateStatus();

      hopPiece(
        myRole,
        piece,
        preview.path,
        function () {
          if (applyToken !== stateApplyToken) {
            return;
          }
          inputLocked = false;
          hopPos = null;
          previewPos = {
            role: myRole,
            pieceIndex: piece,
            pos: preview.path[preview.path.length - 1],
          };
          drawBoard();
          updateStatus();
        },
        applyToken,
        160,
        110
      );
      return;
    }

    // User-requested behavior: illegal click clears any prior valid selection.
    clearSelection();
    inputLocked = true;
    drawBoard();
    updateStatus();

    previewRebound(
      myRole,
      piece,
      preview.path,
      function () {
        if (applyToken !== stateApplyToken) {
          return;
        }
        inputLocked = false;
        drawBoard();
        updateStatus();
      },
      applyToken
    );
  }

  function handleMessage(data) {
    switch (data.type) {
      case "welcome":
        myRole = data.role;
        clearSelection();
        lastMove = null;
        drawBoard();
        updateStatus();
        break;
      case "state":
        handleState(data);
        break;
      case "game_over":
        clearSelection();
        inputLocked = false;
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

  function send(payload) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  turnBtn.addEventListener("click", function () {
    if (turnBtn.disabled || inputLocked || !lastState) {
      return;
    }
    if (lastState.status !== "playing" || lastState.turn !== myRole) {
      return;
    }

    if (lastState.phase === "roll") {
      if (!send({ action: "roll_die" })) {
        return;
      }
      inputLocked = true;
      turnBtn.disabled = true;
      resignBtn.disabled = true;
      statusEl.textContent = "Rolling die...";
      return;
    }

    if (lastState.phase === "select" && Number.isInteger(selectedPiece)) {
      if (!send({ action: "confirm_move", piece: selectedPiece })) {
        return;
      }
      inputLocked = true;
      turnBtn.disabled = true;
      resignBtn.disabled = true;
      statusEl.textContent = "Confirming move...";
    }
  });

  resignBtn.addEventListener("click", function () {
    send({ action: "resign" });
  });

  canvas.addEventListener("click", handleBoardClick);

  drawBoard();
  connect();
})();
