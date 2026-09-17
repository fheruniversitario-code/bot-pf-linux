# 🧠 Memoria del Proyecto: OmniBot SaaS Universal (Nursefashion / PF Linux)

Este archivo actúa como la memoria a largo plazo de Antigravity para este proyecto. **Siempre debe ser leído antes de modificar código crítico.**

## 1. Arquitectura General
*   **Backend:** Node.js (server.js) con Express y Socket.io.
*   **Base de Datos:** SQLite (db.js). Utiliza contactos, mensajes, etiquetas, contactos_etiquetas, solicitudes_asesor y tabla de configuracion.
*   **WhatsApp Web:** Se usa @whiskeysockets/baileys envuelto en un adaptador local (wa-baileys-adapter.js) para mantener compatibilidad con métodos legacy. La sesión se guarda en la carpeta aileys_auth.
*   **Frontend (Panel):** HTML/JS puro estático en public/ (ej. pp_v23.js, index.html). Se comunica con el backend vía WebSockets para estado en tiempo real.

## 2. Motor de Inteligencia Artificial (Gemini)
*   Usa el SDK oficial @google/generative-ai.
*   **Manejo de Caídas (Cascada):** Debido a intermitencias en los servidores de Google, el bot tiene un bloque 	ry/catch que iteraba sobre 30 modelos. 
    *   **Regla Crítica:** Para evitar que el bot se quede "pensando" 15 minutos, la cascada está limitada por un contador global: **Si se superan los 60 segundos (4 modelos fallidos), se aborta la cascada**.
    *   Al abortar, se dispara generarRespuestaEmergencia() que le avisa al cliente de la intermitencia y le sugiere usar el menú numérico.
*   **Precauciones:** Nunca usar variables no definidas dentro de procesarMensajeEntrante. El error contacto is not defined causaba un crash silencioso en el pasado. (Se debe usar contactoPrevio).

## 3. Manejo de Pausas y Reglas de Administradores
*   **Admin Rules:** Si un administrador (registrado en dmin_numeros) envía un mensaje desde su propio WhatsApp, el bot lo **ignora** para evitar auto-responderse.
    *   *Excepción:* Si el admin activa el Modo Prueba enviando !probar, el bot responde como si fuera cliente.
*   **Pausa Humana:** Cuando un humano envía un mensaje manual (msg.fromMe === true), message_create lo detecta y **pausa automáticamente el chat por 30 minutos** (configurable en DB).
*   Para quitar todas las pausas y silencios globales, se usa el comando !reactivar.

## 4. Auditor Centinela (uditor.js)
*   Se ejecuta independientemente para vigilar la salud del servidor.
*   Registra Alertas (ej. Timeout de 15s de la API de Google).
*   Reinicia PM2 / el proceso node si la conexión de WhatsApp se "cuelga". (Nota: Con Baileys, client.getState() siempre responde 'CONNECTED', por lo que los reinicios por timeout de socket son raros, pero vigila zombies).

## 5. Directorio CRM y Agendamiento (Google Calendar)
*   **Directorio:** En el panel de Directorio, se listan los contactos. 
    *   Se agregó la capacidad de etiquetar al paciente *al momento* de crear un nuevo contacto manualmente.
    *   La celda del número de teléfono está desbloqueada para permitir la edición antes de guardar.
    *   Se eliminó el fallo de "contacto no aparece tras guardar" (Endpoint DELETE /api/directorio/:jid y recarga de tabla).
*   **Agendamiento:** Está integrado con Google Calendar (Service Account en JSON). El prompt de la IA se nutre con los eventos libres/ocupados para coordinar. 
    *   **Importante:** A la IA ya se le inyecta el número de teléfono del paciente (leído desde BD) en su Prompt. *Tiene estrictamente prohibido volver a pedirle el teléfono al paciente si ya lo tenemos en la base de datos.*

## 6. Comportamientos Deseados (No modificar sin consultar)
*   Si el cliente pide "asesor" o elige opción 5, la IA DEBE seguir contestando (el chat NO se pausa solo porque lo pidan). El chat SÓLO se pausa cuando el humano interviene y responde desde el teléfono.
*   El Modo Prueba de Administrador es esencial para testeos internos y debe preservarse intacto.
