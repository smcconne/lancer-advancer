// Board rendering and render-related turn predicates.
(function () {
  "use strict";

  const Game = (window.Game = window.Game || {});

  Game.createRenderModule = function (deps) {
    const constants = deps.constants;
    const dom = deps.dom;
    const assets = deps.assets;
    const st = deps.state;

    const COLORS = constants.COLORS;
    const COLS = constants.COLS;
    const ROWS = constants.ROWS;
    const CELL = constants.CELL;
    const LOGICAL_W = constants.LOGICAL_W;
    const LOGICAL_H = constants.LOGICAL_H;
    const PIP_LAYOUT = constants.PIP_LAYOUT;

    const canvas = dom.canvas;
    const ctx = dom.ctx;

    const toLocal = deps.toLocal;
    const isCell = deps.isCell;
    const cellCenter = deps.cellCenter;
    const roundedRectPath = deps.roundedRectPath;
    const moverColor = deps.moverColor;
    const roleDisks = deps.roleDisks;
    const pieceCell = deps.pieceCell;
    const clamp = deps.clamp;
    const dieOf = deps.dieOf;
    const isPieceStaged = deps.isPieceStaged;
    const pieceDiceOptions = deps.pieceDiceOptions;
    const stagedTrackFor = deps.stagedTrackFor;

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

    function currentArrowOverlay() {
      if (st.lastMove && Array.isArray(st.lastMove.track) && st.lastMove.track.length > 1) {
        return st.lastMove;
      }
      return null;
    }

    function selectingRole() {
      if (
        !st.lastState ||
        st.lastState.status !== "playing" ||
        st.lastState.phase !== "select"
      ) {
        return null;
      }
      return st.lastState.turn === "host" || st.lastState.turn === "guest"
        ? st.lastState.turn
        : null;
    }

    function stagedArrowOverlays() {
      const role = selectingRole();
      if (!role) return [];
      if (!st.lastState || !Array.isArray(st.lastState.staged)) return [];
      const overlays = [];
      for (let i = 0; i < st.lastState.staged.length; i++) {
        const track = stagedTrackFor(st.lastState.staged[i][0], role);
        if (track) overlays.push(track);
      }
      return overlays;
    }

    function canSelectPieces() {
      return (
        !!st.lastState &&
        st.lastState.status === "playing" &&
        st.lastState.phase === "select" &&
        st.lastState.turn === st.myRole &&
        !st.inputLocked
      );
    }

    function waitingToConfirmSelection() {
      return canSelectPieces() && st.lastState && st.lastState.can_confirm;
    }

    function waitingToSelectPiece() {
      return canSelectPieces() && st.lastState && !st.lastState.can_confirm;
    }

    function waitingForOpponentToSelectPiece() {
      return (
        !!st.lastState &&
        st.lastState.status === "playing" &&
        st.lastState.phase === "select" &&
        (st.myRole === "host" || st.myRole === "guest") &&
        st.lastState.turn !== st.myRole
      );
    }

    function waitingForOpponentToRollDice() {
      return (
        !!st.lastState &&
        st.lastState.status === "playing" &&
        st.lastState.phase === "roll" &&
        (st.myRole === "host" || st.myRole === "guest") &&
        st.lastState.turn !== st.myRole
      );
    }

    function arrowIdleOffset() {
      if (st.arrowIdleEpoch === null) return 0;

      const backwardMs = 600;
      const forwardMs = 400;
      const maxSlide = CELL / 8;
      const totalMs = backwardMs + forwardMs;
      const elapsed = (Date.now() - st.arrowIdleEpoch) % totalMs;

      if (elapsed < backwardMs) {
        const t = elapsed / backwardMs;
        const exponent = Math.max(1, backwardMs / forwardMs);
        return maxSlide * (1 - Math.pow(1 - t, exponent));
      }

      const forwardElapsed = elapsed - backwardMs;
      return maxSlide * (1 - forwardElapsed / forwardMs);
    }

    function hasSolidArrowOverlay() {
      const staged = stagedArrowOverlays();
      const solidStaged = staged.length >= 2 ? staged.slice(1) : staged;
      const arrowOverlay = currentArrowOverlay();
      const inRollPreviewState =
        !!st.lastState &&
        st.lastState.status === "playing" &&
        st.lastState.phase === "roll";
      const solidCommitted = staged.length === 0 && !!arrowOverlay && !inRollPreviewState;
      return solidStaged.length > 0 || solidCommitted;
    }

    function arrowIdleAnimating() {
      return hasSolidArrowOverlay();
    }

    function flashingSelectableStroke(guestPiece) {
      const t = Date.now() / 1000;
      const mix = (Math.sin(t * Math.PI * 2) + 1) / 2;
      const start = { r: 56, g: 189, b: 248 };
      const end = guestPiece
        ? { r: 255, g: 255, b: 255 }
        : { r: 0, g: 0, b: 0 };
      const r = Math.round(start.r * mix + end.r * (1 - mix));
      const g = Math.round(start.g * mix + end.g * (1 - mix));
      const b = Math.round(start.b * mix + end.b * (1 - mix));
      return "rgb(" + r + ", " + g + ", " + b + ")";
    }

    function syncSelectableFlashLoop() {
      if (canSelectPieces() || waitingForOpponentToSelectPiece() || arrowIdleAnimating()) {
        if (st.selectableFlashTimer !== null) return;
        st.selectableFlashTimer = setInterval(function () {
          if (!canSelectPieces() && !waitingForOpponentToSelectPiece() && !arrowIdleAnimating()) {
            clearInterval(st.selectableFlashTimer);
            st.selectableFlashTimer = null;
            return;
          }
          drawBoard();
        }, 33);
        return;
      }

      if (st.selectableFlashTimer !== null) {
        clearInterval(st.selectableFlashTimer);
        st.selectableFlashTimer = null;
      }
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

      const rawTip = points[points.length - 1];
      let prev = points[points.length - 2];
      for (let i = points.length - 2; i >= 0; i--) {
        if (points[i].x !== rawTip.x || points[i].y !== rawTip.y) {
          prev = points[i];
          break;
        }
      }

      const angle = Math.atan2(rawTip.y - prev.y, rawTip.x - prev.x);
      const headLength = 48;
      const headWidth = 36;
      const halfW = headWidth / 2;
      const moverStroke = grey ? "#9ca3af" : moverColor(mover);
      const baseBackShift = 9;
      const slideBack =
        grey || !opts || typeof opts.slideBack !== "number"
          ? 0
          : Math.max(0, opts.slideBack);
      const totalBackShift = baseBackShift + slideBack;
      const tipX = rawTip.x - Math.cos(angle) * totalBackShift;
      const tipY = rawTip.y - Math.sin(angle) * totalBackShift;
      const baseX = tipX - Math.cos(angle) * headLength;
      const baseY = tipY - Math.sin(angle) * headLength;
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
      ctx.moveTo(tipX, tipY);
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
        ctx.lineTo(tipX, tipY);
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
      ctx.moveTo(tipX, tipY);
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
      if (!st.illegalOverlay || !Array.isArray(track) || track.length === 0) return;
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

    function drawFightHighlight() {
      if (!st.lastState) return;
      const fight = st.lastState.fight;
      const hasPending =
        st.lastState.phase === "fight" &&
        !!fight &&
        Number.isInteger(fight.column);
      // While a fight is active, only show a resolved emblem for THIS fight
      // (fight.result is set on the resolution preview); an earlier fight's
      // lingering fight_result must not leak onto the next fight.
      const result = hasPending
        ? (fight.result || null)
        : st.lastState.fight_result;
      const hasResolved = !!result && Number.isInteger(result.column);

      // Previous fight's clash (shown alongside the current/pending fight).
      const prevResult = st.lastState.previous_fight_result || null;
      if (prevResult && Number.isInteger(prevResult.column)) {
        const prevCells = [[1, prevResult.column], [2, prevResult.column]];
        const prevTop = cellCenter(prevCells[0]);
        const prevBot = cellCenter(prevCells[1]);
        const prevMidX = (prevTop.x + prevBot.x) / 2;
        const prevMidY = (prevTop.y + prevBot.y) / 2;
        if (assets.clashReady && assets.clashImg && assets.clashImg.naturalWidth) {
          const srcW = assets.clashImg.naturalWidth;
          const srcH = assets.clashImg.naturalHeight;
          const aspect = srcW / Math.max(1, srcH);
          const drawH = CELL * 0.6;
          const drawW = drawH * aspect * 1.2;
          const rotated =
            (st.myRole === "host" || st.myRole === "guest") &&
            prevResult.winner !== st.myRole;
          ctx.save();
          ctx.globalAlpha = 1;
          if (rotated) {
            ctx.translate(prevMidX, prevMidY - CELL * 0.005);
            ctx.rotate(Math.PI);
            ctx.drawImage(assets.clashImg, -drawW / 2, -drawH / 2, drawW, drawH);
          } else {
            ctx.drawImage(
              assets.clashImg,
              prevMidX - drawW / 2,
              prevMidY - drawH / 2 - CELL * 0.005,
              drawW,
              drawH
            );
          }
          ctx.restore();
        }
      }

      if (!hasResolved && !hasPending) return;

      const column = hasResolved ? result.column : fight.column;
      const cells = [[1, column], [2, column]];
      const topCenter = cellCenter(cells[0]);
      const bottomCenter = cellCenter(cells[1]);
      const midX = (topCenter.x + bottomCenter.x) / 2;
      const midY = (topCenter.y + bottomCenter.y) / 2;

      const inFightMotion =
        movingEntries().length > 0 &&
        !!st.lastState &&
        st.lastState.phase === "fight";
      const showClash = (!hasPending && hasResolved) || (hasPending && inFightMotion && !!result);
      const source = showClash ? assets.clashImg : assets.lanceBattleImg;
      const ready = showClash ? assets.clashReady : assets.lanceBattleReady;
      if (ready && source && source.naturalWidth) {
        const sourceW = source.naturalWidth;
        const sourceH = source.naturalHeight;
        const aspect = sourceW / Math.max(1, sourceH);
        const drawH = CELL * 0.6;
        const drawW = drawH * aspect * 1.2;
        const rotateForOpponentWin =
          showClash &&
          !!result &&
          (st.myRole === "host" || st.myRole === "guest") &&
          result.winner !== st.myRole;
        ctx.save();
        ctx.globalAlpha = 1;
        if (rotateForOpponentWin) {
          ctx.translate(midX, midY - CELL * 0.005);
          ctx.rotate(Math.PI);
          ctx.drawImage(source, -drawW / 2, -drawH / 2, drawW, drawH);
        } else {
          ctx.drawImage(
            source,
            midX - drawW / 2,
            midY - drawH / 2 - CELL * 0.005,
            drawW,
            drawH
          );
        }
        ctx.restore();
      }
    }

    function drawResolvedFightRollOverlays() {
      if (!st.lastState || st.lastState.phase !== "fight") return;
      if (movingEntries().length > 0) return;
      const fight = st.lastState.fight;
      if (!fight) return;

      const attackerPiece = Number.isInteger(fight.attacker_piece)
        ? fight.attacker_piece
        : null;
      const defenderPiece = Number.isInteger(fight.defender_piece)
        ? fight.defender_piece
        : null;

      // Only this fight's rolled values; never fall back to fight_result,
      // which may still hold a previous fight from the same turn.
      const attackerValue = Number.isInteger(fight.attacker_value)
        ? fight.attacker_value
        : null;
      const defenderValue = Number.isInteger(fight.defender_value)
        ? fight.defender_value
        : null;

      if (attackerPiece !== null && Number.isInteger(attackerValue)) {
        const attackerPos = pieceCell(st.lastState, fight.attacker, attackerPiece);
        if (isCell(attackerPos)) {
          drawTrackDie(attackerPos, attackerValue, fight.attacker);
        }
      }

      if (defenderPiece !== null && Number.isInteger(defenderValue)) {
        const defenderPos = pieceCell(st.lastState, fight.defender, defenderPiece);
        if (isCell(defenderPos)) {
          drawTrackDie(defenderPos, defenderValue, fight.defender);
        }
      }
    }

    function movingEntries() {
      if (Array.isArray(st.hopPosList) && st.hopPosList.length > 0) {
        return st.hopPosList;
      }
      return st.hopPos ? [st.hopPos] : [];
    }

    function movingEntryFor(role, piece) {
      const entries = movingEntries();
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry && entry.role === role && entry.pieceIndex === piece) {
          return entry;
        }
      }
      return null;
    }

    function drawDisk(pos, who, opts) {
      if (!isCell(pos)) return;
      const local = toLocal(pos[0], pos[1]);
      const lr = local[0];
      const lc = local[1];
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
        ? (useDownIcon ? assets.knightDownWhiteCanvas : assets.knightUpWhiteCanvas)
        : (useDownIcon ? assets.knightDownDarkCanvas : assets.knightUpDarkCanvas);
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
      return role === selectingRole() && isPieceStaged(piece);
    }

    function isPiecePromoted(role, piece) {
      if (
        st.lastState &&
        st.lastState.promoted &&
        Array.isArray(st.lastState.promoted[role]) &&
        st.lastState.promoted[role][piece]
      ) {
        return true;
      }
      if (role === selectingRole() && isPieceStaged(piece)) {
        const opt = pieceDiceOptions(piece)[dieOf(piece)];
        if (opt && opt.promotes) {
          const movingEntry = movingEntryFor(role, piece);
          if (
            movingEntry &&
            typeof movingEntry.progress === "number" &&
            Number.isInteger(opt.promotes_at)
          ) {
            return movingEntry.progress >= opt.promotes_at + 0.5;
          }
          return true;
        }
      }
      return false;
    }

    function drawRoleDisks(role, selectedOnly, skipMovingPiece) {
      const disks = roleDisks(st.lastState, role);
      for (let piece = 0; piece < disks.length; piece++) {
        const basePos = disks[piece];
        if (!isCell(basePos)) continue;

        const movingEntry = movingEntryFor(role, piece);
        const moving = !!movingEntry;
        if (skipMovingPiece && moving) continue;

        const selected = isPieceSelected(role, piece);
        if (selectedOnly === true && !selected) continue;
        if (selectedOnly === false && selected) continue;

        let drawPos = basePos;
        if (movingEntry && isCell(movingEntry.pos)) {
          drawPos = movingEntry.pos;
        } else if (
          st.previewPos &&
          st.previewPos.role === role &&
          st.previewPos.pieceIndex === piece &&
          isCell(st.previewPos.pos)
        ) {
          drawPos = st.previewPos.pos;
        } else if (role === selectingRole() && isPieceStaged(piece)) {
          const ov = stagedTrackFor(piece, role);
          if (ov && ov.track.length) drawPos = ov.track[ov.track.length - 1];
        }

        const movedLast =
          !!st.lastState &&
          st.lastState.last_mover === role &&
          (st.lastState.moved_piece === piece ||
            (Number.isInteger(st.lastState.first_moved_piece) &&
              st.lastState.first_moved_piece === piece)) &&
          !waitingForOpponentToSelectPiece();
        const opponentSelecting =
          waitingForOpponentToSelectPiece() &&
          role !== st.myRole;
        const flashOutline =
          (opponentSelecting && !selected) ||
          (role === st.myRole &&
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

    function drawSolidArrowPieceOnTop(role, piece) {
      if (!st.lastState || !st.lastState.disks) return;
      if (!Number.isInteger(piece)) return;

      const disks = roleDisks(st.lastState, role);
      const basePos = disks[piece];
      if (!isCell(basePos)) return;

      const moving = !!movingEntryFor(role, piece);
      if (moving) return;

      const selected = isPieceSelected(role, piece);
      const movedLast =
        !!st.lastState &&
        st.lastState.last_mover === role &&
        (st.lastState.moved_piece === piece ||
          (Number.isInteger(st.lastState.first_moved_piece) &&
            st.lastState.first_moved_piece === piece)) &&
        !waitingForOpponentToSelectPiece();
      const opponentSelecting =
        waitingForOpponentToSelectPiece() &&
        role !== st.myRole;
      const flashOutline =
        (opponentSelecting && !selected) ||
        (role === st.myRole &&
          canSelectPieces() &&
          !isPieceStaged(piece));

      let drawPos = basePos;
      if (
        st.previewPos &&
        st.previewPos.role === role &&
        st.previewPos.pieceIndex === piece &&
        isCell(st.previewPos.pos)
      ) {
        drawPos = st.previewPos.pos;
      } else if (role === selectingRole() && isPieceStaged(piece)) {
        const ov = stagedTrackFor(piece, role);
        if (ov && ov.track.length) drawPos = ov.track[ov.track.length - 1];
      }

      drawDisk(drawPos, role, {
        selected: selected,
        movedLast: movedLast,
        flashOutline: flashOutline,
        moving: false,
        promoted: isPiecePromoted(role, piece),
      });
    }

    function drawMovingDiskOnTop() {
      if (!st.lastState || !st.lastState.disks) return;
      const entries = movingEntries();
      if (entries.length === 0) return;

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry) continue;

        const role = entry.role;
        const piece = entry.pieceIndex;
        const disks = roleDisks(st.lastState, role);
        const basePos = disks[piece];
        if (!isCell(basePos)) continue;

        let drawPos = basePos;
        if (isCell(entry.pos)) {
          drawPos = entry.pos;
        }

        const selected = isPieceSelected(role, piece);
        const movedLast =
          !!st.lastState &&
          st.lastState.last_mover === role &&
          (st.lastState.moved_piece === piece ||
            (Number.isInteger(st.lastState.first_moved_piece) &&
              st.lastState.first_moved_piece === piece)) &&
          !waitingForOpponentToSelectPiece();
        const opponentSelecting =
          waitingForOpponentToSelectPiece() &&
          role !== st.myRole;
        const flashOutline =
          (opponentSelecting && !selected) ||
          (role === st.myRole &&
            canSelectPieces() &&
            !isPieceStaged(piece));

        let promoted = isPiecePromoted(role, piece);
        if (
          entry.flip &&
          entry.flip.isPromotion &&
          typeof entry.flip.pCross === "number" &&
          typeof entry.progress === "number"
        ) {
          promoted = entry.progress >= entry.flip.pCross;
        }

        drawDisk(drawPos, role, {
          selected: selected,
          movedLast: movedLast,
          flashOutline: flashOutline,
          moving: true,
          promoted: promoted,
          flip: entry.flip,
          flipProgress: entry.progress,
        });
      }
    }

    function drawLanceBackground() {
      if (!assets.lanceBgReady || !assets.lanceBgImg.naturalWidth) return;

      const source = assets.lanceBgBlackCanvas || assets.lanceBgImg;
      const sourceW = assets.lanceBgBlackCanvas
        ? assets.lanceBgBlackCanvas.width
        : assets.lanceBgImg.naturalWidth;
      const sourceH = assets.lanceBgBlackCanvas
        ? assets.lanceBgBlackCanvas.height
        : assets.lanceBgImg.naturalHeight;
      const aspect = sourceW / sourceH;
      const spanCells = 4;
      const drawW = spanCells * CELL * 0.62;
      const drawH = drawW / aspect;
      const leftCx = (spanCells / 2) * CELL + CELL * 0.03;
      const rightCx = (COLS - spanCells / 2) * CELL - CELL * 0.03;
      const angle = (225 * Math.PI) / 180;

      const placements = [
        { cx: leftCx, cy: 1.5 * CELL, extraRotation: 0 },
        { cx: leftCx, cy: (ROWS - 0.5) * CELL, extraRotation: 0 },
        { cx: rightCx, cy: 0.5 * CELL, extraRotation: Math.PI },
        { cx: rightCx, cy: (ROWS - 1.5) * CELL, extraRotation: Math.PI },
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
      if (!assets.helmetBgReady || !assets.helmetBgImg.naturalWidth) return;

      const source = assets.helmetBgBlackCanvas || assets.helmetBgImg;

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
      if (!assets.checkBgReady || !assets.checkBgImg.naturalWidth) return;

      const source = assets.checkBgBlackCanvas || assets.checkBgImg;

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

      const bottomColor = st.myRole === "guest" ? COLORS.blue : COLORS.red;
      const topColor = st.myRole === "guest" ? COLORS.red : COLORS.blue;

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
      drawFightHighlight();

      const arrowOverlay = currentArrowOverlay();
      const staged = stagedArrowOverlays();
      const greyFirst = staged.length >= 2;
      const solidStaged = greyFirst ? staged.slice(1) : staged;
      const inRollPreviewState =
        !!st.lastState &&
        st.lastState.status === "playing" &&
        st.lastState.phase === "roll";
      const inFightPreviewState =
        !!st.lastState &&
        st.lastState.status === "playing" &&
        st.lastState.phase === "fight";
      const solidCommitted = staged.length === 0 && arrowOverlay && !inRollPreviewState;
      const idleActive = solidStaged.length > 0 || solidCommitted;
      if (idleActive) {
        if (st.arrowIdleEpoch === null) st.arrowIdleEpoch = Date.now();
      } else {
        st.arrowIdleEpoch = null;
      }
      const headSlideBack = idleActive ? arrowIdleOffset() : 0;
      const greyCommitted =
        staged.length === 0 &&
        st.lastFirstMove &&
        Array.isArray(st.lastFirstMove.track) &&
        st.lastFirstMove.track.length > 1
          ? st.lastFirstMove
          : null;

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

      if (inFightPreviewState && staged.length === 0 && arrowOverlay) {
        drawMoveArrowShaft(arrowOverlay.track, arrowOverlay.mover, { grey: true });
        drawMoveArrowHead(arrowOverlay.track, arrowOverlay.mover, { grey: true });
        drawTrackDie(arrowOverlay.track[0], arrowOverlay.roll, arrowOverlay.mover, {
          grey: true,
        });
      }

      if (st.lastState && st.lastState.disks) {
        const skipMovingPiece = movingEntries().length > 0;
        drawRoleDisks("host", false, skipMovingPiece);
        drawRoleDisks("guest", false, skipMovingPiece);
      }

      if (st.lastState && st.lastState.disks) {
        const skipMovingPiece = movingEntries().length > 0;
        drawRoleDisks("host", true, skipMovingPiece);
        drawRoleDisks("guest", true, skipMovingPiece);
      }

      solidStaged.forEach(function (ov) {
        drawMoveArrowShaft(ov.track, ov.mover);
        drawMoveArrowHead(ov.track, ov.mover, { slideBack: headSlideBack });
        drawTrackDie(ov.track[0], ov.roll, ov.mover);
      });

      if (solidCommitted && !inFightPreviewState) {
        drawMoveArrowShaft(arrowOverlay.track, arrowOverlay.mover);
        drawMoveArrowHead(arrowOverlay.track, arrowOverlay.mover, {
          slideBack: headSlideBack,
        });
        drawTrackDie(arrowOverlay.track[0], arrowOverlay.roll, arrowOverlay.mover);
      }

      solidStaged.forEach(function (ov) {
        drawSolidArrowPieceOnTop(ov.mover, ov.piece);
      });
      if (solidCommitted && !inFightPreviewState) {
        drawSolidArrowPieceOnTop(arrowOverlay.mover, arrowOverlay.piece);
      }

      drawMovingDiskOnTop();
      drawResolvedFightRollOverlays();

      if (st.illegalOverlay && Array.isArray(st.illegalOverlay.track)) {
        drawIllegalX(st.illegalOverlay.track);
      }
    }

    return {
      resizeCanvasForDPR: resizeCanvasForDPR,
      currentArrowOverlay: currentArrowOverlay,
      selectingRole: selectingRole,
      stagedArrowOverlays: stagedArrowOverlays,
      canSelectPieces: canSelectPieces,
      waitingToConfirmSelection: waitingToConfirmSelection,
      waitingToSelectPiece: waitingToSelectPiece,
      waitingForOpponentToSelectPiece: waitingForOpponentToSelectPiece,
      waitingForOpponentToRollDice: waitingForOpponentToRollDice,
      arrowIdleOffset: arrowIdleOffset,
      hasSolidArrowOverlay: hasSolidArrowOverlay,
      arrowIdleAnimating: arrowIdleAnimating,
      flashingSelectableStroke: flashingSelectableStroke,
      syncSelectableFlashLoop: syncSelectableFlashLoop,
      arrowTrackPoints: arrowTrackPoints,
      drawMoveArrowShaft: drawMoveArrowShaft,
      drawMoveArrowHead: drawMoveArrowHead,
      drawTrackDie: drawTrackDie,
      drawIllegalX: drawIllegalX,
      drawFightHighlight: drawFightHighlight,
      drawResolvedFightRollOverlays: drawResolvedFightRollOverlays,
      drawDisk: drawDisk,
      isPieceSelected: isPieceSelected,
      isPiecePromoted: isPiecePromoted,
      drawRoleDisks: drawRoleDisks,
      drawSolidArrowPieceOnTop: drawSolidArrowPieceOnTop,
      drawMovingDiskOnTop: drawMovingDiskOnTop,
      drawLanceBackground: drawLanceBackground,
      drawHelmetBackground: drawHelmetBackground,
      drawCheckBackground: drawCheckBackground,
      drawBoard: drawBoard,
    };
  };
})();
