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

function admitToRoom(io, rooms, sock, roomId, nick) {
  sock.join(roomId);
  const room = rooms[roomId];
  room.peers[sock.id] = { nick, socketId: sock.id };

  const peers = Object.values(room.peers).filter(p => p.socketId !== sock.id);

  sock.emit('room-peers', peers);
  sock.emit('you-are-host', room.host === sock.id);
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
      room.waiting[socket.id] = { nick, socketId: socket.id };
      socket.emit('waiting-for-approval');
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

  // El host aprueba a alguien de la sala de espera
  socket.on('admit-peer', ({ socketId }) => {
    const room = rooms[socket.roomId];
    if (!room || room.host !== socket.id) return; // solo el host puede admitir
    const waiter = room.waiting[socketId];
    if (!waiter) return;
    delete room.waiting[socketId];

    const waiterSocket = io.sockets.sockets.get(socketId);
    if (waiterSocket) admitToRoom(io, rooms, waiterSocket, socket.roomId, waiter.nick);
  });

  // El host rechaza a alguien de la sala de espera
  socket.on('reject-peer', ({ socketId }) => {
    const room = rooms[socket.roomId];
    if (!room || room.host !== socket.id) return;
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

  socket.on('disconnect', () => {
    const { roomId, nick } = socket;
    const room = rooms[roomId];
    if (room) {
      delete room.peers[socket.id];
      delete room.waiting[socket.id];

      if (Object.keys(room.peers).length === 0 && Object.keys(room.waiting).length === 0) {
        delete rooms[roomId];
      } else {
        if (room.host === socket.id) {
          // El host se fue: el siguiente peer más antiguo toma el rol
          const nextHostId = Object.keys(room.peers)[0];
          if (nextHostId) {
            room.host = nextHostId;
            io.to(nextHostId).emit('you-are-host', true);
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
              const promotedSocket = io.sockets.sockets.get(promotedId);
              if (promotedSocket) admitToRoom(io, rooms, promotedSocket, roomId, promoted.nick);
            }
          }
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
