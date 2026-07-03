// Shared DOM bindings used by game room scripts.
(function () {
  "use strict";

  const Game = (window.Game = window.Game || {});
  const constants = Game.constants;
  if (!constants) {
    throw new Error("Game constants must load before dom.js");
  }

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
      const normal = constants.BASE_FACE_NORMALS[faceNum];
      if (!normal) return null;
      return { element: faceEl, normal: normal };
    })
    .filter(Boolean);

  const diceEls = [
    document.getElementById("turn-roll-indicator"),
    document.getElementById("turn-roll-indicator-2"),
  ];

  const opponentFightDiceEls = [
    document.getElementById("opponent-fight-roll-indicator-0"),
    document.getElementById("opponent-fight-roll-indicator-1"),
  ];

  Game.dom = {
    canvas: document.getElementById("board"),
    ctx: document.getElementById("board").getContext("2d"),
    statusEl: document.getElementById("status"),
    turnBtn: document.getElementById("turn-btn"),
    passBtn: document.getElementById("pass-btn"),
    resignBtn: document.getElementById("resign-btn"),
    diceTrayEl: document.getElementById("dice-tray"),
    opponentFightTrayEl: document.getElementById("opponent-fight-tray"),
    diceEls: diceEls,
    opponentFightDiceEls: opponentFightDiceEls,
    dieEl: dieEl,
    dieCubeEl: dieCubeEl,
    die2El: die2El,
    die2CubeEl: die2CubeEl,
    reduceMotionQuery: window.matchMedia
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null,
    overlay: document.getElementById("overlay"),
    overlayIcon: document.getElementById("overlay-icon"),
    overlayTitle: document.getElementById("overlay-title"),
    overlayText: document.getElementById("overlay-text"),
    dieFaceData: dieFaceData,
  };
})();
