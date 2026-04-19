const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 1e8
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_, res) =>
  res.sendFile(path.join(__dirname, "public/index.html"))
);

app.get("/room", (_, res) =>
  res.sendFile(path.join(__dirname, "public/room.html"))
);

/* ================= AI ROUTE ================= */
app.post("/api/ai", async (req, res) => {
  try {
    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: "Missing GROQ_API_KEY in .env" });
    }

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + process.env.GROQ_API_KEY
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: req.body.prompt }]
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({
        error: data.error?.message || "AI request failed"
      });
    }

    res.json({
      content: [
        {
          type: "text",
          text: data.choices?.[0]?.message?.content || "No response"
        }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= DATA ================= */
const rooms = {};

function getRoom(id) {
  if (!rooms[id]) {
    rooms[id] = {
      hostId: null,
      locked: false,
      password: null,
      users: {},
      waiting: {},
      attendance: []
    };
  }
  return rooms[id];
}

function usersList(roomId) {
  const r = rooms[roomId];
  if (!r) return [];

  return Object.values(r.users).map((u) => ({
    id: u.id,
    name: u.name,
    isHost: u.id === r.hostId
  }));
}

function refreshUsers(roomId) {
  io.to(roomId).emit("update-users", usersList(roomId));
}

/* ================= SOCKET ================= */
io.on("connection", (socket) => {
  socket.on("check-password", ({ room, password }) => {
    const r = rooms[room];
    if (!r || !r.password || r.password === password) {
      socket.emit("password-ok");
    } else {
      socket.emit("password-fail");
    }
  });

  socket.on("join-room", ({ room, name }) => {
    const r = getRoom(room);

    socket.roomId = room;
    socket.userName = name;

    if (!r.hostId) {
      r.hostId = socket.id;
      joinNow(socket, room, name);
      socket.emit("your-role", { isHost: true });
      return;
    }

    if (r.locked) {
      socket.emit("rejected");
      return;
    }

    r.waiting[socket.id] = { id: socket.id, name };
    socket.emit("in-waiting-room");
    io.to(r.hostId).emit("waiting-user", {
      id: socket.id,
      name
    });
  });
function joinNow(target, room, name) {
  const r = getRoom(room);

  target.join(room);

  r.users[target.id] = {
    id: target.id,
    name
  };

  r.attendance.push({
    name,
    action: "joined",
    time: new Date().toLocaleTimeString()
  });

  target.emit("admitted");
  target.emit("room-state", { locked: r.locked });

  refreshUsers(room);

  /* existing users see new user */
  target.to(room).emit("user-joined", {
    id: target.id,
    name
  });

  /* new user sees old users */
  Object.values(r.users).forEach((u) => {
    if (u.id !== target.id) {
      target.emit("user-joined", {
        id: u.id,
        name: u.name
      });
    }
  });
}
  socket.on("admit-user", ({ userId }) => {
    const r = rooms[socket.roomId];
    if (!r || r.hostId !== socket.id) return;

    const pending = r.waiting[userId];
    if (!pending) return;

    const target = io.sockets.sockets.get(userId);
    if (!target) return;

    delete r.waiting[userId];
    joinNow(target, socket.roomId, pending.name);
  });

  socket.on("reject-user", ({ userId }) => {
    const r = rooms[socket.roomId];
    if (!r || r.hostId !== socket.id) return;

    delete r.waiting[userId];
    io.to(userId).emit("rejected");
  });

  /* ========= HOST CONTROLS ========= */

  socket.on("host-mute", ({ room, userId }) => {
    const r = rooms[room];
    if (!r || r.hostId !== socket.id) return;

    io.to(userId).emit("force-mute");
  });

  socket.on("host-kick", ({ room, userId }) => {
    const r = rooms[room];
    if (!r || r.hostId !== socket.id) return;

    io.to(userId).emit("force-kick");

    const target = io.sockets.sockets.get(userId);
    if (target) target.disconnect(true);
  });

  socket.on("lock-room", (locked) => {
    const r = rooms[socket.roomId];
    if (!r || r.hostId !== socket.id) return;

    r.locked = locked;
    io.to(socket.roomId).emit("room-locked", locked);
  });

  socket.on("set-password", ({ room, password }) => {
    const r = rooms[room];
    if (!r || r.hostId !== socket.id) return;

    r.password = password || null;
  });

  socket.on("chat", ({ text }) => {
    io.to(socket.roomId).emit("chat", {
      user: socket.userName,
      text,
      system: false
    });
  });


  socket.on("get-attendance", () => {
  const room = socket.roomId;
  const r = rooms[room];

  if (!r) {
    socket.emit("attendance-data", []);
    return;
  }

  socket.emit("attendance-data", r.attendance || []);
});

  socket.on("signal", ({ to, signal }) => {
    io.to(to).emit("signal", {
      from: socket.id,
      signal,
      name: socket.userName
    });
  });

  socket.on("disconnect", () => {
    const room = socket.roomId;
    const r = rooms[room];
    if (!r) return;
r.attendance.push({
  name: socket.userName || "Unknown",
  action: "left",
  time: new Date().toLocaleTimeString()
});
    delete r.waiting[socket.id];

    if (r.users[socket.id]) {
      delete r.users[socket.id];
      socket.to(room).emit("user-disconnected", socket.id);
      refreshUsers(room);
    }

    if (r.hostId === socket.id) {
      const next = Object.keys(r.users)[0];
      if (next) {
        r.hostId = next;
        io.to(next).emit("your-role", { isHost: true });
      } else {
        delete rooms[room];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("✅ Running http://localhost:" + PORT);
});