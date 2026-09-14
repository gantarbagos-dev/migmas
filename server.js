const express = require("express");
const path = require("path");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "128kb" }));

// Always serve the frontend JavaScript fresh. This route must be registered
// BEFORE express.static(), otherwise the static middleware handles it first.
app.get("/frontend.js", (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.sendFile(path.join(__dirname, "public", "frontend.js"));
});
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/version", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.json({ ok: true, version: BUILD_VERSION });
});

const PORT = process.env.PORT || 3000;
const API_WS = "wss://developer.mig33.id/developer/ws";
const BUILD_VERSION = "migsock_ui_v50_socket1-countdown-fixed-v9";

// One authenticated MigReborn account = one WebSocket, as required by the official API.
// The UI can issue ONE batch command that dispatches concurrently to up to 10 sockets.
const sessions = new Map();
const subscribers = new Map();
const kickExecutions = new Map();
const balanceWaiters = new Map();

function makeId() { return crypto.randomBytes(16).toString("hex"); }
function safeError(err) { return String(err?.message || err || "Unknown error"); }

function extractApiError(msg) {
  const data = msg?.data || {};
  const code = String(data.code ?? data.error_code ?? data.error ?? msg?.code ?? msg?.error_code ?? "").trim();
  const message = String(data.message ?? data.detail ?? data.error_message ?? msg?.message ?? msg?.error ?? "Login failed").trim();
  return { code, message };
}

// The public MigReborn Developer API documents developer_login_failed for bad
// credentials. It does not publish a dedicated suspend error code in the docs,
// so SUSPEND is only inferred when the API itself explicitly reports a
// suspension/blocked-account code or message; otherwise the result is ERROR.
function classifyLoginFailure(err) {
  const code = String(err?.code || "").toLowerCase();
  const message = String(err?.message || err || "").toLowerCase();
  const combined = `${code} ${message}`;
  const suspended = /(?:account[_ .-]?suspended|user[_ .-]?suspended|developer[_ .-]?suspended|suspend(?:ed|ion)|account[_ .-]?(?:blocked|disabled|banned)|login[_ .-]?(?:blocked|disabled))/.test(combined);
  if (suspended) return "suspend";
  if (/developer[_ .-]?login[_ .-]?failed/.test(code)) return "error";
  if (/invalid|credential|password|username|unauthori[sz]ed|authentication|auth|timeout|connection|websocket|network|socket|server/.test(combined)) return "error";
  return "error";
}


function publish(sessionId, msg) {
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
  const bw = balanceWaiters.get(sessionId);
  if (bw) { clearTimeout(bw.timer); bw.reject(new Error("Session ditutup sebelum saldo diterima.")); balanceWaiters.delete(sessionId); }
  return true;
}

function connectAccount(username, password, socketIndex = null) {
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

      resolveBalance(sessionId, msg);

      // Forward the raw API event. Socket 1 is explicitly tagged here so
      // the frontend never has to guess which authenticated WebSocket sent it.
      publish(sessionId, { type: "api.event", socketIndex, event: msg });

      // The API's vote-start notification can vary between deployments. For
      // Socket 1, a room.kick state event is the authoritative source for the
      // countdown; pass it through as an explicit trigger so the frontend does
      // not depend on one exact action/status field name.
      if (socketIndex === 0) {
        let rawEvent = "";
        try { rawEvent = JSON.stringify(msg).toLowerCase(); } catch {}
        const eventType = String(msg?.type || msg?.data?.event_type || "").toLowerCase();
        const action = String(msg?.action || msg?.data?.action || "").toLowerCase();
        const status = String(msg?.status_message || msg?.data?.status_message || "").toLowerCase();
        const hasKick = /room\.kick/.test(eventType) || /room\.kick/.test(rawEvent);
        const hasVoteStart = /vote[_ ]started|vote.*started|started.*vote/.test(rawEvent) ||
          (/vote/.test(rawEvent) && /remaining/.test(rawEvent));
        const isKickState = eventType === "room.kick.state" || /room\.kick\.state/.test(rawEvent);
        const isStartState = hasKick && (
          hasVoteStart ||
          action === "vote_started" ||
          /vote/.test(status) && /remaining/.test(status) ||
          isKickState && (/vote/.test(rawEvent) || /remaining/.test(rawEvent))
        );
        if (isStartState) {
          const trigger = { type: "countdown.trigger", socketIndex: 0, event: msg, receivedAt: Date.now() };
          const account = sessions.get(sessionId);
          if (account) account.countdownTrigger = trigger;
          publish(sessionId, trigger);
        }
      }

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
          socketIndex,
          permissions: Array.isArray(msg.data?.developer?.permissions) ? msg.data.developer.permissions : [],
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

      if (msg.type === "session.replaced") {
        publish(sessionId, { type: "login.status", status: "error", code: "session.replaced", message: "Session digantikan oleh login lain." });
        return;
      }

      if (msg.type === "error" && !settled) {
        const apiErr = extractApiError(msg);
        const err = new Error(apiErr.message || "Login failed");
        err.code = apiErr.code;
        err.status = classifyLoginFailure(err);
        finishReject(err);
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

function waitForBalance(sessionId, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const old = balanceWaiters.get(sessionId);
    if (old?.timer) clearTimeout(old.timer);
    const entry = { resolve, reject, timer: null };
    entry.timer = setTimeout(() => {
      if (balanceWaiters.get(sessionId) === entry) balanceWaiters.delete(sessionId);
      reject(new Error("Timeout menunggu wallet.balance.result."));
    }, timeoutMs);
    balanceWaiters.set(sessionId, entry);
  });
}

function resolveBalance(sessionId, msg) {
  if (msg?.type !== "wallet.balance.result") return false;
  const entry = balanceWaiters.get(sessionId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  balanceWaiters.delete(sessionId);
  const wallet = msg?.data?.wallet || null;
  if (!wallet) {
    entry.reject(new Error("wallet.balance.result tidak berisi data wallet."));
    return true;
  }
  entry.resolve(wallet);
  return true;
}

function extractJobId(msg) {
  return String(msg?.data?.job?.job_id ?? msg?.data?.job_id ?? msg?.job_id ?? "").trim();
}

function getActiveSessionIds() { return [...sessions.keys()]; }

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "MIG Duel Kick 10", activeSessions: sessions.size });
});

// Single-account login retained for individual Troop controls.
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, error: "Username dan password wajib diisi." });
  try {
    const result = await connectAccount(String(username).trim(), String(password), 0);
    res.json({ ok: true, account: result });
  } catch (e) {
    const status = classifyLoginFailure(e);
    res.status(401).json({ ok: false, status, code: String(e?.code || ""), error: safeError(e) });
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
      const account = await connectAccount(username, password, index);
      return { index, ok: true, account };
    } catch (e) {
      return { index, ok: false, username, status: classifyLoginFailure(e), code: String(e?.code || ""), error: safeError(e) };
    }
  });

  const results = await Promise.all(jobs);
  res.json({ ok: results.some(x => x.ok), results });
});

function createKickExecution(meta) {
  const id = makeId();
  const execution = { id, meta, done: false, result: null, latest: { type: "kick.progress", phase: "created", ...meta, completedSteps: 0, totalSteps: Number(meta.totalSteps) || 0, percent: 0 } };
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
}


app.get("/api/kick-progress-state", (req, res) => {
  const id = String(req.query.id || "");
  const execution = kickExecutions.get(id);
  if (!execution) return res.status(404).json({ ok: false, error: "Execution tidak ditemukan." });
  return res.json({ ok: true, executionId: id, done: execution.done, progress: execution.latest, result: execution.done ? execution.result : null });
});


// CEK uses Socket 1 (frontend account index 0) to send the exact build version
// through the official room.send_message command.
app.post("/api/check-version", (req, res) => {
  const { sessionId, room } = req.body || {};
  if (!sessionId || !room) return res.status(400).json({ ok: false, error: "Socket 1 dan room wajib tersedia." });
  const account = sessions.get(String(sessionId));
  if (!account || account.socketIndex !== 0) {
    return res.status(400).json({ ok: false, error: "CEK harus menggunakan Socket 1." });
  }
  try {
    const message = `BUILD VERSION: ${BUILD_VERSION}`;
    const payload = { type: "room.send_message", room: String(room).trim(), message };
    send(String(sessionId), payload);
    res.json({ ok: true, socketIndex: 0, version: BUILD_VERSION, payload });
  } catch (e) {
    res.status(400).json({ ok: false, error: safeError(e) });
  }
});

app.get("/api/countdown-trigger", (req, res) => {
  const sessionId = String(req.query.sessionId || "");
  const account = sessions.get(sessionId);
  if (!sessionId || !account) return res.status(401).json({ ok: false });
  const trigger = account.countdownTrigger || null;
  if (trigger) account.countdownTrigger = null;
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  return res.json({ ok: true, trigger });
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

// Balance is a direct WebSocket response. Collect the response per session so
// CEK SALDO ALL does not depend on the single room-event SSE connection.
app.post("/api/balance-all", async (req, res) => {
  const ids = Array.isArray(req.body?.sessionIds)
    ? [...new Set(req.body.sessionIds.map(String))].slice(0, 10)
    : [];
  if (!ids.length) return res.status(400).json({ ok: false, error: "Tidak ada Troop yang ONLINE." });

  const results = await Promise.all(ids.map(async (sessionId) => {
    try {
      const waiter = waitForBalance(sessionId, 8000);
      send(sessionId, { type: "wallet.balance" });
      const wallet = await waiter;
      return { sessionId, ok: true, wallet };
    } catch (e) {
      const pending = balanceWaiters.get(sessionId);
      if (pending?.timer) clearTimeout(pending.timer);
      balanceWaiters.delete(sessionId);
      return { sessionId, ok: false, error: safeError(e) };
    }
  }));

  const success = results.filter(x => x.ok).length;
  res.json({ ok: success > 0, action: "balance", sent: ids.length, success, total: ids.length, results });
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

function waitBatchDelay(delayMs) {
  const ms = Math.max(0, Number(delayMs) || 0);
  return ms > 0 ? sleep(ms) : Promise.resolve();
}


app.post("/api/kick-loop", async (req, res) => {
  const body = req.body || {};
  const { sessionIds, room, targets, websocketSlots } = body;
  const textdelay = body.textdelay;
  const textloop = body.textloop;
  const burstSize = Math.max(1, Math.min(parseInt(body.burstSize, 10) || 3, 10));

  // Preserve the physical Troop/WebSocket slot. Do not compact the list when
  // a middle Troop is offline: T1 must always mean WebSocket slot 1, etc.
  const slotEntries = Array.isArray(websocketSlots)
    ? websocketSlots
        .map(x => ({ sessionId: String(x?.sessionId || "").trim(), websocket: Number(x?.websocket) }))
        .filter(x => x.sessionId && Number.isInteger(x.websocket) && x.websocket >= 1 && x.websocket <= 10)
        .sort((a, b) => a.websocket - b.websocket)
        .filter((x, i, arr) => i === arr.findIndex(y => y.websocket === x.websocket))
    : [];
  const ids = slotEntries.length
    ? slotEntries.map(x => x.sessionId)
    : (Array.isArray(sessionIds)
        ? [...new Set(sessionIds.map(String).filter(Boolean))].slice(0, 10)
        : []);
  const targetList = Array.isArray(targets)
    ? targets.map(x => String(x).trim()).filter(Boolean).slice(0, 10)
    : [];
  const delayMs = Math.max(0, Math.min(Number(textdelay) || 0, 86400000));
  const loopCount = Math.max(1, Math.min(parseInt(textloop, 10) || 1, 100));

  if (!ids.length) return res.status(400).json({ ok: false, error: "Tidak ada Troop yang ONLINE." });
  if (!room) return res.status(400).json({ ok: false, error: "Room wajib diisi." });
  if (!targetList.length) return res.status(400).json({ ok: false, error: "Target kick kosong." });

  // One independent sequence per WebSocket:
  // Troop-1: target 1 -> delay -> target 2 -> ... -> target 10 -> delay -> loop 2
  // Troop-2 does the same sequence concurrently, and so on.
  // Race mode: dispatch small bursts per WebSocket without response verification.
  const totalSteps = loopCount * targetList.length;
  const totalJobs = totalSteps * ids.length;
  const execution = createKickExecution({
    room, websockets: ids.length, loops: loopCount, targets: targetList.length,
    textdelay: delayMs, textloop: loopCount, burstSize, totalSteps, totalJobs,
    targetProgress: targetList.map((target, i) => ({ targetIndex: i + 1, target, completed: 0, dispatched: 0, total: ids.length * loopCount })),
    wsProgress: (slotEntries.length ? slotEntries : ids.map((sessionId, i) => ({ sessionId, websocket: i + 1 })))
      .map(x => ({ websocket: x.websocket, sessionId: x.sessionId, completed: 0, dispatched: 0, total: totalSteps, failed: 0 }))
  });

  (async () => {
    let completedSteps = 0;
    let failedJobs = 0;
    let dispatchedJobs = 0;
    const targetProgress = targetList.map((target, i) => ({ targetIndex: i + 1, target, completed: 0, dispatched: 0, total: ids.length * loopCount }));
    const sequenceResults = [];
    const wsProgress = (slotEntries.length ? slotEntries : ids.map((sessionId, i) => ({ sessionId, websocket: i + 1 })))
      .map(x => ({ websocket: x.websocket, sessionId: x.sessionId, completed: 0, dispatched: 0, total: totalSteps, failed: 0 }));
    // O(1) WebSocket progress lookup for the dispatch hot path.
    const wsProgressBySlot = Object.create(null);
    for (const state of wsProgress) wsProgressBySlot[state.websocket] = state;

    let kickProgressScheduled = false;
    let kickProgressTimer = null;
    let kickProgressContext = null;

    // Coalesce frequent progress updates so the dispatch hot path does not
    // create a Promise-chain entry for every target. UI polling still receives
    // the latest counters shortly after a burst.
    function scheduleKickProgress(context) {
      kickProgressContext = context;
      if (kickProgressScheduled) return;
      kickProgressScheduled = true;
      kickProgressTimer = setTimeout(() => {
        kickProgressTimer = null;
        kickProgressScheduled = false;
        const ctx = kickProgressContext;
        kickProgressContext = null;
        if (!ctx) return;
        for (const tp of targetProgress) {
          tp.completed = Math.min(tp.total, Math.floor(tp.dispatched / Math.max(1, ids.length)));
        }
        completedSteps = Math.min(totalSteps, targetProgress.reduce((sum, tp) => sum + tp.completed, 0));
        publishKickProgress(execution, {
          ...ctx,
          completedSteps,
          totalSteps,
          dispatchedJobs,
          totalJobs,
          percent: totalJobs > 0 ? Math.round((dispatchedJobs / totalJobs) * 100) : 0,
          sent: dispatchedJobs,
          failedJobs,
          targetProgress: targetProgress.map(x => ({ ...x })),
          wsProgress: wsProgress.map(x => ({ ...x }))
        });
      }, 25);
    }


    // Independent pair execution per WebSocket:
    // WS 1-10: 1-2 -> delay -> 3-4 -> delay -> 5-6 -> delay -> 7-8 -> delay -> 9-10
    // Each WebSocket runs its own sequence independently; there is NO barrier between WebSockets.
    const wsEntries = slotEntries.length
      ? slotEntries.map(x => ({ sessionId: x.sessionId, websocket: x.websocket }))
      : ids.map((sessionId, i) => ({ sessionId, websocket: i + 1 }));
    const RACE_BURST = burstSize;

    // Payload strings are prebuilt once. WebSocket validation is performed
    // inside the protected execution block so a disconnected troop is reported
    // as an execution error instead of becoming an unhandled async rejection.
    const kickPayloads = targetList.map(targetUsername =>
      JSON.stringify({ type: "room.kick", room, target_username: targetUsername })
    );

    function sendTarget(runtime, round, targetIndex, sequencePosition) {
      const { sessionId, websocket, socket } = runtime;
      const targetUsername = targetList[targetIndex];
      const startedAt = Date.now();
      const result = {
        sessionId, websocket, loop: round + 1, target: targetUsername,
        targetIndex: targetIndex + 1, sequencePosition, direction: "forward",
        ok: false, jobStatus: "sent", jobId: null, error: null, totalMs: 0
      };

      try {
        if (socket.readyState !== WebSocket.OPEN) throw new Error("WebSocket tidak terhubung.");

        // Instant dispatch: send directly without waiting for an API response.
        socket.send(kickPayloads[targetIndex]);

        dispatchedJobs++;
        targetProgress[targetIndex].dispatched++;
        targetProgress[targetIndex].completed = Math.min(
          targetProgress[targetIndex].total,
          Math.floor(targetProgress[targetIndex].dispatched / Math.max(1, ids.length))
        );
        const wsState = wsProgressBySlot[websocket];
        if (wsState) wsState.dispatched++;
        result.ok = true;
        result.jobStatus = "sent";
        result.totalMs = Math.max(0, Date.now() - startedAt);

        scheduleKickProgress({
          phase: "dispatched",
          loop: round + 1, targetIndex: targetIndex + 1, target: targetUsername,
          sessionId, websocket, direction: "forward",
          sendConfirmed: true, noAck: true, burstSize: RACE_BURST,
          burst: Math.floor(targetIndex / RACE_BURST) + 1,
          burstTotal: Math.ceil(targetList.length / RACE_BURST)
        });

        return result;
      } catch (e) {
        result.ok = false;
        result.jobStatus = "send_failed";
        result.error = safeError(e);
        result.totalMs = Math.max(0, Date.now() - startedAt);
        failedJobs++;
        const wsState = wsProgressBySlot[websocket];
        if (wsState) wsState.failed++;

        scheduleKickProgress({
          phase: "send_failed",
          loop: round + 1, targetIndex: targetIndex + 1, target: targetUsername,
          sessionId, websocket, direction: "forward",
          sendConfirmed: false, noAck: true, error: result.error
        });
        return result;
      }
    }


    async function runTroop(runtime) {
      const { sessionId, websocket: wsOrdinal } = runtime;
      const troopResults = [];
      const orderedIndices = Array.from({ length: targetList.length }, (_, i) => i);

      for (let round = 0; round < loopCount; round++) {
        for (let pos = 0; pos < orderedIndices.length; pos += RACE_BURST) {
          const burstIndexes = orderedIndices.slice(pos, pos + RACE_BURST);

          // Race burst: dispatch up to the configured burst size immediately.
          for (const targetIndex of burstIndexes) {
            const targetUsername = targetList[targetIndex];
            const dispatched = sendTarget(
              runtime, round, targetIndex, pos + 1
            );
            troopResults.push(dispatched);
          }
// Delay diterapkan di antara burst dan juga di antara loop berikutnya.
          const isEndOfLoop = pos + RACE_BURST >= orderedIndices.length;
      const hasNextLoop = round + 1 < loopCount;
      if (delayMs > 0 && !isEndOfLoop) {
        await waitBatchDelay(delayMs);
      }
      if (delayMs > 0 && isEndOfLoop && hasNextLoop) {
            const lastTargetIndex = burstIndexes[burstIndexes.length - 1];
            for (const tp of targetProgress) {
          tp.completed = Math.min(tp.total, Math.floor(tp.dispatched / Math.max(1, ids.length)));
        }
        completedSteps = Math.min(totalSteps, targetProgress.reduce((sum, tp) => sum + tp.completed, 0));
            publishKickProgress(execution, {
              phase: "delay", completedSteps, totalSteps,
              dispatchedJobs, totalJobs,
              percent: totalJobs > 0 ? Math.round((dispatchedJobs / totalJobs) * 100) : 0,
              loop: round + 1,
              targetIndex: lastTargetIndex + 1,
              target: targetList[lastTargetIndex],
              delayMs, burstSize: RACE_BURST,
              burst: Math.floor(pos / RACE_BURST) + 1,
              burstTotal: Math.ceil(orderedIndices.length / RACE_BURST),
              nextBurst: pos + RACE_BURST < orderedIndices.length ? Math.floor(pos / RACE_BURST) + 2 : (hasNextLoop ? 1 : null),
              sessionId, websocket: wsOrdinal,
              direction: "forward",
              sent: dispatchedJobs, failedJobs, sendConfirmed: true,
              noAck: true,
              targetProgress: targetProgress.map(x => ({ ...x })),
              wsProgress: wsProgress.map(x => ({ ...x }))
            });
            await sleep(delayMs);
          }
        }
      }
      return { sessionId, websocket: wsOrdinal, results: troopResults, steps: troopResults.length, orderedIndices };
    }

    try {
      const troopRuntime = wsEntries.map(({ sessionId, websocket }) => {
        const account = sessions.get(sessionId);
        if (!account || account.socket.readyState !== WebSocket.OPEN) {
          throw new Error(`WebSocket T${websocket} tidak terhubung.`);
        }
        if (Array.isArray(account.permissions) && !account.permissions.includes("rooms.kick")) {
          throw new Error(`Permission rooms.kick tidak tersedia pada T${websocket}.`);
        }
        return { sessionId, websocket, socket: account.socket };
      });

      publishKickProgress(execution, {
        phase: "started",
        completedSteps: 0,
        totalSteps,
                dispatchedJobs: 0,
        totalJobs,
        percent: 0,
        loop: 1,
        targetIndex: 1,
        target: targetList[0],
        total: ids.length,
        sent: 0,
        failedJobs: 0,
        sendConfirmed: true,
        noAck: true,
        targetProgress: targetProgress.map(x => ({ ...x })),
        wsProgress: wsProgress.map(x => ({ ...x }))
      });

      // All WebSockets start their own independent 1->10 sequence concurrently.
      const results = await Promise.all(
        troopRuntime.map(runtime => runTroop(runtime))
      );
      const flatResults = results.map(x => x.results).flat();
      sequenceResults.push(...results);

      // Flush any delayed coalesced progress before the final state.
      if (kickProgressTimer) { clearTimeout(kickProgressTimer); kickProgressTimer = null; }
      kickProgressScheduled = false;
      kickProgressContext = null;

      // Completion follows transport dispatch; no API response is awaited.
      const allJobsSucceeded = dispatchedJobs === totalJobs && failedJobs === 0;
      publishKickProgress(execution, {
        phase: allJobsSucceeded ? "completed" : "completed_with_errors",
        completedSteps: Math.min(totalSteps, targetProgress.reduce((sum, tp) => sum + tp.completed, 0)),
        totalSteps,
        dispatchedJobs,
        totalJobs,
        percent: totalJobs > 0 ? Math.round((dispatchedJobs / totalJobs) * 100) : 0,
        loop: loopCount,
        targetIndex: targetList.length,
        target: targetList[targetList.length - 1],
        total: ids.length,
        sent: dispatchedJobs,
        failedJobs,
        sendConfirmed: true,
        noAck: true,
        targetProgress: targetProgress.map(x => ({ ...x })),
        wsProgress: wsProgress.map(x => ({ ...x }))
      });
      execution.done = true;
      execution.completedAt = Date.now();
      execution.results = flatResults;
    } catch (e) {
      execution.done = true;
      execution.error = safeError(e);
      publishKickProgress(execution, { phase: "error", error: execution.error, dispatchedJobs, totalJobs, sent: dispatchedJobs, failedJobs, targetProgress: targetProgress.map(x => ({ ...x })), wsProgress: wsProgress.map(x => ({ ...x })) });
    }

  })();

  res.json({
    ok: true,
    action: "kick-loop",
    executionId: execution.id,
    mode: `race_burst_${burstSize}_instant_dispatch`,
    websockets: ids.length,
    targets: targetList.length,
    loops: loopCount,
    textdelay: delayMs,
    totalSteps,
    totalJobs,
    noAck: true
  });
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
app.listen(PORT, "0.0.0.0", () => console.log(`MIG Duel Kick 10 running on port ${PORT}`));
