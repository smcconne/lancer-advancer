// Game room: render the board from this player's perspective and drive turns.
(function () {
  "use strict";

  const COLORS = {
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
  };
  const COLS = 6;
  const ROWS = 4;
  const CELL = 80; // canvas is 480x320 in its own coordinate space
  const LOGICAL_W = COLS * CELL; // 480 logical drawing units wide
  const LOGICAL_H = ROWS * CELL; // 320 logical drawing units tall

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

  // Server-update detection: the build id this page was served with. If the
  // live socket ever reports a different one the server was redeployed, so we
  // leave the game, return to the lobby, and reload fresh assets.
  const pageBuildId = window.SERVER_BUILD_ID || "";
  const HEARTBEAT_MS = 15000;
  const MAX_RECONNECT = 40; // ~60s of retries to ride out a deploy
  let updating = false;
  let terminal = false; // server closed us deliberately (error / game over)
  let reconnectAttempts = 0;
  let lastPingAt = Date.now();
  let watchdogTimer = null;

  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d");

  // Match the canvas backing store to the displayed size times the device
  // pixel ratio so drawing stays crisp on Hi-DPI screens. The drawing code
  // keeps working in the fixed 480x320 logical space via a context transform.
  function resizeCanvasForDPR() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const cssW = rect.width || LOGICAL_W;
    const cssH = rect.height || LOGICAL_H;
    const backingW = Math.max(1, Math.round(cssW * dpr));
    const backingH = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== backingW || canvas.height !== backingH) {
      canvas.width = backingW;
      canvas.height = backingH;
    }
    ctx.setTransform(
      backingW / LOGICAL_W,
      0,
      0,
      backingH / LOGICAL_H,
      0,
      0
    );
  }

  // Rasterize and tint artwork without disturbing original alpha edges.
  // The SVG is rasterized into a supersampled offscreen canvas so edges stay
  // smooth when scaled onto the board, and "source-atop" recolors every
  // covered pixel to the requested color while leaving antialiasing intact.
  function makeSilhouette(img, color) {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return null;
    const dpr = window.devicePixelRatio || 1;
    const maxDim = 1024;
    let scale = dpr * 4;
    if (w * scale > maxDim || h * scale > maxDim) {
      scale = Math.min(maxDim / w, maxDim / h);
    }
    scale = Math.max(scale, 1);
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const c = canvas.getContext("2d");
    if (!c) return null;
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = "high";
    c.drawImage(img, 0, 0, cw, ch);
    c.globalCompositeOperation = "source-atop";
    c.fillStyle = color || "#000";
    c.fillRect(0, 0, cw, ch);
    return canvas;
  }

  // Decorative jousting-lance background drawn over each player's side.
  let lanceBgReady = false;
  let lanceBgBlackCanvas = null;
  const lanceBgImg = new Image();
  lanceBgImg.onload = function () {
    lanceBgBlackCanvas = makeSilhouette(lanceBgImg);
    lanceBgReady = true;
    drawBoard();
  };
  if (window.LANCE_BG_URL) {
    lanceBgImg.src = window.LANCE_BG_URL;
  }

  let helmetBgReady = false;
  let helmetBgBlackCanvas = null;
  const helmetBgImg = new Image();
  helmetBgImg.onload = function () {
    helmetBgBlackCanvas = makeSilhouette(helmetBgImg);
    helmetBgReady = true;
    drawBoard();
  };
  if (window.HELMET_BG_URL) {
    helmetBgImg.src = window.HELMET_BG_URL;
  }

  let checkBgReady = false;
  let checkBgBlackCanvas = null;
  const checkBgImg = new Image();
  checkBgImg.onload = function () {
    checkBgBlackCanvas = makeSilhouette(checkBgImg);
    checkBgReady = true;
    drawBoard();
  };
  if (window.CHECK_BG_URL) {
    checkBgImg.src = window.CHECK_BG_URL;
  }

  // Piece icon variants by orientation (up/down) and owner color (dark/white).
  let knightUpDarkCanvas = null;
  let knightUpWhiteCanvas = null;
  const knightUpImg = new Image();
  knightUpImg.onload = function () {
    knightUpDarkCanvas = makeSilhouette(knightUpImg, COLORS.diskOutline);
    knightUpWhiteCanvas = makeSilhouette(knightUpImg, COLORS.diskGuestOutline);
    drawBoard();
  };
  if (window.KNIGHT_LANCE_UP_URL) {
    knightUpImg.src = window.KNIGHT_LANCE_UP_URL;
  }

  let knightDownDarkCanvas = null;
  let knightDownWhiteCanvas = null;
  const knightDownImg = new Image();
  knightDownImg.onload = function () {
    knightDownDarkCanvas = makeSilhouette(knightDownImg, COLORS.diskOutline);
    knightDownWhiteCanvas = makeSilhouette(knightDownImg, COLORS.diskGuestOutline);
    drawBoard();
  };
  if (window.KNIGHT_LANCE_DOWN_URL) {
    knightDownImg.src = window.KNIGHT_LANCE_DOWN_URL;
  }
  const statusEl = document.getElementById("status");
  const turnBtn = document.getElementById("turn-btn");
  const passBtn = document.getElementById("pass-btn");
  const resignBtn = document.getElementById("resign-btn");
  const diceTray = document.getElementById("dice-tray");
  const diceEls = [
    document.getElementById("turn-roll-indicator"),
    document.getElementById("turn-roll-indicator-2"),
  ];
  // Backwards-compatible alias for the first die.
  let turnRollIndicatorEl = diceEls[0];
  const dieEl = document.getElementById("die");
  const dieCubeEl = dieEl ? dieEl.querySelector(".die__cube") : null;
  // Second 3D die: cloned from the first so both can roll together.
  let die2El = null;
  let die2CubeEl = null;
  if (dieEl && dieEl.parentElement) {
    die2El = dieEl.cloneNode(true);
    die2El.id = "die-2";
    dieEl.parentElement.appendChild(die2El);
    die2CubeEl = die2El.querySelector(".die__cube");
  }
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
  let stagedPieces = []; // [piece, ...] mirrors lastState.staged for highlight
  let illegalOverlay = null; // { track }
  let lastMove = null;
  let lastFirstMove = null; // grey arrow for opponent's first of two moves
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
  let rollCycleRole = null;
  let dragState = null; // { dieIndex, fromPiece, ghost, pointerId }
  let boardDragStarted = false; // suppress the click after a board die-face drag

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
    2: [[2, 0], [0, 2]],
    3: [[2, 0], [1, 1], [0, 2]],
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
    stagedPieces = [];
    previewPos = null;
    previewMove = null;
    illegalOverlay = null;
  }

  function dieOf(piece) {
    // Index of the staged die assigned to a piece, or -1 if unassigned.
    if (!lastState || !Array.isArray(lastState.staged)) return -1;
    for (let i = 0; i < lastState.staged.length; i++) {
      if (lastState.staged[i][0] === piece) return lastState.staged[i][1];
    }
    return -1;
  }

  function isPieceStaged(piece) {
    return dieOf(piece) !== -1;
  }

  function stagedDieMap(state) {
    const out = {};
    if (state && Array.isArray(state.staged)) {
      state.staged.forEach(function (s) { out[s[0]] = s[1]; });
    }
    return out;
  }

  function newlyStagedPiece(data, previousState) {
    if (!data || data.phase !== "select") return -1;
    if (!Array.isArray(data.staged)) return -1;
    const before = stagedDieMap(previousState);
    for (let i = 0; i < data.staged.length; i++) {
      const p = data.staged[i][0];
      const die = data.staged[i][1];
      // Animate a piece that was just staged or had its die replaced.
      if (before[p] === undefined || before[p] !== die) return p;
    }
    return -1;
  }

  function pieceDiceOptions(piece) {
    const previews = lastState && Array.isArray(lastState.previews)
      ? lastState.previews
      : [];
    const entry = previews[piece];
    return entry && Array.isArray(entry.dice) ? entry.dice : [];
  }

  function dieValue(dieIndex) {
    const dice = lastState && Array.isArray(lastState.dice) ? lastState.dice : null;
    return dice && dieIndex >= 0 && dieIndex < dice.length ? dice[dieIndex] : null;
  }

  function stagedTrackFor(piece, role) {
    const mover = role || myRole;
    const die = dieOf(piece);
    if (die === -1) return null;
    const opt = pieceDiceOptions(piece)[die];
    if (!opt || !Array.isArray(opt.path)) return null;
    const origin = pieceCell(lastState, mover, piece);
    if (!isCell(origin)) return null;
    return {
      mover: mover,
      piece: piece,
      roll: dieValue(die),
      track: [origin].concat(opt.path.filter(isCell)),
    };
  }

  function currentArrowOverlay() {
    // Show the most recent committed move when not actively assigning dice.
    if (lastMove && Array.isArray(lastMove.track) && lastMove.track.length > 1) {
      return lastMove;
    }
    return null;
  }

  function selectingRole() {
    // The role currently assigning dice, whether it's us or the opponent.
    // Independent of inputLocked so staged arrows show during the hop
    // animation of our own newly assigned piece, just like the opponent's.
    if (
      !lastState ||
      lastState.status !== "playing" ||
      lastState.phase !== "select"
    ) {
      return null;
    }
    return lastState.turn === "host" || lastState.turn === "guest"
      ? lastState.turn
      : null;
  }

  function stagedArrowOverlays() {
    const role = selectingRole();
    if (!role) return [];
    if (!lastState || !Array.isArray(lastState.staged)) return [];
    const overlays = [];
    for (let i = 0; i < lastState.staged.length; i++) {
      const track = stagedTrackFor(lastState.staged[i][0], role);
      if (track) overlays.push(track);
    }
    return overlays;
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
    return canSelectPieces() && lastState && lastState.can_confirm;
  }

  function waitingToSelectPiece() {
    return canSelectPieces() && lastState && !lastState.can_confirm;
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

  function waitingForOpponentToRollDice() {
    return (
      !!lastState &&
      lastState.status === "playing" &&
      lastState.phase === "roll" &&
      (myRole === "host" || myRole === "guest") &&
      lastState.turn !== myRole
    );
  }

  function flashingSelectableStroke(guestPiece) {
    // Smoothly blend between established highlight and outline colors.
    const t = Date.now() / 1000;
    const mix = (Math.sin(t * Math.PI * 2) + 1) / 2;
    const start = { r: 56, g: 189, b: 248 }; // COLORS.youRing
    const end = guestPiece
      ? { r: 255, g: 255, b: 255 } // white guest-piece outline
      : { r: 0, g: 0, b: 0 }; // black host-piece outline
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

  function renderDie(el, roll, role) {
    if (!el) return;
    const classes = DIE_DOT_CLASSES[roll];
    if (!classes) {
      el.classList.add("hidden");
      el.classList.remove("die--red", "die--blue", "die--staged", "die--draggable");
      el.setAttribute("aria-hidden", "true");
      el.replaceChildren();
      return;
    }
    el.classList.remove("hidden", "die--red", "die--blue");
    el.classList.add(role === "host" ? "die--red" : "die--blue");
    el.setAttribute("aria-hidden", "false");
    el.replaceChildren();
    classes.forEach(function (dotClasses) {
      const dot = document.createElement("span");
      dot.className = "dot " + dotClasses;
      el.appendChild(dot);
    });
  }

  function hideDieFace(idx) {
    renderDie(diceEls[idx], null, null);
  }

  function hideTurnRollIndicator() {
    hideDieFace(0);
    hideDieFace(1);
  }

  // Render both dice from the current state, marking assigned/draggable dice.
  function renderDice() {
    const dice = lastState && Array.isArray(lastState.dice) ? lastState.dice : null;
    if (!dice || lastState.phase !== "select") {
      hideTurnRollIndicator();
      return;
    }
    const staged = Array.isArray(lastState.staged) ? lastState.staged : [];
    const stagedDice = staged.map(function (s) { return s[1]; });
    for (let i = 0; i < diceEls.length; i++) {
      const el = diceEls[i];
      renderDie(el, dice[i], lastState.turn);
      const assigned = stagedDice.indexOf(i) !== -1;
      el.classList.toggle("die--staged", assigned);
      const mine = lastState.turn === myRole && !inputLocked;
      el.classList.toggle("die--draggable", mine);
      el.dataset.dieIndex = String(i);
    }
  }

  function setTurnRollIndicator() {
    renderDice();
  }

  function stopRollCycle() {
    if (rollCycleTimer !== null) {
      clearInterval(rollCycleTimer);
      rollCycleTimer = null;
    }
    rollCycleRole = null;
  }

  function startRollCycle(role) {
    rollCycleRole = role;
    const showRandomFaces = function () {
      renderDie(diceEls[0], Math.floor(Math.random() * 6) + 1, role);
      renderDie(diceEls[1], Math.floor(Math.random() * 6) + 1, role);
    };
    showRandomFaces();
    if (rollCycleTimer !== null) {
      clearInterval(rollCycleTimer);
    }
    rollCycleTimer = setInterval(showRandomFaces, 150);
  }

  function arrowTrackPoints(track) {
    return track.filter(isCell).map(cellCenter);
  }

  function drawMoveArrowShaft(track, mover, opts) {
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

    const grey = !!(opts && opts.grey);
    const moverStroke = grey ? "#9ca3af" : moverColor(mover);
    const strokeLayers = grey
      ? [
          { width: 16, color: "#6b7280" },
          { width: 12, color: "#9ca3af" },
        ]
      : [
          { width: 20, color: "#0b1220" },
          { width: 16, color: "#ffffff" },
          { width: 12, color: moverStroke },
        ];

    ctx.save();
    if (grey) ctx.globalAlpha = 0.4;
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

  function drawMoveArrowHead(track, mover, opts) {
    const points = track.filter(isCell).map(cellCenter);
    if (points.length < 2) return;
    const grey = !!(opts && opts.grey);

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
    const moverStroke = grey ? "#9ca3af" : moverColor(mover);
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
    if (grey) ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(leftX, leftY);
    ctx.lineTo(rightX, rightY);
    ctx.closePath();
    ctx.fillStyle = moverStroke;
    ctx.fill();

    (grey
      ? [{ width: 6, color: "#6b7280" }]
      : [
          { width: 9, color: "#0b1220" },
          { width: 4.5, color: "#ffffff" },
        ]
    ).forEach(function (layer) {
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

  function drawTrackDie(origin, value, mover, opts) {
    if (!isCell(origin) || typeof value !== "number" || !PIP_LAYOUT[value]) return;

    const grey = !!(opts && opts.grey);
    const center = cellCenter(origin);
    const size = CELL * 0.52;
    const x = center.x - size / 2;
    const y = center.y - size / 2;
    const radius = size * 0.18;

    ctx.save();
    if (grey) ctx.globalAlpha = 0.4;
    roundedRectPath(x, y, size, size, radius);
    ctx.fillStyle = grey ? "#9ca3af" : moverColor(mover);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = grey ? "#6b7280" : "#0b1220";
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

  function mirrorSignForCell(pos) {
    if (!isCell(pos)) return 1;
    const local = toLocal(pos[0], pos[1]);
    const lr = local[0];
    return lr === 0 || lr === 2 ? -1 : 1;
  }

  function iconDownForCell(pos) {
    if (!isCell(pos)) return false;
    const local = toLocal(pos[0], pos[1]);
    const lr = local[0];
    return lr === 0 || lr === ROWS - 1;
  }

  function computeFlipMeta(points, isPromotion) {
    if (!Array.isArray(points) || points.length < 2) return null;
    const cells = points.filter(isCell);
    if (cells.length < 2) return null;

    const origin = cells[0];
    const dest = cells[cells.length - 1];
    let pCross = null;
    for (let i = 0; i < cells.length - 1; i++) {
      if (mirrorSignForCell(cells[i]) !== mirrorSignForCell(cells[i + 1])) {
        pCross = i + 0.5;
        break;
      }
    }

    return {
      pCross: pCross,
      endProgress: cells.length - 1,
      originSign: mirrorSignForCell(origin),
      destSign: mirrorSignForCell(dest),
      originDown: iconDownForCell(origin),
      destDown: iconDownForCell(dest),
      isPromotion: !!isPromotion,
    };
  }

  function drawDisk(pos, who, opts) {
    if (!isCell(pos)) return;
    const [lr, lc] = toLocal(pos[0], pos[1]);
    const cx = lc * CELL + CELL / 2;
    const cy = lr * CELL + CELL / 2;
    const radius = CELL * 0.32;

    const selected = !!(opts && opts.selected);
    const movedLast = !!(opts && opts.movedLast);
    const flashOutline = !!(opts && opts.flashOutline);
    const moving = !!(opts && opts.moving);
    const promoted = !!(opts && opts.promoted);
    const guestPiece = who === "guest";
    const fill = promoted
      ? (who === "guest" ? COLORS.promotedBlue : COLORS.promotedRed)
      : guestPiece
        ? COLORS.diskGuest
        : COLORS.disk;
    const baseStroke = guestPiece ? COLORS.diskGuestOutline : COLORS.diskOutline;

    let useDownIcon = lr === 0 || lr === ROWS - 1;
    let iconScaleX = lr === 0 || lr === 2 ? -1 : 1;
    let flipActive = false;
    const flip = opts && opts.flip;
    const flipProgress = opts && typeof opts.flipProgress === "number"
      ? opts.flipProgress
      : 0;
    if (moving && flip) {
      const endProgress = Math.max(0, Number(flip.endProgress) || 0);
      const progress = clamp(flipProgress, 0, endProgress);
      const originSign = Number(flip.originSign) || 1;
      const destSign = Number(flip.destSign) || originSign;
      const originDown = !!flip.originDown;
      const destDown = !!flip.destDown;
      const pCross =
        typeof flip.pCross === "number" && Number.isFinite(flip.pCross)
          ? flip.pCross
          : null;

      if (pCross === null || pCross <= 0 || pCross >= endProgress) {
        iconScaleX = originSign;
        useDownIcon = originDown;
      } else {
        flipActive = true;
        useDownIcon = progress < pCross ? originDown : destDown;
        if (progress <= pCross) {
          const t = clamp(progress / pCross, 0, 1);
          iconScaleX = originSign * (1 - t);
        } else {
          const tail = endProgress - pCross;
          const t = clamp((progress - pCross) / tail, 0, 1);
          iconScaleX = destSign * t;
        }
      }
    }

    // While a flip is running the whole disk collapses horizontally with the
    // icon, passing through a vertical light-blue line at the midpoint.
    const radiusX = flipActive ? radius * Math.abs(iconScaleX) : radius;
    const stroke = flipActive
      ? COLORS.youRing
      : flashOutline
        ? flashingSelectableStroke(guestPiece)
        : selected
          ? COLORS.youRing
        : movedLast
          ? COLORS.youRing
          : baseStroke;

    ctx.beginPath();
    ctx.ellipse(cx, cy, radiusX, radius, 0, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();

    const iconCanvas = guestPiece
      ? (useDownIcon ? knightDownWhiteCanvas : knightUpWhiteCanvas)
      : (useDownIcon ? knightDownDarkCanvas : knightUpDarkCanvas);
    if (iconCanvas && iconScaleX !== 0) {
      const iconSize = CELL * 0.7;
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(cx, cy, radiusX, radius, 0, 0, Math.PI * 2);
      ctx.clip();
      ctx.translate(cx, 0);
      ctx.scale(iconScaleX, 1);
      ctx.translate(-cx, 0);
      ctx.drawImage(
        iconCanvas,
        cx - iconSize / 2,
        cy - iconSize / 2,
        iconSize,
        iconSize
      );
      ctx.restore();
    }

    ctx.beginPath();
    ctx.ellipse(cx, cy, radiusX, radius, 0, 0, Math.PI * 2);
    ctx.lineWidth = 4;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }

  function isPieceSelected(role, piece) {
    // Staged entries always belong to the role currently assigning dice.
    return role === selectingRole() && isPieceStaged(piece);
  }

  function isPiecePromoted(role, piece) {
    // Committed promotions from the server, plus a live preview: a staged
    // piece shows as promoted while its assigned die's path crosses the
    // threshold (reverting to white if the die is taken back).
    if (
      lastState &&
      lastState.promoted &&
      Array.isArray(lastState.promoted[role]) &&
      lastState.promoted[role][piece]
    ) {
      return true;
    }
    if (role === selectingRole() && isPieceStaged(piece)) {
      const opt = pieceDiceOptions(piece)[dieOf(piece)];
      if (opt && opt.promotes) {
        if (
          hopPos &&
          hopPos.role === role &&
          hopPos.pieceIndex === piece &&
          typeof hopPos.progress === "number" &&
          Number.isInteger(opt.promotes_at)
        ) {
          // While the hop animation runs, stay white until the piece
          // physically crosses the boundary into the threshold cell:
          // path index promotes_at is reached at progress promotes_at + 1,
          // and the cell boundary sits half a segment before that.
          return hopPos.progress >= opt.promotes_at + 0.5;
        }
        return true;
      }
    }
    return false;
  }

  function drawRoleDisks(role, selectedOnly, skipMovingPiece) {
    const disks = roleDisks(lastState, role);
    for (let piece = 0; piece < disks.length; piece++) {
      const basePos = disks[piece];
      if (!isCell(basePos)) continue;

      const moving =
        !!hopPos &&
        hopPos.role === role &&
        hopPos.pieceIndex === piece;
      if (skipMovingPiece && moving) continue;

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
      } else if (role === selectingRole() && isPieceStaged(piece)) {
        // A staged piece sits at the destination of its assigned die.
        const ov = stagedTrackFor(piece, role);
        if (ov && ov.track.length) drawPos = ov.track[ov.track.length - 1];
      }

      const movedLast =
        !!lastState &&
        lastState.last_mover === role &&
        (lastState.moved_piece === piece ||
          (Number.isInteger(lastState.first_moved_piece) &&
            lastState.first_moved_piece === piece)) &&
        !waitingForOpponentToSelectPiece();
      const opponentSelecting =
        waitingForOpponentToSelectPiece() &&
        role !== myRole;
      const flashOutline =
        (opponentSelecting && !selected) ||
        (role === myRole &&
          canSelectPieces() &&
          !isPieceStaged(piece));
      drawDisk(drawPos, role, {
        selected: selected,
        movedLast: movedLast,
        flashOutline: flashOutline,
        moving: moving,
        promoted: isPiecePromoted(role, piece),
      });
    }
  }

  function drawMovingDiskOnTop() {
    if (!hopPos || !lastState || !lastState.disks) return;
    const role = hopPos.role;
    const piece = hopPos.pieceIndex;
    const disks = roleDisks(lastState, role);
    const basePos = disks[piece];
    if (!isCell(basePos)) return;

    let drawPos = basePos;
    if (isCell(hopPos.pos)) {
      drawPos = hopPos.pos;
    }

    const selected = isPieceSelected(role, piece);
    const movedLast =
      !!lastState &&
      lastState.last_mover === role &&
      (lastState.moved_piece === piece ||
        (Number.isInteger(lastState.first_moved_piece) &&
          lastState.first_moved_piece === piece)) &&
      !waitingForOpponentToSelectPiece();
    const opponentSelecting =
      waitingForOpponentToSelectPiece() &&
      role !== myRole;
    const flashOutline =
      (opponentSelecting && !selected) ||
      (role === myRole &&
        canSelectPieces() &&
        !isPieceStaged(piece));

    let promoted = isPiecePromoted(role, piece);
    if (
      hopPos.flip &&
      hopPos.flip.isPromotion &&
      typeof hopPos.flip.pCross === "number" &&
      typeof hopPos.progress === "number"
    ) {
      promoted = hopPos.progress >= hopPos.flip.pCross;
    }

    drawDisk(drawPos, role, {
      selected: selected,
      movedLast: movedLast,
      flashOutline: flashOutline,
      moving: true,
      promoted: promoted,
      flip: hopPos.flip,
      flipProgress: hopPos.progress,
    });
  }

  // Draws transparent jousting-lance images, rotated, over each player's half:
  // one centered on the bottom row's left 4 cells (cols 0-3) and one on the top
  // row's right 4 cells (cols 2-5). Top half: rows 0/1, bottom half: rows 2/3.
  function drawLanceBackground() {
    if (!lanceBgReady || !lanceBgImg.naturalWidth) return;

    const source = lanceBgBlackCanvas || lanceBgImg;
    const sourceW = lanceBgBlackCanvas
      ? lanceBgBlackCanvas.width
      : lanceBgImg.naturalWidth;
    const sourceH = lanceBgBlackCanvas
      ? lanceBgBlackCanvas.height
      : lanceBgImg.naturalHeight;
    const aspect = sourceW / sourceH;
    const spanCells = 4;
    const drawW = spanCells * CELL * 0.7; // span the 4-cell width
    const drawH = drawW / aspect;
    const leftCx = (spanCells / 2) * CELL; // centered over cols 0-3
    const rightCx = (COLS - spanCells / 2) * CELL; // centered over cols 2-5
    const angle = (172 * Math.PI) / 180;

    const placements = [
      { cx: leftCx, cy: 1.5 * CELL, extraRotation: 0 }, // top half, bottom row (row 1)
      { cx: leftCx, cy: (ROWS - 0.5) * CELL, extraRotation: 0 }, // bottom half, bottom row (row 3)
      { cx: rightCx, cy: 0.5 * CELL, extraRotation: Math.PI }, // top half, top row (row 0)
      { cx: rightCx, cy: (ROWS - 1.5) * CELL, extraRotation: Math.PI }, // bottom half, top row (row 2)
    ];

    placements.forEach(function (p) {
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.translate(p.cx, p.cy);
      ctx.rotate(angle + p.extraRotation);
      ctx.drawImage(source, -drawW / 2, -drawH / 2, drawW, drawH);
      ctx.restore();
    });
  }

  function drawHelmetBackground() {
    if (!helmetBgReady || !helmetBgImg.naturalWidth) return;

    const source = helmetBgBlackCanvas || helmetBgImg;

    const drawSize = CELL * 0.60;
    const boardCenterY = (ROWS * CELL) / 2;
    const centerShift = CELL * 0.62;
    const placements = [
      { cx: 0.5 * CELL, cy: (ROWS - 0.5) * CELL, rotation: 0 },
      { cx: (COLS - 0.5) * CELL, cy: 0.5 * CELL, rotation: Math.PI },
    ];

    placements.forEach(function (p) {
      const shiftedCy =
        p.cy < boardCenterY ? p.cy + centerShift : p.cy - centerShift;
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.translate(p.cx, shiftedCy);
      ctx.rotate(p.rotation);
      ctx.drawImage(
        source,
        -drawSize / 2,
        -drawSize / 2,
        drawSize,
        drawSize
      );
      ctx.restore();
    });
  }

  function drawCheckBackground() {
    if (!checkBgReady || !checkBgImg.naturalWidth) return;

    const source = checkBgBlackCanvas || checkBgImg;

    const drawSize = CELL * 0.25;
    const edgeInset = drawSize * 0.25;
    const offsets = [0.08, 0.19, 0.81, 0.92];

    offsets.forEach(function (t) {
      const playerX = t * CELL;
      const playerY = 3 * CELL - edgeInset;

      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.translate(playerX, playerY);
      ctx.drawImage(source, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
      ctx.restore();

      const mirroredT = 1 - t;
      const oppX = (COLS - 1) * CELL + mirroredT * CELL;
      const oppY = 1 * CELL + edgeInset;

      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.translate(oppX, oppY);
      ctx.rotate(Math.PI);
      ctx.drawImage(source, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
      ctx.restore();
    });
  }

  function drawBoard() {
    resizeCanvasForDPR();
    ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);

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

    // Black divider line, 4 cells wide and centered horizontally, drawn
    // between each player's two rows (top player: rows 0/1, bottom: rows 2/3).
    const lineWidthCells = 4;
    const lineStartX = ((COLS - lineWidthCells) / 2) * CELL;
    const lineEndX = lineStartX + lineWidthCells * CELL;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.65)";
    ctx.lineWidth = 4;
    [1, 3].forEach(function (rowBoundary) {
      ctx.beginPath();
      ctx.moveTo(lineStartX, rowBoundary * CELL);
      ctx.lineTo(lineEndX, rowBoundary * CELL);
      ctx.stroke();
    });

    drawLanceBackground();
    drawHelmetBackground();
    drawCheckBackground();

    const arrowOverlay = currentArrowOverlay();
    const staged = stagedArrowOverlays();
    const greyFirst = staged.length >= 2;
    const inRollPreviewState =
      !!lastState &&
      lastState.status === "playing" &&
      lastState.phase === "roll";
    // The opponent's committed first move (of two) is shown greyed beneath
    // the pieces, just like our own staged first move.
    const greyCommitted =
      staged.length === 0 &&
      lastFirstMove &&
      Array.isArray(lastFirstMove.track) &&
      lastFirstMove.track.length > 1
        ? lastFirstMove
        : null;

    // Once a second move is staged, the first move's arrow fades to a
    // transparent grey and is drawn beneath the pieces so the second
    // moved piece layers on top of it.
    if (greyFirst) {
      const first = staged[0];
      drawMoveArrowShaft(first.track, first.mover, { grey: true });
      drawMoveArrowHead(first.track, first.mover, { grey: true });
      drawTrackDie(first.track[0], first.roll, first.mover, { grey: true });
    } else if (greyCommitted) {
      drawMoveArrowShaft(greyCommitted.track, greyCommitted.mover, { grey: true });
      drawMoveArrowHead(greyCommitted.track, greyCommitted.mover, { grey: true });
      drawTrackDie(
        greyCommitted.track[0],
        greyCommitted.roll,
        greyCommitted.mover,
        { grey: true }
      );
    }

    if (inRollPreviewState && staged.length === 0 && arrowOverlay) {
      drawMoveArrowShaft(arrowOverlay.track, arrowOverlay.mover, { grey: true });
      drawMoveArrowHead(arrowOverlay.track, arrowOverlay.mover, { grey: true });
      drawTrackDie(arrowOverlay.track[0], arrowOverlay.roll, arrowOverlay.mover, {
        grey: true,
      });
    }

    if (lastState && lastState.disks) {
      const skipMovingPiece = !!hopPos;
      drawRoleDisks("host", false, skipMovingPiece);
      drawRoleDisks("guest", false, skipMovingPiece);
    }

    if (lastState && lastState.disks) {
      const skipMovingPiece = !!hopPos;
      drawRoleDisks("host", true, skipMovingPiece);
      drawRoleDisks("guest", true, skipMovingPiece);
    }

    // Staged move arrows drawn on top of the pieces. When a second move is
    // staged, the first arrow was already drawn (greyed) beneath the pieces,
    // so only the second arrow is drawn here at full opacity.
    (greyFirst ? staged.slice(1) : staged).forEach(function (ov) {
      drawMoveArrowShaft(ov.track, ov.mover);
      drawMoveArrowHead(ov.track, ov.mover);
      drawTrackDie(ov.track[0], ov.roll, ov.mover);
    });

    if (staged.length === 0 && arrowOverlay && !inRollPreviewState) {
      drawMoveArrowShaft(arrowOverlay.track, arrowOverlay.mover);
      drawMoveArrowHead(arrowOverlay.track, arrowOverlay.mover);
      drawTrackDie(arrowOverlay.track[0], arrowOverlay.roll, arrowOverlay.mover);
    }

    drawMovingDiskOnTop();

    if (illegalOverlay && Array.isArray(illegalOverlay.track)) {
      drawIllegalX(illegalOverlay.track);
    }
  }

  function getMoveOverlay(data, previousState) {
    const hasPath = Array.isArray(data.path) && data.path.length > 0;
    const hasMover = data.last_mover === "host" || data.last_mover === "guest";
    const hasPiece = Number.isInteger(data.moved_piece);
    if (!hasPath || !hasMover || !hasPiece) return null;

    const origin = isCell(data.move_from)
      ? data.move_from
      : pieceCell(previousState, data.last_mover, data.moved_piece);
    if (!origin) return null;

    const cells = data.path.filter(isCell);
    return {
      mover: data.last_mover,
      piece: data.moved_piece,
      roll: cells.length,
      track: [origin].concat(cells),
    };
  }

  function getFirstMoveOverlay(data, previousState) {
    // The opponent's first of two committed moves, shown as a grey arrow.
    const hasPath = Array.isArray(data.first_path) && data.first_path.length > 0;
    const hasMover = data.last_mover === "host" || data.last_mover === "guest";
    const hasPiece = Number.isInteger(data.first_moved_piece);
    if (!hasPath || !hasMover || !hasPiece) return null;

    const origin = isCell(data.first_move_from)
      ? data.first_move_from
      : pieceCell(previousState, data.last_mover, data.first_moved_piece);
    if (!origin) return null;

    const cells = data.first_path.filter(isCell);
    return {
      mover: data.last_mover,
      piece: data.first_moved_piece,
      roll: cells.length,
      track: [origin].concat(cells),
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
        if (lastState.no_legal_move) return "No legal move. Press Pass.";
        return lastState.can_confirm
          ? "Confirm when finished assigning dice."
          : "Drag a die onto a piece to move.";
      }
      return "Opponent is choosing moves...";
    }
    if (lastState.phase === "roll") {
      return lastState.turn === myRole
        ? "Your turn to roll the dice"
        : "Opponent's turn to roll the dice";
    }
    return lastState.turn === myRole ? "Your turn" : "Opponent's turn";
  }

  function updateStatus() {
    statusEl.textContent = currentStatusText();

    const turnRole =
      lastState && lastState.status === "playing" ? lastState.turn : null;
    if (turnRole === "host" || turnRole === "guest") {
      statusEl.style.color = moverColor(turnRole);
    } else {
      statusEl.style.color = "";
    }

    const canPlay =
      !!lastState &&
      lastState.status === "playing" &&
      lastState.turn === myRole;
    const inSelectPhase =
      !!lastState &&
      lastState.status === "playing" &&
      lastState.phase === "select";
    const selecting = canPlay && inSelectPhase;
    const showRollIndicator =
      inSelectPhase && Array.isArray(lastState.dice) && !!lastState.turn;


    const cycleRollIndicator =
      !!lastState &&
      lastState.status === "playing" &&
      lastState.phase === "roll" &&
      (lastState.turn === "host" || lastState.turn === "guest");

    if (cycleRollIndicator) {
      const opponentRolling = lastState.turn !== myRole;
      diceEls.forEach(function (el) {
        if (!el) return;
        el.classList.toggle("die--roll-dim", opponentRolling);
        el.classList.toggle("die--roll-active", !opponentRolling);
      });
      if (rollCycleTimer === null || rollCycleRole !== lastState.turn) {
        startRollCycle(lastState.turn);
      }
    } else if (showRollIndicator) {
      diceEls.forEach(function (el) {
        if (el) el.classList.remove("die--roll-dim", "die--roll-active");
      });
      stopRollCycle();
      renderDice();
    } else {
      diceEls.forEach(function (el) {
        if (el) el.classList.remove("die--roll-dim", "die--roll-active");
      });
      stopRollCycle();
      hideTurnRollIndicator();
    }

    if (!canPlay) {
      turnBtn.disabled = true;
    } else if (selecting) {
      turnBtn.disabled = inputLocked || !lastState.can_confirm;
    } else {
      turnBtn.disabled = inputLocked;
    }

    if (selecting) {
      setTurnButtonText("Confirm");
    } else if (
      waitingForOpponentToSelectPiece() ||
      waitingForOpponentToRollDice()
    ) {
      setTurnButtonText("Their Turn");
    } else {
      setTurnButtonText(turnBtn.disabled && canPlay ? "Rolling" : "Roll Dice");
    }

    // Pass button: always visible, only enabled for active player during
    // selection when passing is allowed.
    const canPass = selecting && !!lastState.can_pass;
    passBtn.disabled = !canPass || inputLocked;

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

  function hopPiece(role, pieceIndex, path, onDone, applyToken, stepMs, settleMs, flipOpts) {
    const hops = Array.isArray(path) ? path.filter(isCell) : [];
    if (hops.length === 0) {
      if (onDone) onDone();
      return;
    }

    const baseStart = pieceCell(lastState, role, pieceIndex);
    const startPos = isCell(baseStart) ? baseStart : hops[0];
    const points = [startPos].concat(hops);
    const flipMeta = computeFlipMeta(points, !!(flipOpts && flipOpts.isPromotion));
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

      hopPos = {
        role: role,
        pieceIndex: pieceIndex,
        pos: pos,
        progress: pathT,
        flip: flipMeta,
      };
      drawBoard();

      if (rawT >= 1) {
        hopPos = {
          role: role,
          pieceIndex: pieceIndex,
          pos: points[points.length - 1],
          progress: segmentCount,
          flip: flipMeta,
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
      70,
      { isPromotion: false }
    );
  }

  function eventToCanonicalCell(event) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;

    const x = (event.clientX - rect.left) * (LOGICAL_W / rect.width);
    const y = (event.clientY - rect.top) * (LOGICAL_H / rect.height);
    if (x < 0 || y < 0 || x >= LOGICAL_W || y >= LOGICAL_H) {
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
      x: (event.clientX - rect.left) * (LOGICAL_W / rect.width),
      y: (event.clientY - rect.top) * (LOGICAL_H / rect.height),
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

  function shouldAnimateRoll(data, previousState) {
    if (data.status !== "playing") return false;
    if (data.phase !== "select") return false;
    if (!Array.isArray(data.dice) || data.dice.length < 2) return false;
    if (Array.isArray(data.staged) && data.staged.length > 0) return false;
    // Only animate the transition from a roll into selection.
    return !previousState || previousState.phase !== "select";
  }

  function setDieColor(role) {
    [dieEl, die2El].forEach(function (el) {
      if (!el) return;
      el.classList.remove("die--red", "die--blue");
      if (role === "host") el.classList.add("die--red");
      else if (role === "guest") el.classList.add("die--blue");
    });
  }

  function showCube(el, cube) {
    if (!el) return;
    el.classList.remove("hidden");
    el.setAttribute("aria-hidden", "false");
    if (cube) {
      cube.style.transition = "none";
      cube.style.transform = "rotateX(0deg) rotateY(0deg)";
    }
  }

  function hideCube(el, cube) {
    if (!el) return;
    el.classList.add("hidden");
    el.classList.remove("die--rolling-geometry");
    el.setAttribute("aria-hidden", "true");
    if (cube) {
      cube.style.transition = "none";
      cube.style.transform = "rotateX(0deg) rotateY(0deg)";
    }
  }

  // Roll both 3D cubes to their target faces, calling onDone once both settle.
  function animate3dDice(dice, role, onDone) {
    setDieColor(role);
    const cubes = [
      { el: dieEl, cube: dieCubeEl, face: dice[0] },
      { el: die2El, cube: die2CubeEl, face: dice[1] },
    ];
    let remaining = cubes.length;
    const finish = function () {
      remaining -= 1;
      if (remaining <= 0 && onDone) onDone();
    };
    const reduce = reduceMotionQuery ? reduceMotionQuery.matches : false;
    cubes.forEach(function (d) {
      if (!d.el || !d.cube) { finish(); return; }
      const orient = FACE_ORIENTATION[d.face] || FACE_ORIENTATION[1];
      showCube(d.el, d.cube);
      d.el.classList.add("die--rolling-geometry");
      if (reduce) {
        d.cube.style.transition = "none";
        d.cube.style.transform =
          "rotateX(" + orient.x + "deg) rotateY(" + orient.y + "deg)";
        setTimeout(finish, 200);
        return;
      }
      const tx = orient.x + (2 + Math.floor(Math.random() * 2)) * 360;
      const ty = orient.y + (2 + Math.floor(Math.random() * 2)) * 360;
      void d.cube.offsetWidth;
      let done = false;
      const onEnd = function (e) {
        if (e && e.propertyName !== "transform") return;
        if (done) return;
        done = true;
        d.cube.removeEventListener("transitionend", onEnd);
        d.el.classList.remove("die--rolling-geometry");
        finish();
      };
      d.cube.addEventListener("transitionend", onEnd);
      setTimeout(onEnd, 1300);
      d.cube.style.transition = "transform 1.1s cubic-bezier(0.2,0.7,0.2,1)";
      d.cube.style.transform = "rotateX(" + tx + "deg) rotateY(" + ty + "deg)";
    });
  }

  function hide3dDice() {
    hideCube(dieEl, dieCubeEl);
    hideCube(die2El, die2CubeEl);
  }

  function animateDiceRoll(dice, role, onDone) {
    stopRollCycle();
    hideTurnRollIndicator();
    animate3dDice(dice, role, function () {
      hide3dDice();
      renderDie(diceEls[0], dice[0], role);
      renderDie(diceEls[1], dice[1], role);
      if (onDone) onDone();
    });
  }

  function shouldAnimateOpponentMove(data, previousState) {
    if (data.status !== "playing" || data.phase !== "roll") return false;
    if (data.last_mover !== "host" && data.last_mover !== "guest") return false;
    if (data.last_mover === myRole) return false;
    if (!Number.isInteger(data.moved_piece)) return false;
    if (!Array.isArray(data.path) || data.path.length === 0) return false;

    // If we already saw the opponent stage moves in select phase, do not
    // replay the committed move animation on confirm.
    if (
      previousState &&
      previousState.status === "playing" &&
      previousState.phase === "select" &&
      previousState.turn === data.last_mover
    ) {
      return false;
    }

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

    const firstMoveOverlay = getFirstMoveOverlay(data, previousState);
    if (firstMoveOverlay) {
      lastFirstMove = firstMoveOverlay;
    } else {
      lastFirstMove = null;
    }

    // Once a player rolls (enters the select phase), stop showing the
    // arrow for the other player's previous move.
    const enteredSelect =
      data.status === "playing" &&
      data.phase === "select" &&
      (!previousState || previousState.phase !== "select");
    if (enteredSelect) {
      lastMove = null;
      lastFirstMove = null;
    }

    if (shouldAnimateRoll(data, previousState)) {
      inputLocked = true;
      lastState = data;
      statusEl.textContent = "Rolling dice...";
      turnBtn.disabled = true;
      passBtn.disabled = true;
      resignBtn.disabled = true;

      animateDiceRoll(data.dice, data.turn, function () {
        if (applyToken !== stateApplyToken) {
          return;
        }
        inputLocked = false;
        hopPos = null;
        lastState = data;
        if (data.no_legal_move) {
          setTransientStatus("No legal move. Press Pass.", 1600);
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
      const promotedBefore =
        !!previousState &&
        !!previousState.promoted &&
        Array.isArray(previousState.promoted[data.last_mover]) &&
        !!previousState.promoted[data.last_mover][data.moved_piece];
      const promotedAfter =
        !!data.promoted &&
        Array.isArray(data.promoted[data.last_mover]) &&
        !!data.promoted[data.last_mover][data.moved_piece];
      const isPromotionMove = !promotedBefore && promotedAfter;

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
          hide3dDice();
          lastState = data;
          drawBoard();
          updateStatus();
        },
        applyToken,
        180,
        150,
        { isPromotion: isPromotionMove }
      );
      return;
    }

    // A die just got dropped on a piece (ours or the opponent's): hop it to
    // the pending destination using the same animation as a committed move.
    const newPiece = newlyStagedPiece(data, previousState);
    if (newPiece >= 0) {
      lastState = data;
      const opt = pieceDiceOptions(newPiece)[dieOf(newPiece)];
      const stagePath = opt && Array.isArray(opt.path) ? opt.path : [];
      if (stagePath.length) {
        inputLocked = true;
        hopPiece(data.turn, newPiece, stagePath, function () {
          if (applyToken !== stateApplyToken) return;
          inputLocked = false;
          hopPos = null;
          drawBoard();
          updateStatus();
        }, applyToken, 160, 110, { isPromotion: !!(opt && opt.promotes) });
        drawBoard();
        updateStatus();
        return;
      }
    }

    inputLocked = false;
    hopPos = null;
    hide3dDice();
    if (data.no_legal_move) {
      // A pass that committed one move means the other die was unplayable;
      // otherwise no die could be played at all.
      setTransientStatus(
        Number.isInteger(data.moved_piece)
          ? "One unplayable die. Turn passed."
          : "No legal move. Turn passed.",
        1600
      );
    }
    lastState = data;
    drawBoard();
    updateStatus();
  }

  function pieceAtEvent(event) {
    const cell = eventToCanonicalCell(event);
    if (!isCell(cell)) return -1;
    const myDisks = roleDisks(lastState, myRole);
    for (let i = 0; i < myDisks.length; i++) {
      if (sameCell(myDisks[i], cell)) return i;
    }
    return -1;
  }

  // Bounce a piece forward and back to signal an illegal drop / collision.
  function previewCollide(piece, dieIndex) {
    const opt = pieceDiceOptions(piece)[dieIndex];
    const path = opt && Array.isArray(opt.path) ? opt.path : [];
    if (path.length === 0) return;
    const applyToken = stateApplyToken;
    inputLocked = true;
    drawBoard();
    updateStatus();
    previewRebound(myRole, piece, path, function () {
      if (applyToken !== stateApplyToken) return;
      inputLocked = false;
      drawBoard();
      updateStatus();
    }, applyToken);
  }

  function handleBoardClick(event) {
    // A click that started a die-face drag is handled by the drag flow.
    if (boardDragStarted) {
      boardDragStarted = false;
      return;
    }
    if (!canSelectPieces()) {
      return;
    }
    // Click a staged piece to send its die back to the tray.
    const piece = pieceAtEvent(event);
    if (piece >= 0 && isPieceStaged(piece)) {
      send({ action: "unstage_move", piece: piece });
    }
  }

  function handleMessage(data) {
    lastPingAt = Date.now();
    if (checkBuild(data.build_id)) {
      return;
    }
    switch (data.type) {
      case "server_info":
      case "ping":
        // Build id already checked above; nothing else to do.
        break;
      case "welcome":
        myRole = data.role;
        clearSelection();
        lastMove = null;
        lastFirstMove = null;
        drawBoard();
        updateStatus();
        break;
      case "state":
        handleState(data);
        break;
      case "game_over":
        terminal = true;
        clearSelection();
        inputLocked = false;
        hopPos = null;
        hide3dDice();
        turnBtn.disabled = true;
        passBtn.disabled = true;
        resignBtn.disabled = true;
        if (data.reason === "promotion") {
          if (data.winner === myRole) {
            showOverlay("You Win", "You promoted all four pieces.");
          } else {
            showOverlay("You Lose", "Your opponent promoted all four pieces.");
          }
        } else if (data.winner === myRole) {
          showOverlay("You Win", "Your opponent resigned.");
        } else {
          showOverlay("You Lose", "You resigned the game.");
        }
        break;
      case "error":
        terminal = true;
        showOverlay("Unavailable", messageForError(data.message));
        break;
    }
  }

  function messageForError(code) {
    if (code === "room not found") return "This room no longer exists.";
    if (code === "room full") return "This room already has two players.";
    return "Could not join this room.";
  }

  // ---- Server-update / reconnect plumbing ----
  function checkBuild(buildId) {
    if (!buildId || !pageBuildId || buildId === pageBuildId) {
      return false;
    }
    applyServerUpdate();
    return true;
  }

  function applyServerUpdate() {
    if (updating) {
      return;
    }
    updating = true;
    clearWatchdog();
    if (socket) {
      try {
        socket.onclose = null;
        socket.close();
      } catch (e) {
        /* ignore */
      }
    }
    showOverlay("Server updated", "Returning to the lobby…");
    setTimeout(function () {
      location.assign("/");
    }, 700);
  }

  function clearWatchdog() {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function startWatchdog() {
    clearWatchdog();
    watchdogTimer = setInterval(function () {
      if (updating || terminal) {
        return;
      }
      // No heartbeat in a while: assume a dead socket and force a reconnect.
      if (
        socket &&
        socket.readyState === WebSocket.OPEN &&
        Date.now() - lastPingAt > HEARTBEAT_MS * 2
      ) {
        try {
          socket.close();
        } catch (e) {
          /* ignore */
        }
      }
    }, HEARTBEAT_MS);
  }

  function connect() {
    socket = new WebSocket(
      wsUrl("/ws/room/" + encodeURIComponent(roomId) + "/?token=" +
        encodeURIComponent(token))
    );
    socket.onopen = function () {
      reconnectAttempts = 0;
      lastPingAt = Date.now();
      startWatchdog();
    };
    socket.onmessage = function (event) {
      handleMessage(JSON.parse(event.data));
    };
    socket.onclose = function () {
      // Don't reconnect when we're deliberately done or already leaving, or
      // after the server told us this room is unusable.
      if (updating || terminal || reconnectAttempts >= MAX_RECONNECT) {
        return;
      }
      reconnectAttempts += 1;
      setTimeout(connect, 1500);
    };
  }

  function send(payload) {
    if (updating) {
      return false;
    }
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
      if (!send({ action: "roll_dice" })) {
        return;
      }
      inputLocked = true;
      turnBtn.disabled = true;
      resignBtn.disabled = true;
      statusEl.textContent = "Rolling dice...";
      return;
    }

    if (lastState.phase === "select" && lastState.can_confirm) {
      if (!send({ action: "confirm_moves" })) {
        return;
      }
      inputLocked = true;
      turnBtn.disabled = true;
      passBtn.disabled = true;
      resignBtn.disabled = true;
      statusEl.textContent = "Confirming moves...";
    }
  });

  passBtn.addEventListener("click", function () {
    if (passBtn.disabled || inputLocked || !lastState) return;
    if (lastState.status !== "playing" || lastState.turn !== myRole) return;
    if (lastState.phase !== "select") return;
    send({ action: "pass_turn" });
  });

  resignBtn.addEventListener("click", function () {
    send({ action: "resign" });
  });

  // -- drag a tray die onto a piece to assign it ------------------------
  function endDrag() {
    if (!dragState) return;
    if (dragState.ghost && dragState.ghost.parentNode) {
      dragState.ghost.parentNode.removeChild(dragState.ghost);
    }
    dragState = null;
  }

  function onDieDown(dieIndex) {
    return function (event) {
      if (!canSelectPieces()) return;
      const value = dieValue(dieIndex);
      if (value == null) return;
      event.preventDefault();
      const el = diceEls[dieIndex];
      // If this die is already staged, dragging it cancels that assignment.
      const fromPiece = (function () {
        const staged = Array.isArray(lastState.staged) ? lastState.staged : [];
        for (let i = 0; i < staged.length; i++) {
          if (staged[i][1] === dieIndex) return staged[i][0];
        }
        return -1;
      })();
      startDieDrag(dieIndex, fromPiece, el, event);
    };
  }

  // Begin dragging a die, whether grabbed from the tray or from its pending
  // face on the board. A staged die is unstaged immediately so it can be
  // dropped onto a new piece.
  function startDieDrag(dieIndex, fromPiece, captureEl, event) {
    if (fromPiece >= 0) {
      send({ action: "unstage_move", piece: fromPiece });
    }
    const ghost = diceEls[dieIndex].cloneNode(true);
    ghost.classList.add("die-ghost");
    ghost.classList.remove("hidden");
    document.body.appendChild(ghost);
    dragState = {
      dieIndex: dieIndex,
      fromPiece: -1,
      ghost: ghost,
      pointerId: event.pointerId,
    };
    moveGhost(event);
    captureEl.setPointerCapture && captureEl.setPointerCapture(event.pointerId);
  }

  // Click-and-hold a pending die face on the board to pick that die back up
  // and reassign it, just like dragging the greyed-out tray die.
  function onBoardPointerDown(event) {
    boardDragStarted = false;
    if (!canSelectPieces()) return;
    const piece = pieceAtEvent(event);
    if (piece < 0 || !isPieceStaged(piece)) return;
    const dieIndex = dieOf(piece);
    if (dieIndex < 0 || dieValue(dieIndex) == null) return;
    event.preventDefault();
    boardDragStarted = true;
    startDieDrag(dieIndex, piece, canvas, event);
  }

  function moveGhost(event) {
    if (!dragState || !dragState.ghost) return;
    dragState.ghost.style.left = event.clientX + "px";
    dragState.ghost.style.top = event.clientY + "px";
  }

  function onPointerMove(event) {
    if (!dragState) return;
    moveGhost(event);
  }

  function onPointerUp(event) {
    if (!dragState) return;
    const drag = dragState;
    endDrag();
    if (!canSelectPieces()) {
      drawBoard();
      updateStatus();
      return;
    }
    const piece = pieceAtEvent(event);
    if (piece < 0) {
      // Dropped off the board: the die was already unstaged on pickup.
      return;
    }
    const opt = pieceDiceOptions(piece)[drag.dieIndex];
    if (opt && opt.legal) {
      // Dropping onto a piece that already has a pending die replaces it.
      send({ action: "stage_move", piece: piece, die_index: drag.dieIndex });
    } else {
      previewCollide(piece, drag.dieIndex);
    }
  }

  diceEls.forEach(function (el, i) {
    el.addEventListener("pointerdown", onDieDown(i));
  });
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);

  canvas.addEventListener("pointerdown", onBoardPointerDown);
  canvas.addEventListener("click", handleBoardClick);

  // Re-render at the correct backing resolution when the display size or the
  // device pixel ratio changes (window resize, zoom, or moving between
  // monitors with different DPI).
  window.addEventListener("resize", drawBoard);

  drawBoard();
  connect();
})();
