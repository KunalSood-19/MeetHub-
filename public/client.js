/* =============================================================
   MeetApp Pro — client.js   (fully corrected)
   ============================================================= */

let meetingTranscript = "";

const socket = io();

function $(id){ return document.getElementById(id); }

const params = new URLSearchParams(location.search);
const room   = params.get("room") || "lobby";
const myName = params.get("name") || localStorage.getItem("meetapp-name") || "Guest";
const myPass = params.get("pass") || "";
localStorage.setItem("meetapp-name", myName);

/* ── STATE ─────────────────────────────────────────────────── */
let localStream   = null;
let blurCanvas    = null;
let blurCtx       = null;
let blurRAF       = null;
let blurOn        = false;
const peers       = {};
let recorder      = null;
let recChunks     = [];
let micOn         = true;
let camOn         = true;
let screenSharing = false;
let sidebarOpen   = true;
let isHost        = false;
let roomLocked    = false;
let pinnedTile    = null;
let aiMode        = "summary";
let transcript    = [];
let captionOn     = false;
let recognition   = null;
let isRecognitionRunning = false;
let audioCtx      = null;
let musicNodes    = [];
let currentSound  = "none";
let agendaItems   = [];
let agTimerSec    = 0;
let agCurrentIdx  = -1;
let agInterval    = null;
let agPaused      = false;
let wbTool        = "pen";
let wbDrawing     = false;
let wbLastX       = 0;
let wbLastY       = 0;
let wbCanvas      = null;
let wbCtx         = null;
let notepadDebounce = null;
let attendanceLog = [];

/* ── INIT ───────────────────────────────────────────────────── */
$("roomBadge").textContent = room;
$("localNm").textContent   = myName + " (You)";
$("localAv").textContent   = myName[0].toUpperCase();

$("roomBadge").addEventListener("click", () => {
  navigator.clipboard.writeText(room);
  toast("📋 Room code copied: " + room);
});

document.addEventListener("click", () => {
  $("reactPop").classList.remove("on");
});

/* ── CLOCK ──────────────────────────────────────────────────── */
const t0 = Date.now();
setInterval(() => {
  const s = Math.floor((Date.now() - t0) / 1000);
  $("clk").textContent =
    [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
      .map(v => String(v).padStart(2, "0")).join(":");
}, 1000);

/* ── TOAST ──────────────────────────────────────────────────── */
let toastTimer;
function toast(msg, dur = 3000) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("on"), dur);
}

/* ── THEME ──────────────────────────────────────────────────── */
function setTheme(name, btn) {
  document.documentElement.setAttribute("data-theme", name);
  document.querySelectorAll(".th-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
}

/* ── PASSWORD CHECK ─────────────────────────────────────────── */
socket.emit("check-password", { room, password: myPass });
socket.on("password-ok",   () => socket.emit("join-room", { room, name: myName }));
socket.on("password-fail", () => { alert("❌ Wrong room password!"); location.href = "/"; });

/* ── WAITING ROOM ───────────────────────────────────────────── */
socket.on("in-waiting-room", () => $("waitModal").classList.add("on"));

socket.on("admitted", async () => {
  $("waitModal").classList.remove("on");
  toast("✅ Admitted!");

  if (localStream) {
    socket.emit("join-video", room);
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localStream = stream;
    const v = $("localVideo");
    v.srcObject = stream;
    v.muted = true;
    v.play().catch(() => {});
    startSpeakerDetection();       // FIX: start speaker detection after stream acquired
    socket.emit("join-video", room);
  } catch(err) {
    console.log(err);
    toast("Camera permission denied");
    socket.emit("join-video", room);
  }
});

socket.on("rejected", () => {
  $("waitModal").classList.remove("on");
  $("rejModal").classList.add("on");
});

/* ── YOUR ROLE ──────────────────────────────────────────────── */
socket.on("your-role", ({ isHost: h }) => {
  isHost = h;
  $("hostBadge").style.display = h ? "" : "none";
  $("hostCtrl").style.display  = h ? "" : "none";
});
socket.on("room-locked", locked => {
  roomLocked = locked;
  $("lockLabel").textContent = locked ? "Unlock Room" : "Lock Room";
});
socket.on("room-state", s => { roomLocked = s.locked; });

/* ── WAITING USERS (host) ───────────────────────────────────── */
socket.on("waiting-user", ({ id, name }) => {
  $("waitingArea").style.display = "";
  switchTab("people", document.querySelector(".stab:nth-child(2)"));

  const wl = $("waitingList");
  if (!$("wu-" + id)) {
    const d = document.createElement("div");
    d.id = "wu-" + id;
    d.className = "pitem";
    d.innerHTML = `
      <div class="pav">${name[0].toUpperCase()}</div>
      <span class="pnm">${esc(name)}</span>
      <div class="host-actions">
        <button class="hact adm" onclick="admitUser('${id}')">Allow</button>
        <button class="hact" onclick="rejectUser('${id}')">Deny</button>
      </div>`;
    wl.appendChild(d);
  }

  showJoinPopup(id, name);
  playJoinSound();
});

function showJoinPopup(id, name) {
  const old = document.getElementById("joinPopup");
  if (old) old.remove();
  const pop = document.createElement("div");
  pop.id = "joinPopup";
  pop.innerHTML = `
    <div class="join-box">
      <h3>${esc(name)} wants to join</h3>
      <div class="join-btns">
        <button onclick="admitUser('${id}');closeJoinPopup()">Allow</button>
        <button class="deny" onclick="rejectUser('${id}');closeJoinPopup()">Deny</button>
      </div>
    </div>`;
  document.body.appendChild(pop);
}

function closeJoinPopup() {
  const p = document.getElementById("joinPopup");
  if (p) p.remove();
}

function playJoinSound() {
  const audio = new Audio("https://actions.google.com/sounds/v1/alarms/beep_short.ogg");
  audio.play().catch(() => {});
}

function admitUser(id) {
  socket.emit("admit-user", { userId: id });
  const el = $("wu-" + id); if (el) el.remove();
  if (!$("waitingList").children.length) $("waitingArea").style.display = "none";
}

function rejectUser(id) {
  socket.emit("reject-user", { userId: id });
  const el = $("wu-" + id); if (el) el.remove();
  if (!$("waitingList").children.length) $("waitingArea").style.display = "none";
}

/* ── MEDIA ──────────────────────────────────────────────────── */
navigator.mediaDevices.getUserMedia({ video: true, audio: true })
  .then(stream => {
    localStream = stream;
    const v = $("localVideo");
    v.srcObject = stream;
    v.muted = true;
    v.play().catch(() => {});
    startSpeakerDetection();       // FIX: start speaker detection after stream acquired
    updateGrid();                  // FIX: update grid on initial load
    socket.emit("join-video", room); // FIX: emit join-video in normal (non-waiting-room) path
  })
  .catch(err => {
    console.log(err);
    updateGrid();                  // FIX: still update grid even without camera
  });

/* ── SPEAKER DETECTION ──────────────────────────────────────── */
function startSpeakerDetection() {
  if (!localStream) return;
  try {
    const ctx      = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    ctx.createMediaStreamSource(localStream).connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let wasSpeaking = false;
    setInterval(() => {
      analyser.getByteFrequencyData(data);
      const avg      = data.reduce((a, b) => a + b, 0) / data.length;
      const speaking = avg > 18;
      $("localTile").classList.toggle("speaking", speaking);
      if (speaking !== wasSpeaking) {
        socket.emit("speaking", speaking);
        wasSpeaking = speaking;
      }
    }, 150);
  } catch(e) { console.warn("Speaker detection:", e); }
}

socket.on("peer-speaking", ({ id, speaking }) => {
  const tile = $("tile-" + id);
  if (tile) tile.classList.toggle("speaking", speaking);
});

/* ── GRID LAYOUT ────────────────────────────────────────────── */
function updateGrid() {
  const grid = $("videoGrid");
  const n    = grid.querySelectorAll(".tile").length;
  grid.className = "vid-grid " + (n <= 1 ? "c1" : n === 2 ? "c2" : n <= 4 ? "c4" : "cM");
}

/* ── WEBRTC ─────────────────────────────────────────────────── */
function createPeer(id, userName = "Guest") {
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" }
    ]
  });

  pc.onicecandidate = e => {
    if (e.candidate) socket.emit("signal", { to: id, signal: e.candidate });
  };

  pc.ontrack = e => {
    let tile = $("tile-" + id);
    if (!tile) {
      tile = document.createElement("div");
      tile.id = "tile-" + id;
      tile.className = "tile";
      tile.onclick = () => pinTile(tile);
      tile.innerHTML = `
        <video id="rv-${id}" autoplay playsinline
          style="width:100%;height:100%;object-fit:cover"></video>
        <div class="nm" id="nm-${id}">${esc(userName)}</div>
        <button class="pin-btn"
          onclick="event.stopPropagation();
          pinTile(document.getElementById('tile-${id}'))">📌</button>`;
      $("videoGrid").appendChild(tile);
      updateGrid();
    }
    $("rv-" + id).srcObject = e.streams[0];
  };

  peers[id] = pc;
  return pc;
}

socket.on("user-joined", async ({id,name})=>{

if(id===socket.id) return;
if(peers[id]) return;
if(!localStream) return;

const pc=createPeer(id,name);

localStream.getTracks().forEach(track=>{
pc.addTrack(track,localStream);
});

if(socket.id < id){

const offer=await pc.createOffer();
await pc.setLocalDescription(offer);

socket.emit("signal",{
to:id,
signal:pc.localDescription
});

}

});

socket.on("signal", async ({ from, signal, name }) => {
  let pc = peers[from];
  if (!pc) {
    pc = createPeer(from, name || "Guest");
    if (localStream) localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  try {
    if (signal.candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(signal));
      return;
    }
    if (signal.type === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(signal));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("signal", { to: from, signal: pc.localDescription, name: myName });
    }
    if (signal.type === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(signal));
    }
  } catch(err) {
    console.error("Signal error:", err);
  }
});

socket.on("user-disconnected", id => {
  if (peers[id]) { peers[id].close(); delete peers[id]; }
  const t = $("tile-" + id); if (t) t.remove();
  updateGrid();
  if (pinnedTile && pinnedTile.id === "tile-" + id) pinnedTile = null;
});

/* ── PIN / SPOTLIGHT ────────────────────────────────────────── */
function pinTile(tile) {
  if (pinnedTile === tile) {
    tile.classList.remove("pinned");
    pinnedTile = null;
    toast("📌 Unpinned");
  } else {
    if (pinnedTile) pinnedTile.classList.remove("pinned");
    tile.classList.add("pinned");
    pinnedTile = tile;
    toast("📌 Pinned — click again to unpin");
  }
}

/* ── USERS LIST ─────────────────────────────────────────────── */
socket.on("update-users", users => {
  attendanceLog = users;
  const list = $("userList");
  list.innerHTML = "";
  users.forEach(u => {
    const me = u.name === myName;
    list.innerHTML += `
      <div class="pitem">
        <div class="pav">${u.name[0].toUpperCase()}</div>
        <span class="pnm">${esc(u.name)}</span>
        ${u.isHost ? '<span class="hbadge">Host</span>' : ""}
        ${me ? '<span style="font-size:9px;color:var(--muted)">(You)</span>' : ""}
${isHost && !me ? `
<div class="host-actions">
<button class="hact" onclick="hostMute('${u.id}')">🔇</button>
<button class="hact" onclick="hostKick('${u.id}')">🚫</button>
</div>
` : ""}
      </div>`;
  });
});

/* ── HOST CONTROLS ──────────────────────────────────────────── */
function toggleLockRoom()  { roomLocked = !roomLocked; socket.emit("lock-room", roomLocked); }
// FIX: include room in set-password emit so server knows which room
function setRoomPassword() {
  const p = prompt("Set password (blank to remove):");
  if (p !== null) socket.emit("set-password", { room, password: p });
}
function hostMute(userId){
 socket.emit("host-mute",{room,userId});
}

function hostKick(userId){
 socket.emit("host-kick",{room,userId});
}

socket.on("force-mute", () => {

  if (!localStream) return;

  const track = localStream.getAudioTracks()[0];

  if (track) {
    track.enabled = false;
    micOn = false;
    updateMicBtn();
  }

  toast("🔇 Host muted you");

});

socket.on("force-kick", () => {
  alert("Host removed you from meeting");
  leaveCall();
});

/* ── MIC ────────────────────────────────────────────────────── */
function toggleMic() {
  if (!localStream) return toast("No microphone found");
  const t = localStream.getAudioTracks()[0];
  if (!t) return toast("No microphone found");
  micOn = !micOn;
  t.enabled = micOn;
  updateMicBtn();
  toast(micOn ? "🎤 Mic on" : "🔇 Muted");
}
function updateMicBtn() {
  const b = $("bMic");
  b.innerHTML = micOn
    ? '<span class="ic">🎤</span><span>Mic</span>'
    : '<span class="ic">🔇</span><span>Muted</span>';
  b.classList.toggle("on", !micOn);
}

/* ── CAMERA ─────────────────────────────────────────────────── */
function toggleCam() {
  if (!localStream) return;
  const t = localStream.getVideoTracks()[0];
  if (!t) return;
  camOn = !camOn;
  t.enabled = camOn;
  $("localCamOff").style.display = camOn ? "none" : "flex";
  const b = $("bCam");
  b.innerHTML = camOn
    ? '<span class="ic">📷</span><span>Camera</span>'
    : '<span class="ic">🚫</span><span>Cam Off</span>';
  b.classList.toggle("on", !camOn);
  toast(camOn ? "📷 Camera on" : "📷 Camera off");
}

/* ── BG BLUR ────────────────────────────────────────────────── */
function toggleBlur() {
  blurOn = !blurOn;
  $("bBlur").classList.toggle("on", blurOn);
  if (blurOn) {
    const vid = $("localVideo");
    blurCanvas = document.createElement("canvas");
    blurCanvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:blur(8px) brightness(.85)";
    $("localTile").insertBefore(blurCanvas, vid);
    blurCtx = blurCanvas.getContext("2d");
    function renderBlur() {
      if (!blurOn) return;
      blurCanvas.width  = vid.videoWidth  || 320;
      blurCanvas.height = vid.videoHeight || 240;
      blurCtx.drawImage(vid, 0, 0);
      blurRAF = requestAnimationFrame(renderBlur);
    }
    renderBlur();
    toast("🎭 BG blur on");
  } else {
    cancelAnimationFrame(blurRAF);
    if (blurCanvas) { blurCanvas.remove(); blurCanvas = null; }
    toast("🎭 BG blur off");
  }
}

/* ── SCREEN SHARE ───────────────────────────────────────────── */
async function shareScreen() {
  if (screenSharing) return stopScreen();
  try {
    const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const track  = screen.getVideoTracks()[0];
    screenSharing = true;
    $("bScreen").classList.add("on");
    $("bScreen").innerHTML = '<span class="ic">🖥️</span><span>Stop</span>';
    Object.values(peers).forEach(pc => {
      const s = pc.getSenders().find(s => s.track && s.track.kind === "video");
      if (s) s.replaceTrack(track);
    });
    $("localVideo").srcObject = screen;
    track.onended = stopScreen;
  } catch(e) { toast("Screen share cancelled"); }
}

function stopScreen() {
  screenSharing = false;
  $("bScreen").classList.remove("on");
  $("bScreen").innerHTML = '<span class="ic">🖥️</span><span>Share</span>';
  if (!localStream) return;
  const ct = localStream.getVideoTracks()[0];
  Object.values(peers).forEach(pc => {
    const s = pc.getSenders().find(s => s.track && s.track.kind === "video");
    if (s && ct) s.replaceTrack(ct);
  });
  $("localVideo").srcObject = localStream;
}

/* ── RECORDING ──────────────────────────────────────────────── */
function toggleRec() {
  if (!localStream) return toast("No stream to record");
  if (!recorder) {
    recChunks = [];
    try {
      recorder = new MediaRecorder(localStream, { mimeType: "video/webm;codecs=vp9" });
    } catch {
      recorder = new MediaRecorder(localStream);
    }
    recorder.ondataavailable = e => e.data.size > 0 && recChunks.push(e.data);
    recorder.onstop = () => {
      const blob = new Blob(recChunks, { type: "video/webm" });
      const a    = document.createElement("a");
      a.href     = URL.createObjectURL(blob);
      a.download = `meet-${Date.now()}.webm`;
      a.click();
      URL.revokeObjectURL(a.href);
      recChunks = [];
      recorder  = null;
    };
    recorder.start(1000);
    $("recDot").classList.add("on");
    $("bRec").classList.add("on");
    $("bRec").innerHTML = '<span class="ic">⏹️</span><span>Stop</span>';
    addChat("⏺ Recording started", "sys");
    toast("⏺ Recording…");
  } else {
    recorder.stop();
    $("recDot").classList.remove("on");
    $("bRec").classList.remove("on");
    $("bRec").innerHTML = '<span class="ic">⏺️</span><span>Record</span>';
    addChat("🛑 Recording saved", "sys");
    toast("🛑 Saved — downloading…");
  }
}

/* ── SNAPSHOT ───────────────────────────────────────────────── */
function takeSnapshot() {
  const canvas = document.createElement("canvas");
  const grid   = $("videoGrid");
  canvas.width  = grid.offsetWidth;
  canvas.height = grid.offsetHeight;
  const ctx     = canvas.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const tiles = grid.querySelectorAll("video");
  const cols  = tiles.length <= 1 ? 1 : tiles.length <= 2 ? 2 : 3;
  const w     = Math.floor(canvas.width  / cols);
  const h     = Math.floor(canvas.height / Math.ceil(tiles.length / cols));
  tiles.forEach((v, i) => {
    try { ctx.drawImage(v, (i % cols) * w, Math.floor(i / cols) * h, w, h); } catch(e) {}
  });
  const flash = document.createElement("div");
  flash.className = "snap-flash";
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 400);
  const a = document.createElement("a");
  a.href     = canvas.toDataURL("image/png");
  a.download = `snapshot-${Date.now()}.png`;
  a.click();
  toast("📸 Snapshot saved!");
}

/* ── CHAT ───────────────────────────────────────────────────── */
function addChat(html, cls = "") {
  const box = $("chatBox");
  const d   = document.createElement("div");
  d.className = "msg " + cls;
  d.innerHTML = html;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
}

socket.on("chat", data => {
  if (data.system) {
    addChat(esc(data.msg), "sys");
  } else {
    const me = data.user === myName;
    addChat(`<div class="snd">${esc(data.user)}</div>${esc(data.text)}`, me ? "mine" : "");
    transcript.push({ user: data.user, text: data.text, time: new Date().toLocaleTimeString() });
    meetingTranscript += `[${new Date().toLocaleTimeString()}] ${data.user}: ${data.text}\n`;
  }
});

function sendMsg() {
  const i = $("msgInput");
  if (!i.value.trim()) return;
  socket.emit("chat", { text: i.value });
  i.value = "";
}

/* ── FILE ───────────────────────────────────────────────────── */
function sendFile() {
  const f = $("fileInput").files[0];
  if (!f)               return toast("Select a file");
  if (f.size > 5*1024*1024) return toast("⚠️ Max 5 MB");
  toast("📤 Sending…");
  const r = new FileReader();
  r.onload = () => { socket.emit("file", { name: f.name, data: r.result }); $("fileInput").value = ""; };
  r.readAsDataURL(f);
}

socket.on("file", f => {
  const ext  = f.name.split(".").pop().toLowerCase();
  const icon = ["jpg","jpeg","png","gif","webp"].includes(ext) ? "🖼️"
             : ext === "pdf" ? "📄"
             : ["zip","rar"].includes(ext) ? "🗜️" : "📂";
  addChat(`<div class="snd">${esc(f.sender)}</div>${icon} <a href="${f.data}" download="${esc(f.name)}" style="color:var(--acc2)">${esc(f.name)}</a>`);
  toast(`${icon} File: ${f.name}`);
});

/* ── REACTIONS ──────────────────────────────────────────────── */
function toggleReactPop() { event.stopPropagation(); $("reactPop").classList.toggle("on"); }
function doReact(emoji)   { socket.emit("reaction", emoji); floatEmoji(emoji); $("reactPop").classList.remove("on"); }
socket.on("reaction", floatEmoji);
function floatEmoji(e) {
  const d = document.createElement("div");
  d.className = "emoji-fl";
  d.textContent = e;
  d.style.cssText = `left:${10 + Math.random() * 70}%;bottom:120px`;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 2200);
}

/* ── RAISE HAND ─────────────────────────────────────────────── */
function raiseHand() { socket.emit("raise-hand"); toast("✋ Hand raised!"); }
socket.on("hand-raised", d => {
  addChat(`✋ ${esc(d.name)} raised their hand`, "sys");
  toast(`✋ ${d.name} raised hand`);
});

/* ── POLL ───────────────────────────────────────────────────── */
const pollVotes = {};

function openPollModal()  { $("pollModal").classList.add("on"); }
function closePollModal() {
  $("pollModal").classList.remove("on");
  ["pQ","pO1","pO2","pO3","pO4"].forEach(id => $(id).value = "");
}

function submitPoll() {
  const q    = $("pQ").value.trim();
  const opts = ["pO1","pO2","pO3","pO4"].map(id => $(id).value.trim()).filter(Boolean);
  if (!q)           return toast("Enter a question");
  if (opts.length < 2) return toast("Need at least 2 options");
  socket.emit("poll", { question: q, options: opts });
  closePollModal();
  toast("📊 Poll launched!");
}

socket.on("poll", ({ id: pid, question, options, creator }) => {
  pollVotes[pid] = {};
  options.forEach(o => pollVotes[pid][o] = 0);
  switchTab("chat", document.querySelector(".stab"));
  const area = $("pollArea");
  const card = document.createElement("div");
  card.className = "poll-card";
  card.id = "poll-" + pid;
  card.innerHTML = `<h4>📊 ${esc(creator)}: ${esc(question)}</h4>` +
    options.map(o => `
      <div class="poll-opt" id="po-${pid}-${esc(o)}" onclick="votePoll('${pid}','${esc(o)}',this)">
        <span>○</span> ${esc(o)}<div style="margin-left:auto;font-size:10px;color:var(--muted)" id="pv-${pid}-${esc(o)}">0</div>
      </div>
      <div class="poll-bar"><div class="poll-fill" id="pf-${pid}-${esc(o)}" style="width:0%"></div></div>`
    ).join("");
  area.appendChild(card);
});

function votePoll(pid, option, el) {
  $("poll-" + pid).querySelectorAll(".poll-opt").forEach(o => { o.classList.remove("voted"); o.onclick = null; });
  el.classList.add("voted");
  el.querySelector("span").textContent = "✓";
  socket.emit("poll-vote", { pollId: pid, option });
  updatePollBar(pid, option);
  toast(`✅ Voted: ${option}`);
}

socket.on("poll-vote", ({ pollId: pid, option }) => updatePollBar(pid, option));

function updatePollBar(pid, option) {
  if (!pollVotes[pid]) return;
  pollVotes[pid][option] = (pollVotes[pid][option] || 0) + 1;
  const total = Object.values(pollVotes[pid]).reduce((a, b) => a + b, 0);
  Object.entries(pollVotes[pid]).forEach(([opt, cnt]) => {
    const pct  = total ? Math.round(cnt / total * 100) : 0;
    const vEl  = $(`pv-${pid}-${opt}`);
    const fEl  = $(`pf-${pid}-${opt}`);
    if (vEl) vEl.textContent  = cnt;
    if (fEl) fEl.style.width  = pct + "%";
  });
}

/* ── WHITEBOARD ─────────────────────────────────────────────── */
function openWB() {
  $("wbModal").classList.add("on");
  setTimeout(() => {
    wbCanvas = $("wbCanvas");
    wbCtx    = wbCanvas.getContext("2d");
    const rect      = wbCanvas.getBoundingClientRect();
    wbCanvas.width  = rect.width  || wbCanvas.parentElement.offsetWidth;
    wbCanvas.height = rect.height || wbCanvas.parentElement.offsetHeight - 56;
    wbCtx.fillStyle = "#ffffff";
    wbCtx.fillRect(0, 0, wbCanvas.width, wbCanvas.height);
    wbCanvas.onmousedown  = wbDown;
    wbCanvas.onmousemove  = wbDraw;
    wbCanvas.onmouseup    = wbUp;
    wbCanvas.onmouseleave = wbUp;
    wbCanvas.ontouchstart = e => { e.preventDefault(); wbDown(e.touches[0]); };
    wbCanvas.ontouchmove  = e => { e.preventDefault(); wbDraw(e.touches[0]); };
    wbCanvas.ontouchend   = wbUp;
  }, 100);
}
function closeWB() { $("wbModal").classList.remove("on"); }

function wbDown(e) {
  wbDrawing = true;
  const r = wbCanvas.getBoundingClientRect();
  wbLastX = e.clientX - r.left;
  wbLastY = e.clientY - r.top;
}
function wbDraw(e) {
  if (!wbDrawing || !wbCtx) return;
  const r     = wbCanvas.getBoundingClientRect();
  const x     = e.clientX - r.left;
  const y     = e.clientY - r.top;
  const color = wbTool === "eraser" ? "#ffffff" : $("wbColor").value;
  const size  = wbTool === "eraser" ? 18 : parseInt($("wbSize").value);
  wbCtx.beginPath();
  wbCtx.moveTo(wbLastX, wbLastY);
  wbCtx.lineTo(x, y);
  wbCtx.strokeStyle = color;
  wbCtx.lineWidth   = size;
  wbCtx.lineCap     = "round";
  wbCtx.lineJoin    = "round";
  wbCtx.stroke();
  socket.emit("whiteboard-draw", { x1: wbLastX, y1: wbLastY, x2: x, y2: y, color, size });
  wbLastX = x;
  wbLastY = y;
}
function wbUp() { wbDrawing = false; }

function clearWB() {
  if (wbCtx) { wbCtx.fillStyle = "#fff"; wbCtx.fillRect(0, 0, wbCanvas.width, wbCanvas.height); }
  socket.emit("whiteboard-clear");
}
function saveWB() {
  const a = document.createElement("a");
  a.href     = wbCanvas.toDataURL();
  a.download = "whiteboard.png";
  a.click();
  toast("💾 Whiteboard saved!");
}
function setWbTool(t) {
  wbTool = t;
  $("wbPenBtn").classList.toggle("on",    t === "pen");
  $("wbEraserBtn").classList.toggle("on", t === "eraser");
}

socket.on("whiteboard-draw", s => {
  if (!wbCtx) return;
  wbCtx.beginPath();
  wbCtx.moveTo(s.x1, s.y1);
  wbCtx.lineTo(s.x2, s.y2);
  wbCtx.strokeStyle = s.color;
  wbCtx.lineWidth   = s.size;
  wbCtx.lineCap     = "round";
  wbCtx.stroke();
});
socket.on("whiteboard-clear", () => {
  if (wbCtx) { wbCtx.fillStyle = "#fff"; wbCtx.fillRect(0, 0, wbCanvas.width, wbCanvas.height); }
});
socket.on("whiteboard-init", strokes => {
  if (!wbCanvas || !wbCtx) return;
  strokes.forEach(s => {
    wbCtx.beginPath();
    wbCtx.moveTo(s.x1, s.y1);
    wbCtx.lineTo(s.x2, s.y2);
    wbCtx.strokeStyle = s.color;
    wbCtx.lineWidth   = s.size;
    wbCtx.lineCap     = "round";
    wbCtx.stroke();
  });
});

/* ── NOTEPAD ────────────────────────────────────────────────── */
$("notepad").addEventListener("input", syncNotepad);
function syncNotepad() {
  clearTimeout(notepadDebounce);
  notepadDebounce = setTimeout(() => socket.emit("notepad-update", $("notepad").value), 300);
}
socket.on("notepad-update", t => { $("notepad").value = t; });
socket.on("notepad-init",   t => { $("notepad").value = t; });

function downloadNotes() {
  const a = document.createElement("a");
  a.href     = "data:text/plain;charset=utf-8," + encodeURIComponent($("notepad").value);
  a.download = "meeting-notes.txt";
  a.click();
  toast("💾 Notes downloaded!");
}
function clearNotes() {
  if (!confirm("Clear shared notes?")) return;
  $("notepad").value = "";
  socket.emit("notepad-update", "");
}

/* ── AGENDA ─────────────────────────────────────────────────── */
function addAgendaItem() {
  const title = $("agTopic").value.trim();
  const mins  = parseInt($("agMins").value) || 5; // FIX: default to 5 if NaN
  if (!title) return toast("Enter a topic name");
  agendaItems.push({ title, secs: mins * 60, done: false });
  $("agTopic").value = "";
  renderAgenda();
  syncAgenda();
  if (agCurrentIdx === -1) selectAgendaItem(0);
}

function renderAgenda() {
  const list = $("agendaList");
  list.innerHTML = "";
  agendaItems.forEach((item, i) => {
    const d = document.createElement("div");
    d.className = "ag-item" +
      (i === agCurrentIdx ? " active" : "") +
      (item.done ? " done" : "");
    d.innerHTML = `
      <div class="ag-dot"></div>
      <span class="ag-title">${esc(item.title)}</span>
      <span class="ag-time">${fmtSecs(item.secs)}</span>
      ${!item.done ? `<button class="ag-del" onclick="event.stopPropagation();removeAgenda(${i})">✕</button>` : ""}`;
    d.addEventListener("click", () => selectAgendaItem(i));
    list.appendChild(d);
  });
  updateAgendaTimer();
}

function selectAgendaItem(i) {
  if (i >= agendaItems.length) return;
  agCurrentIdx = i;
  agTimerSec   = agendaItems[i].secs;
  agPaused     = false;
  clearInterval(agInterval);
  renderAgenda();
}

function agStart() {
  if (agCurrentIdx === -1 && agendaItems.length) selectAgendaItem(0);
  if (agCurrentIdx === -1) return toast("Add agenda items first");
  agPaused = false;
  clearInterval(agInterval);
  agInterval = setInterval(() => {
    if (agPaused) return;
    agTimerSec--;
    if (agTimerSec <= 0) {
      agTimerSec = 0;
      clearInterval(agInterval);
      toast("⏰ Time up: " + agendaItems[agCurrentIdx].title);
      agendaItems[agCurrentIdx].done = true;
      renderAgenda();
      syncAgenda(); // FIX: sync after state change
      return;
    }
    updateAgendaTimer();
  }, 1000);
}

function agPause() {
  agPaused = !agPaused;
  toast(agPaused ? "⏸ Paused" : "▶ Resumed");
}

function agNext() {
  if (agCurrentIdx < agendaItems.length - 1) {
    agendaItems[agCurrentIdx].done = true;
    selectAgendaItem(agCurrentIdx + 1);
    agStart();
    syncAgenda(); // FIX: sync after state change
  } else {
    toast("✅ All done!");
    clearInterval(agInterval);
    agendaItems.forEach(a => a.done = true);
    renderAgenda();
    syncAgenda(); // FIX: sync after state change
  }
}

function removeAgenda(i) {
  agendaItems.splice(i, 1);
  if (agCurrentIdx >= agendaItems.length) agCurrentIdx = agendaItems.length - 1;
  renderAgenda();
  syncAgenda();
}

// FIX: removed broken double-ternary guard; always update safely
function updateAgendaTimer() {
  const disp  = $("agTimerDisp");
  const label = $("agTimerLabel");
  if (!disp || !label) return;
  disp.textContent  = agCurrentIdx >= 0 ? fmtSecs(agTimerSec) : "--:--";
  label.textContent = agCurrentIdx >= 0 && agendaItems[agCurrentIdx]
    ? agendaItems[agCurrentIdx].title
    : "No topic selected";
  disp.style.color = (agTimerSec < 60 && agTimerSec > 0) ? "var(--red)" : "var(--acc)";
}

function syncAgenda() { socket.emit("agenda-update", agendaItems); }
socket.on("agenda-update", items => { agendaItems = items; renderAgenda(); });
socket.on("agenda-init",   items => { agendaItems = items; renderAgenda(); });

function fmtSecs(s) {
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/* ═══════════════════════════════════════════════════════════════
   CAPTIONS
   ═══════════════════════════════════════════════════════════════ */
function toggleCaptions() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast("⚠️ Captions need Chrome browser");

  const bar = $("capBar");
  const btn = $("bCap");

  /* ── TURN OFF ── */
  if (captionOn) {
    captionOn = false;
    isRecognitionRunning = false;
    if (recognition) {
      recognition.onend   = null;
      recognition.onerror = null;
      try { recognition.stop(); } catch(e) {}
      recognition = null;
    }
    bar.style.display = "none";
    bar.textContent   = "";
    btn.classList.remove("on");
    toast("Captions off");
    return;
  }

  /* ── TURN ON ── */
  captionOn   = true;
  recognition = new SR();
  recognition.lang            = "en-US";
  recognition.continuous      = true;
  recognition.interimResults  = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    isRecognitionRunning = true;
    bar.style.display    = "block";
    bar.textContent      = "🎤 Listening…";
    btn.classList.add("on");
  };

  recognition.onresult = event => {
    let finalText   = "";
    let interimText = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText   += t + " ";
      else                          interimText  += t;
    }
    bar.textContent = (finalText || interimText).trim() || "🎤 Listening…";
    if (finalText.trim()) {
      meetingTranscript += `[Speech] ${myName}: ${finalText.trim()}\n`;
      socket.emit("caption-broadcast", finalText.trim());
    }
  };

  recognition.onerror = e => {
    console.warn("Caption error:", e.error);
    isRecognitionRunning = false;
    if (e.error === "not-allowed") {
      toast("⚠️ Mic blocked — allow microphone access in browser");
      captionOn = false;
      bar.style.display = "none";
      btn.classList.remove("on");
      recognition = null;
    }
    // other errors — let onend handle restart
  };

  recognition.onend = () => {
    isRecognitionRunning = false;
    if (captionOn && recognition) {
      setTimeout(() => {
        if (captionOn && recognition && !isRecognitionRunning) {
          try { recognition.start(); } catch(e) { console.warn("Caption restart failed:", e); }
        }
      }, 500);
    }
  };

  try {
    recognition.start();
    toast("💬 Captions on");
  } catch(e) {
    toast("Could not start captions: " + e.message);
    captionOn   = false;
    recognition = null;
  }
}

/* ── Receive other people's captions ───────────────────────── */
socket.on("caption-broadcast", ({ name, text }) => {
  const others = $("capOthers");
  const key    = "cap-" + name.replace(/\s+/g, "_");
  let el       = $(key);
  if (!el) {
    el = document.createElement("div");
    el.className = "cap-other";
    el.id        = key;
    others.appendChild(el);
  }
  el.textContent = `${name}: ${text}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.remove(), 5000);
});

/* ═══════════════════════════════════════════════════════════════
   AI MODAL
   ═══════════════════════════════════════════════════════════════ */
function openAI() {
  $("aiModal").classList.add("on");
  $("aiResult").textContent = "Click Generate to analyze the meeting.";
  $("aiResult").className   = "ai-result loading";
}
function closeAI() { $("aiModal").classList.remove("on"); }

function switchAI(mode, btn) {
  aiMode = mode;
  document.querySelectorAll(".ai-tab").forEach(b => b.classList.remove("on"));
  btn.classList.add("on");
  $("aiResult").textContent = "Click Generate to analyze the meeting.";
  $("aiResult").className   = "ai-result loading";
}

async function generateAI() {
  const result    = $("aiResult");
  const chatLines = transcript.map(m => `[${m.time}] ${m.user}: ${m.text}`).join("\n");
  const notes     = $("notepad").value.trim();
  const speech    = meetingTranscript.trim();

  if (!chatLines && !notes && !speech) {
    result.textContent = "⚠️ No meeting content yet. Chat, turn on captions, or write notes first!";
    return;
  }

  result.textContent = "⚡ Generating with AI…";
  result.className   = "ai-result loading";

  const context = `Meeting Room: ${room}
Date/Time: ${new Date().toLocaleString()}

Chat Messages:
${chatLines || "(none)"}

Speech / Captions:
${speech || "(none)"}

Shared Notes:
${notes || "(none)"}`;

  const prompts = {
    summary: `You are a professional meeting assistant. Write a clear concise meeting summary (3-5 paragraphs) covering: key topics discussed, decisions made, and outcomes.\n\nMeeting Data:\n${context}`,
    notes:   `You are a professional meeting assistant. Extract and organize key points from this meeting into bullet points grouped by topic. Be actionable and clear.\n\nMeeting Data:\n${context}`,
    actions: `You are a professional meeting assistant. Extract ALL action items from this meeting. Format: "• [Person] will [action] by [deadline]". If no person specified write "Team". If no deadline omit it.\n\nMeeting Data:\n${context}`
  };

  try {
    const res  = await fetch("/api/ai", {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ prompt: prompts[aiMode] })
    });
    const data = await res.json();
    if (data.error) {
      result.textContent = "❌ " + data.error;
    } else {
      const text = data.content?.find(c => c.type === "text")?.text || "No response.";
      result.textContent = text;
      toast("🤖 AI analysis ready!");
    }
    result.className = "ai-result";
  } catch(e) {
    result.textContent = "❌ Network error: " + e.message;
    result.className   = "ai-result";
  }
}

function copyAI() {
  navigator.clipboard.writeText($("aiResult").textContent);
  toast("📋 Copied to clipboard!");
}

/* ── MUSIC ──────────────────────────────────────────────────── */
function toggleMusic() {
  $("musicBar").classList.toggle("on");
  $("bMusic").classList.toggle("on", $("musicBar").classList.contains("on"));
}

function playSound(type) {
  stopMusic();
  currentSound = type;
  document.querySelectorAll(".music-btn").forEach(b => b.classList.remove("on"));
  // FIX: safe ID lookup — only add "on" if the element exists
  const btnId = "m" + type.charAt(0).toUpperCase() + type.slice(1);
  const btnEl = $(btnId);
  if (btnEl) btnEl.classList.add("on");
  if (type === "none") return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const vol      = parseFloat($("volSlider").value);
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = vol;
    gainNode.connect(audioCtx.destination);
    musicNodes = [gainNode];

    if (type === "lofi") {
      [[220,.4],[275,.3],[330,.25],[440,.2],[550,.15]].forEach(([freq, amp]) => {
        const osc = audioCtx.createOscillator();
        const g   = audioCtx.createGain();
        g.gain.value = amp * .03;
        const flt = audioCtx.createBiquadFilter();
        flt.type = "lowpass"; flt.frequency.value = 800;
        osc.type = "sine"; osc.frequency.value = freq;
        osc.connect(flt); flt.connect(g); g.connect(gainNode);
        osc.start();
        musicNodes.push(osc, g, flt);
      });
    } else if (type === "rain") {
      const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
      const d   = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const src = audioCtx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const flt = audioCtx.createBiquadFilter();
      flt.type = "bandpass"; flt.frequency.value = 400; flt.Q.value = .5;
      const g = audioCtx.createGain(); g.gain.value = .08;
      src.connect(flt); flt.connect(g); g.connect(gainNode);
      src.start();
      musicNodes.push(src, flt, g);
    } else if (type === "space") {
      [[80,.5],[120,.3],[160,.2]].forEach(([freq, amp]) => {
        const osc  = audioCtx.createOscillator();
        const lfo  = audioCtx.createOscillator();
        const lfoG = audioCtx.createGain();
        lfoG.gain.value = 5;
        const g = audioCtx.createGain(); g.gain.value = amp * .02;
        osc.type = "sine"; osc.frequency.value = freq;
        lfo.type = "sine"; lfo.frequency.value = .1 + Math.random() * .1;
        lfo.connect(lfoG); lfoG.connect(osc.frequency);
        osc.connect(g); g.connect(gainNode);
        osc.start(); lfo.start();
        musicNodes.push(osc, lfo, lfoG, g);
      });
    }
    toast("🎵 " + { lofi: "Lofi vibes", rain: "Rain sounds", space: "Space ambience" }[type]);
  } catch(e) { toast("Audio error: " + e.message); }
}

function stopMusic() {
  musicNodes.forEach(n => {
    try { if (n.stop) n.stop(); if (n.disconnect) n.disconnect(); } catch(e) {}
  });
  musicNodes = [];
  if (audioCtx) { try { audioCtx.close(); } catch(e) {} audioCtx = null; }
}

function setMusicVol(v) {
  if (musicNodes[0] && musicNodes[0].gain) musicNodes[0].gain.value = parseFloat(v);
}

/* ── ATTENDANCE ─────────────────────────────────────────────── */
/* ── ATTENDANCE ───────────────────────────── */

function downloadAttendance() {

  socket.emit("get-attendance");

  toast("📊 Preparing attendance...");
}

socket.on("attendance-data", (log) => {

  if (!log || !log.length) {
    toast("No attendance data found");
    return;
  }

  let csv = "Name,Action,Time\n";

  log.forEach(row => {
    csv += `"${row.name}","${row.action}","${row.time}"\n`;
  });

  const blob = new Blob([csv], {
    type: "text/csv;charset=utf-8;"
  });

  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `attendance-${room}.csv`;

  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);

  toast("✅ Attendance downloaded");
});

/* ── SIDEBAR ────────────────────────────────────────────────── */
function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  $("sidebar").classList.toggle("closed", !sidebarOpen);
}

// FIX: corrected switchTab — toggle panels by matching "tab-{name}" to panel IDs,
//      not trying to add "on" to a tab element as if it were a panel
function switchTab(name, btn) {
  // Deactivate all tab buttons
  document.querySelectorAll(".stab").forEach(b => b.classList.remove("on"));
  // Hide all panels
  document.querySelectorAll(".spanel").forEach(p => p.classList.remove("on"));
  // Activate the target panel
  const panel = $("tab-" + name);
  if (panel) panel.classList.add("on");
  // Activate the button
  if (btn) {
    btn.classList.add("on");
  } else {
    // Fallback: find button by onclick attribute containing the tab name
    const fallback = document.querySelector(`.stab[onclick*="'${name}'"]`);
    if (fallback) fallback.classList.add("on");
  }
  // Open sidebar if closed
  if (!sidebarOpen) { sidebarOpen = true; $("sidebar").classList.remove("closed"); }
}

/* ── LEAVE ──────────────────────────────────────────────────── */
function leaveCall() {
  stopMusic();
  if (localStream)  localStream.getTracks().forEach(t => t.stop());
  if (recorder)     recorder.stop();
  if (recognition)  { recognition.onend = null; recognition.onerror = null; try { recognition.stop(); } catch(e) {} }
  clearInterval(agInterval);
  location.href = "/";
}

/* ── UTILS ──────────────────────────────────────────────────── */
function esc(s = "") {
  return String(s)
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;");
}