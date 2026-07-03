// Session/bootstrap state for the room page.
(function () {
  "use strict";

  const Game = (window.Game = window.Game || {});

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

  Game.session = {
    getToken: getToken,
    wsUrl: wsUrl,
    token: getToken(),
    roomId: window.ROOM_ID,
    pageBuildId: window.SERVER_BUILD_ID || "",
  };
})();
