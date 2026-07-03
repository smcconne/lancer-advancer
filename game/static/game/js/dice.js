// Dice tray rendering and 3D dice animation logic.
(function () {
  "use strict";

  const Game = (window.Game = window.Game || {});

  Game.createDiceModule = function (deps) {
    const constants = deps.constants;
    const dom = deps.dom;
    const st = deps.state;

    const FACE_ORIENTATION = constants.FACE_ORIENTATION;
    const DIE_DOT_CLASSES = constants.DIE_DOT_CLASSES;

    const diceEls = dom.diceEls;
    const opponentFightDiceEls = dom.opponentFightDiceEls;
    const opponentFightTrayEl = dom.opponentFightTrayEl;
    const dieEl = dom.dieEl;
    const dieCubeEl = dom.dieCubeEl;
    const die2El = dom.die2El;
    const die2CubeEl = dom.die2CubeEl;
    const reduceMotionQuery = dom.reduceMotionQuery;
    const dieFaceData = dom.dieFaceData;
    let fightCycleTimer = null;

    function clamp(value, min, max) {
      return Math.max(min, Math.min(max, value));
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

    function clearFightIndicators() {
      if (!Array.isArray(opponentFightDiceEls)) return;
      opponentFightDiceEls.forEach(function (el) {
        renderDie(el, null, null);
        if (el) {
          el.classList.remove("die--staged", "die--draggable");
          el.dataset.dieIndex = "";
        }
      });
    }

    function stopFightCycle() {
      if (fightCycleTimer !== null) {
        clearInterval(fightCycleTimer);
        fightCycleTimer = null;
      }
    }

    function randomFightPip() {
      return Math.floor(Math.random() * 6) + 1;
    }

    function renderFightIndicators() {
      const fight = st.lastState && st.lastState.phase === "fight" ? st.lastState.fight : null;
      if (!fight || !Array.isArray(opponentFightDiceEls) || opponentFightDiceEls.length < 2) {
        stopFightCycle();
        hideTurnRollIndicator();
        clearFightIndicators();
        if (opponentFightTrayEl) {
          opponentFightTrayEl.classList.add("hidden");
          opponentFightTrayEl.setAttribute("aria-hidden", "true");
        }
        return;
      }

      if (opponentFightTrayEl) {
        opponentFightTrayEl.classList.remove("hidden");
        opponentFightTrayEl.setAttribute("aria-hidden", "false");
      }

      const attackerCount = fight.attacker_die_count === 2 ? 2 : 1;
      const defenderCount = fight.defender_die_count === 2 ? 2 : 1;
      const attackerDice = Array.isArray(fight.attacker_dice) ? fight.attacker_dice : null;
      const defenderDice = Array.isArray(fight.defender_dice) ? fight.defender_dice : null;
      const myRole = st.myRole;
      const myIsAttacker = fight.attacker === myRole;
      const myCount = myIsAttacker ? attackerCount : defenderCount;
      const myDice = myIsAttacker ? attackerDice : defenderDice;
      const myColorRole = myRole;
      const oppCount = myIsAttacker ? defenderCount : attackerCount;
      const oppDice = myIsAttacker ? defenderDice : attackerDice;
      const oppColorRole = myIsAttacker ? fight.defender : fight.attacker;
      const myPending = myDice === null;
      const oppPending = oppDice === null;

      function sideValue(dice, count, slotIndex, pending) {
        if (slotIndex >= count) return null;
        if (Array.isArray(dice) && Number.isInteger(dice[slotIndex])) {
          return dice[slotIndex];
        }
        if (!pending) return null;
        return randomFightPip();
      }

      renderDie(diceEls[0], sideValue(myDice, myCount, 0, myPending), myColorRole);
      renderDie(diceEls[1], sideValue(myDice, myCount, 1, myPending), myColorRole);
      renderDie(
        opponentFightDiceEls[0],
        sideValue(oppDice, oppCount, 0, oppPending),
        oppColorRole
      );
      renderDie(
        opponentFightDiceEls[1],
        sideValue(oppDice, oppCount, 1, oppPending),
        oppColorRole
      );

      const pending = myPending || oppPending;
      if (pending && fightCycleTimer === null) {
        fightCycleTimer = setInterval(function () {
          const stillFight =
            !!st.lastState &&
            st.lastState.phase === "fight" &&
            !!st.lastState.fight;
          if (!stillFight) {
            stopFightCycle();
            return;
          }
          renderFightIndicators();
        }, 140);
      } else if (!pending) {
        stopFightCycle();
      }
    }

    function renderDice() {
      const dice = st.lastState && Array.isArray(st.lastState.dice) ? st.lastState.dice : null;
      const fight = st.lastState && st.lastState.phase === "fight" ? st.lastState.fight : null;

      if (fight) {
        renderFightIndicators();
        return;
      }

      stopFightCycle();
      if (opponentFightTrayEl) {
        opponentFightTrayEl.classList.add("hidden");
        opponentFightTrayEl.setAttribute("aria-hidden", "true");
      }

      if (!dice || st.lastState.phase !== "select") {
        hideTurnRollIndicator();
        return;
      }
      const staged = Array.isArray(st.lastState.staged) ? st.lastState.staged : [];
      const stagedDice = staged.map(function (s) { return s[1]; });
      for (let i = 0; i < diceEls.length; i++) {
        const el = diceEls[i];
        renderDie(el, dice[i], st.lastState.turn);
        const assigned = stagedDice.indexOf(i) !== -1;
        el.classList.toggle("die--staged", assigned);
        const mine = st.lastState.turn === st.myRole && !st.inputLocked;
        el.classList.toggle("die--draggable", mine);
        el.dataset.dieIndex = String(i);
      }
    }

    function setTurnRollIndicator() {
      renderDice();
    }

    function stopRollCycle() {
      if (st.rollCycleTimer !== null) {
        clearInterval(st.rollCycleTimer);
        st.rollCycleTimer = null;
      }
      st.rollCycleRole = null;
    }

    function startRollCycle(role) {
      st.rollCycleRole = role;
      const showRandomFaces = function () {
        renderDie(diceEls[0], Math.floor(Math.random() * 6) + 1, role);
        renderDie(diceEls[1], Math.floor(Math.random() * 6) + 1, role);
      };
      showRandomFaces();
      if (st.rollCycleTimer !== null) {
        clearInterval(st.rollCycleTimer);
      }
      st.rollCycleTimer = setInterval(showRandomFaces, 150);
    }

    function setCubeRotation(rotX, rotY) {
      if (!dieCubeEl) return;
      dieCubeEl.style.transform =
        "rotateX(" + rotX + "deg) rotateY(" + rotY + "deg)";
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
      st.depthRafId = requestAnimationFrame(depthShadingTick);
    }

    function startDepthShading() {
      if (st.depthRafId !== null || dieFaceData.length === 0) return;
      depthShadingTick();
    }

    function stopDepthShading() {
      if (st.depthRafId !== null) {
        cancelAnimationFrame(st.depthRafId);
        st.depthRafId = null;
      }
    }

    function clearDieAnimation() {
      if (!dieCubeEl) return;
      if (st.dieTransitionHandler) {
        dieCubeEl.removeEventListener("transitionend", st.dieTransitionHandler);
        st.dieTransitionHandler = null;
      }
      if (st.dieTransitionFallbackId !== null) {
        clearTimeout(st.dieTransitionFallbackId);
        st.dieTransitionFallbackId = null;
      }
    }

    function setDieColor(role) {
      [dieEl, die2El].forEach(function (el) {
        if (!el) return;
        el.classList.remove("die--red", "die--blue");
        if (role === "host") el.classList.add("die--red");
        else if (role === "guest") el.classList.add("die--blue");
      });
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
        st.dieTransitionFallbackId = setTimeout(function () {
          st.dieTransitionFallbackId = null;
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

      st.dieTransitionHandler = function (event) {
        if (event.propertyName !== "transform") return;
        clearDieAnimation();
        dieCubeEl.style.transition = "none";
        setCubeRotation(finalOrientation.x, finalOrientation.y);
        updateDepthShading();
        stopDepthShading();
        dieEl.classList.remove("die--rolling-geometry");
        if (onDone) onDone();
      };
      dieCubeEl.addEventListener("transitionend", st.dieTransitionHandler);

      st.dieTransitionFallbackId = setTimeout(function () {
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

    function animate3dDice(dice, role, onDone) {
      setDieColor(role);
      const cubes = [];
      if (Number.isInteger(dice[0])) {
        cubes.push({ el: dieEl, cube: dieCubeEl, face: dice[0] });
      }
      if (Number.isInteger(dice[1])) {
        cubes.push({ el: die2El, cube: die2CubeEl, face: dice[1] });
      }
      if (!Number.isInteger(dice[1])) {
        hideCube(die2El, die2CubeEl);
      }
      [dieEl, die2El].forEach(function (el) {
        if (!el) return;
        el.classList.remove("die--solo");
      });
      if (cubes.length === 1 && cubes[0].el) {
        cubes[0].el.classList.add("die--solo");
      }
      if (cubes.length === 0) {
        hide3dDice();
        if (onDone) onDone();
        return;
      }
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
      [dieEl, die2El].forEach(function (el) {
        if (!el) return;
        el.classList.remove("die--solo");
      });
      hideCube(dieEl, dieCubeEl);
      hideCube(die2El, die2CubeEl);
    }

    function animateDiceRoll(dice, role, onDone, opts) {
      stopRollCycle();
      hideTurnRollIndicator();
      animate3dDice(dice, role, function () {
        hide3dDice();
        if (!(opts && opts.skipTrayRender)) {
          renderDie(diceEls[0], dice[0], role);
          renderDie(diceEls[1], dice[1], role);
        }
        if (onDone) onDone();
      });
    }

    return {
      renderDie: renderDie,
      hideDieFace: hideDieFace,
      hideTurnRollIndicator: hideTurnRollIndicator,
      renderDice: renderDice,
      setTurnRollIndicator: setTurnRollIndicator,
      stopRollCycle: stopRollCycle,
      startRollCycle: startRollCycle,
      setCubeRotation: setCubeRotation,
      resetDepthShading: resetDepthShading,
      getCubeMatrix: getCubeMatrix,
      updateDepthShading: updateDepthShading,
      depthShadingTick: depthShadingTick,
      startDepthShading: startDepthShading,
      stopDepthShading: stopDepthShading,
      clearDieAnimation: clearDieAnimation,
      setDieColor: setDieColor,
      isDieRolling: isDieRolling,
      hideDie: hideDie,
      animateRoll: animateRoll,
      showCube: showCube,
      hideCube: hideCube,
      animate3dDice: animate3dDice,
      hide3dDice: hide3dDice,
      animateDiceRoll: animateDiceRoll,
    };
  };
})();
