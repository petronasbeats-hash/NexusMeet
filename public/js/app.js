// ── Configuración ──────────────────────────────────────────────
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    // Si tienes TURN (Metered.ca u otro), agrégalo aquí:
    // { urls: 'turn:tu-servidor.com', username: 'user', credential: 'pass' }
  ]
};

// ── Estado ─────────────────────────────────────────────────────
async function loadIceServers() {
  try {
    const res = await fetch('/api/turn-credentials');
    const turnServers = await res.json();
    if (Array.isArray(turnServers) && turnServers.length) {
      ICE_SERVERS.iceServers.push(...turnServers);
      console.log('[TURN] Credenciales cargadas:', turnServers.length, 'servidores');
    }
  } catch (e) {
    console.warn('[TURN] No se pudieron cargar credenciales, usando solo STUN', e);
  }
}
loadIceServers();

let socket = null;
let localStream = null;
let myNick = '';
let myRoomId = '';
let micOn = true;
let camOn = true;

// peerConnections: { socketId: RTCPeerConnection }
const peerConnections = {};
// peerNicks: { socketId: nick }
const peerNicks = {};

// ── Utilidades ─────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function toast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), duration);
}

function setStatus(msg) {
  document.getElementById('status-text').textContent = msg;
}

function updatePeersBadge() {
  const count = Object.keys(peerConnections).length + 1;
  const badge = document.getElementById('peers-badge');
  badge.textContent = count === 1 ? 'Solo tú' : `${count} personas`;
  badge.className = count > 1 ? 'badge live' : 'badge';
}

// ── Media ───────────────────────────────────────────────────────
async function getMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (e) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      camOn = false;
    } catch (e2) {
      localStream = new MediaStream();
      camOn = false;
      micOn = false;
    }
  }
  return localStream;
}

// ── Videos en pantalla ──────────────────────────────────────────
function addVideoTile(stream, nick, tileId, muted = false) {
  const container = document.getElementById('videos-container');

  let tile = document.getElementById(tileId);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.id = tileId;
    tile.innerHTML = `
      <video autoplay ${muted ? 'muted' : ''} playsinline></video>
      <div class="tile-no-cam">
        <div class="avatar">${nick.charAt(0).toUpperCase()}</div>
        <p>${nick}</p>
      </div>
      <div class="tile-label">${nick}</div>
    `;
    container.appendChild(tile);
  }

  const video = tile.querySelector('video');
  video.srcObject = stream;

  if (!muted && stream.getVideoTracks().length === 0) {
    tile.classList.add('cam-off');
  }

  updateGridLayout();
  return tile;
}

function removeVideoTile(tileId) {
  const tile = document.getElementById(tileId);
  if (tile) tile.remove();
  updateGridLayout();
}

function updateGridLayout() {
  const container = document.getElementById('videos-container');
  const count = container.querySelectorAll('.video-tile').length;
  container.className = '';
  if (count === 2) container.classList.add('two-peers');
  else if (count === 3) container.classList.add('three-peers');
  else if (count >= 4) container.classList.add('four-peers');
}

// ── WebRTC ──────────────────────────────────────────────────────
function createPeerConnection(socketId, nick) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peerConnections[socketId] = pc;
  peerNicks[socketId] = nick;

  // Agregar tracks locales
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  // ICE candidates → servidor
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      socket.emit('ice-candidate', { to: socketId, candidate });
    }
  };

  // Stream remoto → video tile
  pc.ontrack = ({ streams }) => {
    const remoteStream = streams[0];
    const tileId = `tile-${socketId}`;
    addVideoTile(remoteStream, nick, tileId);
    setStatus(`En llamada con: ${Object.values(peerNicks).join(', ')}`);
  };

  pc.onconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      cleanupPeer(socketId);
    }
  };

  updatePeersBadge();
  return pc;
}

function cleanupPeer(socketId) {
  if (peerConnections[socketId]) {
    peerConnections[socketId].close();
    delete peerConnections[socketId];
  }
  const nick = peerNicks[socketId] || 'Alguien';
  delete peerNicks[socketId];
  removeVideoTile(`tile-${socketId}`);
  updatePeersBadge();
  toast(`${nick} salió de la sala`);
  if (Object.keys(peerConnections).length === 0) {
    setStatus('Esperando participantes...');
  } else {
    setStatus(`En llamada con: ${Object.values(peerNicks).join(', ')}`);
  }
}

// ── Socket.io ───────────────────────────────────────────────────
function connectSocket(roomId, nick) {
  socket = io();

  socket.on('connect', () => {
    socket.emit('join-room', { roomId, nick });
  });

  socket.on('chat-message', ({ nick: fromNick, message, ts }) => {
    addChatMessage(fromNick, message, fromNick === myNick);
  });

  // Lista de peers ya en la sala → iniciar offer a cada uno
  socket.on('room-peers', async (peers) => {
    for (const peer of peers) {
      const pc = createPeerConnection(peer.socketId, peer.nick);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: peer.socketId, offer });
    }
  });

  // Nuevo peer llegó → lo notifican a nosotros
  socket.on('peer-joined', ({ nick: pNick, socketId }) => {
    toast(`${pNick} se unió`);
  });

  // Recibimos offer de alguien → respondemos
  socket.on('offer', async ({ from, nick: pNick, offer }) => {
    const pc = createPeerConnection(from, pNick);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { to: from, answer });
  });

  // Recibimos answer
  socket.on('answer', async ({ from, answer }) => {
    const pc = peerConnections[from];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
  });

  // ICE candidate remoto
  socket.on('ice-candidate', async ({ from, candidate }) => {
    const pc = peerConnections[from];
    if (pc && candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    }
  });

  // Peer se fue
  socket.on('peer-left', ({ socketId, nick: pNick }) => {
    cleanupPeer(socketId);
  });
}

// ── Acciones UI ─────────────────────────────────────────────────
async function createRoom() {
  const nick = document.getElementById('nick-input').value.trim();
  if (!nick) { toast('Escribe tu nickname'); return; }

  const roomId = Math.random().toString(36).slice(2, 8).toUpperCase();
  await startSession(nick, roomId);
}

async function joinRoom() {
  const nick = document.getElementById('nick-input').value.trim();
  if (!nick) { toast('Escribe tu nickname'); return; }
  const room = document.getElementById('join-input').value.trim().toUpperCase();
  if (!room) { toast('Ingresa el código de sala'); return; }
  await startSession(nick, room);
}

async function startSession(nick, roomId) {
  myNick = nick;
  myRoomId = roomId;

  await getMedia();

  showScreen('room-screen');
  document.getElementById('room-id-display').textContent = roomId;

  // Tile local
  const container = document.getElementById('videos-container');
  container.innerHTML = '';
  addVideoTile(localStream, nick + ' (tú)', 'tile-local', true);
  if (!camOn) document.getElementById('tile-local').classList.add('cam-off');

  connectSocket(roomId, nick);

  // URL con código de sala
  const url = `${window.location.origin}?room=${roomId}`;
  history.replaceState({}, '', `?room=${roomId}`);
  document.getElementById('copy-btn').setAttribute('data-url', url);
}

function copyInvite() {
  const roomId = myRoomId;
  const url = `${window.location.origin}?room=${roomId}`;
  const text = `Únete a mi videollamada en Nexus Meet\nCódigo: ${roomId}\nEnlace: ${url}`;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => toast('¡Enlace copiado!'));
  } else {
    prompt('Comparte este código:', roomId);
  }
}

function toggleMic() {
  micOn = !micOn;
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = micOn);
  const btn = document.getElementById('mic-btn');
  btn.classList.toggle('off', !micOn);
  btn.title = micOn ? 'Silenciar' : 'Activar micrófono';
}

function toggleCam() {
  camOn = !camOn;
  if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = camOn);
  const tile = document.getElementById('tile-local');
  if (tile) tile.classList.toggle('cam-off', !camOn);
  const btn = document.getElementById('cam-btn');
  btn.classList.toggle('off', !camOn);
}

function hangUp() {
  // Cerrar todas las conexiones
  Object.values(peerConnections).forEach(pc => pc.close());
  Object.keys(peerConnections).forEach(k => delete peerConnections[k]);
  Object.keys(peerNicks).forEach(k => delete peerNicks[k]);

  if (localStream) localStream.getTracks().forEach(t => t.stop());
  localStream = null;

  if (socket) { socket.disconnect(); socket = null; }

  history.replaceState({}, '', '/');
  micOn = true; camOn = true;
  document.getElementById('mic-btn').classList.remove('off');
  document.getElementById('cam-btn').classList.remove('off');
  document.getElementById('nick-input').value = '';
  document.getElementById('join-input').value = '';

  showScreen('lobby');
}

// ── Auto-join desde URL ──────────────────────────────────────────
const params = new URLSearchParams(window.location.search);
const roomFromUrl = params.get('room');
if (roomFromUrl) {
  document.getElementById('join-input').value = roomFromUrl.toUpperCase();
  document.getElementById('join-input').focus();
}


function addChatMessage(nick, message, isMine) {
  const list = document.getElementById('chat-messages');
  if (!list) return;
  const div = document.createElement('div');
  div.className = 'chat-msg' + (isMine ? ' mine' : '');
  div.innerHTML = `<span class="chat-nick">${nick}:</span> <span class="chat-text"></span>`;
  div.querySelector('.chat-text').textContent = message;
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
}

function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message || !socket) return;
  socket.emit('chat-message', { roomId: myRoomId, nick: myNick, message });
  input.value = '';
}

function toggleChat() {
  const panel = document.getElementById('chat-panel');
  if (panel) panel.classList.toggle('open');
}
