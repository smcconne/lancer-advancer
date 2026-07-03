// Artwork loading and derived canvases shared by board rendering.
(function () {
  "use strict";

  const Game = (window.Game = window.Game || {});
  const constants = Game.constants;
  if (!constants) {
    throw new Error("Game constants must load before assets.js");
  }

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

  const assets = {
    makeSilhouette: makeSilhouette,
    initialized: false,

    lanceBgReady: false,
    lanceBgBlackCanvas: null,
    lanceBgImg: new Image(),

    lanceBattleReady: false,
    lanceBattleBlackCanvas: null,
    lanceBattleImg: new Image(),

    clashReady: false,
    clashBlackCanvas: null,
    clashImg: new Image(),

    helmetBgReady: false,
    helmetBgBlackCanvas: null,
    helmetBgImg: new Image(),

    checkBgReady: false,
    checkBgBlackCanvas: null,
    checkBgImg: new Image(),

    victoryReady: false,
    victoryBlackCanvas: null,
    victoryBlackDataUrl: "",
    victoryImg: new Image(),

    defeatReady: false,
    defeatBlackCanvas: null,
    defeatBlackDataUrl: "",
    defeatImg: new Image(),

    knightUpDarkCanvas: null,
    knightUpWhiteCanvas: null,
    knightUpImg: new Image(),

    knightDownDarkCanvas: null,
    knightDownWhiteCanvas: null,
    knightDownImg: new Image(),
  };

  assets.ensureLoaded = function (onAssetReady) {
    if (assets.initialized) return;
    assets.initialized = true;

    const notify = function () {
      if (typeof onAssetReady === "function") {
        onAssetReady();
      }
    };

    assets.lanceBgImg.onload = function () {
      assets.lanceBgBlackCanvas = makeSilhouette(assets.lanceBgImg);
      assets.lanceBgReady = true;
      notify();
    };
    if (window.LANCE_BG_URL) {
      assets.lanceBgImg.src = window.LANCE_BG_URL;
    }

    assets.lanceBattleImg.onload = function () {
      assets.lanceBattleBlackCanvas = null;
      assets.lanceBattleReady = true;
      notify();
    };
    if (window.LANCE_BATTLE_URL) {
      assets.lanceBattleImg.src = window.LANCE_BATTLE_URL;
    }

    assets.clashImg.onload = function () {
      assets.clashBlackCanvas = null;
      assets.clashReady = true;
      notify();
    };
    if (window.CLASH_URL) {
      assets.clashImg.src = window.CLASH_URL;
    }

    assets.helmetBgImg.onload = function () {
      assets.helmetBgBlackCanvas = makeSilhouette(assets.helmetBgImg);
      assets.helmetBgReady = true;
      notify();
    };
    if (window.HELMET_BG_URL) {
      assets.helmetBgImg.src = window.HELMET_BG_URL;
    }

    assets.checkBgImg.onload = function () {
      assets.checkBgBlackCanvas = makeSilhouette(assets.checkBgImg);
      assets.checkBgReady = true;
      notify();
    };
    if (window.CHECK_BG_URL) {
      assets.checkBgImg.src = window.CHECK_BG_URL;
    }

    assets.victoryImg.onload = function () {
      assets.victoryBlackCanvas = makeSilhouette(assets.victoryImg, "#000");
      if (assets.victoryBlackCanvas) {
        assets.victoryBlackDataUrl = assets.victoryBlackCanvas.toDataURL("image/png");
      }
      assets.victoryReady = true;
      notify();
    };
    if (window.VICTORY_URL) {
      assets.victoryImg.src = window.VICTORY_URL;
    }

    assets.defeatImg.onload = function () {
      assets.defeatBlackCanvas = makeSilhouette(assets.defeatImg, "#000");
      if (assets.defeatBlackCanvas) {
        assets.defeatBlackDataUrl = assets.defeatBlackCanvas.toDataURL("image/png");
      }
      assets.defeatReady = true;
      notify();
    };
    if (window.DEFEAT_URL) {
      assets.defeatImg.src = window.DEFEAT_URL;
    }

    assets.knightUpImg.onload = function () {
      assets.knightUpDarkCanvas = makeSilhouette(
        assets.knightUpImg,
        constants.COLORS.diskOutline
      );
      assets.knightUpWhiteCanvas = makeSilhouette(
        assets.knightUpImg,
        constants.COLORS.diskGuestOutline
      );
      notify();
    };
    if (window.KNIGHT_LANCE_UP_URL) {
      assets.knightUpImg.src = window.KNIGHT_LANCE_UP_URL;
    }

    assets.knightDownImg.onload = function () {
      assets.knightDownDarkCanvas = makeSilhouette(
        assets.knightDownImg,
        constants.COLORS.diskOutline
      );
      assets.knightDownWhiteCanvas = makeSilhouette(
        assets.knightDownImg,
        constants.COLORS.diskGuestOutline
      );
      notify();
    };
    if (window.KNIGHT_LANCE_DOWN_URL) {
      assets.knightDownImg.src = window.KNIGHT_LANCE_DOWN_URL;
    }
  };

  Game.assets = assets;
})();
