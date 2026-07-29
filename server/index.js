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
const METERED_API_KEY = process.env.METERED_API_KEY || 'QVm58GV3HJYJu1elHRspqGFQq44GzHuUocRXyYZw8E4o-mZB';
const METERED_DOMAIN = 'rushnow.metered.live';

app.get('/api/turn-credentials', async (req, res) => {
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

// Estado de las salas: { roomId: { socketId: { nick, socketId } } }
const rooms = {};

io.on('connection', (socket) => {
  console.log(`[+] Conectado: ${socket.id}`);

  // Usuario se une a una sala
  socket.on('join-room', ({ roomId, nick }) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.nick = nick;

    if (!rooms[roomId]) rooms[roomId] = {};
    rooms[roomId][socket.id] = { nick, socketId: socket.id };

    const peers = Object.values(rooms[roomId]).filter(p => p.socketId !== socket.id);

    // Notificar al nuevo usuario quiénes ya están en la sala
    socket.emit('room-peers', peers);

    // Notificar a los demás que llegó alguien nuevo
    socket.to(roomId).emit('peer-joined', { nick, socketId: socket.id });

    console.log(`[sala:${roomId}] ${nick} se unió (${Object.keys(rooms[roomId]).length} en sala)`);
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
  socket.on('disconnect', () => {
    const { roomId, nick } = socket;
    if (roomId && rooms[roomId]) {
      delete rooms[roomId][socket.id];
      if (Object.keys(rooms[roomId]).length === 0) {
        delete rooms[roomId];
      } else {
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
