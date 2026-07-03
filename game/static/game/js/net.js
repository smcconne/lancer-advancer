// Networking, server update handling, and state application pipeline.
(function () {
  "use strict";

  const Game = (window.Game = window.Game || {});

  Game.createNetModule = function (deps) {
    const constants = deps.constants;
    const session = deps.session;
    const dom = deps.dom;
    const assets = deps.assets;
    const st = deps.state;

    const HEARTBEAT_MS = constants.HEARTBEAT_MS;
    const MAX_RECONNECT = constants.MAX_RECONNECT;

    const wsUrl = session.wsUrl;
    const token = session.token;
    const roomId = session.roomId;
    const pageBuildId = session.pageBuildId;

    const statusEl = dom.statusEl;
    const turnBtn = dom.turnBtn;
    const passBtn = dom.passBtn;
    const resignBtn = dom.resignBtn;

    const clearSelection = deps.clearSelection;
    const drawBoard = deps.drawBoard;
    const updateStatus = deps.updateStatus;
    const hide3dDice = deps.hide3dDice;
    const animateDiceRoll = deps.animateDiceRoll;
    const hopPiece = deps.hopPiece;
    const newlyStagedPiece = deps.newlyStagedPiece;
    const pieceDiceOptions = deps.pieceDiceOptions;
    const dieOf = deps.dieOf;
    const setTransientStatus = deps.setTransientStatus;
    const pieceCell = deps.pieceCell;
    const isCell = deps.isCell;
    const sameCell = deps.sameCell;
    const computeFlipMeta = deps.computeFlipMeta;
    const moverColor = deps.moverColor || function () { return ""; };
    const showOverlay = deps.showOverlay;
    const FIGHT_RESOLUTION_HOLD_MS = 1500;

    function overlayIconUrl(kind) {
      const isVictory = kind === "victory";
      const urlKey = isVictory ? "victoryBlackDataUrl" : "defeatBlackDataUrl";
      const canvasKey = isVictory ? "victoryBlackCanvas" : "defeatBlackCanvas";
      const imageKey = isVictory ? "victoryImg" : "defeatImg";

      if (!assets) {
        return isVictory ? window.VICTORY_URL || "" : window.DEFEAT_URL || "";
      }

      if (assets[urlKey]) {
        return assets[urlKey];
      }

      if (!assets[canvasKey] && assets.makeSilhouette) {
        const img = assets[imageKey];
        if (img && img.complete && img.naturalWidth > 0) {
          assets[canvasKey] = assets.makeSilhouette(img, "#000");
        }
      }

      if (assets[canvasKey]) {
        assets[urlKey] = assets[canvasKey].toDataURL("image/png");
        return assets[urlKey];
      }

      return isVictory ? window.VICTORY_URL || "" : window.DEFEAT_URL || "";
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

    function shouldAnimateRoll(data, previousState) {
      if (data.status !== "playing") return false;
      if (data.phase !== "select") return false;
      if (!Array.isArray(data.dice) || data.dice.length < 2) return false;
      if (Array.isArray(data.staged) && data.staged.length > 0) return false;
      return !previousState || previousState.phase !== "select";
    }

    function shouldAnimateOpponentMove(data, previousState) {
      if (data.status !== "playing" || data.phase !== "roll") return false;
      if (data.last_mover !== "host" && data.last_mover !== "guest") return false;
      if (data.last_mover === st.myRole) return false;
      if (!Number.isInteger(data.moved_piece)) return false;
      if (!Array.isArray(data.path) || data.path.length === 0) return false;
      if (previousState && previousState.phase === "fight") return false;

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

    function sameFightResult(a, b) {
      return JSON.stringify(a || null) === JSON.stringify(b || null);
    }

    function hasNewFightResult(data, previousState) {
      if (!data || !data.fight_result) return false;
      return !sameFightResult(data.fight_result, previousState && previousState.fight_result);
    }

    function hasFightDice(dice) {
      return Array.isArray(dice) && dice.length > 0;
    }

    // Every fight roll that this client has not animated yet, in the order
    // they should play: the local player's roll first, then the opponent's.
    function newlyArrivedFightRolls(data, previousState) {
      const prevFight = previousState && previousState.fight ? previousState.fight : null;
      const currFight = data && data.fight ? data.fight : null;
      const resultIsNew = hasNewFightResult(data, previousState);

      let src = null;
      if (
        currFight &&
        (hasFightDice(currFight.attacker_dice) || hasFightDice(currFight.defender_dice))
      ) {
        src = currFight;
      } else if (resultIsNew) {
        src = data.fight_result;
      }
      if (!src) return [];

      const rolls = [];
      if (
        hasFightDice(src.attacker_dice) &&
        !(prevFight && hasFightDice(prevFight.attacker_dice))
      ) {
        rolls.push({ role: src.attacker, dice: src.attacker_dice });
      }
      if (
        hasFightDice(src.defender_dice) &&
        !(prevFight && hasFightDice(prevFight.defender_dice))
      ) {
        rolls.push({ role: src.defender, dice: src.defender_dice });
      }
      rolls.sort(function (a, b) {
        return (a.role === st.myRole ? 0 : 1) - (b.role === st.myRole ? 0 : 1);
      });
      return rolls;
    }

    function animateFightResolution(data, previousState, applyToken, onDone) {
      const result = data && data.fight_result;
      if (!result || !previousState || !previousState.disks) {
        onDone();
        return;
      }

      let animState;
      try {
        animState = JSON.parse(JSON.stringify(previousState));
      } catch (e) {
        onDone();
        return;
      }

      function applyMoveSnapshot(move) {
        if (!animState.disks || !Array.isArray(animState.disks[move.role])) return;
        if (!Array.isArray(animState.disks[move.role][move.piece])) return;
        animState.disks[move.role][move.piece] = [move.to[0], move.to[1]];
      }

      function easeInOutCubic(t) {
        if (t < 0.5) {
          return 4 * t * t * t;
        }
        return 1 - Math.pow(-2 * t + 2, 3) / 2;
      }

      function easeOutCubic(t) {
        return 1 - Math.pow(1 - t, 3);
      }

      function easeInCubic(t) {
        return t * t * t;
      }

      function clearMotion() {
        st.hopPos = null;
        st.hopPosList = null;
      }

      function keyFor(role, piece) {
        return role + ":" + piece;
      }

      // Setting the result on the animated state is what flips the emblem
      // from lance-battle to clash, so it only happens at impact time.
      function markClash() {
        if (animState.fight) {
          animState.fight.result = result;
        }
        animState.fight_result = result;
      }

      function runPhase(durationMs, easeFn, positionsForT, onPhaseDone) {
        const startTime = performance.now();
        st.lastState = animState;
        function frame(now) {
          if (applyToken !== st.stateApplyToken) {
            return;
          }

          const elapsed = now - startTime;
          const rawT = Math.min(1, Math.max(0, elapsed / durationMs));
          const easedT = easeFn(rawT);

          clearMotion();
          st.hopPosList = positionsForT(easedT);
          drawBoard();
          updateStatus();

          if (rawT >= 1) {
            onPhaseDone();
            return;
          }
          requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
      }

      function runSimultaneousMoves(moves, onMovesDone) {
        const animatedMoves = [];
        for (let i = 0; i < moves.length; i++) {
          const move = moves[i];
          if (
            !move ||
            (move.role !== "host" && move.role !== "guest") ||
            !Number.isInteger(move.piece) ||
            !isCell(move.to)
          ) {
            continue;
          }
          const from = isCell(move.from)
            ? [move.from[0], move.from[1]]
            : pieceCell(animState, move.role, move.piece);
          if (!isCell(from) || sameCell(from, move.to)) {
            applyMoveSnapshot(move);
            continue;
          }
          animatedMoves.push({
            role: move.role,
            piece: move.piece,
            from: from,
            to: move.to,
            flip: move.flip || null,
            move: move,
          });
        }

        if (animatedMoves.length === 0) {
          clearMotion();
          st.lastState = animState;
          drawBoard();
          updateStatus();
          onMovesDone();
          return;
        }

        const startTime = performance.now();
        const durationMs = 170;
        const settleMs = 100;
        st.lastState = animState;

        function frame(now) {
          if (applyToken !== st.stateApplyToken) {
            return;
          }

          const elapsed = now - startTime;
          const rawT = Math.min(1, Math.max(0, elapsed / durationMs));
          const easedT = easeInOutCubic(rawT);

          clearMotion();
          st.hopPosList = animatedMoves.map(function (entry) {
            const pos = [
              entry.from[0] + (entry.to[0] - entry.from[0]) * easedT,
              entry.from[1] + (entry.to[1] - entry.from[1]) * easedT,
            ];
            return {
              role: entry.role,
              pieceIndex: entry.piece,
              pos: pos,
              progress: easedT,
              flip: entry.flip,
            };
          });
          drawBoard();
          updateStatus();

          if (rawT >= 1) {
            st.hopPosList = animatedMoves.map(function (entry) {
              return {
                role: entry.role,
                pieceIndex: entry.piece,
                pos: [entry.to[0], entry.to[1]],
                progress: 1,
                flip: entry.flip,
              };
            });
            drawBoard();
            updateStatus();
            setTimeout(function () {
              if (applyToken !== st.stateApplyToken) {
                return;
              }
              for (let i = 0; i < animatedMoves.length; i++) {
                applyMoveSnapshot(animatedMoves[i].move);
              }
              clearMotion();
              st.lastState = animState;
              drawBoard();
              updateStatus();
              onMovesDone();
            }, settleMs);
            return;
          }

          requestAnimationFrame(frame);
        }

        requestAnimationFrame(frame);
      }

      function runKnockback(clashByKey) {
        const pushes = Array.isArray(result.pushes) ? result.pushes : [];
        const moves = pushes.map(function (push) {
          return {
            role: result.loser,
            piece: push.piece,
            to: push.to,
            flip: isCell(push.from)
              ? computeFlipMeta([push.from, push.to], false)
              : null,
          };
        });

        const winnerCell = pieceCell(animState, result.winner, winnerPiece);
        const winnerClash =
          clashByKey && clashByKey[keyFor(result.winner, winnerPiece)];
        if (isCell(winnerCell) && isCell(winnerClash)) {
          moves.push({
            role: result.winner,
            piece: winnerPiece,
            from: winnerClash,
            to: winnerCell,
            flip: computeFlipMeta([winnerCell, winnerCell], false),
          });
        }

        const loserClash =
          clashByKey && clashByKey[keyFor(result.loser, loserPiece)];
        moves.push({
          role: result.loser,
          piece: loserPiece,
          from: isCell(loserClash) ? loserClash : null,
          to: result.loser_to,
          flip: isCell(result.loser_from)
            ? computeFlipMeta([result.loser_from, result.loser_to], false)
            : null,
        });

        runSimultaneousMoves(moves, wrappedOnDone);
      }

      const winnerPiece = result.winner_piece;
      const loserPiece = result.loser_piece;
      const attackerPiece =
        result.attacker === result.winner ? winnerPiece : loserPiece;
      const defenderPiece =
        result.defender === result.winner ? winnerPiece : loserPiece;

      const wrappedOnDone = function () {
        st.joustWinner = null;
        onDone();
      };

      const attackerFrom = pieceCell(animState, result.attacker, attackerPiece);
      const defenderFrom = pieceCell(animState, result.defender, defenderPiece);
      if (
        !isCell(attackerFrom) ||
        !isCell(defenderFrom) ||
        !Number.isInteger(result.column)
      ) {
        markClash();
        runKnockback(null);
        return;
      }

      st.joustWinner = result.winner;

      const retreatDistance = 0.6;
      const minCenterCol = -0.18;
      const maxCenterCol = 5.18;
      const clashRowMid = 1.5;
      const clashRowOffset = 0.28;

      function retreatCell(from, role) {
        const sign = role === "host" ? 1 : -1;
        const c = from[1] + sign * retreatDistance;
        const clampedC = Math.min(maxCenterCol, Math.max(minCenterCol, c));
        return [from[0], clampedC];
      }

      const attackerRetreat = retreatCell(attackerFrom, result.attacker);
      const defenderRetreat = retreatCell(defenderFrom, result.defender);

      // Stable orientation while the fighters occupy fractional positions.
      const attackerHoldFlip = computeFlipMeta([attackerFrom, attackerFrom], false);
      const defenderHoldFlip = computeFlipMeta([defenderFrom, defenderFrom], false);

      const attackerIsTop = attackerFrom[0] <= defenderFrom[0];
      const attackerClash = [
        clashRowMid + (attackerIsTop ? -clashRowOffset : clashRowOffset),
        result.column,
      ];
      const defenderClash = [
        clashRowMid + (attackerIsTop ? clashRowOffset : -clashRowOffset),
        result.column,
      ];

      const clashByKey = {};
      clashByKey[keyFor(result.attacker, attackerPiece)] = attackerClash;
      clashByKey[keyFor(result.defender, defenderPiece)] = defenderClash;

      runPhase(
        200,
        easeOutCubic,
        function (t) {
          return [
            {
              role: result.attacker,
              pieceIndex: attackerPiece,
              pos: [
                attackerFrom[0] + (attackerRetreat[0] - attackerFrom[0]) * t,
                attackerFrom[1] + (attackerRetreat[1] - attackerFrom[1]) * t,
              ],
              progress: t,
              flip: attackerHoldFlip,
            },
            {
              role: result.defender,
              pieceIndex: defenderPiece,
              pos: [
                defenderFrom[0] + (defenderRetreat[0] - defenderFrom[0]) * t,
                defenderFrom[1] + (defenderRetreat[1] - defenderFrom[1]) * t,
              ],
              progress: t,
              flip: defenderHoldFlip,
            },
          ];
        },
        function () {
          runPhase(
            250,
            easeInCubic,
            function (t) {
              return [
                {
                  role: result.attacker,
                  pieceIndex: attackerPiece,
                  pos: [
                    attackerRetreat[0] + (attackerClash[0] - attackerRetreat[0]) * t,
                    attackerRetreat[1] + (attackerClash[1] - attackerRetreat[1]) * t,
                  ],
                  progress: t,
                  flip: attackerHoldFlip,
                },
                {
                  role: result.defender,
                  pieceIndex: defenderPiece,
                  pos: [
                    defenderRetreat[0] + (defenderClash[0] - defenderRetreat[0]) * t,
                    defenderRetreat[1] + (defenderClash[1] - defenderRetreat[1]) * t,
                  ],
                  progress: t,
                  flip: defenderHoldFlip,
                },
              ];
            },
            function () {
              markClash();
              runKnockback(clashByKey);
            }
          );
        }
      );
    }

    function buildResolvedFightPreview(data, previousState) {
      if (!data || !data.fight_result || !previousState || !previousState.fight) {
        return null;
      }
      let preview;
      try {
        preview = JSON.parse(JSON.stringify(previousState));
      } catch (e) {
        return null;
      }
      preview.phase = "fight";
      preview.fight = preview.fight || {};
      preview.fight.attacker_dice = data.fight_result.attacker_dice;
      preview.fight.defender_dice = data.fight_result.defender_dice;
      preview.fight.attacker_value = data.fight_result.attacker_value;
      preview.fight.defender_value = data.fight_result.defender_value;
      preview.fight.result = data.fight_result;
      preview.can_fight_roll = { host: false, guest: false };
      preview.fight_result = data.fight_result;
      return preview;
    }

    function handleState(data) {
      const incomingVersion =
        typeof data.version === "number"
          ? data.version
          : st.latestStateVersion + 1;
      if (incomingVersion < st.latestStateVersion) {
        return;
      }

      st.latestStateVersion = incomingVersion;
      const applyToken = ++st.stateApplyToken;
      const previousState = st.lastState;

      clearSelection();
      st.arrowIdleEpoch = null;

      const moveOverlay = getMoveOverlay(data, previousState);
      if (moveOverlay) {
        st.lastMove = moveOverlay;
      } else if (!data.last_mover) {
        st.lastMove = null;
      }

      const firstMoveOverlay = getFirstMoveOverlay(data, previousState);
      if (firstMoveOverlay) {
        st.lastFirstMove = firstMoveOverlay;
      } else {
        st.lastFirstMove = null;
      }

      const enteredSelect =
        data.status === "playing" &&
        data.phase === "select" &&
        (!previousState || previousState.phase !== "select");
      if (enteredSelect) {
        st.lastMove = null;
        st.lastFirstMove = null;
      }

      const shouldAnimateResolvedFight = hasNewFightResult(data, previousState);
      const fightRollsToAnimate = newlyArrivedFightRolls(data, previousState);
      if (data.phase !== "fight" && !shouldAnimateResolvedFight) {
        st.pendingFightRoll = false;
      }

      if (shouldAnimateRoll(data, previousState)) {
        st.inputLocked = true;
        st.lastState = data;
        statusEl.textContent = "Rolling dice...";
        turnBtn.disabled = true;
        passBtn.disabled = true;
        resignBtn.disabled = true;

        animateDiceRoll(data.dice, data.turn, function () {
          if (applyToken !== st.stateApplyToken) {
            return;
          }
          st.inputLocked = false;
          st.hopPos = null;
          st.hopPosList = null;
          st.lastState = data;
          if (data.no_legal_move) {
            setTransientStatus("No legal move. Press Pass.", 1600);
          }
          drawBoard();
          updateStatus();
        });
        return;
      }

      if (fightRollsToAnimate.length > 0) {
        const includesMine = fightRollsToAnimate.some(function (roll) {
          return roll.role === st.myRole;
        });
        const resolvesFight = shouldAnimateResolvedFight;

        // Lock input while the local roll animates or the fight resolves;
        // an opponent's first roll must leave this player free to roll.
        st.inputLocked = includesMine || resolvesFight;
        if (st.inputLocked) {
          st.lastState = previousState || data;
          turnBtn.disabled = true;
          passBtn.disabled = true;
          resignBtn.disabled = true;
        } else {
          st.lastState = data;
          drawBoard();
          updateStatus();
        }

        const finalizeFightRolls = function () {
          if (applyToken !== st.stateApplyToken) {
            return;
          }
          st.inputLocked = false;
          st.hopPos = null;
          st.hopPosList = null;
          hide3dDice();
          st.lastState = data;
          drawBoard();
          updateStatus();
        };

        const afterFightRolls = function () {
          if (applyToken !== st.stateApplyToken) {
            return;
          }
          if (resolvesFight) {
            const preview = buildResolvedFightPreview(data, previousState || data);
            if (preview) {
              st.lastState = preview;
              drawBoard();
              updateStatus();
            }
            setTimeout(function () {
              if (applyToken !== st.stateApplyToken) {
                return;
              }
              animateFightResolution(
                data,
                previousState || data,
                applyToken,
                finalizeFightRolls
              );
            }, FIGHT_RESOLUTION_HOLD_MS);
            return;
          }
          finalizeFightRolls();
        };

        let rollIndex = 0;
        const runNextRoll = function () {
          if (applyToken !== st.stateApplyToken) {
            return;
          }
          if (rollIndex >= fightRollsToAnimate.length) {
            afterFightRolls();
            return;
          }
          const roll = fightRollsToAnimate[rollIndex];
          rollIndex += 1;
          const isMine = roll.role === st.myRole;
          const opponent = st.myRole === "host" ? "guest" : "host";
          statusEl.textContent = isMine
            ? "Rolling fight dice..."
            : "Opponent rolling fight dice...";
          statusEl.style.color = moverColor(isMine ? st.myRole : opponent);
          animateDiceRoll(roll.dice, roll.role, function () {
            if (applyToken !== st.stateApplyToken) {
              return;
            }
            if (roll.role === st.myRole) {
              st.pendingFightRoll = false;
            }
            runNextRoll();
          }, { skipTrayRender: true });
        };

        runNextRoll();
        return;
      }

      if (shouldAnimateResolvedFight) {
        st.inputLocked = true;
        const preview = buildResolvedFightPreview(data, previousState || data);
        st.lastState = preview || previousState || data;
        drawBoard();
        updateStatus();
        setTimeout(function () {
          if (applyToken !== st.stateApplyToken) {
            return;
          }
          animateFightResolution(data, previousState || data, applyToken, function () {
            if (applyToken !== st.stateApplyToken) {
              return;
            }
            st.inputLocked = false;
            st.hopPos = null;
            st.hopPosList = null;
            hide3dDice();
            st.lastState = data;
            drawBoard();
            updateStatus();
          });
        }, FIGHT_RESOLUTION_HOLD_MS);
        return;
      }

      if (shouldAnimateOpponentMove(data, previousState)) {
        st.inputLocked = true;
        st.lastState = previousState || data;
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
            if (applyToken !== st.stateApplyToken) {
              return;
            }
            st.inputLocked = false;
            st.hopPos = null;
            st.hopPosList = null;
            hide3dDice();
            st.lastState = data;
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

      const newPiece = newlyStagedPiece(data, previousState);
      if (newPiece >= 0) {
        st.lastState = data;
        const opt = pieceDiceOptions(newPiece)[dieOf(newPiece)];
        const stagePath = opt && Array.isArray(opt.path) ? opt.path : [];
        if (stagePath.length) {
          st.inputLocked = true;
          hopPiece(data.turn, newPiece, stagePath, function () {
            if (applyToken !== st.stateApplyToken) return;
            st.inputLocked = false;
            st.hopPos = null;
            st.hopPosList = null;
            drawBoard();
            updateStatus();
          }, applyToken, 160, 110, { isPromotion: !!(opt && opt.promotes) });
          drawBoard();
          updateStatus();
          return;
        }
      }

      st.inputLocked = false;
      st.hopPos = null;
      st.hopPosList = null;
      hide3dDice();
      if (data.no_legal_move) {
        setTransientStatus(
          Number.isInteger(data.moved_piece)
            ? "One unplayable die. Turn passed."
            : "No legal move. Turn passed.",
          1600
        );
      }
      st.lastState = data;
      drawBoard();
      updateStatus();
    }

    function handleMessage(data) {
      st.lastPingAt = Date.now();
      if (checkBuild(data.build_id)) {
        return;
      }
      switch (data.type) {
        case "server_info":
        case "ping":
          break;
        case "welcome":
          st.myRole = data.role;
          st.pendingFightRoll = false;
          st.hopPos = null;
          st.hopPosList = null;
          clearSelection();
          st.lastMove = null;
          st.lastFirstMove = null;
          drawBoard();
          updateStatus();
          break;
        case "state":
          handleState(data);
          break;
        case "game_over":
          st.terminal = true;
          st.pendingFightRoll = false;
          clearSelection();
          st.inputLocked = false;
          st.hopPos = null;
          st.hopPosList = null;
          hide3dDice();
          turnBtn.disabled = true;
          passBtn.disabled = true;
          resignBtn.disabled = true;
          if (data.reason === "promotion") {
            if (data.winner === st.myRole) {
              showOverlay(
                "You Win",
                "You promoted all four pieces.",
                overlayIconUrl("victory"),
                "Victory"
              );
            } else {
              showOverlay(
                "You Lose",
                "Your opponent promoted all four pieces.",
                overlayIconUrl("defeat"),
                "Defeat"
              );
            }
          } else if (data.winner === st.myRole) {
            showOverlay(
              "You Win",
              "Your opponent resigned.",
              overlayIconUrl("victory"),
              "Victory"
            );
          } else {
            showOverlay(
              "You Lose",
              "You resigned the game.",
              overlayIconUrl("defeat"),
              "Defeat"
            );
          }
          break;
        case "error":
          st.terminal = true;
          showOverlay("Unavailable", messageForError(data.message));
          break;
      }
    }

    function messageForError(code) {
      if (code === "room not found") return "This room no longer exists.";
      if (code === "room full") return "This room already has two players.";
      return "Could not join this room.";
    }

    function checkBuild(buildId) {
      if (!buildId || !pageBuildId || buildId === pageBuildId) {
        return false;
      }
      applyServerUpdate();
      return true;
    }

    function applyServerUpdate() {
      if (st.updating) {
        return;
      }
      st.updating = true;
      clearWatchdog();
      if (st.socket) {
        try {
          st.socket.onclose = null;
          st.socket.close();
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
      if (st.watchdogTimer) {
        clearInterval(st.watchdogTimer);
        st.watchdogTimer = null;
      }
    }

    function startWatchdog() {
      clearWatchdog();
      st.watchdogTimer = setInterval(function () {
        if (st.updating || st.terminal) {
          return;
        }
        if (
          st.socket &&
          st.socket.readyState === WebSocket.OPEN &&
          Date.now() - st.lastPingAt > HEARTBEAT_MS * 2
        ) {
          try {
            st.socket.close();
          } catch (e) {
            /* ignore */
          }
        }
      }, HEARTBEAT_MS);
    }

    function connect() {
      st.socket = new WebSocket(
        wsUrl("/ws/room/" + encodeURIComponent(roomId) + "/?token=" +
          encodeURIComponent(token))
      );
      st.socket.onopen = function () {
        st.reconnectAttempts = 0;
        st.lastPingAt = Date.now();
        startWatchdog();
      };
      st.socket.onmessage = function (event) {
        handleMessage(JSON.parse(event.data));
      };
      st.socket.onclose = function () {
        if (st.updating || st.terminal || st.reconnectAttempts >= MAX_RECONNECT) {
          return;
        }
        st.reconnectAttempts += 1;
        setTimeout(connect, 1500);
      };
    }

    function send(payload) {
      if (st.updating) {
        return false;
      }
      if (st.socket && st.socket.readyState === WebSocket.OPEN) {
        st.socket.send(JSON.stringify(payload));
        return true;
      }
      return false;
    }

    return {
      getMoveOverlay: getMoveOverlay,
      getFirstMoveOverlay: getFirstMoveOverlay,
      shouldAnimateRoll: shouldAnimateRoll,
      shouldAnimateOpponentMove: shouldAnimateOpponentMove,
      handleState: handleState,
      handleMessage: handleMessage,
      messageForError: messageForError,
      checkBuild: checkBuild,
      applyServerUpdate: applyServerUpdate,
      clearWatchdog: clearWatchdog,
      startWatchdog: startWatchdog,
      connect: connect,
      send: send,
    };
  };
})();
