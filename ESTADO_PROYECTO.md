# ESTADO_PROYECTO

### Objetivo actual
Plataforma SaaS de automatización por WhatsApp impulsada por IA (Gemini). Combina un panel web comercial con CRM, gestión de citas, respuestas en tiempo real (Socket.io), control de modos de ausencia (Curso/Vacaciones) y lectura de catálogo.

### Arquitectura y archivos activos
- **`server.js`**: Backend principal (Node.js/Express). Orquesta API, conexión con Gemini (Prompts y reglas), Socket.io y lógica de negocio/base de datos (SQLite).
- **`calendar-service.js`**: Módulo desacoplado para integración con Google Calendar API (Service Account, Free/Busy, resolución de lenguaje natural para fechas, creación y cancelación de citas).
- **`bot.js`**: Core de WhatsApp usando `whatsapp-web.js`. Maneja autenticación Multi-Device, recepción/envío de mensajes multimedia y eventos de la sesión de Puppeteer.
- **`db.js`**: Inicialización y esquema de la base de datos SQLite (configuración, mensajes, contactos, etiquetas, reglas, citas con sincronización a Google Calendar).
- **`public/index.html`**: UI del panel de administración (Tailwind CSS, inyección de variables, reglas CSS específicas de Tema Claro/Oscuro).
- **`public/app.js`**: Lógica frontend (SPA). Control de vistas, WebSockets, llamadas API y manipulación dinámica del DOM.

### Cambios y avances recientes
- **Módulo Universal de Agendamiento Inteligente con Google Calendar:**
  - **Paridad 100% en los 3 bots:** Mismo código base compartido entre `bot-nursefashion`, `bot-pf-linux` y `PLANTILLA_BOT_UNIVERSAL_SAAS`.
  - **Interruptor Maestro por Base de Datos (`modulo_agenda_activo`):** Activación/desactivación en caliente desde el panel web o SQLite sin tocar código.
  - **Autenticación con Google Service Account:** Diseñado para operación autónoma 24/7 sin tokens que caduquen ni redirecciones web.
  - **Disponibilidad Real en Vivo:** La IA inyecta slots disponibles consultando Free/Busy de Google Calendar + horario laboral y festivos del negocio.
  - **Agendamiento y Cancelación Conversacional:** Detección de intenciones y marcado técnico `[AGENDAR_CITA: ...]` / `[CANCELAR_CITA: ...]` para creación bidireccional automática en SQLite y Google Calendar.
  - **Diagnóstico en Vivo en el Panel Web:** Botón "🔌 Probar Conexión con Google Calendar" que valida credenciales y permisos al instante.
  - **Tabla de Citas Enriquecida:** Con enlaces directos al evento en Google Calendar, origen (🤖 WhatsApp IA / 👤 Panel Web) y botón de cancelación inmediata.
- **Autenticación Universal de Administrador (`!admin <clave>`):** Ahora cualquier usuario puede vincular su WhatsApp como Administrador enviando su contraseña del panel directamente al bot por chat. El bot valida con `bcrypt`, extrae su identificador exacto (`@lid` o número) y lo guarda en `numeros_admins` en SQLite, confirmando por WhatsApp y actualizando el panel web.
- **Corrección y Priorización del Menú Numérico:**
  - Reducción del bloqueo de inactividad de 12 horas a 1 hora (y siempre activo en `!probar`).
  - Activación inmediata con palabras clave: `menu`, `menú`, `inicio`, `opciones`, `empezar` y nuevo comando `!menu`.
  - Prioridad de ejecución: Las opciones del menú numérico se evalúan antes de las palabras clave de asesor humano, eliminando el bloqueo que existía sobre las opciones 3 y 5.
- **Manejo Amigable de Comandos Desconocidos:** Si un administrador escribe un comando con `!` no reconocido, el bot responde con sugerencias en lugar de guardar silencio.
- **Interrelación y UX del Panel:** Incorporación del botón y modal "Ver Comandos WhatsApp" y botón "Vista Previa del Menú" en el panel web.
- Corrección del ordenamiento cronológico del panel de chat (`ORDER BY timestamp DESC LIMIT 250` y `.reverse()`).
- Conversión dinámica de horarios (formato AM/PM) en las respuestas de la IA.
- Refinamiento total del "Modo Claro" y sanitización de espacios invisibles Unicode.

### Decisiones clave y errores resueltos
- **Agendamiento con Service Account:** Se eligió Google Service Account sobre OAuth2 para permitir ejecución desatendida en servidores en la nube sin requerir inicio de sesión interactivo de Google ni refresco manual de tokens.
- **Autenticación de Admin:** Para evitar que el enmascaramiento `@lid` de WhatsApp Multi-Device rompa los comandos, el comando `!admin <contraseña>` autorregistra automáticamente el identificador real recibido en el evento.
- **Métricas de CPU en Oracle Cloud:** El pico de 84.6% en métricas de Host se debe a la animación de canvas del código QR e intentos de reconexión de Chromium (`puppeteer`) cuando los teléfonos están desconectados/apagados.
- **Estilizado del Tema Claro:** Todos los overrides deben estar aislados bajo `body.light-theme` en `index.html`.
- **Persistencia del Modo Curso en IA:** Si la IA alucina seguir en capacitación tras apagar el switch, se debe al historial en memoria inyectado a Gemini. Requiere conversación nueva o limpiar historial.

### Siguiente paso pendiente
1. Cargar las credenciales JSON de la cuenta de servicio y el Calendar ID en el panel web (Pestaña "Agenda de Citas") y probar la conexión con el botón de diagnóstico.
2. Realizar pruebas de conversación en vivo por WhatsApp para verificar la asignación de citas y la sincronización con Google Calendar.
3. Vincular los WhatsApp de los dos bots una vez que los teléfonos estén con carga y probar los comandos `!admin <clave>`, `!menu` y `!probar`.
