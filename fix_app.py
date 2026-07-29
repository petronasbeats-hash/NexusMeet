path = "public/js/app.js"
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

marker = "let socket = null;"
if "loadIceServers" in content:
    print("Ya existe el bloque TURN, no se modifica.")
elif marker not in content:
    print("ERROR: no se encontro el marcador. No se hizo ningun cambio.")
else:
    snippet = "async function loadIceServers() {\n  try {\n    const res = await fetch('/api/turn-credentials');\n    const turnServers = await res.json();\n    if (Array.isArray(turnServers) && turnServers.length) {\n      ICE_SERVERS.iceServers.push(...turnServers);\n      console.log('[TURN] Credenciales cargadas:', turnServers.length, 'servidores');\n    }\n  } catch (e) {\n    console.warn('[TURN] No se pudieron cargar credenciales, usando solo STUN', e);\n  }\n}\nloadIceServers();\n\n"
    idx = content.find(marker)
    content = content[:idx] + snippet + content[idx:]
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print("Listo: TURN agregado a app.js")
