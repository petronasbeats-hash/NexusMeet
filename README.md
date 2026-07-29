# 🎥 Nexus Meet — Videollamadas sin registro

App de videollamadas peer-to-peer usando WebRTC + Socket.io. Sin cuenta, sin registro, solo un nickname y un enlace.

---

## 🚀 Instalación local

```bash
# 1. Instalar dependencias
npm install

# 2. Correr el servidor
npm start

# 3. Abrir en el navegador
# http://localhost:3000
```

Para desarrollo con auto-reload:
```bash
npm run dev
```

---

## ☁️ Deploy en Railway (gratis, 5 minutos)

1. Sube el proyecto a GitHub
2. Entra a https://railway.app y crea cuenta
3. "New Project" → "Deploy from GitHub repo"
4. Selecciona tu repo → Deploy automático
5. Railway te da una URL pública tipo: `https://nexusmeet-xxx.railway.app`

---

## ☁️ Deploy en Render (gratis)

1. Sube el proyecto a GitHub
2. Entra a https://render.com → New → Web Service
3. Conecta tu repo
4. Build Command: `npm install`
5. Start Command: `npm start`
6. Deploy → URL pública lista

---

## 🏗️ Estructura del proyecto

```
videocall/
├── server/
│   └── index.js          # Servidor de señalización (Socket.io)
├── public/
│   ├── index.html        # Frontend
│   ├── css/style.css     # Estilos
│   └── js/app.js         # Lógica WebRTC + Socket.io
├── package.json
└── README.md
```

---

## 🔧 Cómo funciona

```
Tú ──────────────────────────────── Amigo
 │    1. Intercambian SDP (offer/   │
 │       answer) vía Socket.io      │
 │    2. Intercambian ICE candidates│
 └──────── Conexión directa ────────┘
           (WebRTC P2P)
```

El servidor solo actúa como intermediario al inicio de la llamada.
Una vez conectados, el audio y video van directo entre los navegadores.

---

## 🌐 TURN Server (opcional, para redes corporativas)

Si los usuarios están detrás de firewalls o VPNs, necesitarás un servidor TURN.
Metered.ca ofrece uno gratis: https://www.metered.ca/stun-turn

Agrega tus credenciales en `public/js/app.js`:

```js
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:tu-servidor.metered.ca:80',
      username: 'TU_USERNAME',
      credential: 'TU_PASSWORD'
    }
  ]
};
```

---

## 🔒 Variables de entorno

| Variable            | Default | Descripción |
|---------------------|---------|-------------|
| `PORT`              | `3000`  | Puerto del servidor |
| `METERED_API_KEY`   | (ninguno) | API key de Metered.ca para TURN. Sin ella, solo se usan servidores STUN. |

---

## ✨ Características

- Sin registro ni cuenta
- Salas con código de 6 caracteres
- Enlace de invitación directo
- Hasta 4 personas por sala (grilla automática)
- Controles de micrófono y cámara
- Funciona en Chrome, Firefox, Safari, Edge
