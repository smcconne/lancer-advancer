// Game room: render the board from this player's perspective and drive turns.
(function () {
  "use strict";

  const Game = window.Game || {};
  const constants = Game.constants;
  const dom = Game.dom;
  const session = Game.session;
  const helpers = Game.helpers;
  const assets = Game.assets;
  if (
    !constants ||
    !dom ||
    !session ||
    !helpers ||
    !assets ||
    typeof Game.createRenderModule !== "function" ||
    typeof Game.createDiceModule !== "function" ||
    typeof Game.createNetModule !== "function"
  ) {
    throw new Error("Missing required game modules (constants/dom/state/helpers/assets/render/dice/net)");
  }

  const ROWS = constants.ROWS;
  const CELL = constants.CELL; // canvas is 480x320 in its own coordinate space
  const LOGICAL_W = constants.LOGICAL_W; // 480 logical drawing units wide
  const LOGICAL_H = constants.LOGICAL_H; // 320 logical drawing units tall

  let updating = false;
  let terminal = false; // server closed us deliberately (error / game over)
  let reconnectAttempts = 0;
  let lastPingAt = Date.now();
  let watchdogTimer = null;

  const canvas = dom.canvas;
  const ctx = dom.ctx;

  // Image loading and derived canvases are managed in assets.js.
  const statusEl = dom.statusEl;
  const turnBtn = dom.turnBtn;
  const passBtn = dom.passBtn;
  const resignBtn = dom.resignBtn;
  const diceEls = dom.diceEls;
  const diceTrayEl = dom.diceTrayEl;
  const opponentFightTrayEl = dom.opponentFightTrayEl;
  const overlay = dom.overlay;
  const overlayIcon = dom.overlayIcon;
  const overlayTitle = dom.overlayTitle;
  const overlayText = dom.overlayText;

  let myRole = null; // "host" | "guest"
  let lastState = null;
  let socket = null;
  let hopPos = null; // { role, pieceIndex, pos }
  let hopPosList = null; // [{ role, pieceIndex, pos, progress?, flip? }]
  let previewPos = null; // { role, pieceIndex, pos }
  let illegalOverlay = null; // { track }
  let lastMove = null;
  let lastFirstMove = null; // grey arrow for opponent's first of two moves
  let arrowIdleEpoch = null;
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
  let pendingFightRoll = false;
  let joustWinner = null; // role of winning fighter during joust animation

  // Canonical (server) coordinates -> this player's local view. The host sees
  // canonical coordinates directly; the guest sees the board rotated 180deg.
  function toLocal(r, c) {
    return helpers.toLocalForRole(r, c, myRole);
  }

  function toCanonical(r, c) {
    return helpers.toCanonicalForRole(r, c, myRole);
  }

  function isCell(pos) {
    return helpers.isCell(pos);
  }

  function sameCell(a, b) {
    return helpers.sameCell(a, b);
  }

  function cellCenter(pos) {
    return helpers.cellCenter(pos, myRole);
  }

  function roundedRectPath(x, y, width, height, radius) {
    helpers.roundedRectPath(ctx, x, y, width, height, radius);
  }

  function moverColor(role) {
    return helpers.moverColor(role);
  }

  function roleDisks(state, role) {
    return helpers.roleDisks(state, role);
  }

  function pieceCell(state, role, piece) {
    return helpers.pieceCell(state, role, piece);
  }

  function clearSelection() {
    previewPos = null;
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

  const stateBridge = {};
  Object.defineProperties(stateBridge, {
    myRole: { get: function () { return myRole; }, set: function (v) { myRole = v; } },
    lastState: { get: function () { return lastState; }, set: function (v) { lastState = v; } },
    socket: { get: function () { return socket; }, set: function (v) { socket = v; } },
    hopPos: { get: function () { return hopPos; }, set: function (v) { hopPos = v; } },
    hopPosList: { get: function () { return hopPosList; }, set: function (v) { hopPosList = v; } },
    previewPos: { get: function () { return previewPos; }, set: function (v) { previewPos = v; } },
    illegalOverlay: { get: function () { return illegalOverlay; }, set: function (v) { illegalOverlay = v; } },
    lastMove: { get: function () { return lastMove; }, set: function (v) { lastMove = v; } },
    lastFirstMove: { get: function () { return lastFirstMove; }, set: function (v) { lastFirstMove = v; } },
    arrowIdleEpoch: { get: function () { return arrowIdleEpoch; }, set: function (v) { arrowIdleEpoch = v; } },
    dieTransitionHandler: { get: function () { return dieTransitionHandler; }, set: function (v) { dieTransitionHandler = v; } },
    dieTransitionFallbackId: { get: function () { return dieTransitionFallbackId; }, set: function (v) { dieTransitionFallbackId = v; } },
    depthRafId: { get: function () { return depthRafId; }, set: function (v) { depthRafId = v; } },
    latestStateVersion: { get: function () { return latestStateVersion; }, set: function (v) { latestStateVersion = v; } },
    stateApplyToken: { get: function () { return stateApplyToken; }, set: function (v) { stateApplyToken = v; } },
    inputLocked: { get: function () { return inputLocked; }, set: function (v) { inputLocked = v; } },
    transientStatusText: { get: function () { return transientStatusText; }, set: function (v) { transientStatusText = v; } },
    transientStatusUntil: { get: function () { return transientStatusUntil; }, set: function (v) { transientStatusUntil = v; } },
    selectableFlashTimer: { get: function () { return selectableFlashTimer; }, set: function (v) { selectableFlashTimer = v; } },
    rollCycleTimer: { get: function () { return rollCycleTimer; }, set: function (v) { rollCycleTimer = v; } },
    rollCycleRole: { get: function () { return rollCycleRole; }, set: function (v) { rollCycleRole = v; } },
    pendingFightRoll: { get: function () { return pendingFightRoll; }, set: function (v) { pendingFightRoll = v; } },
    joustWinner: { get: function () { return joustWinner; }, set: function (v) { joustWinner = v; } },
    updating: { get: function () { return updating; }, set: function (v) { updating = v; } },
    terminal: { get: function () { return terminal; }, set: function (v) { terminal = v; } },
    reconnectAttempts: { get: function () { return reconnectAttempts; }, set: function (v) { reconnectAttempts = v; } },
    lastPingAt: { get: function () { return lastPingAt; }, set: function (v) { lastPingAt = v; } },
    watchdogTimer: { get: function () { return watchdogTimer; }, set: function (v) { watchdogTimer = v; } },
  });

  const renderApi = Game.createRenderModule({
    constants: constants,
    dom: dom,
    assets: assets,
    state: stateBridge,
    toLocal: toLocal,
    isCell: isCell,
    cellCenter: cellCenter,
    roundedRectPath: roundedRectPath,
    moverColor: moverColor,
    roleDisks: roleDisks,
    pieceCell: pieceCell,
    clamp: clamp,
    dieOf: dieOf,
    isPieceStaged: isPieceStaged,
    pieceDiceOptions: pieceDiceOptions,
    stagedTrackFor: stagedTrackFor,
  });

  const diceApi = Game.createDiceModule({
    constants: constants,
    dom: dom,
    state: stateBridge,
  });

  const netApi = Game.createNetModule({
    constants: constants,
    session: session,
    dom: dom,
    assets: assets,
    state: stateBridge,
    clearSelection: clearSelection,
    drawBoard: drawBoard,
    updateStatus: updateStatus,
    hide3dDice: diceApi.hide3dDice,
    animateDiceRoll: diceApi.animateDiceRoll,
    hopPiece: hopPiece,
    newlyStagedPiece: newlyStagedPiece,
    pieceDiceOptions: pieceDiceOptions,
    dieOf: dieOf,
    setTransientStatus: setTransientStatus,
    pieceCell: pieceCell,
    isCell: isCell,
    sameCell: sameCell,
    computeFlipMeta: computeFlipMeta,
    moverColor: moverColor,
    showOverlay: showOverlay,
  });

  function canSelectPieces() {
    return renderApi.canSelectPieces();
  }

  function waitingForOpponentToSelectPiece() {
    return renderApi.waitingForOpponentToSelectPiece();
  }

  function waitingForOpponentToRollDice() {
    return renderApi.waitingForOpponentToRollDice();
  }

  function syncSelectableFlashLoop() {
    return renderApi.syncSelectableFlashLoop();
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
    return diceApi.hideTurnRollIndicator();
  }

  // Render both dice from the current state, marking assigned/draggable dice.
  function renderDice() {
    return diceApi.renderDice();
  }

  function stopRollCycle() {
    return diceApi.stopRollCycle();
  }

  function startRollCycle(role) {
    return diceApi.startRollCycle(role);
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

  function drawBoard() {
    return renderApi.drawBoard();
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
    if (lastState.phase === "fight") {
      if (joustWinner) {
        const colorName = joustWinner === "host" ? "Red" : "Blue";
        return colorName + " charges forward!";
      }
      if (lastState.fight_result) {
        const fr = lastState.fight_result;
        const f = lastState.fight || null;
        if (f && Number.isInteger(f.column) && fr.column === f.column) {
          const colorName = fr.winner === "host" ? "Red" : "Blue";
          return colorName + " prepares to charge";
        }
      }
      const fight = lastState.fight || null;
      const column = fight && Number.isInteger(fight.column) ? fight.column + 1 : "?";
      const canRoll =
        !!lastState.can_fight_roll &&
        !!lastState.can_fight_roll[myRole];
      if (canRoll) {
        return "Fight in column " + column + ". Roll now.";
      }
      return "Fight in column " + column + ". Waiting for opponent roll.";
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
    if (joustWinner) {
      statusEl.style.color = moverColor(joustWinner);
    } else if (
      lastState &&
      lastState.phase === "fight" &&
      lastState.fight_result &&
      lastState.fight_result.winner &&
      lastState.fight &&
      lastState.fight_result.column === lastState.fight.column
    ) {
      statusEl.style.color = moverColor(lastState.fight_result.winner);
    } else if (
      lastState &&
      lastState.phase === "fight" &&
      (myRole === "host" || myRole === "guest")
    ) {
      const canRoll =
        !!lastState.can_fight_roll && !!lastState.can_fight_roll[myRole];
      const opponent = myRole === "host" ? "guest" : "host";
      statusEl.style.color = moverColor(canRoll ? myRole : opponent);
    } else if (turnRole === "host" || turnRole === "guest") {
      statusEl.style.color = moverColor(turnRole);
    } else {
      statusEl.style.color = "";
    }

    const inFightPhase =
      !!lastState &&
      lastState.status === "playing" &&
      lastState.phase === "fight";
    const canFightRoll =
      inFightPhase &&
      !!lastState.can_fight_roll &&
      !!lastState.can_fight_roll[myRole];

    const canPlay =
      !!lastState &&
      lastState.status === "playing" &&
      (lastState.turn === myRole || canFightRoll);
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

    if (diceTrayEl) {
      diceTrayEl.classList.remove("hidden");
    }
    if (opponentFightTrayEl) {
      opponentFightTrayEl.classList.toggle("hidden", !inFightPhase);
      opponentFightTrayEl.setAttribute("aria-hidden", inFightPhase ? "false" : "true");
    }

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
    } else if (inFightPhase) {
      diceEls.forEach(function (el) {
        if (el) el.classList.remove("die--roll-dim", "die--roll-active");
      });
      stopRollCycle();
      hideTurnRollIndicator();
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
    } else if (inFightPhase) {
      turnBtn.disabled = inputLocked || !canFightRoll;
    } else if (selecting) {
      turnBtn.disabled = inputLocked || !lastState.can_confirm;
    } else {
      turnBtn.disabled = inputLocked;
    }

    if (inFightPhase) {
      setTurnButtonText(canFightRoll ? "Roll Fight" : "Their Turn");
    } else if (selecting) {
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
    passBtn.classList.toggle("hidden", inFightPhase);

    resignBtn.disabled = !lastState || lastState.status !== "playing" || inputLocked;
    canvas.classList.toggle("board--selectable", canSelectPieces());
    syncSelectableFlashLoop();
  }

  function showOverlay(title, text, iconUrl, iconAlt) {
    overlayTitle.textContent = title;
    overlayText.textContent = text || "";
    if (overlayIcon) {
      if (iconUrl) {
        overlayIcon.src = iconUrl;
        overlayIcon.alt = iconAlt || "";
        overlayIcon.classList.remove("hidden");
        overlayIcon.removeAttribute("aria-hidden");
      } else {
        overlayIcon.classList.add("hidden");
        overlayIcon.alt = "";
        overlayIcon.setAttribute("aria-hidden", "true");
        overlayIcon.removeAttribute("src");
      }
    }
    overlay.classList.remove("hidden");
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
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
      hopPosList = null;
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

  function connect() {
    return netApi.connect();
  }

  function send(payload) {
    return netApi.send(payload);
  }

  turnBtn.addEventListener("click", function () {
    if (turnBtn.disabled || inputLocked || !lastState) {
      return;
    }
    const canFightRollNow =
      lastState.phase === "fight" &&
      !!lastState.can_fight_roll &&
      !!lastState.can_fight_roll[myRole];
    if (
      lastState.status !== "playing" ||
      (lastState.turn !== myRole && !canFightRollNow)
    ) {
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

    if (lastState.phase === "fight") {
      if (!lastState.can_fight_roll || !lastState.can_fight_roll[myRole]) {
        return;
      }
      if (!send({ action: "fight_roll" })) {
        return;
      }
      pendingFightRoll = true;
      inputLocked = true;
      turnBtn.disabled = true;
      passBtn.disabled = true;
      resignBtn.disabled = true;
      statusEl.textContent = "Rolling fight die...";
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

  assets.ensureLoaded(drawBoard);
  drawBoard();
  connect();
})();
