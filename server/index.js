const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

// Servir archivos estáticos del frontend
app.use(express.static(path.join(__dirname, '../public')));

// --- TURN credentials (Metered.ca) ---
// La API key SIEMPRE debe venir de una variable de entorno (METERED_API_KEY).
// No se deja ningun valor por defecto aqui porque el repo es publico.
const METERED_API_KEY = process.env.METERED_API_KEY;
const METERED_DOMAIN = 'rushnow.metered.live';

app.get('/api/turn-credentials', async (req, res) => {
  if (!METERED_API_KEY) {
    console.warn('METERED_API_KEY no configurada: usando solo servidores STUN');
    return res.json([]);
  }
  try {
    const response = await fetch(
      `https://${METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`
    );
    const iceServers = await response.json();
    res.json(iceServers);
  } catch (err) {
    console.error('Error obteniendo credenciales TURN:', err);
    res.status(500).json({ error: 'No se pudieron obtener credenciales TURN' });
  }
});


// Redirigir cualquier ruta al index.html (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Estado de las salas:
// { roomId: { host, peers, waiting, locked, inviteToken, inviteExpires } }
const rooms = {};

const INVITE_TTL_MS = 4 * 60 * 60 * 1000; // los enlaces de invitación duran 4 horas

function generateInviteToken() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

const DEFAULT_RULES = 'Sé respetuoso con los demás participantes. No compartas contenido inapropiado. El host puede expulsar a quien no cumpla estas reglas.';

// ¿Puede este socket moderar (host o co-host)?
function canModerate(room, socketId) {
  return room.host === socketId || room.coHosts.has(socketId);
}

// ¿Puede actorId aplicar una acción de moderación sobre targetId?
// (un co-host no puede moderar al host)
function canModerateTarget(room, actorId, targetId) {
  if (!canModerate(room, actorId)) return false;
  if (targetId === room.host && actorId !== room.host) return false;
  return true;
}

function broadcastRoles(io, roomId, room) {
  io.to(roomId).emit('room-roles', { host: room.host, coHosts: Array.from(room.coHosts) });
}

function admitToRoom(io, rooms, sock, roomId, nick) {
  sock.join(roomId);
  const room = rooms[roomId];
  room.peers[sock.id] = { nick, socketId: sock.id };

  const peers = Object.values(room.peers).filter(p => p.socketId !== sock.id);

  sock.emit('room-peers', peers);
  sock.emit('you-are-host', room.host === sock.id);
  sock.emit('you-are-cohost', room.coHosts.has(sock.id));
  sock.emit('room-roles', { host: room.host, coHosts: Array.from(room.coHosts) });
  sock.emit('invite-info', { token: room.inviteToken, expiresAt: room.inviteExpires });
  sock.emit('room-lock-changed', room.locked);
  sock.to(roomId).emit('peer-joined', { nick, socketId: sock.id });

  console.log(`[sala:${roomId}] ${nick} se unió (${Object.keys(room.peers).length} en sala)`);
}

io.on('connection', (socket) => {
  console.log(`[+] Conectado: ${socket.id}`);

  // Usuario pide unirse a una sala
  socket.on('join-room', ({ roomId, nick, invite, hostToken }) => {
    socket.roomId = roomId;
    socket.nick = nick;

    // Sala nueva: quien la crea entra directo y es el host
    if (!rooms[roomId]) {
      const hostToken = generateInviteToken();
      rooms[roomId] = {
        host: socket.id,
        peers: {},
        waiting: {},
        locked: false,
        inviteToken: generateInviteToken(),
        inviteExpires: Date.now() + INVITE_TTL_MS,
        hostToken, // identifica al creador original, para que pueda reclamar el rol si vuelve
        rules: DEFAULT_RULES,
        bannedNicks: new Set(),
        coHosts: new Set(),
      };
      admitToRoom(io, rooms, socket, roomId, nick);
      socket.emit('host-token', hostToken);
      return;
    }

    const room = rooms[roomId];

    // Reclamo de host: si trae el token del creador original, recupera el rol
    // sin pasar por sala de espera, bloqueo ni validación de invitación
    if (hostToken && room.hostToken && hostToken === room.hostToken) {
      const oldHostId = room.host;
      room.host = socket.id;
      if (oldHostId && oldHostId !== socket.id) {
        io.to(oldHostId).emit('you-are-host', false);
      }
      admitToRoom(io, rooms, socket, roomId, nick);
      socket.emit('host-token', room.hostToken);
      io.to(roomId).emit('host-reclaimed', { nick });
      return;
    }

    // Si fue expulsado de esta sala, no puede volver a entrar con el mismo nick
    if (room.bannedNicks.has(nick.toLowerCase())) {
      socket.emit('you-are-banned');
      return;
    }

    // Sala bloqueada por el host: nadie más puede entrar aunque tenga el código
    if (room.locked) {
      socket.emit('room-locked');
      return;
    }

    // El enlace de invitación debe ser válido y no haber expirado
    if (!invite || invite !== room.inviteToken || Date.now() > room.inviteExpires) {
      socket.emit('invite-invalid');
      return;
    }

    const hostConnected = room.host && io.sockets.sockets.get(room.host);

    if (hostConnected) {
      // Hay host activo: pasa a la sala de espera hasta que lo apruebe
      room.waiting[socket.id] = { nick, socketId: socket.id, rulesAccepted: false };
      socket.emit('waiting-for-approval');
      socket.emit('room-rules', room.rules);
      io.to(room.host).emit('join-request', { nick, socketId: socket.id });
      return;
    }

    // No hay host conectado (se fue): esta persona toma el rol de host
    room.host = socket.id;
    admitToRoom(io, rooms, socket, roomId, nick);
  });

  // El host bloquea/desbloquea la sala
  socket.on('lock-room', () => {
    const room = rooms[socket.roomId];
    if (!room || room.host !== socket.id) return;
    room.locked = true;
    io.to(socket.roomId).emit('room-lock-changed', true);
  });

  socket.on('unlock-room', () => {
    const room = rooms[socket.roomId];
    if (!room || room.host !== socket.id) return;
    room.locked = false;
    io.to(socket.roomId).emit('room-lock-changed', false);
  });

  // El host define/edita las reglas de la sala
  socket.on('set-room-rules', ({ text }) => {
    const room = rooms[socket.roomId];
    if (!room || room.host !== socket.id || typeof text !== 'string') return;
    room.rules = text.slice(0, 1000);
    // Reenviar a todos los que siguen esperando
    Object.keys(room.waiting).forEach(socketId => {
      io.to(socketId).emit('room-rules', room.rules);
    });
  });

  // Alguien en la sala de espera confirma que leyó y entendió las reglas
  socket.on('confirm-rules', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const waiter = room.waiting[socket.id];
    if (!waiter) return;
    waiter.rulesAccepted = true;
    if (room.host) io.to(room.host).emit('waiting-rules-confirmed', { socketId: socket.id });
  });

  // Chat privado entre el host y alguien en la sala de espera
  socket.on('waiting-chat-to-host', ({ message }) => {
    const room = rooms[socket.roomId];
    if (!room || !room.waiting[socket.id] || !message) return;
    if (room.host) {
      io.to(room.host).emit('waiting-chat-message', {
        socketId: socket.id, nick: socket.nick, message, fromHost: false,
      });
    }
  });

  socket.on('waiting-chat-to-waiter', ({ socketId, message }) => {
    const room = rooms[socket.roomId];
    if (!room || room.host !== socket.id || !message) return;
    if (room.waiting[socketId]) {
      io.to(socketId).emit('waiting-chat-message', { message, fromHost: true });
    }
  });

  // El host manda de vuelta a la sala de espera a alguien que ya estaba dentro
  socket.on('demote-peer', ({ socketId }) => {
    const room = rooms[socket.roomId];
    if (!room || !canModerateTarget(room, socket.id, socketId) || socketId === socket.id) return;
    const peer = room.peers[socketId];
    if (!peer) return;
    delete room.peers[socketId];
    room.waiting[socketId] = { nick: peer.nick, socketId, rulesAccepted: false };

    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) {
      targetSocket.emit('sent-to-waiting-room');
      targetSocket.emit('room-rules', room.rules);
    }
    socket.to(socket.roomId).emit('peer-left', { socketId, nick: peer.nick });
    io.to(socket.id).emit('join-request', { nick: peer.nick, socketId });
  });

  // El host expulsa a alguien: no puede volver a entrar con el mismo nick
  socket.on('expel-peer', ({ socketId }) => {
    const room = rooms[socket.roomId];
    if (!room || !canModerateTarget(room, socket.id, socketId) || socketId === socket.id) return;
    const peer = room.peers[socketId] || room.waiting[socketId];
    if (!peer) return;
    delete room.peers[socketId];
    delete room.waiting[socketId];
    room.bannedNicks.add(peer.nick.toLowerCase());

    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) targetSocket.emit('expelled-from-room');
    socket.to(socket.roomId).emit('peer-left', { socketId, nick: peer.nick });
  });

  // El host aprueba a alguien de la sala de espera
  socket.on('admit-peer', ({ socketId }) => {
    const room = rooms[socket.roomId];
    if (!room || !canModerate(room, socket.id)) return; // host o co-host puede admitir
    const waiter = room.waiting[socketId];
    if (!waiter) return;
    delete room.waiting[socketId];

    const waiterSocket = io.sockets.sockets.get(socketId);
    if (waiterSocket) admitToRoom(io, rooms, waiterSocket, socket.roomId, waiter.nick);
  });

  // El host rechaza a alguien de la sala de espera
  socket.on('reject-peer', ({ socketId }) => {
    const room = rooms[socket.roomId];
    if (!room || !canModerate(room, socket.id)) return;
    delete room.waiting[socketId];
    io.to(socketId).emit('join-rejected');
  });

  // Señalización WebRTC: offer
  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', { from: socket.id, nick: socket.nick, offer });
  });

  // Señalización WebRTC: answer
  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  // Señalización WebRTC: ICE candidate
  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // Usuario se desconecta
  socket.on('chat-message', ({ roomId, nick, message }) => {
    if (!roomId || !message) return;
    io.to(roomId).emit('chat-message', { nick, message, ts: Date.now() });
  });

  // Cualquier peer informa su estado de mic/cámara para que los demás vean el ícono
  socket.on('peer-state', ({ micOn, camOn }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    socket.to(socket.roomId).emit('peer-state', { socketId: socket.id, micOn, camOn });
  });

  // El host o co-host fuerza (enciende/apaga) el mic de un participante
  socket.on('host-force-mic', ({ socketId, micOn }) => {
    const room = rooms[socket.roomId];
    if (!room || !canModerateTarget(room, socket.id, socketId) || !room.peers[socketId]) return;
    io.to(socketId).emit('forced-mic', { micOn: !!micOn });
  });

  // El host o co-host fuerza (enciende/apaga) la cámara de un participante
  socket.on('host-force-cam', ({ socketId, camOn }) => {
    const room = rooms[socket.roomId];
    if (!room || !canModerateTarget(room, socket.id, socketId) || !room.peers[socketId]) return;
    io.to(socketId).emit('forced-cam', { camOn: !!camOn });
  });

  // El host cede su rol a otro participante de la sala
  socket.on('transfer-host', ({ socketId }) => {
    const room = rooms[socket.roomId];
    if (!room || room.host !== socket.id || socketId === socket.id || !room.peers[socketId]) return;
    const oldHostId = socket.id;
    room.host = socketId;
    room.coHosts.delete(socketId);
    // Se revoca la posibilidad de que el creador original reclame el rol de vuelta
    room.hostToken = generateInviteToken();

    io.to(oldHostId).emit('you-are-host', false);
    const newHostSocket = io.sockets.sockets.get(socketId);
    if (newHostSocket) {
      newHostSocket.emit('you-are-host', true);
      newHostSocket.emit('you-are-cohost', false);
      newHostSocket.emit('host-token', room.hostToken);
    }
    broadcastRoles(io, socket.roomId, room);
    const newHostPeer = room.peers[socketId];
    io.to(socket.roomId).emit('host-changed', { nick: newHostPeer ? newHostPeer.nick : '' });
  });

  // El host asigna a alguien como co-host
  socket.on('assign-cohost', ({ socketId }) => {
    const room = rooms[socket.roomId];
    if (!room || room.host !== socket.id || socketId === socket.id || !room.peers[socketId]) return;
    room.coHosts.add(socketId);
    io.to(socketId).emit('you-are-cohost', true);
    broadcastRoles(io, socket.roomId, room);
    const peer = room.peers[socketId];
    io.to(socket.roomId).emit('cohost-changed', { nick: peer ? peer.nick : '', assigned: true });
  });

  // El host revoca el rol de co-host
  socket.on('revoke-cohost', ({ socketId }) => {
    const room = rooms[socket.roomId];
    if (!room || room.host !== socket.id) return;
    room.coHosts.delete(socketId);
    io.to(socketId).emit('you-are-cohost', false);
    broadcastRoles(io, socket.roomId, room);
    const peer = room.peers[socketId];
    io.to(socket.roomId).emit('cohost-changed', { nick: peer ? peer.nick : 'Alguien', assigned: false });
  });

  socket.on('disconnect', () => {
    const { roomId, nick } = socket;
    const room = rooms[roomId];
    if (room) {
      delete room.peers[socket.id];
      delete room.waiting[socket.id];
      room.coHosts.delete(socket.id);

      if (Object.keys(room.peers).length === 0 && Object.keys(room.waiting).length === 0) {
        delete rooms[roomId];
      } else {
        if (room.host === socket.id) {
          // El host se fue: el siguiente peer más antiguo toma el rol
          const nextHostId = Object.keys(room.peers)[0];
          if (nextHostId) {
            room.host = nextHostId;
            room.coHosts.delete(nextHostId);
            io.to(nextHostId).emit('you-are-host', true);
            io.to(nextHostId).emit('you-are-cohost', false);
            // Reenviar al nuevo host las solicitudes de espera pendientes
            Object.values(room.waiting).forEach(w => {
              io.to(nextHostId).emit('join-request', { nick: w.nick, socketId: w.socketId });
            });
          } else {
            // No quedan peers, pero hay gente esperando: el primero se vuelve host
            const waitingIds = Object.keys(room.waiting);
            if (waitingIds.length) {
              const promotedId = waitingIds[0];
              const promoted = room.waiting[promotedId];
              delete room.waiting[promotedId];
              room.host = promotedId;
              room.coHosts.delete(promotedId);
              const promotedSocket = io.sockets.sockets.get(promotedId);
              if (promotedSocket) admitToRoom(io, rooms, promotedSocket, roomId, promoted.nick);
            }
          }
          broadcastRoles(io, roomId, room);
        } else {
          broadcastRoles(io, roomId, room);
        }
        socket.to(roomId).emit('peer-left', { socketId: socket.id, nick });
      }
    }
    console.log(`[-] Desconectado: ${nick || socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\n🎥 Servidor corriendo en http://localhost:${PORT}\n`);
});
