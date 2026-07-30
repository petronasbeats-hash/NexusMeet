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
let screenStream = null;
let isScreenSharing = false;
let cameraVideoTrack = null; // referencia a la track de cámara para volver a ella
let audioMixContext = null;  // AudioContext para mezclar mic + audio del sistema
let mixedAudioTrack = null;  // track resultante de la mezcla
let micGainNode = null;      // controla el volumen del mic dentro de la mezcla
let audioShareStream = null; // stream de getDisplayMedia usado solo para tomar su audio
let isAudioOnlyShare = false; // true si se está compartiendo audio de pestaña sin mostrar su video
let spatialAudioContext = null;
let spatialEnabled = false;
let isHost = false;
let isRoomLocked = false;
let myInviteToken = null;
let myInviteExpires = null;
const peerAudioNodes = {};   // { socketId: { source, panner } }
let pinnedTileId = null;     // id del tile anclado en pantalla grande, null = vista de galería
const peerMicState = {};     // { socketId: bool } último estado de mic conocido de cada peer
const peerCamState = {};     // { socketId: bool } último estado de cámara conocido de cada peer
let mySocketId = null;
let isCoHost = false;
let currentHostId = null;
let coHostIds = new Set();

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
  cameraVideoTrack = localStream.getVideoTracks()[0] || null;
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
    const isRemote = tileId !== 'tile-local';
    const socketId = isRemote ? tileId.slice(5) : null;
    tile.innerHTML = `
      <video autoplay ${muted ? 'muted' : ''} playsinline></video>
      <div class="tile-no-cam">
        <div class="avatar">${nick.charAt(0).toUpperCase()}</div>
        <p>${nick}</p>
      </div>
      <div class="tile-label">${nick}</div>
      <div class="tile-indicators" id="${tileId}-indicators"></div>
      <button class="tile-pin-btn" onclick="togglePin('${tileId}')" title="Anclar / quitar anclaje">📌</button>
      <button class="tile-fullscreen-btn" onclick="toggleTileFullscreen('${tileId}')" title="Pantalla completa">⛶</button>
      ${isRemote ? `
        <button class="tile-mod-btn" onclick="toggleTileMenu('${tileId}')">⋮</button>
        <div class="tile-mod-menu" id="mod-menu-${tileId}">${buildModMenuHtml(socketId)}</div>
      ` : ''}
    `;
    container.appendChild(tile);
  }

  const video = tile.querySelector('video');
  video.srcObject = stream;

  if (!muted && stream.getVideoTracks().length === 0) {
    tile.classList.add('cam-off');
  }

  updateRoleBadges();
  updateGridLayout();
  return tile;
}

function removeVideoTile(tileId) {
  const tile = document.getElementById(tileId);
  if (tile) tile.remove();
  if (pinnedTileId === tileId) { pinnedTileId = null; updateGalleryButton(); }
  updateGridLayout();
}

function updateGridLayout() {
  const container = document.getElementById('videos-container');
  const tiles = container.querySelectorAll('.video-tile');
  const count = tiles.length;
  container.className = '';

  if (pinnedTileId && document.getElementById(pinnedTileId)) {
    container.classList.add('pinned-view');
    tiles.forEach(t => t.classList.toggle('pinned-tile', t.id === pinnedTileId));
    return;
  }

  if (count === 2) container.classList.add('two-peers');
  else if (count === 3) container.classList.add('three-peers');
  else if (count >= 4) container.classList.add('four-peers');
}

// ── Anclar / pantalla completa ───────────────────────────────────
function togglePin(tileId) {
  pinnedTileId = (pinnedTileId === tileId) ? null : tileId;
  updateGridLayout();
  updateGalleryButton();
}

function unpinAll() {
  pinnedTileId = null;
  updateGridLayout();
  updateGalleryButton();
}

function updateGalleryButton() {
  const btn = document.getElementById('gallery-btn');
  if (btn) btn.style.display = pinnedTileId ? 'inline-block' : 'none';
}

function toggleTileFullscreen(tileId) {
  const tile = document.getElementById(tileId);
  if (!tile) return;
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    tile.requestFullscreen().catch(() => toast('No se pudo entrar a pantalla completa'));
  }
}

// ── Indicadores de mic/cámara de otros + controles del host ──────
function reportPeerState() {
  if (socket) socket.emit('peer-state', { micOn, camOn });
}

function updatePeerIndicators(socketId, pMic, pCam) {
  peerMicState[socketId] = pMic;
  peerCamState[socketId] = pCam;
  const indicators = document.getElementById(`tile-${socketId}-indicators`);
  if (indicators) {
    indicators.innerHTML =
      (pMic === false ? '<span class="tile-ind">🔇</span>' : '') +
      (pCam === false ? '<span class="tile-ind">🚫🎥</span>' : '');
  }
  const micBtn = document.getElementById(`mod-mic-${socketId}`);
  if (micBtn) micBtn.textContent = pMic === false ? 'Activar su micrófono' : 'Silenciar su micrófono';
  const camBtn = document.getElementById(`mod-cam-${socketId}`);
  if (camBtn) camBtn.textContent = pCam === false ? 'Encender su cámara' : 'Apagar su cámara';
}

function hostToggleMic(socketId) {
  if (!socket || (!isHost && !isCoHost)) return;
  const newMicOn = peerMicState[socketId] === false;
  socket.emit('host-force-mic', { socketId, micOn: newMicOn });
  document.querySelectorAll('.tile-mod-menu.show').forEach(m => m.classList.remove('show'));
}

function hostToggleCam(socketId) {
  if (!socket || (!isHost && !isCoHost)) return;
  const newCamOn = peerCamState[socketId] === false;
  socket.emit('host-force-cam', { socketId, camOn: newCamOn });
  document.querySelectorAll('.tile-mod-menu.show').forEach(m => m.classList.remove('show'));
}

// ── Roles: host / co-host ──────────────────────────────────────────
function buildModMenuHtml(socketId) {
  const micLabel = peerMicState[socketId] === false ? 'Activar su micrófono' : 'Silenciar su micrófono';
  const camLabel = peerCamState[socketId] === false ? 'Encender su cámara' : 'Apagar su cámara';
  const isThatHost = socketId === currentHostId;
  const isThatCoHost = coHostIds.has(socketId);
  const canMod = isHost || isCoHost;

  let html = '';
  if (canMod) {
    html += `<button id="mod-mic-${socketId}" onclick="hostToggleMic('${socketId}')">${micLabel}</button>`;
    html += `<button id="mod-cam-${socketId}" onclick="hostToggleCam('${socketId}')">${camLabel}</button>`;
  }
  if (isHost && !isThatHost) {
    html += `<button onclick="transferHost('${socketId}')">Ceder host a esta persona</button>`;
    html += isThatCoHost
      ? `<button onclick="revokeCoHost('${socketId}')">Quitar co-host</button>`
      : `<button onclick="assignCoHost('${socketId}')">Hacer co-host</button>`;
  }
  if (canMod && !isThatHost) {
    html += `<button onclick="demotePeer('${socketId}')">Enviar a sala de espera</button>`;
    html += `<button class="tm-expel" onclick="expelPeer('${socketId}')">Expulsar de la sala</button>`;
  }
  return html;
}

function rebuildAllTileMenus() {
  document.querySelectorAll('.video-tile').forEach(tile => {
    if (tile.id === 'tile-local') return;
    const socketId = tile.id.slice(5);
    const menu = document.getElementById(`mod-menu-${tile.id}`);
    if (menu) menu.innerHTML = buildModMenuHtml(socketId);
  });
}

function updateRoleBadges() {
  document.querySelectorAll('.video-tile').forEach(tile => {
    const id = tile.id === 'tile-local' ? mySocketId : tile.id.slice(5);
    let badge = tile.querySelector('.tile-role-badge');
    let icon = '';
    if (id && currentHostId && id === currentHostId) icon = '👑';
    else if (id && coHostIds.has(id)) icon = '⭐';

    if (icon) {
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'tile-role-badge';
        tile.appendChild(badge);
      }
      badge.textContent = icon;
      badge.title = icon === '👑' ? 'Host' : 'Co-host';
    } else if (badge) {
      badge.remove();
    }
  });
}

function transferHost(socketId) {
  if (!socket || !isHost) return;
  if (!confirm('¿Ceder el rol de host a esta persona? Perderás tus privilegios de host.')) return;
  socket.emit('transfer-host', { socketId });
  document.querySelectorAll('.tile-mod-menu.show').forEach(m => m.classList.remove('show'));
}

function assignCoHost(socketId) {
  if (!socket || !isHost) return;
  socket.emit('assign-cohost', { socketId });
  document.querySelectorAll('.tile-mod-menu.show').forEach(m => m.classList.remove('show'));
}

function revokeCoHost(socketId) {
  if (!socket || !isHost) return;
  socket.emit('revoke-cohost', { socketId });
  document.querySelectorAll('.tile-mod-menu.show').forEach(m => m.classList.remove('show'));
}

// ── WebRTC ──────────────────────────────────────────────────────
function createPeerConnection(socketId, nick) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peerConnections[socketId] = pc;
  peerNicks[socketId] = nick;

  // Agregar tracks locales (respeta pantalla/audio mezclado si ya están activos)
  if (localStream) {
    localStream.getTracks().forEach(track => {
      if (track.kind === 'video' && isScreenSharing && screenStream) {
        pc.addTrack(screenStream.getVideoTracks()[0], screenStream);
      } else if (track.kind === 'audio' && mixedAudioTrack) {
        pc.addTrack(mixedAudioTrack, screenStream || localStream);
      } else {
        pc.addTrack(track, localStream);
      }
    });
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
    if (spatialEnabled) setupSpatialForPeer(socketId, remoteStream);
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
  if (peerAudioNodes[socketId]) {
    peerAudioNodes[socketId].source.disconnect();
    peerAudioNodes[socketId].panner.disconnect();
    delete peerAudioNodes[socketId];
    updateSpatialPanning();
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
function connectSocket(roomId, nick, invite) {
  socket = io();

  socket.on('connect', () => {
    mySocketId = socket.id;
    const hostToken = sessionStorage.getItem(`nm-host-${roomId}`);
    socket.emit('join-room', { roomId, nick, invite, hostToken });
  });

  socket.on('host-token', (token) => {
    sessionStorage.setItem(`nm-host-${roomId}`, token);
  });

  socket.on('host-reclaimed', ({ nick: pNick }) => {
    toast(`${pNick} recuperó el rol de host`);
  });

  socket.on('chat-message', ({ nick: fromNick, message, ts }) => {
    addChatMessage(fromNick, message, fromNick === myNick);
  });

  // ── Indicadores de mic/cámara + control remoto del host ──────────
  socket.on('peer-state', ({ socketId, micOn: pMic, camOn: pCam }) => {
    updatePeerIndicators(socketId, pMic, pCam);
  });

  socket.on('forced-mic', ({ micOn: forcedMicOn }) => {
    micOn = forcedMicOn;
    if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = micOn);
    if (micGainNode) micGainNode.gain.value = micOn ? 1 : 0;
    const btn = document.getElementById('mic-btn');
    if (btn) btn.classList.toggle('off', !micOn);
    toast(micOn ? 'El host activó tu micrófono' : 'El host te silenció');
    reportPeerState();
  });

  socket.on('forced-cam', ({ camOn: forcedCamOn }) => {
    camOn = forcedCamOn;
    if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = camOn);
    const tile = document.getElementById('tile-local');
    if (tile) tile.classList.toggle('cam-off', !camOn);
    const btn = document.getElementById('cam-btn');
    if (btn) btn.classList.toggle('off', !camOn);
    toast(camOn ? 'El host encendió tu cámara' : 'El host apagó tu cámara');
    reportPeerState();
  });

  // ── Sala de espera ──────────────────────────────────────────────
  socket.on('waiting-for-approval', () => {
    document.getElementById('waiting-overlay').classList.add('show');
  });

  socket.on('join-rejected', () => {
    toast('El host no aprobó tu entrada a la sala');
    hangUp();
  });

  socket.on('you-are-host', (value) => {
    isHost = value;
    updateLockButton();
    rebuildAllTileMenus();
    updateRoleBadges();
  });

  socket.on('you-are-cohost', (value) => {
    isCoHost = value;
    toast(value ? 'Ahora eres co-host' : 'Ya no eres co-host');
    updateLockButton();
    rebuildAllTileMenus();
    updateRoleBadges();
  });

  socket.on('room-roles', ({ host, coHosts }) => {
    currentHostId = host;
    coHostIds = new Set(coHosts || []);
    isCoHost = coHostIds.has(mySocketId);
    updateLockButton();
    rebuildAllTileMenus();
    updateRoleBadges();
  });

  socket.on('host-changed', ({ nick: newHostNick }) => {
    if (newHostNick) toast(`${newHostNick} es ahora el host`);
  });

  socket.on('cohost-changed', ({ nick: pNick, assigned }) => {
    toast(assigned ? `${pNick} ahora es co-host` : `${pNick} ya no es co-host`);
  });

  socket.on('join-request', ({ nick: pNick, socketId }) => {
    addJoinRequest(pNick, socketId);
  });

  // ── Reglas de la sala ─────────────────────────────────────────────
  socket.on('room-rules', (text) => {
    currentRoomRules = text;
    const el = document.getElementById('waiting-rules-text');
    if (el) el.textContent = text;
    // Si ya estaba esperando y le vuelven a mandar reglas (p. ej. tras un demote), resetear el estado
    const checkbox = document.getElementById('rules-checkbox');
    const confirmBtn = document.getElementById('confirm-rules-btn');
    const note = document.getElementById('rules-confirmed-note');
    if (checkbox) { checkbox.checked = false; checkbox.disabled = false; }
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.style.display = 'inline-block'; }
    if (note) note.style.display = 'none';
  });

  socket.on('waiting-rules-confirmed', ({ socketId }) => {
    markRulesConfirmed(socketId);
  });

  // ── Chat privado con quien espera ─────────────────────────────────
  socket.on('waiting-chat-message', (data) => {
    if (data.fromHost) {
      // Soy el que espera: me llegó un mensaje del host
      appendWaitingChatMessage('Host', data.message, true);
    } else {
      // Soy el host: me llegó un mensaje de alguien en espera
      appendJrChatMessage(data.socketId, data.nick, data.message, false);
    }
  });

  // ── Moderación: me mandaron de vuelta a espera / me expulsaron ────
  socket.on('sent-to-waiting-room', () => {
    toast('El host te envió de vuelta a la sala de espera');
    // Cerrar conexiones activas pero mantener el socket conectado
    Object.values(peerConnections).forEach(pc => pc.close());
    Object.keys(peerConnections).forEach(k => delete peerConnections[k]);
    Object.keys(peerNicks).forEach(k => delete peerNicks[k]);
    document.getElementById('videos-container').querySelectorAll('.video-tile:not(#tile-local)').forEach(t => t.remove());
    isHost = false;
    updateLockButton();
    document.getElementById('waiting-overlay').classList.add('show');
  });

  socket.on('expelled-from-room', () => {
    toast('Fuiste expulsado de esta sala');
    hangUp();
  });

  socket.on('you-are-banned', () => {
    toast('No puedes entrar: fuiste expulsado de esta sala anteriormente');
    hangUp();
  });

  // ── Invitación y bloqueo de sala ──────────────────────────────────
  socket.on('invite-info', ({ token, expiresAt }) => {
    myInviteToken = token;
    myInviteExpires = expiresAt;
  });

  socket.on('invite-invalid', () => {
    toast('Este enlace de invitación ya no es válido o expiró');
    hangUp();
  });

  socket.on('room-locked', () => {
    toast('Esta sala está bloqueada por el host');
    hangUp();
  });

  socket.on('room-lock-changed', (locked) => {
    isRoomLocked = locked;
    updateLockButton();
    toast(locked ? 'Sala bloqueada: nadie más puede entrar' : 'Sala desbloqueada');
  });

  // Lista de peers ya en la sala → iniciar offer a cada uno
  socket.on('room-peers', async (peers) => {
    document.getElementById('waiting-overlay').classList.remove('show');
    for (const peer of peers) {
      const pc = createPeerConnection(peer.socketId, peer.nick);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: peer.socketId, offer });
    }
    reportPeerState();
  });

  // Nuevo peer llegó → lo notifican a nosotros
  socket.on('peer-joined', ({ nick: pNick, socketId }) => {
    toast(`${pNick} se unió`);
    reportPeerState();
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
  await startSession(nick, roomId, null); // sala nueva: no necesita token, se genera en el server
}

async function joinRoom() {
  const nick = document.getElementById('nick-input').value.trim();
  if (!nick) { toast('Escribe tu nickname'); return; }
  const room = document.getElementById('join-input').value.trim().toUpperCase();
  if (!room) { toast('Ingresa el código de sala'); return; }

  // El token de invitación solo es válido si el código coincide con el del enlace abierto
  const invite = (roomFromUrl && room === roomFromUrl.toUpperCase()) ? inviteFromUrl : null;
  await startSession(nick, room, invite);
}

async function startSession(nick, roomId, invite) {
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

  connectSocket(roomId, nick, invite);

  history.replaceState({}, '', `?room=${roomId}`);
}

function copyInvite() {
  const roomId = myRoomId;
  const url = myInviteToken
    ? `${window.location.origin}?room=${roomId}&invite=${myInviteToken}`
    : `${window.location.origin}?room=${roomId}`;
  const horas = myInviteExpires ? Math.max(1, Math.round((myInviteExpires - Date.now()) / 3600000)) : 4;
  const text = `Únete a mi videollamada en Nexus Meet\nEnlace: ${url}\n(el enlace expira en ~${horas}h)`;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => toast('¡Enlace copiado!'));
  } else {
    prompt('Comparte este enlace:', url);
  }
}

function toggleMic() {
  micOn = !micOn;
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = micOn);
  if (micGainNode) micGainNode.gain.value = micOn ? 1 : 0;
  const btn = document.getElementById('mic-btn');
  btn.classList.toggle('off', !micOn);
  btn.title = micOn ? 'Silenciar' : 'Activar micrófono';
  reportPeerState();
}

function toggleCam() {
  camOn = !camOn;
  if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = camOn);
  const tile = document.getElementById('tile-local');
  if (tile) tile.classList.toggle('cam-off', !camOn);
  const btn = document.getElementById('cam-btn');
  btn.classList.toggle('off', !camOn);
  reportPeerState();
}

// ── Compartir pantalla ───────────────────────────────────────────
async function toggleScreenShare() {
  if (isScreenSharing) {
    stopScreenShare();
    return;
  }
  if (isAudioOnlyShare) stopAudioOnlyShare(); // no mezclar los dos modos a la vez

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (e) {
    toast('No se pudo compartir pantalla');
    return;
  }

  screenStream = stream;
  isScreenSharing = true;
  const screenTrack = screenStream.getVideoTracks()[0];
  const screenAudioTrack = screenStream.getAudioTracks()[0] || null;

  // Reemplazar la track de video en cada conexión activa
  Object.values(peerConnections).forEach(pc => {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) sender.replaceTrack(screenTrack);
  });

  // Si el navegador capturó audio del sistema/pestaña, mezclarlo con tu micrófono
  if (screenAudioTrack) {
    setupAudioMix(screenAudioTrack);
  }

  // Mostrar la pantalla en tu propio tile
  const localVideo = document.querySelector('#tile-local video');
  if (localVideo) localVideo.srcObject = screenStream;
  const localTile = document.getElementById('tile-local');
  if (localTile) localTile.classList.remove('cam-off');

  const btn = document.getElementById('screen-btn');
  if (btn) btn.classList.add('active');
  toast(screenAudioTrack ? 'Compartiendo pantalla con audio' : 'Compartiendo pantalla');

  // Si el usuario detiene desde el propio control del navegador
  screenTrack.onended = () => stopScreenShare();
}

// Mezcla el audio del sistema/pestaña compartida con el micrófono usando Web Audio API,
// y envía esa mezcla en lugar del audio del micrófono solo.
function setupAudioMix(screenAudioTrack) {
  if (audioMixContext) return; // ya hay una mezcla activa (pantalla o audio de pestaña)
  audioMixContext = new AudioContext();
  const destination = audioMixContext.createMediaStreamDestination();

  // Fuente 1: audio del sistema/pestaña que estás compartiendo
  const screenSource = audioMixContext.createMediaStreamSource(new MediaStream([screenAudioTrack]));
  screenSource.connect(destination);

  // Fuente 2: tu micrófono (respeta si está silenciado)
  const micTrack = localStream ? localStream.getAudioTracks()[0] : null;
  if (micTrack) {
    const micSource = audioMixContext.createMediaStreamSource(new MediaStream([micTrack]));
    micGainNode = audioMixContext.createGain();
    micGainNode.gain.value = micOn ? 1 : 0;
    micSource.connect(micGainNode).connect(destination);
  }

  mixedAudioTrack = destination.stream.getAudioTracks()[0];

  // Enviar la mezcla en cada conexión activa
  Object.values(peerConnections).forEach(pc => {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
    if (sender) sender.replaceTrack(mixedAudioTrack);
  });
}

function stopScreenShare() {
  if (!isScreenSharing) return;

  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  isScreenSharing = false;

  // Revertir la mezcla de audio si estaba activa: volver a enviar solo el mic
  if (audioMixContext) {
    const micTrack = localStream ? localStream.getAudioTracks()[0] : null;
    Object.values(peerConnections).forEach(pc => {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
      if (sender && micTrack) sender.replaceTrack(micTrack);
    });
    audioMixContext.close();
    audioMixContext = null;
    mixedAudioTrack = null;
    micGainNode = null;
  }

  // Volver a enviar la cámara en cada conexión
  Object.values(peerConnections).forEach(pc => {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender && cameraVideoTrack) sender.replaceTrack(cameraVideoTrack);
  });

  // Restaurar tu tile local
  const localVideo = document.querySelector('#tile-local video');
  if (localVideo && localStream) localVideo.srcObject = localStream;
  const localTile = document.getElementById('tile-local');
  if (localTile) localTile.classList.toggle('cam-off', !camOn);

  const btn = document.getElementById('screen-btn');
  if (btn) btn.classList.remove('active');
  toast('Dejaste de compartir pantalla');
}

// ── Audio espacial ────────────────────────────────────────────────
// Cada participante suena más a la izquierda o derecha según su
// posición en la cuadrícula, usando un StereoPannerNode por peer.
function toggleSpatialAudio() {
  spatialEnabled = !spatialEnabled;
  const btn = document.getElementById('spatial-btn');

  if (spatialEnabled) {
    spatialAudioContext = spatialAudioContext || new AudioContext();
    if (spatialAudioContext.state === 'suspended') spatialAudioContext.resume();

    // Enganchar el audio de los peers ya conectados
    Object.keys(peerConnections).forEach(socketId => {
      const tile = document.getElementById(`tile-${socketId}`);
      const video = tile && tile.querySelector('video');
      if (video && video.srcObject) setupSpatialForPeer(socketId, video.srcObject);
    });

    if (btn) btn.classList.add('active');
    toast('Audio espacial activado');
  } else {
    disableSpatialAudio();
    if (btn) btn.classList.remove('active');
    toast('Audio espacial desactivado');
  }
}

function setupSpatialForPeer(socketId, stream) {
  if (!spatialAudioContext || peerAudioNodes[socketId]) return;
  const audioTrack = stream.getAudioTracks()[0];
  if (!audioTrack) return;

  // Mutear el <video> para no duplicar el audio (se reproduce vía Web Audio)
  const tile = document.getElementById(`tile-${socketId}`);
  const video = tile && tile.querySelector('video');
  if (video) video.muted = true;

  const source = spatialAudioContext.createMediaStreamSource(new MediaStream([audioTrack]));
  const panner = spatialAudioContext.createStereoPanner();
  source.connect(panner).connect(spatialAudioContext.destination);

  peerAudioNodes[socketId] = { source, panner };
  updateSpatialPanning();
}

function updateSpatialPanning() {
  const ids = Object.keys(peerAudioNodes);
  const n = ids.length;
  ids.forEach((id, i) => {
    // Distribuye los paneos de -0.8 (izquierda) a 0.8 (derecha)
    const pan = n === 1 ? 0 : -0.8 + (1.6 * i) / (n - 1);
    peerAudioNodes[id].panner.pan.value = pan;
  });
}

function disableSpatialAudio() {
  Object.entries(peerAudioNodes).forEach(([socketId, nodes]) => {
    nodes.source.disconnect();
    nodes.panner.disconnect();
    const tile = document.getElementById(`tile-${socketId}`);
    const video = tile && tile.querySelector('video');
    if (video) video.muted = false; // volver al audio normal del <video>
  });
  Object.keys(peerAudioNodes).forEach(id => delete peerAudioNodes[id]);
}

// ── Compartir solo audio de una pestaña (mantiene tu cámara visible) ─────
// Igual que compartir pantalla, pide getDisplayMedia (el navegador exige
// pedir video), pero detenemos esa track de video al instante: nunca se
// muestra ni se envía, tu cámara sigue siendo lo que ven los demás.
async function toggleAudioOnlyShare() {
  if (isAudioOnlyShare) {
    stopAudioOnlyShare();
    return;
  }
  if (isScreenSharing) stopScreenShare(); // no mezclar los dos modos a la vez

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (e) {
    toast('No se pudo compartir el audio');
    return;
  }

  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0];

  if (!audioTrack) {
    toast('Esa pestaña no tiene audio (marca "Compartir audio de la pestaña")');
    if (videoTrack) videoTrack.stop();
    return;
  }

  // Detenemos el video de inmediato: no se ve ni se envía a nadie
  if (videoTrack) videoTrack.stop();

  audioShareStream = stream;
  isAudioOnlyShare = true;
  setupAudioMix(audioTrack);

  const btn = document.getElementById('audio-share-btn');
  if (btn) btn.classList.add('active');
  toast('Compartiendo audio de la pestaña');

  audioTrack.onended = () => stopAudioOnlyShare();
}

function stopAudioOnlyShare() {
  if (!isAudioOnlyShare) return;
  isAudioOnlyShare = false;

  if (audioShareStream) {
    audioShareStream.getTracks().forEach(t => t.stop());
    audioShareStream = null;
  }

  // Revertir la mezcla: volver a enviar solo el mic
  if (audioMixContext) {
    const micTrack = localStream ? localStream.getAudioTracks()[0] : null;
    Object.values(peerConnections).forEach(pc => {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
      if (sender && micTrack) sender.replaceTrack(micTrack);
    });
    audioMixContext.close();
    audioMixContext = null;
    mixedAudioTrack = null;
    micGainNode = null;
  }

  const btn = document.getElementById('audio-share-btn');
  if (btn) btn.classList.remove('active');
  toast('Dejaste de compartir audio');
}

function addJoinRequest(nick, socketId) {
  const container = document.getElementById('join-requests');
  if (!container || document.getElementById(`jr-${socketId}`)) return;

  const card = document.createElement('div');
  card.className = 'join-request-card';
  card.id = `jr-${socketId}`;
  card.innerHTML = `
    <p><strong></strong> quiere entrar a la sala</p>
    <p class="jr-status">⏳ Aún no confirma haber leído las reglas</p>
    <div class="join-request-actions">
      <button class="jr-accept" disabled title="Debe confirmar las reglas primero">Aceptar</button>
      <button class="jr-reject">Rechazar</button>
    </div>
    <button class="jr-chat-toggle">💬 Mensaje privado</button>
    <div class="jr-chat">
      <div class="jr-chat-messages"></div>
      <div class="jr-chat-input-row">
        <input type="text" placeholder="Escríbele…">
        <button class="jr-chat-send">Enviar</button>
      </div>
    </div>
  `;
  card.querySelector('strong').textContent = nick;
  card.querySelector('.jr-accept').onclick = () => respondJoinRequest(socketId, true);
  card.querySelector('.jr-reject').onclick = () => respondJoinRequest(socketId, false);
  card.querySelector('.jr-chat-toggle').onclick = () => {
    card.querySelector('.jr-chat').classList.toggle('show');
  };
  const sendJrChat = () => {
    const input = card.querySelector('.jr-chat-input-row input');
    const message = input.value.trim();
    if (!message || !socket) return;
    socket.emit('waiting-chat-to-waiter', { socketId, message });
    appendJrChatMessage(socketId, 'Tú', message, true);
    input.value = '';
  };
  card.querySelector('.jr-chat-send').onclick = sendJrChat;
  card.querySelector('.jr-chat-input-row input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendJrChat();
  });
  container.appendChild(card);
}

function markRulesConfirmed(socketId) {
  const card = document.getElementById(`jr-${socketId}`);
  if (!card) return;
  const status = card.querySelector('.jr-status');
  if (status) { status.textContent = '✅ Confirmó haber leído las reglas'; status.classList.add('confirmed'); }
  const acceptBtn = card.querySelector('.jr-accept');
  if (acceptBtn) { acceptBtn.disabled = false; acceptBtn.removeAttribute('title'); }
}

function appendJrChatMessage(socketId, nick, message, isMine) {
  const card = document.getElementById(`jr-${socketId}`);
  if (!card) return;
  const list = card.querySelector('.jr-chat-messages');
  const div = document.createElement('div');
  div.className = 'wc-msg' + (isMine ? '' : ' from-host');
  div.textContent = `${nick}: ${message}`;
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
}

function respondJoinRequest(socketId, accept) {
  if (!socket) return;
  socket.emit(accept ? 'admit-peer' : 'reject-peer', { socketId });
  const card = document.getElementById(`jr-${socketId}`);
  if (card) card.remove();
}

// ── Reglas de la sala ────────────────────────────────────────────
let currentRoomRules = '';

function confirmRules() {
  if (!socket) return;
  socket.emit('confirm-rules');
  document.getElementById('confirm-rules-btn').style.display = 'none';
  document.getElementById('rules-checkbox').disabled = true;
  document.getElementById('rules-confirmed-note').style.display = 'block';
}

function sendWaitingChat() {
  const input = document.getElementById('waiting-chat-input');
  const message = input.value.trim();
  if (!message || !socket) return;
  socket.emit('waiting-chat-to-host', { message });
  appendWaitingChatMessage('Tú', message, false);
  input.value = '';
}

function appendWaitingChatMessage(nick, message, fromHost) {
  const list = document.getElementById('waiting-chat-messages');
  if (!list) return;
  const div = document.createElement('div');
  div.className = 'wc-msg' + (fromHost ? ' from-host' : '');
  div.textContent = `${nick}: ${message}`;
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
}

function openRulesEditor() {
  if (!isHost) return;
  document.getElementById('rules-editor-textarea').value = currentRoomRules;
  document.getElementById('rules-editor').classList.add('show');
}

function closeRulesEditor() {
  document.getElementById('rules-editor').classList.remove('show');
}

function saveRoomRules() {
  const text = document.getElementById('rules-editor-textarea').value.trim();
  if (!text || !socket) return;
  socket.emit('set-room-rules', { text });
  currentRoomRules = text;
  closeRulesEditor();
  toast('Reglas actualizadas');
}

// ── Moderación de participantes (solo host) ──────────────────────
function toggleTileMenu(tileId) {
  document.querySelectorAll('.tile-mod-menu').forEach(m => {
    if (m.id !== `mod-menu-${tileId}`) m.classList.remove('show');
  });
  const menu = document.getElementById(`mod-menu-${tileId}`);
  if (menu) menu.classList.toggle('show');
}

function demotePeer(socketId) {
  if (!socket || !isHost) return;
  socket.emit('demote-peer', { socketId });
  document.querySelectorAll('.tile-mod-menu.show').forEach(m => m.classList.remove('show'));
}

function expelPeer(socketId) {
  if (!socket || !isHost) return;
  if (!confirm('¿Expulsar a este participante? No podrá volver a entrar con el mismo nombre.')) return;
  socket.emit('expel-peer', { socketId });
  document.querySelectorAll('.tile-mod-menu.show').forEach(m => m.classList.remove('show'));
}

function toggleLock() {
  if (!isHost) { toast('Solo el host puede bloquear la sala'); return; }
  if (!socket) return;
  socket.emit(isRoomLocked ? 'unlock-room' : 'lock-room');
}

function updateLockButton() {
  const btn = document.getElementById('lock-btn');
  const badge = document.getElementById('lock-badge');
  if (btn) {
    btn.style.display = isHost ? 'inline-block' : 'none';
    btn.textContent = isRoomLocked ? 'Desbloquear sala' : 'Bloquear sala';
  }
  if (badge) badge.style.display = isRoomLocked ? 'inline-block' : 'none';

  const rulesBtn = document.getElementById('rules-btn');
  if (rulesBtn) rulesBtn.style.display = isHost ? 'inline-block' : 'none';

  const videosContainer = document.getElementById('videos-container');
  if (videosContainer) {
    videosContainer.classList.toggle('host-mode', isHost);
    videosContainer.classList.toggle('mod-mode', isHost || isCoHost);
  }
}

function hangUp() {
  isHost = false;
  isRoomLocked = false;
  isCoHost = false;
  currentHostId = null;
  coHostIds = new Set();
  pinnedTileId = null;
  Object.keys(peerMicState).forEach(k => delete peerMicState[k]);
  Object.keys(peerCamState).forEach(k => delete peerCamState[k]);
  updateGalleryButton();
  myInviteToken = null;
  myInviteExpires = null;
  updateLockButton();
  const waitingOverlay = document.getElementById('waiting-overlay');
  if (waitingOverlay) waitingOverlay.classList.remove('show');
  const joinRequests = document.getElementById('join-requests');
  if (joinRequests) joinRequests.innerHTML = '';

  // Apagar audio espacial si estaba activo
  if (spatialEnabled) { disableSpatialAudio(); spatialEnabled = false; }

  // Detener compartir solo-audio si estaba activo
  if (isAudioOnlyShare) stopAudioOnlyShare();

  // Detener compartir pantalla si estaba activo
  if (isScreenSharing) stopScreenShare();

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
  const spatialBtn = document.getElementById('spatial-btn');
  if (spatialBtn) spatialBtn.classList.remove('active');
  document.getElementById('nick-input').value = '';
  document.getElementById('join-input').value = '';

  showScreen('lobby');
}

// ── Auto-join desde URL ──────────────────────────────────────────
const params = new URLSearchParams(window.location.search);
const roomFromUrl = params.get('room');
const inviteFromUrl = params.get('invite');
if (roomFromUrl) {
  document.getElementById('join-input').value = roomFromUrl.toUpperCase();
  document.getElementById('join-input').focus();
}


function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function getKnownNicks() {
  return [myNick, ...Object.values(peerNicks)].filter(Boolean);
}

// Envuelve las @menciones de participantes conocidos en un <span> resaltado
function renderMessageHtml(message) {
  let html = escapeHtml(message);
  getKnownNicks().forEach(nick => {
    const safeNick = nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`@${safeNick}\\b`, 'gi');
    html = html.replace(re, `<span class="mention">@${escapeHtml(nick)}</span>`);
  });
  return html;
}

function messageMentionsMe(message) {
  if (!myNick) return false;
  const safeNick = myNick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`@${safeNick}\\b`, 'i');
  return re.test(message);
}

function addChatMessage(nick, message, isMine) {
  const list = document.getElementById('chat-messages');
  if (!list) return;
  const mentioned = !isMine && messageMentionsMe(message);
  const div = document.createElement('div');
  div.className = 'chat-msg' + (isMine ? ' mine' : '') + (mentioned ? ' mentioned' : '');
  div.innerHTML = `<span class="chat-nick"></span> <span class="chat-text"></span>`;
  div.querySelector('.chat-nick').textContent = nick + ':';
  div.querySelector('.chat-text').innerHTML = renderMessageHtml(message);
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
  if (mentioned) toast(`${nick} te mencionó`);
}

function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message || !socket) return;
  socket.emit('chat-message', { roomId: myRoomId, nick: myNick, message });
  input.value = '';
  closeMentionDropdown();
}

function toggleChat() {
  const panel = document.getElementById('chat-panel');
  if (panel) panel.classList.toggle('open');
}

// ── Autocompletado de @mentions ──────────────────────────────────
let mentionMatches = [];
let mentionActiveIndex = -1;
let mentionAnchorStart = -1; // posición del "@" dentro del input

function getMentionQuery(input) {
  const value = input.value;
  const pos = input.selectionStart;
  const upToCursor = value.slice(0, pos);
  const match = upToCursor.match(/(?:^|\s)@([a-zA-Z0-9_]*)$/);
  if (!match) return null;
  return { query: match[1], start: pos - match[1].length - 1 };
}

function updateMentionDropdown() {
  const input = document.getElementById('chat-input');
  const dropdown = document.getElementById('mention-dropdown');
  if (!input || !dropdown) return;

  const context = getMentionQuery(input);
  if (!context) { closeMentionDropdown(); return; }

  const query = context.query.toLowerCase();
  const candidates = Object.values(peerNicks).filter(n => n.toLowerCase().startsWith(query));

  if (!candidates.length) { closeMentionDropdown(); return; }

  mentionMatches = candidates;
  mentionActiveIndex = 0;
  mentionAnchorStart = context.start;

  dropdown.innerHTML = '';
  candidates.forEach((nick, i) => {
    const item = document.createElement('div');
    item.className = 'mention-item' + (i === 0 ? ' active' : '');
    item.textContent = nick;
    item.onclick = () => selectMention(nick);
    dropdown.appendChild(item);
  });
  dropdown.classList.add('show');
}

function closeMentionDropdown() {
  mentionMatches = [];
  mentionActiveIndex = -1;
  mentionAnchorStart = -1;
  const dropdown = document.getElementById('mention-dropdown');
  if (dropdown) { dropdown.classList.remove('show'); dropdown.innerHTML = ''; }
}

function selectMention(nick) {
  const input = document.getElementById('chat-input');
  if (!input || mentionAnchorStart < 0) return;
  const before = input.value.slice(0, mentionAnchorStart);
  const after = input.value.slice(input.selectionStart);
  const insertion = `@${nick} `;
  input.value = before + insertion + after;
  const cursorPos = (before + insertion).length;
  input.setSelectionRange(cursorPos, cursorPos);
  input.focus();
  closeMentionDropdown();
}

function handleChatKeydown(event) {
  const dropdown = document.getElementById('mention-dropdown');
  const isOpen = dropdown && dropdown.classList.contains('show');

  if (isOpen && mentionMatches.length) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      mentionActiveIndex = (mentionActiveIndex + 1) % mentionMatches.length;
      highlightMentionItem();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      mentionActiveIndex = (mentionActiveIndex - 1 + mentionMatches.length) % mentionMatches.length;
      highlightMentionItem();
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      selectMention(mentionMatches[mentionActiveIndex]);
      return;
    }
    if (event.key === 'Escape') {
      closeMentionDropdown();
      return;
    }
  }

  if (event.key === 'Enter') sendChatMessage();
}

function highlightMentionItem() {
  const dropdown = document.getElementById('mention-dropdown');
  if (!dropdown) return;
  [...dropdown.children].forEach((item, i) => {
    item.classList.toggle('active', i === mentionActiveIndex);
  });
}
