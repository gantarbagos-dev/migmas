const express = require("express");
const path = require("path");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
// Official MigReborn Developer WebSocket endpoint documented at mig33.id/api.html
const API_WS = "wss://developer.mig33.id/developer/ws";

// Runtime-only sessions. Credentials are never written to disk.
const sessions = new Map();
const subscribers = new Map(); // sessionId -> Set(res)

function makeId() {
  return crypto.randomBytes(16).toString("hex");
}

function safeError(err) {
  return String(err?.message || err || "Unknown error");
}

function publish(sessionId, msg) {
  const set = subscribers.get(sessionId);
  if (!set) return;
  const payload = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of set) {
    try { res.write(payload); } catch {}
  }
}

function removeSession(sessionId) {
  const account = sessions.get(sessionId);
  if (account?.pingTimer) clearInterval(account.pingTimer);
  sessions.delete(sessionId);
  const set = subscribers.get(sessionId);
  if (set) {
    for (const res of set) {
      try { res.end(); } catch {}
    }
    subscribers.delete(sessionId);
  }
}

function connectAccount(username, password) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(API_WS);
    const sessionId = makeId();
    let settled = false;

    const finishReject = (err) => {
      if (!settled) {
        settled = true;
        try { socket.close(); } catch {}
        reject(err);
      }
    };

    socket.on("open", () => {
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

      // Keep API responses/events available to the web UI without inventing
      // an API response schema that is not documented by MigReborn.
      publish(sessionId, { type: "api.event", event: msg });

      if (msg.type === "auth.required") return;

      if (msg.type === "session.ready") {
        if (settled) return;
        settled = true;

        const account = {
          sessionId,
          username,
          socket,
          connectedAt: Date.now(),
          lastEvent: null,
          joinedRoom: null
        };
        sessions.set(sessionId, account);

        socket.on("close", () => {
          if (sessions.get(sessionId)?.socket === socket) {
            publish(sessionId, { type: "session.closed", reason: "WebSocket closed" });
            removeSession(sessionId);
          }
        });

        socket.on("error", (err) => {
          publish(sessionId, { type: "session.error", error: safeError(err) });
        });

        // Official API requires ping at least every 30–50 seconds and closes
        // connections after 60 seconds without a ping.
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

      if (msg.type === "room.join.result" && msg.data?.room) {
        const account = sessions.get(sessionId);
        if (account) account.joinedRoom = msg.data.room;
      }

      if (msg.type === "error" && !settled) {
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
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: "Username dan password wajib diisi." });
  }
  try {
    const result = await connectAccount(String(username).trim(), String(password));
    res.json({ ok: true, account: result });
  } catch (e) {
    res.status(401).json({ ok: false, error: safeError(e) });
  }
});

// Browser event stream for the already-authenticated session.
app.get("/api/events", (req, res) => {
  const sessionId = String(req.query.sessionId || "");
  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(401).end();
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  if (!subscribers.has(sessionId)) subscribers.set(sessionId, new Set());
  subscribers.get(sessionId).add(res);
  res.write(`data: ${JSON.stringify({ type: "stream.ready" })}\n\n`);

  const keepAlive = setInterval(() => {
    try { res.write(": keep-alive\n\n"); } catch {}
  }, 20000);

  req.on("close", () => {
    clearInterval(keepAlive);
    const set = subscribers.get(sessionId);
    if (set) {
      set.delete(res);
      if (!set.size) subscribers.delete(sessionId);
    }
  });
});

app.post("/api/action", (req, res) => {
  const { sessionId, action, room, targetUsername, message } = req.body || {};
  if (!sessionId || !action) {
    return res.status(400).json({ ok: false, error: "Parameter tidak lengkap." });
  }

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
    removeSession(sessionId);
  }
  res.json({ ok: true });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`MIG Duel Kick 10 running on port ${PORT}`);
});
