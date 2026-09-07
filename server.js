const express = require("express");
const path = require("path");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const API_WS = "wss://developer.mig33.id/developer/ws";

// In-memory sessions. Credentials are never written to disk.
const sessions = new Map();

function id() {
  return crypto.randomBytes(16).toString("hex");
}

function safeError(err) {
  return String(err?.message || err || "Unknown error");
}

function connectAccount(username, password) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(API_WS);
    const sessionId = id();
    let opened = false;
    let settled = false;

    const finishReject = (err) => {
      if (!settled) {
        settled = true;
        try { socket.close(); } catch {}
        reject(err);
      }
    };

    socket.on("open", () => {
      opened = true;
      socket.send(JSON.stringify({
        type: "developer.login",
        username,
        password
      }));
    });

    socket.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch { return; }

      if (msg.type === "auth.required") return;

      if (msg.type === "session.ready") {
        if (settled) return;
        settled = true;

        const account = {
          sessionId,
          username,
          socket,
          connectedAt: Date.now(),
          lastMessage: null
        };
        sessions.set(sessionId, account);

        socket.on("close", () => {
          if (sessions.get(sessionId)?.socket === socket) sessions.delete(sessionId);
        });

        // Keep-alive every 40 seconds as required by the API.
        account.pingTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "ping" }));
          }
        }, 40000);

        resolve({
          sessionId,
          username,
          permissions: msg.data?.developer?.permissions || [],
          wallet: msg.data?.wallet || msg.data?.developer?.wallet || null
        });
        return;
      }

      if (msg.type === "error") {
        finishReject(new Error(msg.data?.message || msg.data?.error || "Login failed"));
      }
    });

    socket.on("error", finishReject);

    setTimeout(() => {
      if (!settled) finishReject(new Error("Login timeout"));
    }, 15000);
  });
}

function send(sessionId, payload) {
  const account = sessions.get(sessionId);
  if (!account) throw new Error("Session tidak ditemukan / sudah terputus.");
  if (account.socket.readyState !== WebSocket.OPEN) {
    throw new Error("WebSocket tidak terhubung.");
  }
  account.socket.send(JSON.stringify(payload));
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "MIG Duel Kick 10", activeSessions: sessions.size });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, error: "Username dan password wajib diisi." });

  try {
    const result = await connectAccount(String(username).trim(), String(password));
    res.json({ ok: true, account: result });
  } catch (e) {
    res.status(401).json({ ok: false, error: safeError(e) });
  }
});

app.post("/api/action", (req, res) => {
  const { sessionId, action, room, targetUsername, message } = req.body || {};
  if (!sessionId || !action) return res.status(400).json({ ok: false, error: "Parameter tidak lengkap." });

  try {
    if (action === "join") {
      if (!room) throw new Error("Room wajib diisi.");
      send(sessionId, { type: "room.join", room });
    } else if (action === "leave") {
      if (!room) throw new Error("Room wajib diisi.");
      send(sessionId, { type: "room.leave", room });
    } else if (action === "participants") {
      if (!room) throw new Error("Room wajib diisi.");
      send(sessionId, { type: "room.participants", room });
    } else if (action === "kick") {
      if (!room || !targetUsername) throw new Error("Room dan target wajib diisi.");
      send(sessionId, { type: "room.kick", room, target_username: targetUsername });
    } else if (action === "message") {
      if (!room || !message) throw new Error("Room dan pesan wajib diisi.");
      send(sessionId, { type: "room.send_message", room, message });
    } else if (action === "balance") {
      send(sessionId, { type: "wallet.balance" });
    } else {
      throw new Error("Action tidak dikenal.");
    }

    res.json({ ok: true, sent: action });
  } catch (e) {
    res.status(400).json({ ok: false, error: safeError(e) });
  }
});

app.post("/api/logout", (req, res) => {
  const { sessionId } = req.body || {};
  const account = sessions.get(sessionId);
  if (account) {
    clearInterval(account.pingTimer);
    try { account.socket.close(); } catch {}
    sessions.delete(sessionId);
  }
  res.json({ ok: true });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`MIG Duel Kick 10 running on port ${PORT}`);
});