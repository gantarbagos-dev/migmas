const express = require("express");
const path = require("path");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "128kb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const API_WS = "wss://developer.mig33.id/developer/ws";

// One authenticated MigReborn account = one WebSocket, as required by the official API.
// The UI can issue ONE batch command that dispatches concurrently to up to 10 sockets.
const sessions = new Map();
const subscribers = new Map();
const eventHistory = new Map();
const MAX_EVENT_HISTORY = 500;
const kickJobWaiters = new Map();
const kickExecutions = new Map();

function makeId() { return crypto.randomBytes(16).toString("hex"); }
function safeError(err) { return String(err?.message || err || "Unknown error"); }

function publish(sessionId, msg) {
  if (!eventHistory.has(sessionId)) eventHistory.set(sessionId, []);
  const history = eventHistory.get(sessionId);
  history.push(msg);
  if (history.length > MAX_EVENT_HISTORY) history.shift();
  const set = subscribers.get(sessionId);
  if (!set) return;
  const payload = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of set) {
    try { res.write(payload); } catch {}
  }
}

function closeSession(sessionId, reason = "logout") {
  const account = sessions.get(sessionId);
  if (!account) return false;
  if (account.pingTimer) clearInterval(account.pingTimer);
  try { if (account.socket.readyState === WebSocket.OPEN) account.socket.close(1000, reason); } catch {}
  sessions.delete(sessionId);
  const set = subscribers.get(sessionId);
  if (set) {
    for (const res of set) { try { res.end(); } catch {} }
    subscribers.delete(sessionId);
  }
  eventHistory.delete(sessionId);
  return true;
}

function connectAccount(username, password) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(API_WS);
    const sessionId = makeId();
    let settled = false;
    let timeout;

    const finishReject = (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        try { socket.close(); } catch {}
        reject(err);
      }
    };

    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "developer.login", username, password }));
    });

    socket.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      resolveKickQueued(sessionId, msg);

      const accountForEvent = sessions.get(sessionId);
      const countdownSignal = detectKickCountdown(msg, accountForEvent);
      if (countdownSignal) publish(sessionId, countdownSignal);

      publish(sessionId, { type: "api.event", event: msg });

      if (msg.type === "auth.required") return;

      if (msg.type === "session.ready") {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);

        const account = {
          sessionId,
          username,
          socket,
          connectedAt: Date.now(),
          joinedRoom: null,
          pingTimer: null
        };
        sessions.set(sessionId, account);

        socket.on("close", () => {
          if (sessions.get(sessionId)?.socket === socket) {
            publish(sessionId, { type: "session.closed", reason: "WebSocket closed" });
            closeSession(sessionId, "socket closed");
          }
        });
        socket.on("error", (err) => publish(sessionId, { type: "session.error", error: safeError(err) }));

        account.pingTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            try { socket.send(JSON.stringify({ type: "ping" })); } catch {}
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
    timeout = setTimeout(() => finishReject(new Error("Login timeout")), 15000);
  });
}

function send(sessionId, payload) {
  const account = sessions.get(sessionId);
  if (!account) throw new Error("Session tidak ditemukan / sudah terputus.");
  if (account.socket.readyState !== WebSocket.OPEN) throw new Error("WebSocket tidak terhubung.");
  account.socket.send(JSON.stringify(payload));
}

function waitForKickQueued(sessionId, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const list = kickJobWaiters.get(sessionId) || [];
      const index = list.indexOf(entry);
      if (index >= 0) list.splice(index, 1);
      if (list.length) kickJobWaiters.set(sessionId, list);
      else kickJobWaiters.delete(sessionId);
      reject(new Error("Timeout menunggu room.kick.queued."));
    }, timeoutMs);
    const entry = { resolve, reject, timer };
    const list = kickJobWaiters.get(sessionId) || [];
    list.push(entry);
    kickJobWaiters.set(sessionId, list);
  });
}

function resolveKickQueued(sessionId, msg) {
  if (msg?.type !== "room.kick.queued") return false;
  const list = kickJobWaiters.get(sessionId);
  if (!list?.length) return false;
  const entry = list.shift();
  clearTimeout(entry.timer);
  if (list.length) kickJobWaiters.set(sessionId, list);
  else kickJobWaiters.delete(sessionId);
  const jobId = msg?.data?.job?.job_id ?? msg?.job_id ?? null;
  entry.resolve(jobId);
  return true;
}

function getActiveSessionIds() { return [...sessions.keys()]; }

function extractEventText(value, depth = 0) {
  if (depth > 10 || value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return "";
  if (Array.isArray(value)) {
    return value.map(v => extractEventText(v, depth + 1)).join(" ");
  }
  return Object.values(value)
    .map(v => extractEventText(v, depth + 1))
    .filter(Boolean)
    .join(" ");
}

function detectKickCountdown(msg, account) {
  const text = extractEventText(msg);
  if (!/\bhas\s+been\s+started\s+by\b/i.test(text)) return null;
  const room = String(
    msg?.data?.room ?? msg?.data?.room_name ?? msg?.room ?? msg?.room_name ?? account?.joinedRoom ?? ""
  ).trim();
  return {
    type: "kick.countdown.start",
    room,
    seconds: Number.isFinite(Number(msg?.seconds)) ? Number(msg.seconds) : null,
    source: "backend"
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "MIG Duel Kick 10", activeSessions: sessions.size });
});

// Single-account login retained for individual Troop controls.
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

// ONE HTTP command opens the 10 required, separate WebSockets concurrently.
app.post("/api/login-batch", async (req, res) => {
  const input = Array.isArray(req.body?.accounts) ? req.body.accounts.slice(0, 10) : [];
  if (!input.length) return res.status(400).json({ ok: false, error: "Tidak ada Troop untuk login." });

  const jobs = input.map(async (item) => {
    const index = Number.isInteger(item?.index) ? item.index : input.indexOf(item);
    const username = String(item?.username || "").trim();
    const password = String(item?.password || "");
    if (!username || !password) return { index, ok: false, error: "Nama dan password kosong." };

    // Replace an existing session for the same Troop slot before reconnecting.
    const oldSessionId = String(item?.sessionId || "");
    if (oldSessionId) closeSession(oldSessionId, "relogin");

    try {
      const account = await connectAccount(username, password);
      return { index, ok: true, account };
    } catch (e) {
      return { index, ok: false, username, error: safeError(e) };
    }
  });

  const results = await Promise.all(jobs);
  res.json({ ok: results.some(x => x.ok), results });
});

function createKickExecution(meta) {
  const id = makeId();
  const execution = { id, meta, clients: new Set(), done: false, result: null, latest: { type: "kick.progress", phase: "created", ...meta, completedSteps: 0, totalSteps: Number(meta.totalSteps) || 0, percent: 0 } };
  kickExecutions.set(id, execution);
  setTimeout(() => {
    const current = kickExecutions.get(id);
    if (current && current.done) kickExecutions.delete(id);
  }, 10 * 60 * 1000);
  return execution;
}

function publishKickProgress(execution, event) {
  if (!execution) return;
  execution.latest = { type: "kick.progress", ...event };
  const payload = `data: ${JSON.stringify(execution.latest)}\n\n`;
  for (const res of execution.clients) { try { res.write(payload); } catch {} }
}

function finishKickExecution(execution, result) {
  if (!execution) return;
  execution.done = true;
  execution.result = result;
  publishKickProgress(execution, result);
  for (const res of execution.clients) { try { res.end(); } catch {} }
  execution.clients.clear();
}

app.get("/api/kick-progress-state", (req, res) => {
  const id = String(req.query.id || "");
  const execution = kickExecutions.get(id);
  if (!execution) return res.status(404).json({ ok: false, error: "Execution tidak ditemukan." });
  return res.json({ ok: true, executionId: id, done: execution.done, progress: execution.latest, result: execution.done ? execution.result : null });
});

app.get("/api/kick-progress", (req, res) => {
  const id = String(req.query.id || "");
  const execution = kickExecutions.get(id);
  if (!execution) return res.status(404).end();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  execution.clients.add(res);
  res.write(`data: ${JSON.stringify({ type: "kick.progress", phase: "connected", ...execution.meta })}\n\n`);
  if (execution.done) {
    res.write(`data: ${JSON.stringify(execution.result)}\n\n`);
    res.end();
    execution.clients.delete(res);
  }
  const keepAlive = setInterval(() => { try { res.write(": keep-alive\n\n"); } catch {} }, 15000);
  req.on("close", () => { clearInterval(keepAlive); execution.clients.delete(res); });
});

app.get("/api/events", (req, res) => {
  const sessionId = String(req.query.sessionId || "");
  if (!sessionId || !sessions.has(sessionId)) return res.status(401).end();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  if (!subscribers.has(sessionId)) subscribers.set(sessionId, new Set());
  subscribers.get(sessionId).add(res);
  res.write(`data: ${JSON.stringify({ type: "stream.ready" })}\n\n`);
  for (const oldEvent of (eventHistory.get(sessionId) || [])) {
    try { res.write(`data: ${JSON.stringify(oldEvent)}\n\n`); } catch {}
  }
  const keepAlive = setInterval(() => { try { res.write(": keep-alive\n\n"); } catch {} }, 20000);
  req.on("close", () => {
    clearInterval(keepAlive);
    const set = subscribers.get(sessionId);
    if (set) { set.delete(res); if (!set.size) subscribers.delete(sessionId); }
  });
});

// Single-account action retained for individual Troop controls.
app.post("/api/action", (req, res) => {
  const { sessionId, action, room, targetUsername, message } = req.body || {};
  if (!sessionId || !action) return res.status(400).json({ ok: false, error: "Parameter tidak lengkap." });
  try {
    if (action === "join") { if (!room) throw new Error("Room wajib diisi."); send(sessionId, { type: "room.join", room }); }
    else if (action === "leave") { if (!room) throw new Error("Room wajib diisi."); send(sessionId, { type: "room.leave", room }); }
    else if (action === "participants") { if (!room) throw new Error("Room wajib diisi."); send(sessionId, { type: "room.participants", room }); }
    else if (action === "kick") { if (!room || !targetUsername) throw new Error("Room dan target wajib diisi."); send(sessionId, { type: "room.kick", room, target_username: targetUsername }); }
    else if (action === "message") { if (!room || !message) throw new Error("Room dan pesan wajib diisi."); send(sessionId, { type: "room.send_message", room, message }); }
    else if (action === "balance") send(sessionId, { type: "wallet.balance" });
    else throw new Error("Action tidak dikenal.");
    res.json({ ok: true, sent: action });
  } catch (e) { res.status(400).json({ ok: false, error: safeError(e) }); }
});

// ONE HTTP command dispatches the same official command concurrently to up to 10 WebSockets.
app.post("/api/batch-action", (req, res) => {
  const { sessionIds, action, room, targetUsername, message } = req.body || {};
  const ids = Array.isArray(sessionIds) ? [...new Set(sessionIds.map(String))].slice(0, 10) : [];
  if (!ids.length || !action) return res.status(400).json({ ok: false, error: "Session atau action tidak lengkap." });

  let payload;
  if (action === "join") { if (!room) return res.status(400).json({ ok: false, error: "Room wajib diisi." }); payload = { type: "room.join", room }; }
  else if (action === "leave") { if (!room) return res.status(400).json({ ok: false, error: "Room wajib diisi." }); payload = { type: "room.leave", room }; }
  else if (action === "participants") { if (!room) return res.status(400).json({ ok: false, error: "Room wajib diisi." }); payload = { type: "room.participants", room }; }
  else if (action === "balance") payload = { type: "wallet.balance" };
  else if (action === "kick") { if (!room || !targetUsername) return res.status(400).json({ ok: false, error: "Room dan target wajib diisi." }); payload = { type: "room.kick", room, target_username: targetUsername }; }
  else if (action === "message") { if (!room || !message) return res.status(400).json({ ok: false, error: "Room dan pesan wajib diisi." }); payload = { type: "room.send_message", room, message }; }
  else return res.status(400).json({ ok: false, error: "Action tidak dikenal." });

  const results = [];
  for (const sessionId of ids) {
    try { send(sessionId, payload); results.push({ sessionId, ok: true }); }
    catch (e) { results.push({ sessionId, ok: false, error: safeError(e) }); }
  }
  res.json({ ok: results.some(x => x.ok), action, sent: results.filter(x => x.ok).length, total: results.length, results });
});


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

app.post("/api/kick-loop", async (req, res) => {
  const body = req.body || {};
  const { sessionIds, room, targets } = body;
  const textdelay = body.textdelay;
  const textloop = body.textloop;

  const ids = Array.isArray(sessionIds)
    ? [...new Set(sessionIds.map(String).filter(Boolean))].slice(0, 10)
    : [];
  const targetList = Array.isArray(targets)
    ? targets.map(x => String(x).trim()).filter(Boolean).slice(0, 10)
    : [];
  const delayMs = Math.max(0, Math.min(Number(textdelay) || 0, 86400000));
  const loopCount = Math.max(1, Math.min(parseInt(textloop, 10) || 1, 100));

  if (!ids.length) return res.status(400).json({ ok: false, error: "Tidak ada Troop yang ONLINE." });
  if (!room) return res.status(400).json({ ok: false, error: "Room wajib diisi." });
  if (!targetList.length) return res.status(400).json({ ok: false, error: "Target kick kosong." });

  const totalSteps = loopCount * targetList.length;
  const execution = createKickExecution({
    room, websockets: ids.length, loops: loopCount, targets: targetList.length,
    textdelay: delayMs, textloop: loopCount, totalSteps
  });

  // Start immediately and let the progress SSE report each target/loop.
  (async () => {
    let sent = 0;
    let completedSteps = 0;
    const queued = [];
    try {
      publishKickProgress(execution, { phase: "started", completedSteps, totalSteps, percent: 0,
        loop: 1, targetIndex: 1, target: targetList[0], acknowledged: 0, total: ids.length });

      for (let round = 0; round < loopCount; round++) {
        for (let targetIndex = 0; targetIndex < targetList.length; targetIndex++) {
          const targetUsername = targetList[targetIndex];
          const pending = [];
          let sentThisTarget = 0;

          for (const sessionId of ids) {
            try {
              const ack = waitForKickQueued(sessionId, 15000);
              pending.push(ack.then(jobId => ({ sessionId, jobId, ok: true }))
                .catch(error => ({ sessionId, ok: false, error: safeError(error) })));
              send(sessionId, { type: "room.kick", room, target_username: targetUsername });
              sent++;
              sentThisTarget++;
            } catch (e) {
              pending.push(Promise.resolve({ sessionId, ok: false, error: safeError(e) }));
            }
          }

          publishKickProgress(execution, {
            phase: "waiting_ack", completedSteps, totalSteps,
            percent: Math.round((completedSteps / totalSteps) * 100),
            loop: round + 1, targetIndex: targetIndex + 1, target: targetUsername,
            acknowledged: 0, total: ids.length, sent: sentThisTarget
          });

          const acknowledgements = await Promise.all(pending);
          const failed = acknowledgements.filter(x => !x.ok);
          const okCount = acknowledgements.filter(x => x.ok).length;
          queued.push({
            loop: round + 1, target: targetUsername, acknowledged: okCount, total: ids.length,
            jobs: acknowledgements.filter(x => x.ok).map(x => ({ sessionId: x.sessionId, jobId: x.jobId })),
            errors: failed
          });

          if (failed.length === acknowledgements.length) {
            throw new Error(`Semua WebSocket gagal menerima ACK room.kick.queued untuk target ${targetUsername}.`);
          }

          completedSteps++;
          publishKickProgress(execution, {
            phase: "target_done", completedSteps, totalSteps,
            percent: Math.round((completedSteps / totalSteps) * 100),
            loop: round + 1, targetIndex: targetIndex + 1, target: targetUsername,
            acknowledged: okCount, total: ids.length, sent: sentThisTarget
          });
        }

        if (round < loopCount - 1 && delayMs > 0) {
          publishKickProgress(execution, { phase: "delay", completedSteps, totalSteps,
            percent: Math.round((completedSteps / totalSteps) * 100), loop: round + 1,
            targetIndex: targetList.length, target: targetList[targetList.length - 1],
            delayMs, acknowledged: ids.length, total: ids.length });
          await sleep(delayMs);
        }
      }

      finishKickExecution(execution, {
        phase: "completed", completedSteps, totalSteps, percent: 100, ok: true, completed: true,
        queuedAll: true, queueAware: true, executionId: execution.id, websockets: ids.length,
        loops: loopCount, textdelay: delayMs, textloop: loopCount, targets: targetList.length, sent, queued
      });
    } catch (e) {
      finishKickExecution(execution, {
        phase: "failed", completedSteps, totalSteps,
        percent: Math.round((completedSteps / totalSteps) * 100), ok: false,
        error: safeError(e), queueAware: true, executionId: execution.id, sent, queued
      });
    }
  })();

  res.json({ ok: true, started: true, executionId: execution.id, totalSteps, websockets: ids.length,
    loops: loopCount, targets: targetList.length, textdelay: delayMs, textloop: loopCount });
});

app.post("/api/logout", (req, res) => {
  const { sessionId } = req.body || {};
  closeSession(String(sessionId || ""), "logout");
  res.json({ ok: true });
});

// ONE logout command for all active sessions.
app.post("/api/logout-batch", (req, res) => {
  const ids = Array.isArray(req.body?.sessionIds) ? [...new Set(req.body.sessionIds.map(String))].slice(0, 10) : getActiveSessionIds();
  let closed = 0;
  for (const id of ids) if (closeSession(id, "logout all")) closed++;
  res.json({ ok: true, closed });
});

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => console.log(`MIG Duel Kick 10 running on port ${PORT}`));
