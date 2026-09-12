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
const kickJobStatusWaiters = new Map();
const kickExecutions = new Map();
const balanceWaiters = new Map();

function makeId() { return crypto.randomBytes(16).toString("hex"); }
function safeError(err) { return String(err?.message || err || "Unknown error"); }

function resultPermissions(msg) {
  return Array.isArray(msg?.data?.developer?.permissions) ? msg.data.developer.permissions : [];
}

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
  const bw = balanceWaiters.get(sessionId);
  if (bw) { clearTimeout(bw.timer); bw.reject(new Error("Session ditutup sebelum saldo diterima.")); balanceWaiters.delete(sessionId); }
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
      resolveJobStatus(sessionId, msg);
      resolveBalance(sessionId, msg);

      // Jangan membuat event countdown sintetis dari teks umum.
      // Countdown hanya boleh dipicu frontend oleh event vote-kick yang
      // strukturnya benar-benar cocok dengan room.kick.state/vote_started.
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

      if (msg.type === "error" && !settled) {
        finishReject(new Error(msg.data?.message || msg.data?.error || "Login failed"));
      }
    });

    socket.on("error", finishReject);
    timeout = setTimeout(() => finishReject(new Error("Login timeout")), 15000);
  });
}

function nowMs() { return Date.now(); }

function send(sessionId, payload) {
  const account = sessions.get(sessionId);
  if (!account) throw new Error("Session tidak ditemukan / sudah terputus.");
  if (account.socket.readyState !== WebSocket.OPEN) throw new Error("WebSocket tidak terhubung.");
  account.socket.send(JSON.stringify(payload));
}

function waitForKickQueued(sessionId, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, timer: null };
    entry.timer = setTimeout(() => {
      const list = kickJobWaiters.get(sessionId) || [];
      const index = list.indexOf(entry);
      if (index >= 0) list.splice(index, 1);
      if (list.length) kickJobWaiters.set(sessionId, list);
      else kickJobWaiters.delete(sessionId);
      reject(new Error("Timeout menunggu respons room.kick."));
    }, timeoutMs);
    const list = kickJobWaiters.get(sessionId) || [];
    list.push(entry);
    kickJobWaiters.set(sessionId, list);
  });
}

function findJobId(value, depth = 0) {
  if (depth > 8 || value == null) return null;
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJobId(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;

  // Known API shapes first.
  const direct = value.job_id ?? value.jobId ?? value.id;
  if (direct != null && typeof direct !== "object") return String(direct);
  if (value.job) {
    const nested = findJobId(value.job, depth + 1);
    if (nested) return nested;
  }
  if (value.result) {
    const nested = findJobId(value.result, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function resolveKickQueued(sessionId, msg) {
  const list = kickJobWaiters.get(sessionId);
  if (!list?.length) return false;

  const type = String(msg?.type || "").toLowerCase();
  const isQueued = type === "room.kick.queued" ||
    type === "room.kick.result" ||
    type === "room.kick.accepted" ||
    type === "room.kick.started" ||
    (type.startsWith("room.kick.") && (type.includes("queue") || type.includes("accept")));
  const isKickError = type === "room.kick.error" ||
    type === "room.kick.failed" ||
    type === "room.kick.rejected";

  // A generic error is only consumed here when it clearly belongs to the kick
  // command. This prevents an unrelated API error from satisfying the waiter.
  const errorText = extractJobMessage(msg).toLowerCase();
  const genericKickError = type === "error" &&
    (errorText.includes("kick") || errorText.includes("room") || errorText.includes("permission"));

  if (!isQueued && !isKickError && !genericKickError) return false;

  const entry = list.shift();
  clearTimeout(entry.timer);
  if (list.length) kickJobWaiters.set(sessionId, list);
  else kickJobWaiters.delete(sessionId);

  if (isKickError || genericKickError) {
    const code = msg?.data?.error || msg?.error || "kick_error";
    const message = msg?.data?.message || msg?.data?.error_message || msg?.message || code;
    entry.reject(new Error(`${code}: ${message}`));
    return true;
  }

  const jobId = findJobId(msg?.data) || findJobId(msg);
  if (!jobId) {
    // Some API/proxy versions acknowledge the command without exposing the
    // job id in the first envelope. Keep the original response in the error
    // so the UI shows the actual API event instead of a blind timeout.
    const status = extractJobState(msg);
    entry.reject(new Error(`room.kick diterima tetapi job_id tidak ditemukan${status ? ` (status: ${status})` : ""}.`));
    return true;
  }
  entry.resolve(jobId);
  return true;
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

function waitForJobStatus(sessionId, jobId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const key = `${sessionId}:${jobId}`;
    const timer = setTimeout(() => {
      kickJobStatusWaiters.delete(key);
      reject(new Error(`Timeout menunggu status job ${jobId}.`));
    }, timeoutMs);
    kickJobStatusWaiters.set(key, { resolve, reject, timer });
  });
}

function resolveJobStatus(sessionId, msg) {
  if (!msg) return false;
  const data = msg.data || {};
  const job = data.job || data.result?.job || data.result?.data?.job || {};
  const jobId = data.job_id ?? job.job_id ?? data.result?.job_id ?? data.result?.job?.job_id ?? msg.job_id ?? msg.data?.id ?? null;
  if (!jobId) return false;
  const key = `${sessionId}:${jobId}`;
  const entry = kickJobStatusWaiters.get(key);
  if (!entry) return false;

  const state = extractJobState(msg);
  const type = String(msg.type || "").toLowerCase();
  const looksLikeJobResponse = type.includes("job") || type === "error";
  if (!state && !looksLikeJobResponse) return false;

  clearTimeout(entry.timer);
  kickJobStatusWaiters.delete(key);
  entry.resolve(msg);
  return true;
}

function extractJobState(msg) {
  const candidates = [
    msg?.data?.status, msg?.data?.job?.status, msg?.data?.job?.state,
    msg?.data?.result?.status, msg?.data?.result?.state,
    msg?.data?.result?.data?.status, msg?.data?.result?.data?.job?.status,
    msg?.status, msg?.state
  ];
  return candidates.find(v => typeof v === "string")?.toLowerCase() || "";
}

function extractJobMessage(msg) {
  return String(
    msg?.data?.message ?? msg?.data?.error ??
    msg?.data?.result?.message ?? msg?.data?.result?.error ??
    msg?.message ?? msg?.error ?? ""
  );
}

async function waitForKickJob(sessionId, jobId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = "";
  while (Date.now() < deadline) {
    const waiter = waitForJobStatus(sessionId, jobId, Math.max(1000, deadline - Date.now()));
    try {
      send(sessionId, { type: "job.get", job_id: jobId });
    } catch (e) {
      const entry = kickJobStatusWaiters.get(`${sessionId}:${jobId}`);
      if (entry) { clearTimeout(entry.timer); kickJobStatusWaiters.delete(`${sessionId}:${jobId}`); }
      throw e;
    }
    const msg = await waiter;
    const state = extractJobState(msg);
    if (state) lastState = state;
    if (["completed", "complete", "success", "succeeded", "done", "finished"].includes(state)) {
      return { ok: true, status: state, event: msg };
    }
    if (["failed", "error", "cancelled", "canceled", "rejected"].includes(state)) {
      return { ok: false, status: state, error: extractJobMessage(msg) || `Job berstatus ${state}.`, event: msg };
    }
    if (String(msg?.type || "").toLowerCase() === "error") {
      return { ok: false, status: "error", error: extractJobMessage(msg) || "job.get gagal.", event: msg };
    }
    await sleep(250);
  }
  throw new Error(`Timeout job ${jobId}${lastState ? ` (status terakhir: ${lastState})` : ""}.`);
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
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.json({ ok: true, executionId: id, done: execution.done, progress: execution.latest, result: execution.done ? execution.result : null });
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

// Balance is a direct WebSocket response. Collect the response per session so
// CEK SALDO ALL does not depend on the single room-event SSE connection.
app.post("/api/balance-all", async (req, res) => {
  const ids = Array.isArray(req.body?.sessionIds)
    ? [...new Set(req.body.sessionIds.map(String))].slice(0, 10)
    : [];
  if (!ids.length) return res.status(400).json({ ok: false, error: "Tidak ada Troop yang ONLINE." });

  const results = await Promise.all(ids.map(async (sessionId) => {
    try {
      // Register waiter before sending to avoid a very fast response racing past it.
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

  // One independent sequence per WebSocket:
  // Troop-1: target 1 -> delay -> target 2 -> ... -> target 10 -> delay -> loop 2
  // Troop-2 does the same sequence concurrently, and so on.
  // No room.kick ACK and no job.get is awaited.
  const totalSteps = loopCount * targetList.length;
  const totalJobs = totalSteps * ids.length;
  const execution = createKickExecution({
    room, websockets: ids.length, loops: loopCount, targets: targetList.length,
    textdelay: delayMs, textloop: loopCount, totalSteps, totalJobs,
    targetProgress: targetList.map((target, i) => ({ targetIndex: i + 1, target, completed: 0, total: ids.length * loopCount })),
    wsProgress: ids.map((sessionId, i) => ({ websocket: i + 1, sessionId, completed: 0, total: totalSteps, failed: 0, lastMs: null }))
  });

  (async () => {
    let sent = 0;
    let completedSteps = 0;
    let completedJobs = 0;
    let failedJobs = 0;
    const targetProgress = targetList.map((target, i) => ({ targetIndex: i + 1, target, completed: 0, total: ids.length * loopCount }));
    const sequenceResults = [];
    const wsProgress = ids.map((sessionId, i) => ({ websocket: i + 1, sessionId, completed: 0, total: totalSteps, failed: 0, lastMs: null }));
    const stateLock = { chain: Promise.resolve() };

    function addProgress(fn) {
      stateLock.chain = stateLock.chain.then(fn).catch(() => {});
      return stateLock.chain;
    }

    // Independent pair execution per WebSocket:
    // WS 1-10: 1-2 -> delay -> 3-4 -> delay -> 5-6 -> delay -> 7-8 -> delay -> 9-10
    // Each WebSocket runs its own sequence independently; there is NO barrier between WebSockets.
    const wsEntries = ids.map((sessionId, i) => ({ sessionId, websocket: i + 1 }));
    const pairCount = Math.ceil(targetList.length / 2);

    async function sendTarget(sessionId, wsOrdinal, round, targetIndex, sequencePosition) {
      const targetUsername = targetList[targetIndex];
      const startedAt = nowMs();
      // Setiap percobaan job dihitung, baik sukses maupun gagal, agar progress tidak macet.
      completedJobs++;
      targetProgress[targetIndex].completed++;
      wsProgress[wsOrdinal - 1].completed++;
      let ok = false;
      let error = null;
      try {
        const account = sessions.get(sessionId);
        if (!account || account.socket.readyState !== WebSocket.OPEN) throw new Error("WebSocket tidak terhubung.");
        if (Array.isArray(account.permissions) && !account.permissions.includes("rooms.kick")) {
          throw new Error("Permission rooms.kick tidak tersedia.");
        }
        send(sessionId, { type: "room.kick", room, target_username: targetUsername });
        sent++;
        ok = true;
      } catch (e) {
        failedJobs++;
        wsProgress[wsOrdinal - 1].failed++;
        error = safeError(e);
      }

      wsProgress[wsOrdinal - 1].lastMs = Math.max(0, nowMs() - startedAt);
      const result = {
        sessionId, websocket: wsOrdinal, loop: round + 1, target: targetUsername,
        targetIndex: targetIndex + 1, sequencePosition, direction: "forward",
        ok, jobStatus: ok ? "sent" : "send_failed", unconfirmed: ok, error,
        totalMs: Math.max(0, nowMs() - startedAt)
      };

      await addProgress(async () => {
        completedSteps = Math.min(totalSteps, Math.floor(completedJobs / Math.max(1, ids.length)));
        publishKickProgress(execution, {
          phase: ok ? "sent" : "send_failed", completedSteps, totalSteps,
          completedJobs, totalJobs,
          percent: totalJobs > 0 ? Math.round((completedJobs / totalJobs) * 100) : 0,
          loop: round + 1, targetIndex: targetIndex + 1, target: targetUsername,
          sessionId, websocket: wsOrdinal, direction: "forward",
          activeWs: wsProgress.filter(x => x.completed > 0).length, total: ids.length, sent, failedJobs, noAck: true,
          targetProgress: targetProgress.map(x => ({ ...x })),
          wsProgress: wsProgress.map(x => ({ ...x }))
        });
      });
      return result;
    }

    async function runTroop(sessionId, wsOrdinal) {
      const troopResults = [];
      const orderedIndices = Array.from({ length: targetList.length }, (_, i) => i);

      for (let round = 0; round < loopCount; round++) {
        for (let pair = 0; pair < pairCount; pair++) {
          const firstPos = pair * 2;
          for (let offset = 0; offset < 2; offset++) {
            const pos = firstPos + offset;
            if (pos >= orderedIndices.length) break;
            const targetIndex = orderedIndices[pos];
            troopResults.push(await sendTarget(
              sessionId, wsOrdinal, round, targetIndex, pos + 1
            ));
          }

          // Delay belongs only to this WebSocket's own sequence.
          // No other WebSocket is blocked by this delay.
          const hasNextPair = pair + 1 < pairCount || round + 1 < loopCount;
          if (delayMs > 0 && hasNextPair) {
            await addProgress(async () => {
              const lastTargetIndex = orderedIndices[Math.min((pair + 1) * 2, orderedIndices.length) - 1];
              publishKickProgress(execution, {
                phase: "delay", completedSteps, totalSteps,
                completedJobs, totalJobs,
                percent: totalJobs > 0 ? Math.round((completedJobs / totalJobs) * 100) : 0,
                loop: round + 1,
                targetIndex: lastTargetIndex + 1,
                target: targetList[lastTargetIndex],
                delayMs, nextPair: pair + 2 <= pairCount ? pair + 2 : null,
                sessionId, websocket: wsOrdinal,
                direction: "forward",
                sent, failedJobs, noAck: true,
                targetProgress: targetProgress.map(x => ({ ...x })),
                wsProgress: wsProgress.map(x => ({ ...x }))
              });
            });
            await sleep(delayMs);
          }
        }
      }
      return { sessionId, websocket: wsOrdinal, results: troopResults, steps: troopResults.length, orderedIndices };
    }

    try {
      publishKickProgress(execution, {
        phase: "started",
        completedSteps: 0,
        totalSteps,
        completedJobs: 0,
        totalJobs,
        percent: 0,
        loop: 1,
        targetIndex: 1,
        target: targetList[0],
        total: ids.length,
        sent: 0,
        failedJobs: 0,
        noAck: true,
        targetProgress: targetProgress.map(x => ({ ...x })),
        wsProgress: wsProgress.map(x => ({ ...x }))
      });

      // All WebSockets start their own independent 1->10 sequence concurrently.
      const results = await Promise.all(
        wsEntries.map(({ sessionId, websocket }) => runTroop(sessionId, websocket))
      );
      const flatResults = results.map(x => x.results).flat();
      sequenceResults.push(...results);

      publishKickProgress(execution, {
        phase: "completed",
        completedSteps: totalSteps,
        totalSteps,
        completedJobs,
        totalJobs,
        percent: totalJobs > 0 ? Math.round((completedJobs / totalJobs) * 100) : 100,
        loop: loopCount,
        targetIndex: targetList.length,
        target: targetList[targetList.length - 1],
        total: ids.length,
        sent,
        failedJobs,
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
      publishKickProgress(execution, { phase: "error", error: execution.error, completedJobs, totalJobs, sent, failedJobs, targetProgress: targetProgress.map(x => ({ ...x })), wsProgress: wsProgress.map(x => ({ ...x })) });
    }

  })();

  res.json({
    ok: true,
    action: "kick-loop",
    executionId: execution.id,
    mode: "paired_targets_per_websocket_no_ack",
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
app.listen(PORT, () => console.log(`MIG Duel Kick 10 running on port ${PORT}`));
