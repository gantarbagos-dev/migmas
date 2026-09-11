
const accounts = Array.from({length:10},()=>({sessionId:null,username:"",password:"",balance:"-",eventSource:null}));
const targets = [];
const participantNames = [];
const el = id => document.getElementById(id);

const log = msg => {
  const t = new Date().toLocaleTimeString();
  const logEl = el("log");
  if(logEl) logEl.textContent = `[${t}] ${msg}\n` + logEl.textContent;
};

function esc(v){
  return String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;");
}

function sync(){
  for(let i=0; i<10; i++){
    if(el(`u${i}`)) accounts[i].username = el(`u${i}`).value.trim();
    if(el(`p${i}`)) accounts[i].password = el(`p${i}`).value;
  }
}

function renderAccounts(){
  el("accounts").innerHTML = accounts.map((a, i) => `
    <div class="bg-slate-950/80 border border-slate-800/70 rounded-xl p-3 space-y-2.5 transition-all hover:border-slate-700">
      <div class="flex items-center justify-between">
        <span class="text-xs font-bold tracking-wide text-slate-400">Troop ${i+1}</span>
        <div class="flex items-center gap-2">
          <span id="b${i}" class="text-[11px] bg-slate-900 border border-slate-800 text-slate-300 px-2 py-0.5 rounded-md">${esc(a.balance)}</span>
          <span id="status${i}" class="text-[10px] font-bold px-2 py-0.5 rounded-full ${a.sessionId ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-800/50' : 'bg-slate-900 text-slate-400 border border-slate-800'}">${a.sessionId ? "ONLINE" : "OFFLINE"}</span>
        </div>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input id="u${i}" value="${esc(a.username)}" class="bg-slate-900/90 border border-slate-800 rounded-lg px-3 py-2 text-xs sm:text-sm text-slate-200 focus:border-blue-500 placeholder:text-slate-600" placeholder="Username" autocomplete="off">
        <input id="p${i}" value="${esc(a.password)}" type="password" class="bg-slate-900/90 border border-slate-800 rounded-lg px-3 py-2 text-xs sm:text-sm text-slate-200 focus:border-blue-500 placeholder:text-slate-600" placeholder="Password" autocomplete="off">
      </div>
      <div class="flex gap-2 pt-0.5">
        <button onclick="loginOne(${i})" class="flex-1 bg-blue-600/15 hover:bg-blue-600/25 text-blue-400 border border-blue-800/30 font-bold py-1.5 px-3 rounded-lg text-xs transition-all active:scale-95">LOGIN</button>
        <button onclick="logoutOne(${i})" class="flex-1 bg-rose-950/15 hover:bg-rose-950/25 text-rose-400 border border-rose-800/30 font-bold py-1.5 px-3 rounded-lg text-xs transition-all active:scale-95">LOGOUT</button>
      </div>
    </div>
  `).join("");
}

function setStatus(i, text, kind=""){
  const s = el(`status${i}`);
  if(!s) return;
  s.textContent = text;
  if(kind === "online") {
    s.className = "text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-950/80 text-emerald-400 border border-emerald-800/50";
  } else if(kind === "error") {
    s.className = "text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-950/80 text-rose-400 border border-rose-800/50";
  } else {
    s.className = "text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-900 text-slate-400 border border-slate-800";
  }
}

function setBalance(i, label){
  accounts[i].balance = label || "-";
  const b = el(`b${i}`);
  if(b) b.textContent = accounts[i].balance;
}

function validRange(){
  const rawStart = el("rangeStart").value.trim();
  const rawEnd = el("rangeEnd").value.trim();
  if(rawStart === "") return null;
  const start = Number(rawStart);
  if(!Number.isSafeInteger(start) || start < 0) return null;
  let end = rawEnd === "" ? start + 9 : Number(rawEnd);
  if(!Number.isSafeInteger(end)) return null;
  const step = end >= start ? 1 : -1;
  end = start + step * 9;
  return {start, end, step};
}

function generateTroop(){
  sync();
  const main = el("mainTroop").value.trim();
  if(!main){ log("Generate Troop gagal: isi Main troop terlebih dahulu."); return; }
  const range = validRange();
  if(!range){ log("Generate Troop gagal: angka mulai harus berupa bilangan bulat yang valid."); return; }
  el("rangeEnd").value = String(range.end);
  for(let i=0; i<10; i++){
    accounts[i].username = main + String(range.start + i * range.step);
  }
  renderAccounts();
  log(`Generate Troop berhasil: ${accounts[0].username} sampai ${accounts[9].username}.`);
}

function generatePassword(){
  sync();
  const p = el("mainPassword").value;
  if(!p){ log("Generate Password gagal: isi Main password terlebih dahulu."); return; }
  for(let i=0; i<10; i++){
    accounts[i].password = p;
  }
  renderAccounts();
  log("Generate Password: Main password disalin ke semua 10 troop.");
}

function clearFields(){
  for(let i=0; i<10; i++){
    accounts[i].username = "";
    accounts[i].password = "";
    accounts[i].balance = "-";
  }
  el("mainTroop").value = "";
  el("mainPassword").value = "";
  renderAccounts();
  log("Semua field troop dikosongkan.");
}

let apiDisplayIndex = null;
function openEvents(i){
  const a = accounts[i];
  if(!a.sessionId) return;
  // Tampilkan event dari satu WebSocket saja agar log tidak terduplikasi.
  if(apiDisplayIndex !== null && apiDisplayIndex !== i){
    return;
  }
  apiDisplayIndex = i;
  if(a.eventSource) try{ a.eventSource.close(); }catch{}
  const es = new EventSource(`/api/events?sessionId=${encodeURIComponent(a.sessionId)}`);
  a.eventSource = es;
  es.onmessage = e => {
    try{
      const wrapper = JSON.parse(e.data);
      const msg = wrapper?.event ?? wrapper;
      handleApiEvent(i, msg);
    }catch(err){
      handleApiEvent(i, {type:"sse.parse.error", raw:e.data, error:String(err)});
    }
  };
  es.onerror = () => {};
}

const TIMER_START_MS = 60000;
let timerValue = TIMER_START_MS;
let timerRunning = false;
let timerDeadline = 0;
let timerFrame = 0;
let timerGeneration = 0;
let kickTriggeredForTimer = false;
let lastTimerEventKey = "";
let activeVoteKey = "";

function renderTimer(){
  const node = el("timerValue");
  if(node) node.textContent = String(Math.max(0, Math.ceil(timerValue)));
}

function getKickTimerMs(){
  return Math.max(0, Number(el("kickTimer")?.value) || 0);
}

function resetTimer(){
  timerGeneration++;
  timerRunning = false;
  if(timerFrame) clearTimeout(timerFrame);
  timerFrame = 0;
  timerDeadline = 0;
  timerValue = TIMER_START_MS;
  kickTriggeredForTimer = false;
  renderTimer();
  log("Timer di-reset ke 60000 ms.");
}

function triggerKickAllIfReached(previousValue = null){
  const configuredMs = getKickTimerMs();
  if(kickTriggeredForTimer || configuredMs < 0) return;

  // Jangan bergantung pada exact millisecond tick. Trigger saat countdown
  // melewati nilai textbox, sehingga 1500 ms tidak akan terlewat akibat
  // setTimeout/performance jitter.
  const reached = previousValue === null
    ? timerValue <= configuredMs
    : previousValue > configuredMs && timerValue <= configuredMs;

  if(reached){
    kickTriggeredForTimer = true;
    log(`Countdown mencapai ${configuredMs} ms: menjalankan KICK ALL otomatis.`);
    const button = el("kickAllButton");
    if(button) button.click();
    else kickSelectedTargets();
  }
}

function startCountdown(durationMs = TIMER_START_MS, eventKey = ""){
  // Event yang sama/duplikat tidak boleh menghidupkan ulang timer.
  if(eventKey && eventKey === lastTimerEventKey){
    return;
  }
  if(eventKey) lastTimerEventKey = eventKey;

  const duration = Math.max(0, Number(durationMs) || 0);
  const generation = ++timerGeneration;

  if(timerFrame) clearTimeout(timerFrame);

  timerValue = duration;
  timerDeadline = performance.now() + duration;
  timerRunning = duration > 0;
  kickTriggeredForTimer = false;
  renderTimer();
  triggerKickAllIfReached(null);

  if(!timerRunning){
    timerValue = 0;
    renderTimer();
    return;
  }

  // Asynchronous countdown. Tidak ada interval blocking dan timer tidak
  // pernah di-reset ke 60000 saat mencapai 0.
  const tick = () => {
    if(!timerRunning || generation !== timerGeneration) return;

    const previousValue = timerValue;
    const remaining = Math.max(0, timerDeadline - performance.now());
    const nextValue = Math.ceil(remaining);

    timerValue = nextValue;
    renderTimer();
    triggerKickAllIfReached(previousValue);

    if(remaining <= 0){
      timerRunning = false;
      timerValue = 0;
      timerFrame = 0;
      renderTimer();
      log("Countdown selesai: 0 ms. Menunggu event vote_started berikutnya.");
      return;
    }

    // Update cukup sering untuk tampilan, tetapi tidak memaksa 1 callback
    // untuk setiap 1 ms.
    timerFrame = setTimeout(tick, Math.min(100, Math.max(10, remaining % 100 || 25)));
  };

  timerFrame = setTimeout(tick, 0);
}

const apiEventHistory = [];
const MAX_API_EVENT_HISTORY = 8;

function clearApiEvents(){
  apiEventHistory.length = 0;
  const box = el("apiEvent");
  if(box) box.textContent = "Log API dibersihkan. Menunggu event baru…";
}

function getKickEventData(msg){
  return msg?.data ?? msg ?? {};
}

function getEventTimestamp(msg){
  const data = getKickEventData(msg);
  const candidates = [
    data?.time, data?.timestamp, data?.event_time, data?.eventTime, data?.created_at, data?.createdAt,
    msg?.time, msg?.timestamp, msg?.event_time, msg?.eventTime, msg?.created_at, msg?.createdAt
  ];
  for(const value of candidates){
    if(value == null || value === "") continue;
    if(typeof value === "number" || (/^\d+(?:\.\d+)?$/.test(String(value)))){
      const n = Number(value);
      if(Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
    }
    const t = Date.parse(String(value));
    if(Number.isFinite(t)) return t;
  }
  return null;
}

function getVoteRemainingMs(msg){
  const data = getKickEventData(msg);
  const status = String(data?.status_message ?? msg?.status_message ?? "").trim();
  const match = status.match(/(\d+)\s*(?:s|sec|secs|second|seconds)\s+remaining\.?$/i);
  if(match) return Math.max(0, Number(match[1]) * 1000);
  const millisecondCandidates = [data?.remaining_ms, data?.remainingMs, msg?.remaining_ms, msg?.remainingMs];
  for(const value of millisecondCandidates){
    const n = Number(value);
    if(Number.isFinite(n) && n >= 0) return n;
  }
  const secondCandidates = [data?.remaining, msg?.remaining];
  for(const value of secondCandidates){
    const n = Number(value);
    if(Number.isFinite(n) && n >= 0) return n * 1000;
  }
  return null;
}

function getVoteCountdownMs(msg){
  // Prioritaskan waktu event asli dari API. Jika WebSocket terlambat 8 detik,
  // countdown dimulai dari ~52.000 ms, bukan 60.000 ms.
  const eventTime = getEventTimestamp(msg);
  if(Number.isFinite(eventTime)){
    const age = Math.max(0, Date.now() - eventTime);
    return Math.max(0, TIMER_START_MS - age);
  }

  // Fallback jika API tidak memberi timestamp: gunakan sisa waktu yang tertulis
  // pada status event. Ini tetap lebih akurat daripada selalu memulai 60 detik.
  const remaining = getVoteRemainingMs(msg);
  if(Number.isFinite(remaining)) return Math.min(TIMER_START_MS, Math.max(0, remaining));

  return TIMER_START_MS;
}

function isVoteStartedKickEvent(msg){
  const data = getKickEventData(msg);
  const eventType = String(msg?.type ?? data?.event_type ?? "").toLowerCase();
  const action = String(data?.action ?? msg?.action ?? "").toLowerCase();
  const command = String(data?.command ?? msg?.command ?? "").toLowerCase();
  const status = String(data?.status_message ?? msg?.status_message ?? "").trim();
  const success = data?.success ?? msg?.success;

  // Harus persis state awal vote-kick. Event status lain tidak boleh
  // menyalakan/restart countdown.
  if(eventType !== "room.kick.state" || action !== "vote_started" || command !== "kick" || success === false) return false;
  if(!/^A vote to kick\s+.+\s+has been started by\s+.+,\s+\d+\s+more votes needed\.\s+\d+\s*(?:s|sec|secs|second|seconds)\s+remaining\.?$/i.test(status)) return false;

  // Event lebih tua dari satu countdown penuh tidak relevan lagi.
  const eventTime = getEventTimestamp(msg);
  if(Number.isFinite(eventTime) && Date.now() - eventTime > TIMER_START_MS + 5000) return false;

  return true;
}

function getVoteKey(msg){
  const data = getKickEventData(msg);
  const explicitId = String(
    data?.event_id ?? data?.eventId ?? data?.id ?? msg?.event_id ?? msg?.eventId ?? ""
  ).trim();
  if(explicitId) return `id:${explicitId}`;

  const target = String(data?.target_username ?? "").trim().toLowerCase();
  const starter = String(data?.username ?? "").trim().toLowerCase();
  const room = String(data?.room ?? data?.room_name ?? "").trim().toLowerCase();
  const time = String(data?.time ?? msg?.time ?? "").trim();

  // Jika API tidak menyediakan event_id, waktu event tetap dipakai untuk
  // membedakan dua vote yang benar-benar berbeda. Status countdown tidak
  // pernah dipakai sebagai identitas event.
  return `vote:${room}|${target}|${starter}|${time}`;
}

function isVoteFinishedEvent(msg){
  const data = getKickEventData(msg);
  const eventType = String(msg?.type ?? data?.event_type ?? "").toLowerCase();
  const action = String(data?.action ?? msg?.action ?? "").toLowerCase();
  return (eventType === "room.kick.state" || eventType === "room.kick") &&
    ["vote_completed","vote_cancelled","vote_failed","kick_completed","kick_failed","completed","cancelled"].includes(action);
}

function appendApiEvent(i, msg){
  const box = el("apiEvent");
  if(!box) return;
  const entry = `[${new Date().toLocaleTimeString()}] Troop ${i + 1} • ${msg?.type ?? "unknown"}\n${JSON.stringify(msg, null, 2)}`;
  apiEventHistory.push(entry);
  if(apiEventHistory.length > MAX_API_EVENT_HISTORY) apiEventHistory.shift();
  box.textContent = apiEventHistory.join("\n\n────────────────────────\n\n");
  box.scrollTop = box.scrollHeight;
}

function handleApiEvent(i, msg){
  appendApiEvent(i, msg);
  if(isVoteFinishedEvent(msg)){
    // Vote lama sudah berakhir; vote_started berikutnya boleh menjadi trigger baru.
    activeVoteKey = "";
  }
  if(isVoteStartedKickEvent(msg)){
    const eventKey = getVoteKey(msg);

    // Event yang sama dapat dikirim berkali-kali oleh stream. Jangan pernah
    // restart countdown hanya karena ada salinan event vote_started.
    if(eventKey && eventKey === activeVoteKey) return;

    // Selama countdown aktif, event vote_started lain tidak boleh me-reset
    // timer yang sedang berjalan. Timer berikutnya hanya boleh dimulai setelah
    // countdown selesai (atau setelah reset manual).
    if(timerRunning) return;

    activeVoteKey = eventKey;
    const countdownMs = getVoteCountdownMs(msg);
    log(`Vote kick terdeteksi: countdown real-time ${countdownMs} ms.`);
    startCountdown(countdownMs, eventKey);
  }
  if(msg.type === "wallet.balance.result" || msg.type === "wallet.transfer.result"){
    const w = msg.data?.wallet;
    if(w?.label) setBalance(i, w.label);
    else if(w?.balance_cr != null) setBalance(i, `${w.balance_cr} CR`);
  }
  if(msg.type === "session.replaced"){
    setStatus(i, "OFFLINE");
    accounts[i].sessionId = null;
    setBalance(i, "-");
  }
  if(String(msg.type||"").includes("participants") || hasParticipantContainer(msg.data)){
    const list = extractParticipantNames(msg);
    if(list.length){
      renderParticipants(list);
      log(`Participants diterima dari Troop ${i+1}: ${list.length} peserta.`);
    }
  }
}

function hasParticipantContainer(data){
  if(!data || typeof data !== "object") return false;
  return ["participants", "participant", "members", "users"].some(k => Object.prototype.hasOwnProperty.call(data, k));
}

function extractParticipantNames(msg){
  const found = [];
  const seen = new Set();
  const add = v => {
    if(typeof v !== "string") return;
    const n = v.trim();
    if(n && !seen.has(n)){ seen.add(n); found.push(n); }
  };
  function walk(v, depth, participantContext=false){
    if(depth > 10 || v == null) return;
    if(Array.isArray(v)){ for(const x of v) walk(x, depth+1, participantContext); return; }
    if(typeof v !== "object") return;
    const keys = Object.keys(v);
    const ctx = participantContext || keys.some(k => ["participants","participant","members","users"].includes(k));
    if(ctx && typeof v.username === "string") add(v.username);
    if(ctx && typeof v.user_name === "string") add(v.user_name);
    if(ctx && typeof v.name === "string" && keys.some(k => ["user_id","userId","username","user_name"].includes(k))) add(v.name);
    for(const [k, val] of Object.entries(v)){
      if(["password","permissions","wallet"].includes(k)) continue;
      const childCtx = ctx || ["participants","participant","members","users","items","result","data"].includes(k);
      walk(val, depth+1, childCtx);
    }
  }
  walk(msg, 0, String(msg?.type||"").includes("participants"));
  return found;
}

function renderParticipants(list, merge=true){
  const combined = merge ? [...participantNames, ...list] : list;
  const unique = [...new Set(combined.filter(Boolean))];
  participantNames.length = 0;
  participantNames.push(...unique);
  if(!unique.length){
    el("participantsList").innerHTML = '<div class="flex items-center justify-center h-full text-xs text-slate-500 py-10">Tidak ada peserta.</div>';
    return;
  }
  el("participantsList").innerHTML = unique.map(n => `
    <label class="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-slate-900 border border-slate-800/80 hover:border-slate-700 cursor-pointer transition-colors">
      <input type="checkbox" class="participant-check w-4 h-4 rounded border-slate-700 bg-slate-950 text-blue-600 accent-blue-600" data-name="${esc(n)}" onchange="toggleParticipantTarget(this)">
      <span class="text-xs sm:text-sm text-slate-200 truncate">${esc(n)}</span>
    </label>
  `).join("");
}

function clearParticipants(){
  participantNames.length = 0;
  el("participantsList").innerHTML = '<div class="flex items-center justify-center h-full text-xs text-slate-500 py-10">Belum ada data participants.</div>';
}

function toggleParticipantTarget(checkbox){
  const n = String(checkbox?.dataset?.name || "").trim();
  if(!n) return;
  if(checkbox.checked){
    if(!targets.includes(n)) targets.push(n);
  }else{
    const idx = targets.indexOf(n);
    if(idx >= 0) targets.splice(idx, 1);
  }
  renderTargets();
}

function renderTargets(){
  el("targetList").innerHTML = targets.length ? targets.map((n, i) => `
    <div class="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-slate-900 border border-slate-800/80">
      <span class="text-[11px] font-mono font-bold text-blue-400 bg-blue-950/40 px-2 py-0.5 rounded border border-blue-800/40">${String(i+1).padStart(2,"0")}</span>
      <span class="text-xs sm:text-sm text-slate-200 truncate flex-1">${esc(n)}</span>
    </div>
  `).join("") : '<div class="flex items-center justify-center h-full text-xs text-slate-500 py-10">Belum ada target.</div>';
}

function clearTargets(){
  targets.length = 0;
  renderTargets();
}

async function loginOne(i){
  sync();
  const a = accounts[i];
  if(!a.username || !a.password){ log(`Troop ${i+1}: nama dan password wajib diisi.`); return; }
  if(a.sessionId) await logoutOne(i, true);
  setStatus(i, "LOGIN…");
  try{
    const r = await fetch("/api/login", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({username:a.username, password:a.password})});
    const j = await r.json();
    if(!j.ok) throw new Error(j.error || "Login gagal");
    a.sessionId = j.account.sessionId;
    const w = j.account.wallet;
    if(w?.label) setBalance(i, w.label);
    else if(w?.balance_cr != null) setBalance(i, `${w.balance_cr} CR`);
    else setBalance(i, "-");
    setStatus(i, "ONLINE", "online");
    openEvents(i);
    log(`Troop ${i+1} ${a.username}: ONLINE`);
  }catch(e){
    setStatus(i, "OFFLINE", "error");
    log(`Troop ${i+1}: LOGIN GAGAL - ${e.message}`);
  }
}

async function logoutOne(i, silent=false){
  const a = accounts[i];
  if(a.eventSource) try{ a.eventSource.close(); }catch{}
  a.eventSource = null;
  if(apiDisplayIndex === i) apiDisplayIndex = null;
  if(a.sessionId){
    try{ await fetch("/api/logout", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({sessionId:a.sessionId})}); }catch{}
  }
  a.sessionId = null;
  setStatus(i, "OFFLINE");
  setBalance(i, "-");
  if(!silent) log(`Troop ${i+1}: LOGOUT`);
}

async function batchAction(action, extra={}){
  const ids = accounts.map(a => a.sessionId).filter(Boolean);
  if(!ids.length){ log(`${action.toUpperCase()}: tidak ada Troop yang ONLINE.`); return null; }
  try{
    const r = await fetch("/api/batch-action", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({sessionIds:ids, action, ...extra})});
    const j = await r.json();
    if(!j.ok){ log(`${action.toUpperCase()} gagal: ${j.error||"Tidak ada session aktif."}`); return null; }
    log(`${action.toUpperCase()}: ${j.sent}/${j.total} WebSocket diperintah bersamaan.`);
    return j;
  }catch(e){
    log(`${action.toUpperCase()} gagal - ${e.message}`);
    return null;
  }
}

async function loginAll(){
  sync();
  const list = accounts.map((a, i) => ({index:i, username:a.username, password:a.password, sessionId:a.sessionId})).filter(a => a.username && a.password);
  if(!list.length){ log("LOGIN ALL: isi minimal satu Troop."); return; }
  list.forEach(a => setStatus(a.index, "LOGIN…"));
  try{
    const r = await fetch("/api/login-batch", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({accounts:list})});
    const j = await r.json();
    for(const item of (j.results || [])){
      const i = item.index;
      if(item.ok){
        accounts[i].sessionId = item.account.sessionId;
        const w = item.account.wallet;
        if(w?.label) setBalance(i, w.label);
        else if(w?.balance_cr != null) setBalance(i, `${w.balance_cr} CR`);
        else setBalance(i, "-");
        setStatus(i, "ONLINE", "online");
        openEvents(i);
      } else {
        accounts[i].sessionId = null;
        setStatus(i, "OFFLINE", "error");
        setBalance(i, "-");
      }
    }
    const ok = (j.results || []).filter(x => x.ok).length;
    const total = (j.results || []).length;
    log(`LOGIN ALL: ${ok}/${total} Troop login bersamaan.`);
    for(const item of (j.results || [])) if(!item.ok) log(`Troop ${item.index+1}: LOGIN GAGAL - ${item.error}`);
  }catch(e){
    for(const a of list) setStatus(a.index, "OFFLINE", "error");
    log(`LOGIN ALL gagal - ${e.message}`);
  }
}

async function logoutAll(){
  const ids = accounts.map(a => a.sessionId).filter(Boolean);
  accounts.forEach(a => { if(a.eventSource) try{ a.eventSource.close(); }catch{}; a.eventSource = null; });
  try{ await fetch("/api/logout-batch", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({sessionIds:ids})}); }catch{}
  for(let i=0; i<10; i++){
    accounts[i].sessionId = null;
    setStatus(i, "OFFLINE");
    setBalance(i, "-");
  }
  log("LOGOUT ALL: semua WebSocket ditutup bersamaan.");
}

el("resetTimerButton")?.addEventListener("click", resetTimer);
el("clearApiEvents")?.addEventListener("click", clearApiEvents);
el("generateTroop").onclick = generateTroop;
el("generatePassword").onclick = generatePassword;
el("clearFields").onclick = clearFields;

el("saveAccounts").onclick = function(){
  sync();
  let name = el("saveName").value.trim() || "troop1";
  name = name.replace(/\.json$/i, "") || "troop1";
  const data = {
    app: "MIGMASTER PROTOTIPE 1.0",
    version: 5,
    savedAt: new Date().toISOString(),
    mainTroop: el("mainTroop").value.trim(),
    mainPassword: el("mainPassword").value,
    rangeStart: el("rangeStart").value,
    rangeEnd: el("rangeEnd").value,
    accounts: accounts.map(a => ({username:a.username, password:a.password}))
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name + ".json";
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
  log(`Save berhasil: ${name}`);
};

el("loadAccounts").onclick = ()=> el("loadFile").click();
el("loadFile").onchange = e => {
  const file = e.target.files[0];
  if(file){
    const reader = new FileReader();
    reader.onload = () => {
      try{
        const data = JSON.parse(reader.result);
        if(!Array.isArray(data.accounts)) throw new Error("Format save tidak valid.");
        el("mainTroop").value = String(data.mainTroop || "");
        el("mainPassword").value = String(data.mainPassword || "");
        el("rangeStart").value = String(data.rangeStart ?? "1");
        el("rangeEnd").value = String(data.rangeEnd ?? "10");
        for(let i=0; i<10; i++){
          const a = data.accounts[i] || {};
          accounts[i].username = String(a.username || "");
          accounts[i].password = String(a.password || "");
          accounts[i].balance = "-";
        }
        const base = file.name.replace(/\.json$/i, "");
        el("saveName").value = base || "troop1";
        renderAccounts();
        log(`Load berhasil: ${file.name}`);
      }catch(err){
        log(`Load gagal: ${err.message}`);
      }
    };
    reader.readAsText(file);
  }
  e.target.value = "";
};

el("loginAll").onclick = loginAll;
el("logoutAll").onclick = logoutAll;

async function joinAll(){
  const room = el("room").value.trim();
  if(!room){ log("JOIN ALL: nama room belum diisi."); return; }
  await batchAction("join", {room});
}

async function leaveAll(){
  const room = el("room").value.trim();
  if(!room){ log("LEAVE ALL: nama room belum diisi."); return; }
  await batchAction("leave", {room});
}

async function participants(){
  const room = el("room").value.trim();
  if(!room){ log("PARTICIPANTS: nama room belum diisi."); return; }
  clearParticipants();
  const sessionId = accounts.map(a => a.sessionId).find(Boolean);
  if(!sessionId){ log("PARTICIPANTS: tidak ada Troop yang ONLINE."); return; }
  try{
    const r = await fetch("/api/action", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({sessionId, action:"participants", room})});
    const j = await r.json();
    if(!j.ok){ log(`PARTICIPANTS gagal: ${j.error||"Gagal meminta list peserta."}`); return; }
    const troopIndex = accounts.findIndex(a => a.sessionId === sessionId);
    log(`PARTICIPANTS: list peserta diminta oleh Troop ${troopIndex >= 0 ? troopIndex + 1 : "ONLINE"} saja.`);
  }catch(e){
    log(`PARTICIPANTS gagal - ${e.message}`);
  }
}

async function balanceAll(){
  const online = accounts.map((a, i) => ({i, sessionId:a.sessionId})).filter(x => x.sessionId);
  if(!online.length){ log("CEK SALDO ALL: tidak ada Troop yang ONLINE."); return; }
  // Saldo tidak bergantung pada satu SSE event-source. Backend menunggu
  // wallet.balance.result untuk setiap session dan mengembalikan hasilnya.
  try{
    const r = await fetch("/api/balance-all", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({sessionIds:online.map(x => x.sessionId)})
    });
    const j = await r.json();
    const bySession = new Map((j.results || []).map(x => [x.sessionId, x]));
    let ok = 0;
    for(const item of online){
      const result = bySession.get(item.sessionId);
      if(result?.ok){
        const w = result.wallet || {};
        if(w.label) setBalance(item.i, w.label);
        else if(w.balance_cr != null) setBalance(item.i, `${w.balance_cr} CR`);
        else setBalance(item.i, "-");
        ok++;
      }else{
        setBalance(item.i, "-");
        log(`Troop ${item.i + 1}: CEK SALDO GAGAL - ${result?.error || "Tidak ada response."}`);
      }
    }
    log(`CEK SALDO ALL: ${ok}/${online.length} saldo berhasil diperbarui.`);
  }catch(e){
    log(`CEK SALDO ALL gagal - ${e.message}`);
  }
}


async function kickSelectedTargets(){
  const room = el("room").value.trim();
  if(!room){ log("KICK ALL: nama room belum diisi."); return; }
  if(!targets.length){ log("KICK ALL: belum ada target kick."); return; }

  const textdelay = Math.max(0, parseInt(el("textdelay")?.value || "50", 10) || 0);
  const textloop = Math.max(1, parseInt(el("textloop")?.value || "1", 10) || 1);
  const onlineWs = accounts.map(a=>a.sessionId).filter(Boolean).length;

  try{
    const r = await fetch("/api/kick-loop", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        sessionIds: accounts.map(a=>a.sessionId).filter(Boolean),
        room, targets:[...targets], textdelay, textloop
      })
    });
    const j = await r.json();
    if(!j.ok || !j.executionId){
      log(`KICK ALL gagal: ${j.error || "Gagal memulai KICK ALL."}`);
      return;
    }
    log(`KICK ALL dimulai: ${targets.length} target × ${textloop} loop × ${onlineWs} WS • pair delay ${textdelay} ms.`);
  }catch(e){
    log(`KICK ALL gagal - ${e.message}`);
  }
}

renderAccounts();
renderTargets();
renderTimer();
