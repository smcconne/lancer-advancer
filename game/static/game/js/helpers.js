// Shared utility helpers for board coordinates and common state access.
(function () {
  "use strict";

  const Game = (window.Game = window.Game || {});
  const constants = Game.constants;
  if (!constants) {
    throw new Error("Game constants must load before helpers.js");
  }

  function toLocalForRole(r, c, role) {
    if (role === "guest") {
      return [constants.ROWS - 1 - r, constants.COLS - 1 - c];
    }
    return [r, c];
  }

  function toCanonicalForRole(r, c, role) {
    if (role === "guest") {
      return [constants.ROWS - 1 - r, constants.COLS - 1 - c];
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

  function cellCenter(pos, role) {
    const local = toLocalForRole(pos[0], pos[1], role);
    return {
      x: local[1] * constants.CELL + constants.CELL / 2,
      y: local[0] * constants.CELL + constants.CELL / 2,
    };
  }

  function roundedRectPath(ctx, x, y, width, height, radius) {
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
    return role === "host" ? constants.COLORS.red : constants.COLORS.blue;
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

  Game.helpers = {
    toLocalForRole: toLocalForRole,
    toCanonicalForRole: toCanonicalForRole,
    isCell: isCell,
    sameCell: sameCell,
    cellCenter: cellCenter,
    roundedRectPath: roundedRectPath,
    moverColor: moverColor,
    roleDisks: roleDisks,
    pieceCell: pieceCell,
  };
})();
