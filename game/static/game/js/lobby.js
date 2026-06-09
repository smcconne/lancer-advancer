// Lobby: maintain an anonymous identity, show open rooms live, and host a game.
(function () {
  "use strict";

  // Stable anonymous id for this browser, reused across lobby and game pages.
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
  const listEl = document.getElementById("room-list");
  const hostBtn = document.getElementById("host-btn");

  // ---- Render the list of joinable rooms ----
  function renderRooms(rooms) {
    listEl.textContent = "";
    if (!rooms.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No open rooms yet.";
      listEl.appendChild(li);
      return;
    }
    for (const room of rooms) {
      const li = document.createElement("li");

      const idSpan = document.createElement("span");
      idSpan.className = "room-id";
      idSpan.textContent = "Room " + room.id;

      const joinLink = document.createElement("a");
      joinLink.className = "btn btn-primary";
      joinLink.href = "/" + encodeURIComponent(room.id);
      joinLink.textContent = "Join";

      li.appendChild(idSpan);
      li.appendChild(joinLink);
      listEl.appendChild(li);
    }
  }

  // ---- Live lobby socket ----
  function connect() {
    const socket = new WebSocket(wsUrl("/ws/lobby/"));
    socket.onmessage = function (event) {
      const data = JSON.parse(event.data);
      if (data.type === "rooms") {
        renderRooms(data.rooms);
      }
    };
    // Reconnect if the socket drops (e.g. server restart).
    socket.onclose = function () {
      setTimeout(connect, 1500);
    };
  }
  connect();

  // ---- Host a new room ----
  hostBtn.addEventListener("click", async function () {
    hostBtn.disabled = true;
    try {
      const response = await fetch("/host", {
        method: "POST",
        headers: {
          "X-CSRFToken": window.CSRF_TOKEN,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token: token }).toString(),
      });
      if (!response.ok) {
        throw new Error("Failed to create room");
      }
      const data = await response.json();
      location.assign("/" + encodeURIComponent(data.room_id));
    } catch (err) {
      hostBtn.disabled = false;
      alert("Could not host a game. Please try again.");
    }
  });
})();
