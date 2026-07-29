path = "server/index.js"
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

if "TURN credentials (Metered.ca)" in content:
    print("Ya existe el bloque TURN, no se modifica.")
else:
    snippet = '''// --- TURN credentials (Metered.ca) ---
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

'''
    marker = "const PORT = process.env.PORT"
    idx = content.find(marker)
    if idx == -1:
        print("ERROR: no se encontró la línea 'const PORT'. No se hizo ningún cambio.")
    else:
        content = content[:idx] + snippet + content[idx:]
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        print("Listo: bloque TURN insertado en server/index.js")
