require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Client, LocalAuth, MessageMedia } = require('./wa-baileys-adapter');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');

const { db, runQuery, getQuery, allQuery, inicializarBD, DB_PATH } = require('./db');
const Auditor = require('./auditor');
const calendarService = require('./calendar-service');

const DIR_UPLOADS = path.join(__dirname, 'public', 'uploads');
const DIR_DOCS = path.join(__dirname, 'documentos');
const DIR_IMAGENES = path.join(__dirname, 'imagenes');

if (!fs.existsSync(DIR_UPLOADS)) fs.mkdirSync(DIR_UPLOADS, { recursive: true });
if (!fs.existsSync(DIR_DOCS)) fs.mkdirSync(DIR_DOCS, { recursive: true });
if (!fs.existsSync(DIR_IMAGENES)) fs.mkdirSync(DIR_IMAGENES, { recursive: true });

const uploadLogo = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, DIR_UPLOADS),
        filename: (req, file, cb) => cb(null, 'logo-' + Date.now() + path.extname(file.originalname))
    })
});

const uploadDoc = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, DIR_DOCS),
        filename: (req, file, cb) => {
            const cleanName = Buffer.from(file.originalname, 'latin1').toString('utf8');
            cb(null, cleanName);
        }
    })
});

const uploadImagen = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, DIR_IMAGENES),
        filename: (req, file, cb) => {
            const cleanName = Buffer.from(file.originalname, 'latin1').toString('utf8');
            cb(null, cleanName);
        }
    })
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
    socket.emit('estado_whatsapp', { conectado: wsClienteConectado });
    socket.emit('estado_control_actualizado', { wsClienteConectado });
    if (!wsClienteConectado && ultimoQrCode) {
        socket.emit('qr_actualizado', { qr: ultimoQrCode });
    }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'omnibot_super_secret_jwt_key_2026';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir index.html sin cach�
app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// static config
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(DIR_UPLOADS));
app.use('/imagenes', express.static(DIR_IMAGENES));

// Estado de WhatsApp Web en Memoria
let wsClienteConectado = false;
let ultimoQrCode = null;
let botPausadoGlobal = false;
const chatsPausados = new Map();
const chatsEsperandoNombre = new Map(); // JID -> Timestamp de inicio de pausa
const idsMensajesEnviadosBot = new Set();
const idsMensajesRecibidos = new Set(); // Para deduplicación estricta de mensajes entrantes
const chatsEnProceso = new Map(); // JID -> Timestamp inicio (bloqueo concurrente con expiración automática TTL)
const ultimosTextosEnviadosBot = new Map(); // Texto limpio -> Timestamp (para evitar que el bot se auto-pause a sí mismo)
const colasProcesamiento = new Map();

const ultimosJidsEnviadosBot = new Map(); // JID / últimos 8 dígitos -> Timestamp

function registrarEnvioBot(jid, texto) {
    const ahora = Date.now();
    if (jid) {
        ultimosJidsEnviadosBot.set(jid, ahora);
        const num = jid.replace(/[^0-9]/g, '');
        if (num && num.length >= 8) ultimosJidsEnviadosBot.set(num.slice(-8), ahora);
    }
    if (texto) {
        ultimosTextosEnviadosBot.set(texto.trim(), ahora);
    }
    for (const [j, ts] of ultimosJidsEnviadosBot.entries()) {
        if (ahora - ts > 45000) ultimosJidsEnviadosBot.delete(j);
    }
    for (const [t, ts] of ultimosTextosEnviadosBot.entries()) {
        if (ahora - ts > 45000) ultimosTextosEnviadosBot.delete(t);
    }
}

function registrarTextoEnviadoBot(texto) {
    registrarEnvioBot(null, texto);
}

// ------------------------------------------------------------------------------
// 1. CONFIGURACIÓN DE GEMINI AI
// ------------------------------------------------------------------------------
const geminiApiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || '';
const genAI = geminiApiKey ? new GoogleGenerativeAI(geminiApiKey) : null;
// Modelos se detectan dinámicamente via obtenerModelosDisponibles() — no hardcodear aquí

// ------------------------------------------------------------------------------
// 2. HELPERS DE TIEMPO, ANTI-BAN Y UTILIDADES
// ------------------------------------------------------------------------------
function obtenerFechaHoraLocal() {
    const ahora = new Date();
    const opciones = {
        timeZone: 'America/Mexico_City',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: true
    };
    return new Intl.DateTimeFormat('es-MX', opciones).format(ahora);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ------------------------------------------------------------------------------
// 3. MIDDLEWARE DE AUTENTICACIÓN JWT
// ------------------------------------------------------------------------------
function autenticarToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Acceso no autorizado' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Sesión inválida o expirada' });
        req.user = user;
        next();
    });
}

// ------------------------------------------------------------------------------
// 4. RUTAS DE LA API (REST API PARA EL DASHBOARD)
// ------------------------------------------------------------------------------

// Login de Usuario / Administrador
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const usuario = await getQuery("SELECT * FROM usuarios WHERE username = ?", [username]);
        if (!usuario) return res.status(400).json({ error: 'Usuario o contraseña incorrectos' });

        if (usuario.estado === 'suspendido') {
            return res.status(403).json({ error: 'Tu cuenta y servicio se encuentran suspendidos por falta de pago. Contacta a tu proveedor.' });
        }

        const passValida = bcrypt.compareSync(password, usuario.password_hash);
        if (!passValida) return res.status(400).json({ error: 'Usuario o contraseña incorrectos' });

        const token = jwt.sign({ 
            id: usuario.id, 
            username: usuario.username, 
            nombre: usuario.nombre,
            rol: usuario.rol || 'cliente',
            plan: usuario.plan || 'Pro',
            estado: usuario.estado || 'activo'
        }, JWT_SECRET, { expiresIn: '7d' });

        res.json({ 
            token, 
            usuario: { 
                id: usuario.id,
                username: usuario.username, 
                nombre: usuario.nombre,
                rol: usuario.rol || 'cliente',
                plan: usuario.plan || 'Pro',
                estado: usuario.estado || 'activo'
            } 
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Cambio de Contraseña y Datos de Perfil (Para el Cliente)
app.post('/api/perfil/cambiar-password', autenticarToken, async (req, res) => {
    try {
        const { nuevo_username, nuevo_nombre, password_actual, nuevo_password } = req.body;
        const usuario = await getQuery("SELECT * FROM usuarios WHERE id = ?", [req.user.id]);
        if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });

        if (password_actual && nuevo_password) {
            const passValida = bcrypt.compareSync(password_actual, usuario.password_hash);
            if (!passValida) return res.status(400).json({ error: 'La contraseña actual no es correcta' });

            const nuevoHash = bcrypt.hashSync(nuevo_password, 10);
            await runQuery(
                "UPDATE usuarios SET username = ?, nombre = ?, password_hash = ? WHERE id = ?",
                [nuevo_username || usuario.username, nuevo_nombre || usuario.nombre, nuevoHash, req.user.id]
            );
        } else {
            await runQuery(
                "UPDATE usuarios SET username = ?, nombre = ? WHERE id = ?",
                [nuevo_username || usuario.username, nuevo_nombre || usuario.nombre, req.user.id]
            );
        }

        res.json({ success: true, message: 'Perfil y credenciales actualizados correctamente' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ------------------------------------------------------------------------------
// ENDPOINT DE MONITOREO REMOTO PARA TORRE DE CONTROL (PUERTO 9000)
// ------------------------------------------------------------------------------
app.get('/api/bot/estado-remoto', async (req, res) => {
    try {
        const nombreNegocio = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'nombre_negocio'"))?.valor || 'OmniBot';
        const totalMensajes = (await getQuery("SELECT COUNT(*) as total FROM mensajes"))?.total || 0;
        const totalContactos = (await getQuery("SELECT COUNT(*) as total FROM contactos WHERE es_ignorado = 0"))?.total || 0;
        const totalCitas = (await getQuery("SELECT COUNT(*) as total FROM citas_agenda"))?.total || 0;

        res.json({
            online: wsClienteConectado,
            botPausadoGlobal,
            nombre: nombreNegocio,
            puerto: PORT,
            totalMensajes,
            totalContactos,
            totalCitas
        });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// Estadísticas y Métricas (KPIs de Ventas y CRM)
app.get('/api/stats', autenticarToken, async (req, res) => {
    try {
        const ventasTotal = await getQuery("SELECT SUM(valor) as total FROM pedidos_cotizaciones WHERE estado = 'Pagado'");
        const ventasPendientes = await getQuery("SELECT SUM(valor) as total, COUNT(*) as cantidad FROM pedidos_cotizaciones WHERE estado = 'Pendiente de pago'");
        const cotizacionesSinCerrar = await getQuery("SELECT COUNT(*) as total FROM pedidos_cotizaciones WHERE estado IN ('Nuevo', 'Contactado', 'Pendiente de pago')");
        const totalContactos = await getQuery("SELECT COUNT(*) as total FROM contactos WHERE es_ignorado = 0");
        const citasHoy = await getQuery("SELECT COUNT(*) as total FROM citas_agenda WHERE estado = 'Confirmada'");

        res.json({
            conectado: wsClienteConectado,
            vendido_total: ventasTotal?.total || 0,
            pendiente_pago: ventasPendientes?.total || 0,
            pedidos_pendientes_count: ventasPendientes?.cantidad || 0,
            cotizaciones_sin_cerrar: cotizacionesSinCerrar?.total || 0,
            total_contactos: totalContactos?.total || 0,
            citas_hoy: citasHoy?.total || 0
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Helper para calcular y formatear tiempo transcurrido en lenguaje natural
function formatearTiempoRelativo(timestampMs) {
    if (!timestampMs) return { texto: 'Sin mensajes', dias: 0, meses: 0, fecha: '---' };
    const ahora = Date.now();
    const difMs = Math.max(0, ahora - timestampMs);
    const difMins = Math.floor(difMs / (1000 * 60));
    const difHoras = Math.floor(difMins / 60);
    const difDias = Math.floor(difHoras / 24);
    const difMeses = Math.floor(difDias / 30);

    const fechaObj = new Date(timestampMs);
    const fechaFormateada = fechaObj.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });

    let texto = '';
    if (difMins < 1) texto = 'hace un momento';
    else if (difMins < 60) texto = `hace ${difMins} min`;
    else if (difHoras < 24) texto = `hace ${difHoras} h`;
    else if (difDias === 1) texto = `hace 1 día (${fechaFormateada})`;
    else if (difDias < 30) texto = `hace ${difDias} días (${fechaFormateada})`;
    else if (difMeses === 1) texto = `hace 1 mes (${fechaFormateada})`;
    else if (difMeses < 12) texto = `hace ${difMeses} meses (${fechaFormateada})`;
    else texto = `hace más de 1 año (${fechaFormateada})`;

    return { texto, dias: difDias, meses: difMeses, fecha: fechaFormateada };
}

// ============================================================================
// DIRECTORIO DE PACIENTES / CLIENTES (MINI-CRM)
// ============================================================================

app.get('/api/directorio', autenticarToken, async (req, res) => {
    try {
        const queryBusqueda = (req.query.q || '').trim();
        let whereClause = '';
        let params = [];

        if (queryBusqueda) {
            whereClause = `WHERE (c.nombre LIKE ? OR c.telefono LIKE ? OR c.correo LIKE ? OR c.expediente LIKE ?)`;
            const likeParam = `%${queryBusqueda}%`;
            params = [likeParam, likeParam, likeParam, likeParam];
        }

        const contactos = await allQuery(`
            SELECT c.jid, c.telefono, c.nombre, c.pushname, c.correo, c.expediente, c.domicilio,
                   (SELECT COUNT(*) FROM mensajes WHERE chat_id = c.jid) as total_mensajes
            FROM contactos c
            ${whereClause}
            ORDER BY c.nombre ASC
            LIMIT 500
        `, params);

        // Obtener etiquetas para el directorio
        const listaJids = contactos.map(c => c.jid);
        if (listaJids.length > 0) {
            const etqsAsignadas = await allQuery(`
                SELECT ce.jid, e.id, e.nombre, e.color 
                FROM contactos_etiquetas ce
                JOIN etiquetas e ON ce.etiqueta_id = e.id
                WHERE ce.jid IN (${listaJids.map(() => '?').join(',')})
            `, listaJids);
            
            contactos.forEach(c => {
                c.etiquetas_lista = etqsAsignadas.filter(et => et.jid === c.jid);
            });
        } else {
            contactos.forEach(c => c.etiquetas_lista = []);
        }

        res.json(contactos);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/directorio', autenticarToken, async (req, res) => {
    try {
        const { telefono, nombre, correo, expediente, domicilio } = req.body;
        if (!telefono) return res.status(400).json({ error: "El teléfono es requerido" });
        const telLimpio = telefono.replace(/[^0-9]/g, '');
        const jid = telLimpio.length === 10 ? `521${telLimpio}@c.us` : `${telLimpio}@c.us`;

        await runQuery(
            "INSERT INTO contactos (jid, telefono, nombre, correo, expediente, domicilio, ultimo_contacto) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(jid) DO UPDATE SET nombre = excluded.nombre, correo = excluded.correo, expediente = excluded.expediente, domicilio = excluded.domicilio",
            [jid, telLimpio, nombre || 'Nuevo Paciente', correo || '', expediente || '', domicilio || '', Date.now()]
        );
        res.json({ success: true, jid });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/directorio/:jid', autenticarToken, async (req, res) => {
    try {
        const jid = decodeURIComponent(req.params.jid);
        const { nombre, correo, expediente, domicilio } = req.body;
        
        await runQuery(
            "UPDATE contactos SET nombre = ?, correo = ?, expediente = ?, domicilio = ? WHERE jid = ?",
            [nombre, correo || '', expediente || '', domicilio || '', jid]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Lista de Conversaciones Mejorada (Live Chat con Etiquetas y Tiempo Relativo)
app.get('/api/conversaciones', autenticarToken, async (req, res) => {
    try {
        const queryBusqueda = (req.query.q || '').trim();
        let whereClause = '';
        let params = [];

        if (queryBusqueda) {
            whereClause = `WHERE (c.nombre LIKE ? OR c.telefono LIKE ? OR c.jid LIKE ? OR c.pushname LIKE ?)`;
            const likeParam = `%${queryBusqueda}%`;
            params = [likeParam, likeParam, likeParam, likeParam];
        }

        const chats = await allQuery(`
            SELECT c.jid, c.telefono, c.nombre, c.pushname, c.correo, c.expediente, c.domicilio, c.es_ignorado, c.ultimo_contacto,
                   (SELECT CASE 
                        WHEN cuerpo LIKE '/9j/%' OR cuerpo LIKE 'data:image%' THEN '📷 (Imagen / Infografía)'
                        ELSE cuerpo 
                    END FROM mensajes WHERE chat_id = c.jid AND cuerpo NOT LIKE '%e2e_notification%' ORDER BY timestamp DESC, id DESC LIMIT 1) as ultimo_mensaje,
                   (SELECT timestamp FROM mensajes WHERE chat_id = c.jid AND cuerpo NOT LIKE '%e2e_notification%' ORDER BY timestamp DESC, id DESC LIMIT 1) as hora_ultimo_mensaje,
                   (SELECT es_ia FROM mensajes WHERE chat_id = c.jid AND cuerpo NOT LIKE '%e2e_notification%' ORDER BY timestamp DESC, id DESC LIMIT 1) as ultimo_fue_ia
            FROM contactos c
            ${whereClause}
            ORDER BY 
                CASE WHEN (SELECT COUNT(*) FROM mensajes WHERE chat_id = c.jid AND cuerpo NOT LIKE '%e2e_notification%') > 0 THEN 1 ELSE 0 END DESC,
                COALESCE(
                    (SELECT MAX(timestamp) FROM mensajes WHERE chat_id = c.jid AND cuerpo NOT LIKE '%e2e_notification%'),
                    c.ultimo_contacto
                ) DESC
            LIMIT 300
        `, params);

        // Obtener etiquetas asignadas para cada contacto
        const resultado = await Promise.all(chats.map(async (c) => {
            const tags = await allQuery(`
                SELECT e.id, e.nombre, e.color, ce.asignado_en
                FROM etiquetas e
                INNER JOIN contactos_etiquetas ce ON e.id = ce.etiqueta_id
                WHERE ce.jid = ?
            `, [c.jid]);

            const infoTiempo = formatearTiempoRelativo(c.ultimo_contacto || c.hora_ultimo_mensaje);

            return {
                ...c,
                etiquetas_lista: tags || [],
                tiempo_relativo: infoTiempo.texto,
                dias_sin_contacto: infoTiempo.dias,
                meses_sin_contacto: infoTiempo.meses,
                fecha_ultimo_contacto: infoTiempo.fecha
            };
        }));

        res.json(resultado);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ------------------------------------------------------------------------------
// GESTIÓN DE ETIQUETAS / LISTAS DE WHATSAPP (LABELS & CRM TAGS)
// ------------------------------------------------------------------------------
app.get('/api/etiquetas', autenticarToken, async (req, res) => {
    try {
        const etiquetas = await allQuery(`
            SELECT e.*, COUNT(ce.jid) as total_contactos
            FROM etiquetas e
            LEFT JOIN contactos_etiquetas ce ON e.id = ce.etiqueta_id
            GROUP BY e.id
            ORDER BY e.id ASC
        `);
        res.json(etiquetas);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/etiquetas', autenticarToken, async (req, res) => {
    try {
        const { nombre, color } = req.body;
        if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'El nombre de la etiqueta es requerido' });
        await runQuery("INSERT OR IGNORE INTO etiquetas (nombre, color, creado_en) VALUES (?, ?, ?)", [nombre.trim(), color || '#6366f1', Date.now()]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/etiquetas/:id', autenticarToken, async (req, res) => {
    try {
        const { nombre, color } = req.body;
        await runQuery("UPDATE etiquetas SET nombre = ?, color = ? WHERE id = ?", [nombre.trim(), color, req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/etiquetas/:id', autenticarToken, async (req, res) => {
    try {
        await runQuery("DELETE FROM contactos_etiquetas WHERE etiqueta_id = ?", [req.params.id]);
        await runQuery("DELETE FROM reglas_seguimiento WHERE etiqueta_id = ?", [req.params.id]);
        await runQuery("DELETE FROM etiquetas WHERE id = ?", [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Asignar / Desasignar Etiquetas a un Contacto
app.get('/api/contactos/:jid/etiquetas', autenticarToken, async (req, res) => {
    try {
        const jid = decodeURIComponent(req.params.jid);
        const tags = await allQuery(`
            SELECT e.*, ce.asignado_en
            FROM etiquetas e
            INNER JOIN contactos_etiquetas ce ON e.id = ce.etiqueta_id
            WHERE ce.jid = ?
        `, [jid]);
        res.json(tags);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/contactos/:jid/etiquetas', autenticarToken, async (req, res) => {
    try {
        const jid = decodeURIComponent(req.params.jid);
        const { etiqueta_id, accion } = req.body; // accion: 'asignar' o 'quitar'
        if (accion === 'quitar') {
            await runQuery("DELETE FROM contactos_etiquetas WHERE jid = ? AND etiqueta_id = ?", [jid, etiqueta_id]);
        } else {
            await runQuery("INSERT OR REPLACE INTO contactos_etiquetas (jid, etiqueta_id, asignado_en) VALUES (?, ?, ?)", [jid, etiqueta_id, Date.now()]);
        }

        // Sincronización hacia WhatsApp Business en vivo (si la cuenta vinculada es Business)
        if (client && wsClienteConectado) {
            try {
                const etiquetaBD = await getQuery("SELECT nombre FROM etiquetas WHERE id = ?", [etiqueta_id]);
                if (etiquetaBD) {
                    const labelsWA = await client.getLabels();
                    const matchWA = labelsWA.find(l => l.name.toLowerCase() === etiquetaBD.nombre.toLowerCase());
                    if (matchWA && accion === 'asignar') {
                        await client.addOrRemoveLabels([matchWA.id], [jid]);
                    }
                }
            } catch (errWA) {}
        }

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Sincronizar / Importar Etiquetas y Asignaciones desde WhatsApp Business (Extracción Directa)
app.post('/api/etiquetas/sincronizar-whatsapp', autenticarToken, async (req, res) => {
    try {
        if (!client || !wsClienteConectado) {
            return res.status(400).json({ error: 'El bot no está conectado a WhatsApp en este momento. Asegúrate de que el bot esté en verde y conectado.' });
        }

        let dataWA = null;
        try {
            dataWA = await client.pupPage.evaluate(() => {
                let labelsRaw = [];
                try {
                    labelsRaw = window.WWebJS.getLabels();
                } catch(e) {}

                let chatsModels = [];
                try {
                    chatsModels = window.require('WAWebCollections').Chat.getModelsArray();
                } catch(e) {}

                const chatsParsed = [];
                chatsModels.forEach(c => {
                    if (!c) return;
                    const tit = c.formattedTitle || c.name || '';
                    if (c.isGroup && tit.includes('[CONTROL-BOT]')) return; // Solo omitir grupo de control interno

                    const labelIds = (c.labels || []).map(id => String(id));
                    const lastMsg = c.lastMessage;
                    const contact = c.contact;
                    const isLid = c.id && c.id._serialized && c.id._serialized.endsWith('@lid');

                    let uTxt = '';
                    if (lastMsg && (!lastMsg.type || !lastMsg.type.includes('notification'))) {
                        if (lastMsg.body && !lastMsg.body.includes('e2e_notification')) {
                            uTxt = lastMsg.body;
                        } else if (lastMsg.hasMedia) {
                            uTxt = lastMsg.caption ? `📷 ${lastMsg.caption}` : '📷 (Multimedia / Archivo)';
                        }
                    }

                    let tel = '';
                    if (c.isGroup) {
                        tel = 'Grupo';
                    } else if (!isLid && c.id && c.id.user) {
                        tel = c.id.user;
                    } else if (contact && contact.number && !contact.number.startsWith('1660') && contact.number.length <= 13) {
                        tel = contact.number;
                    }

                    let nombreCalculado = tit;
                    if (!nombreCalculado && contact) {
                        nombreCalculado = contact.name || contact.pushname || '';
                    }
                    if (!nombreCalculado) {
                        nombreCalculado = (tel && tel !== 'Grupo') ? `Cliente (+${tel})` : 'Cliente';
                    }

                    chatsParsed.push({
                        jid: c.id ? c.id._serialized : null,
                        telefono: tel,
                        nombre: nombreCalculado,
                        esGrupo: c.isGroup ? 1 : 0,
                        labelIds: labelIds,
                        timestamp: (lastMsg && lastMsg.t && uTxt ? lastMsg.t : 0),
                        ultimoTexto: uTxt,
                        esMio: lastMsg && lastMsg.fromMe ? 1 : 0
                    });
                });

                return {
                    labels: labelsRaw,
                    chats: chatsParsed
                };
            });
        } catch (errEval) {
            return res.status(400).json({ 
                error: 'Error al consultar WhatsApp Web. Asegúrate de que el bot esté conectado a una cuenta de WhatsApp Business. Detalle: ' + errEval.message 
            });
        }

        if (!dataWA || !dataWA.labels || dataWA.labels.length === 0) {
            return res.json({ success: true, message: 'No se encontraron etiquetas creadas en WhatsApp Business.', total_etiquetas: 0, total_asignaciones: 0 });
        }

        // 1. Limpiar etiquetas de prueba/semilla que no correspondan a las de WhatsApp Business
        const nombresWA = dataWA.labels.map(l => l.name.toLowerCase().trim());
        const etiquetasLocales = await allQuery("SELECT id, nombre FROM etiquetas");
        for (const etq of etiquetasLocales) {
            if (!nombresWA.includes(etq.nombre.toLowerCase().trim())) {
                await runQuery("DELETE FROM contactos_etiquetas WHERE etiqueta_id = ?", [etq.id]);
                await runQuery("DELETE FROM etiquetas WHERE id = ?", [etq.id]);
            }
        }

        // 2. Guardar o actualizar etiquetas en la base de datos local
        const mapWALabelToBD = {};
        let importadas = 0;
        let asignacionesTotal = 0;

        for (const l of dataWA.labels) {
            const colorHex = l.hexColor || '#10b981';
            let etiquetaBD = await getQuery("SELECT id FROM etiquetas WHERE LOWER(nombre) = LOWER(?)", [l.name.trim()]);
            if (!etiquetaBD) {
                const r = await runQuery("INSERT INTO etiquetas (nombre, color, creado_en) VALUES (?, ?, ?)", [l.name.trim(), colorHex, Date.now()]);
                etiquetaBD = { id: r.id };
                importadas++;
            } else {
                await runQuery("UPDATE etiquetas SET color = ? WHERE id = ?", [colorHex, etiquetaBD.id]);
            }
            mapWALabelToBD[String(l.id)] = etiquetaBD.id;
        }

        // 3. Procesar chats con sus etiquetas, nombres y fechas reales
        for (const ch of dataWA.chats) {
            if (!ch.jid || (ch.jid.endsWith('@lid') && !ch.ultimoTexto)) continue;
            // Solo considerar tReal si el chat realmente tiene mensajes válidos
            const tReal = (ch.timestamp > 0 && ch.ultimoTexto) ? ch.timestamp * 1000 : 0;
            let nomLimpio = ch.nombre;
            if (!nomLimpio || nomLimpio === 'Cliente' || nomLimpio.toLowerCase().includes('usuario desconocido') || nomLimpio.startsWith('Cliente (+994')) {
                nomLimpio = (ch.telefono && ch.telefono !== 'Grupo' && !ch.telefono.startsWith('1660') && ch.telefono.length <= 13) ? `Cliente (+${ch.telefono})` : 'Cliente';
            }

            await runQuery(`
                INSERT INTO contactos (jid, telefono, nombre, pushname, ultimo_contacto)
                VALUES (?, ?, ?, '', ?)
                ON CONFLICT(jid) DO UPDATE SET
                    telefono = CASE WHEN excluded.telefono != '' THEN excluded.telefono ELSE contactos.telefono END,
                    nombre = CASE WHEN excluded.nombre != 'Cliente' AND excluded.nombre NOT LIKE '%desconocido%' AND excluded.nombre != 'Cliente' AND excluded.nombre != '' THEN excluded.nombre ELSE contactos.nombre END,
                    ultimo_contacto = CASE WHEN ? > 0 THEN ? ELSE contactos.ultimo_contacto END
            `, [ch.jid, ch.telefono, nomLimpio, tReal, tReal, tReal]);

            // Guardar último mensaje para vista previa en el panel si no existe y no es notificación
            if (ch.ultimoTexto && !ch.ultimoTexto.includes('e2e_notification')) {
                const yaMsg = await getQuery("SELECT id FROM mensajes WHERE chat_id = ? LIMIT 1", [ch.jid]);
                if (!yaMsg) {
                    await runQuery(`
                        INSERT INTO mensajes (chat_id, emisor, emisor_nombre, cuerpo, tipo, es_mio, es_ia, timestamp)
                        VALUES (?, ?, ?, ?, 'chat', ?, 0, ?)
                    `, [ch.jid, ch.jid, ch.esMio ? 'Asesor' : nomLimpio, ch.ultimoTexto, ch.esMio, tReal || Date.now()]);
                }
            }

            // Asignar las etiquetas de WhatsApp Business
            if (ch.labelIds && ch.labelIds.length > 0) {
                for (const lid of ch.labelIds) {
                    const bdEtqId = mapWALabelToBD[String(lid)];
                    if (bdEtqId) {
                        await runQuery("INSERT OR REPLACE INTO contactos_etiquetas (jid, etiqueta_id, asignado_en) VALUES (?, ?, ?)", [ch.jid, bdEtqId, tReal || Date.now()]);
                        asignacionesTotal++;
                    }
                }
            }
        }

        res.json({
            success: true,
            message: `¡Sincronización completada! Se importaron ${dataWA.labels.length} etiquetas reales y se vincularon ${asignacionesTotal} clientes con sus nombres y fechas históricas.`,
            total_etiquetas: dataWA.labels.length,
            total_asignaciones: asignacionesTotal
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ------------------------------------------------------------------------------
// MOTOR UNIVERSAL DE SEGUIMIENTOS Y RECORDATORIOS PROGRAMADOS
// ------------------------------------------------------------------------------
app.get('/api/seguimientos/reglas', autenticarToken, async (req, res) => {
    try {
        const reglas = await allQuery(`
            SELECT r.*, e.nombre as etiqueta_nombre, e.color as etiqueta_color
            FROM reglas_seguimiento r
            LEFT JOIN etiquetas e ON r.etiqueta_id = e.id
            ORDER BY r.id ASC
        `);
        res.json(reglas);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/seguimientos/reglas', autenticarToken, async (req, res) => {
    try {
        const { nombre, etiqueta_id, dias_espera, mensaje_plantilla, hora_envio, activo, modo_envio } = req.body;
        if (!nombre || !mensaje_plantilla) return res.status(400).json({ error: 'Nombre y mensaje de plantilla requeridos' });

        await runQuery(`
            INSERT INTO reglas_seguimiento (nombre, etiqueta_id, dias_espera, mensaje_plantilla, hora_envio, activo, modo_envio, creado_en)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [nombre.trim(), etiqueta_id || null, parseInt(dias_espera, 10) || 90, mensaje_plantilla.trim(), hora_envio || '10:30', activo !== undefined ? activo : 1, modo_envio || 'automatico', Date.now()]);

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/seguimientos/reglas/:id', autenticarToken, async (req, res) => {
    try {
        const { nombre, etiqueta_id, dias_espera, mensaje_plantilla, hora_envio, activo, modo_envio } = req.body;
        await runQuery(`
            UPDATE reglas_seguimiento SET
                nombre = ?, etiqueta_id = ?, dias_espera = ?, mensaje_plantilla = ?, hora_envio = ?, activo = ?, modo_envio = ?
            WHERE id = ?
        `, [nombre.trim(), etiqueta_id || null, parseInt(dias_espera, 10) || 90, mensaje_plantilla.trim(), hora_envio || '10:30', activo !== undefined ? activo : 1, modo_envio || 'automatico', req.params.id]);

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/seguimientos/reglas/:id', autenticarToken, async (req, res) => {
    try {
        await runQuery("DELETE FROM reglas_seguimiento WHERE id = ?", [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Bandeja de clientes/Clientes con Seguimiento Pendiente o Próximo
app.get('/api/seguimientos/pendientes', autenticarToken, async (req, res) => {
    try {
        const reglas = await allQuery("SELECT * FROM reglas_seguimiento WHERE activo = 1");
        const nombreNegocio = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'nombre_negocio'"))?.valor || 'nuestro negocio';
        const listaPendientes = [];

        for (const r of reglas) {
            let contactosCandidatos = [];
            if (r.etiqueta_id) {
                contactosCandidatos = await allQuery(`
                    SELECT c.jid, c.telefono, c.nombre, c.pushname, c.ultimo_contacto, ce.asignado_en
                    FROM contactos c
                    INNER JOIN contactos_etiquetas ce ON c.jid = ce.jid
                    WHERE ce.etiqueta_id = ? AND c.es_ignorado = 0
                `, [r.etiqueta_id]);
            } else {
                contactosCandidatos = await allQuery(`
                    SELECT jid, telefono, nombre, pushname, ultimo_contacto, ultimo_contacto as asignado_en
                    FROM contactos
                    WHERE es_ignorado = 0
                `);
            }

            for (const c of contactosCandidatos) {
                const fechaBase = c.asignado_en || c.ultimo_contacto || Date.now();
                const difDias = Math.floor((Date.now() - fechaBase) / (1000 * 60 * 60 * 24));

                // Verificar si ya se envió este seguimiento
                const yaEnviado = await getQuery("SELECT id, fecha_enviado FROM historial_seguimientos WHERE jid = ? AND regla_id = ? AND estado = 'enviado'", [c.jid, r.id]);

                const nombreLimpio = c.nombre || c.pushname || 'Estimado(a)';
                const mensajePersonalizado = r.mensaje_plantilla
                    .replace(/{nombre}/gi, nombreLimpio)
                    .replace(/{negocio}/gi, nombreNegocio)
                    .replace(/{dias}/gi, r.dias_espera);

                if (!yaEnviado && difDias >= r.dias_espera) {
                    listaPendientes.push({
                        jid: c.jid,
                        telefono: c.telefono,
                        nombre: nombreLimpio,
                        regla_id: r.id,
                        regla_nombre: r.nombre,
                        dias_espera_regla: r.dias_espera,
                        dias_transcurridos: difDias,
                        mensaje_preparado: mensajePersonalizado,
                        modo_envio: r.modo_envio,
                        estado: 'listo_para_enviar'
                    });
                }
            }
        }

        res.json(listaPendientes);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Enviar Seguimiento Manualmente con 1 Clic
app.post('/api/seguimientos/enviar', autenticarToken, async (req, res) => {
    try {
        const { jid, regla_id, mensaje } = req.body;
        if (!jid || !mensaje || !client) return res.status(400).json({ error: 'Faltan parámetros o WhatsApp no está conectado' });

        const contacto = await getQuery("SELECT nombre, pushname, telefono FROM contactos WHERE jid = ?", [jid]);
        const nombreCliente = contacto?.nombre || contacto?.pushname || 'Cliente';

        await client.sendMessage(jid, mensaje);

        // Registrar en historial de seguimientos y en mensajes
        await runQuery(`
            INSERT INTO historial_seguimientos (jid, regla_id, telefono, nombre, mensaje_enviado, fecha_programada, fecha_enviado, timestamp, estado)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'enviado')
        `, [jid, regla_id || null, contacto?.telefono || jid, nombreCliente, mensaje, new Date().toISOString(), new Date().toLocaleDateString('es-MX'), Date.now()]);

        await runQuery(
            "INSERT INTO mensajes (chat_id, emisor, emisor_nombre, cuerpo, es_mio, es_ia, timestamp) VALUES (?, ?, ?, ?, 1, 1, ?)",
            [jid, 'bot', 'Seguimiento Automático', mensaje, Date.now()]
        );

        io.emit('nuevo_mensaje', {
            chat_id: jid,
            emisor: 'bot',
            emisor_nombre: 'Seguimiento Automático',
            cuerpo: mensaje,
            es_mio: 1,
            es_ia: 1,
            timestamp: Date.now()
        });

        res.json({ success: true, message: 'Recordatorio de seguimiento enviado con éxito' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Mensajes de un Chat específico (con sincronización en vivo de WhatsApp y unificación de LID y teléfono)
app.get('/api/conversaciones/:jid/mensajes', autenticarToken, async (req, res) => {
    try {
        const { jid } = req.params;
        let contacto = await getQuery("SELECT * FROM contactos WHERE jid = ?", [jid]);
        let telLimpio = contacto?.telefono || jid.replace(/[^0-9]/g, '');

        let waChat = null;
        // Sincronizar mensajes recientes de WhatsApp Web para reflejar lo que envías desde el celular oficial
        if (client && wsClienteConectado) {
            try {
                // 1. Intentar obtener el chat directamente por JID
                try {
                    waChat = await client.getChatById(jid);
                } catch(e1) {}

                // 2. Si no se encontró (muy común con identificadores @lid), buscar vía contacto de WhatsApp
                if (!waChat) {
                    try {
                        const waContact = await client.getContactById(jid);
                        if (waContact) {
                            waChat = await waContact.getChat().catch(() => null);
                            if (waContact.number && !waContact.number.startsWith('1660')) {
                                telLimpio = waContact.number;
                                await runQuery("UPDATE contactos SET telefono = ? WHERE jid = ?", [telLimpio, jid]);
                                if (contacto) contacto.telefono = telLimpio;
                            }
                        }
                    } catch(e2) {}
                }

                // 3. Si aún no se encontró y tenemos teléfono limpio válido
                if (!waChat && telLimpio && telLimpio.length >= 10 && !telLimpio.startsWith('1660')) {
                    try {
                        waChat = await client.getChatById(`${telLimpio}@c.us`).catch(() => null);
                    } catch(e3) {}
                }

                // 4. Si aún no se encontró, buscar en los chats en memoria por coincidencia de nombre o número
                if (!waChat) {
                    try {
                        const todos = await client.getChats();
                        waChat = todos.find(c => {
                            if (c.id?._serialized === jid) return true;
                            if (contacto?.nombre && c.name && c.name.toLowerCase() === contacto.nombre.toLowerCase()) return true;
                            if (telLimpio && telLimpio.length >= 8 && !telLimpio.startsWith('1660')) {
                                const cNum = (c.id?.user || '').replace(/[^0-9]/g, '');
                                return cNum.endsWith(telLimpio.slice(-8)) || telLimpio.endsWith(cNum.slice(-8));
                            }
                            return false;
                        });
                    } catch(e4) {}
                }

                // Si encontramos el chat en WhatsApp Web, traer los últimos 60 mensajes
                let rawMsgs = [];
                if (waChat) {
                    try {
                        rawMsgs = await waChat.fetchMessages({ limit: 60 });
                    } catch(eFetch) {
                        console.warn("waChat.fetchMessages falló, intentando extracción directa:", eFetch.message);
                    }
                }

                // Si rawMsgs está vacío o falló, extraer directamente desde Puppeteer en la memoria de WhatsApp Web
                if ((!rawMsgs || rawMsgs.length === 0) && client.pupPage) {
                    try {
                        const ultimos8 = (telLimpio && !telLimpio.startsWith('1660') && telLimpio.length >= 8) ? telLimpio.slice(-8) : '';
                        const extraidos = await client.pupPage.evaluate((targetJid, u8) => {
                            try {
                                const collections = window.require ? window.require('WAWebCollections') : null;
                                if (!collections) return [];
                                const MsgCol = collections.Msg;
                                const ChatCol = collections.Chat;
                                const WidFactory = window.require('WAWebWidFactory');

                                let chat = null;
                                if (WidFactory && ChatCol) {
                                    try { chat = ChatCol.get(WidFactory.createWid(targetJid)); } catch(e) {}
                                }
                                if (!chat && ChatCol) {
                                    const all = ChatCol.getModelsArray ? ChatCol.getModelsArray() : (ChatCol.models || []);
                                    chat = all.find(c => {
                                        const idStr = c.id?._serialized || '';
                                        return idStr === targetJid || (u8 && idStr.includes(u8));
                                    });
                                }

                                let msgs = [];
                                if (chat && chat.msgs) {
                                    msgs = chat.msgs.getModelsArray ? chat.msgs.getModelsArray() : (chat.msgs.models || []);
                                }
                                if ((!msgs || msgs.length === 0) && MsgCol) {
                                    const all = MsgCol.getModelsArray ? MsgCol.getModelsArray() : (MsgCol.models || []);
                                    msgs = all.filter(m => {
                                        const rem = m.id?.remote?._serialized || m.id?.remote || '';
                                        return rem === targetJid || (u8 && rem.includes(u8));
                                    });
                                }

                                return (msgs || []).slice(-60).map(m => ({
                                    fromMe: !!(m.id?.fromMe || m.fromMe),
                                    from: m.from?._serialized || m.from || '',
                                    body: m.body || m.caption || (m.hasMedia ? '📷 (Archivo multimedia)' : ''),
                                    type: m.type || 'chat',
                                    timestamp: m.t || Math.floor(Date.now() / 1000)
                                }));
                            } catch(err) {
                                return [];
                            }
                        }, jid, ultimos8);
                        if (Array.isArray(extraidos) && extraidos.length > 0) {
                            rawMsgs = extraidos;
                        }
                    } catch(ePup) {}
                }

                if (rawMsgs && rawMsgs.length > 0) {
                    const ultimos8 = (telLimpio && !telLimpio.startsWith('1660') && telLimpio.length >= 8) ? telLimpio.slice(-8) : '';
                    const chatVinculado = waChat?.id?._serialized || jid;

                    for (const m of rawMsgs) {
                        const esMio = m.fromMe ? 1 : 0;
                        const timestampMs = (m.timestamp || Math.floor(Date.now() / 1000)) * 1000;
                        let cuerpoTxt = m.body || (m.hasMedia ? '📷 (Infografía / Imagen enviada)' : (m.type === 'chat' ? '' : `💬 (${m.type || 'Mensaje'})`));

                        if (!cuerpoTxt || cuerpoTxt.includes('e2e_notification')) continue;

                        if (cuerpoTxt.startsWith('/9j/') || cuerpoTxt.startsWith('data:image') || (cuerpoTxt.length > 200 && !cuerpoTxt.includes(' '))) {
                            cuerpoTxt = '📷 (Infografía / Imagen enviada)';
                        }

                        const esMensajeIA = esMio === 1 && (
                            cuerpoTxt.startsWith('🤖') ||
                            cuerpoTxt.startsWith('👨‍⚕️') ||
                            cuerpoTxt.startsWith('🏥') ||
                            cuerpoTxt.startsWith('🎓') ||
                            cuerpoTxt.startsWith('🌴')
                        );

                        const emisorNombre = esMio ? (esMensajeIA ? 'Asistente IA' : 'Asesor Humano') : (waChat?.name || waChat?.formattedTitle || contacto?.nombre || 'Cliente');

                        // Deduplicar estrictamente por contenido del texto y emisor dentro de un rango de tiempo
                        const yaExiste = await getQuery(`
                            SELECT id, es_ia, emisor_nombre FROM mensajes 
                            WHERE (chat_id = ? OR chat_id = ? OR (? != '' AND chat_id LIKE ?))
                              AND cuerpo = ?
                              AND es_mio = ?
                              AND ABS(timestamp - ?) <= 25000
                        `, [
                            jid,
                            chatVinculado,
                            ultimos8,
                            `%${ultimos8}%`,
                            cuerpoTxt,
                            esMio,
                            timestampMs
                        ]);

                        if (yaExiste) {
                            if (esMensajeIA && (yaExiste.es_ia === 0 || yaExiste.emisor_nombre === 'Asesor Humano')) {
                                await runQuery("UPDATE mensajes SET es_ia = 1, emisor_nombre = 'Asistente IA', emisor = 'bot' WHERE id = ?", [yaExiste.id]);
                            }
                        } else {
                            await runQuery(`
                                INSERT INTO mensajes (chat_id, emisor, emisor_nombre, cuerpo, tipo, es_mio, es_ia, timestamp)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                            `, [jid, esMio ? (esMensajeIA ? 'bot' : 'yo') : (m.from || jid), emisorNombre, cuerpoTxt, m.type || 'chat', esMio, esMensajeIA ? 1 : 0, timestampMs]);
                        }
                    }

                        // Actualizar nombre si aún no estaba personalizado
                        if (contacto && (contacto.nombre === 'Cliente' || !contacto.nombre || contacto.nombre.toLowerCase().includes('usuario desconocido'))) {
                            let nomActualizado = waChat.name || waChat.formattedTitle;
                            try {
                                const cInfo = await waChat.getContact();
                                if (cInfo) nomActualizado = cInfo.name || cInfo.pushname || nomActualizado;
                            } catch(e) {}
                            if (nomActualizado && nomActualizado !== 'Cliente' && !nomActualizado.toLowerCase().includes('usuario desconocido')) {
                                await runQuery("UPDATE contactos SET nombre = ? WHERE jid = ?", [nomActualizado, jid]);
                                contacto.nombre = nomActualizado;
                            }
                        }
                    }
            } catch (errFetch) {
                console.error("Error sincronizando mensajes de WhatsApp:", errFetch.message);
            }
        }

        // Obtener mensajes unificando por JID, chat vinculado y últimos 8 dígitos del teléfono
        const ultimos8 = (telLimpio && !telLimpio.startsWith('1660') && telLimpio.length >= 8) ? telLimpio.slice(-8) : '';
        const chatVinculado = waChat?.id?._serialized || jid;

        const todosMensajesRaw = await allQuery(`
            SELECT * FROM mensajes 
            WHERE (chat_id = ? OR chat_id = ? OR (? != '' AND chat_id LIKE ?))
              AND cuerpo NOT LIKE '%e2e_notification%'
            ORDER BY timestamp DESC, id DESC 
            LIMIT 250
        `, [jid, chatVinculado, ultimos8, `%${ultimos8}%`]);
        
        const todosMensajes = todosMensajesRaw.reverse();

        // Deduplicar mensajes en memoria y normalizar multimedia/infografías
        const mensajes = [];
        const vistos = new Set();
        for (const m of todosMensajes) {
            let cuerpoNormalizado = (m.cuerpo || '').trim();
            if (cuerpoNormalizado.startsWith('/9j/') || cuerpoNormalizado.startsWith('data:image') || (cuerpoNormalizado.length > 200 && !cuerpoNormalizado.includes(' '))) {
                cuerpoNormalizado = '📷 (Infografía / Imagen enviada)';
                m.cuerpo = cuerpoNormalizado;
            } else if (cuerpoNormalizado === '📷 (Multimedia enviado desde teléfono)' || cuerpoNormalizado === '📷 (Archivo multimedia)') {
                cuerpoNormalizado = '📷 (Infografía / Imagen enviada)';
                m.cuerpo = cuerpoNormalizado;
            }

            const key = `${m.es_mio}_${cuerpoNormalizado}_${Math.round(m.timestamp / 10000)}`;
            if (!vistos.has(key)) {
                vistos.add(key);
                mensajes.push(m);
            }
        }

        const pedido = await getQuery("SELECT * FROM pedidos_cotizaciones WHERE cliente_telefono LIKE ? ORDER BY id DESC LIMIT 1", [`%${telLimpio}%`]);
        res.json({ contacto, mensajes, pedido });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Enviar Mensaje desde el Panel Web (Intervención Humana)
app.post('/api/conversaciones/:jid/enviar', autenticarToken, async (req, res) => {
    try {
        const { jid } = req.params;
        const { texto } = req.body;
        if (!texto || !client) return res.status(400).json({ error: 'Mensaje vacío o bot desconectado' });

        const sent = await client.sendMessage(jid, texto);
        if (sent && sent.id) idsMensajesEnviadosBot.add(sent.id._serialized);

        // Guardar mensaje en base de datos
        await runQuery(
            "INSERT INTO mensajes (chat_id, emisor, emisor_nombre, cuerpo, es_mio, es_ia, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [jid, 'yo', 'Asesor Humano', texto, 1, 0, Date.now()]
        );

        // Pausar automáticamente el bot en este chat por 30 minutos
        chatsPausados.set(jid, Date.now());

        // Si el cliente tenía una solicitud de asesor pendiente, marcarla como atendida
        const telClean = jid.replace(/[^0-9]/g, '');
        await runQuery("UPDATE solicitudes_asesor SET estado = 'atendido' WHERE (jid = ? OR telefono LIKE ?) AND estado = 'pendiente'", [jid, `%${telClean}%`]);
        io.emit('solicitud_asesor_actualizada');

        io.emit('nuevo_mensaje', {
            chat_id: jid,
            emisor: 'yo',
            emisor_nombre: 'Asesor Humano',
            cuerpo: texto,
            es_mio: 1,
            es_ia: 0,
            timestamp: Date.now()
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Reanudar Bot en un chat específico (Quitar pausa de asesor humano y volver a IA)
app.post('/api/conversaciones/:jid/reactivar', autenticarToken, async (req, res) => {
    try {
        const jid = decodeURIComponent(req.params.jid);
        chatsPausados.delete(jid);

        // Limpiar también jids y teléfonos asociados
        const telClean = jid.replace(/[^0-9]/g, '');
        for (const [pJid] of chatsPausados.entries()) {
            if ((telClean.length >= 8 && pJid.includes(telClean)) || jid.includes(pJid.replace(/[^0-9]/g, ''))) {
                chatsPausados.delete(pJid);
            }
        }

        io.emit('chat_reactivado', { jid });
        console.log(`🤖 [BOT REANUDADO] El bot volverá a responder con IA en el chat ${jid}`);
        res.json({ success: true, message: 'Bot reanudado para este cliente exitosamente' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Enviar Infografía o Imagen desde el Panel Web por WhatsApp
app.post('/api/conversaciones/:jid/enviar-imagen', autenticarToken, uploadImagen.single('imagen'), async (req, res) => {
    try {
        const jid = decodeURIComponent(req.params.jid);
        const { nombre_imagen, caption } = req.body;
        let rutaArchivo = null;

        if (req.file) {
            rutaArchivo = req.file.path;
        } else if (nombre_imagen) {
            const ruta = path.join(DIR_IMAGENES, path.basename(nombre_imagen));
            if (fs.existsSync(ruta)) {
                rutaArchivo = ruta;
            }
        }

        if (!rutaArchivo || !fs.existsSync(rutaArchivo)) {
            return res.status(400).json({ error: 'No se encontró la imagen especificada para enviar' });
        }

        if (!client || !wsClienteConectado) {
            return res.status(400).json({ error: 'El bot no está conectado a WhatsApp en este momento' });
        }

        const media = MessageMedia.fromFilePath(rutaArchivo);
        const options = {};
        if (caption && caption.trim()) {
            options.caption = caption.trim();
        }

        const sent = await client.sendMessage(jid, media, options);
        if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);

        const textoGuardar = caption && caption.trim() ? `📷 ${caption.trim()}` : '📷 (Infografía / Imagen enviada)';
        const tsMs = Date.now();

        await runQuery(
            "INSERT INTO mensajes (chat_id, emisor, emisor_nombre, cuerpo, tipo, es_mio, es_ia, timestamp) VALUES (?, 'yo', 'Asesor Humano', ?, 'image', 1, 0, ?)",
            [jid, textoGuardar, tsMs]
        );

        await runQuery("UPDATE contactos SET ultimo_contacto = ? WHERE jid = ?", [tsMs, jid]);

        // Pausar automáticamente el bot en este chat por 30 minutos
        chatsPausados.set(jid, tsMs);

        // Si el cliente tenía una solicitud de asesor pendiente, marcarla como atendida
        const telClean = jid.replace(/[^0-9]/g, '');
        await runQuery("UPDATE solicitudes_asesor SET estado = 'atendido' WHERE (jid = ? OR telefono LIKE ?) AND estado = 'pendiente'", [jid, `%${telClean}%`]);
        io.emit('solicitud_asesor_actualizada');

        io.emit('nuevo_mensaje', {
            chat_id: jid,
            emisor: 'yo',
            emisor_nombre: 'Asesor Humano',
            cuerpo: textoGuardar,
            tipo: 'image',
            es_mio: 1,
            es_ia: 0,
            timestamp: tsMs
        });

        res.json({ success: true, message: 'Imagen enviada exitosamente por WhatsApp' });
    } catch (e) {
        console.error("Error al enviar imagen por WhatsApp:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// Obtener lista de respuestas rápidas predeterminadas
app.get('/api/respuestas-rapidas', autenticarToken, async (req, res) => {
    try {
        const respuestas = await allQuery("SELECT * FROM respuestas_rapidas ORDER BY id ASC");
        res.json(respuestas);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Guardar o editar respuesta rápida
app.post('/api/respuestas-rapidas', autenticarToken, async (req, res) => {
    try {
        const { id, atajo, titulo, contenido } = req.body;
        if (!titulo || !contenido) return res.status(400).json({ error: 'Título y contenido son obligatorios' });

        if (id) {
            await runQuery("UPDATE respuestas_rapidas SET atajo = ?, titulo = ?, contenido = ? WHERE id = ?", [atajo || '', titulo, contenido, id]);
        } else {
            await runQuery("INSERT INTO respuestas_rapidas (atajo, titulo, contenido) VALUES (?, ?, ?)", [atajo || '', titulo, contenido]);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Eliminar respuesta rápida
app.delete('/api/respuestas-rapidas/:id', autenticarToken, async (req, res) => {
    try {
        await runQuery("DELETE FROM respuestas_rapidas WHERE id = ?", [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Obtener enlaces rápidos del sistema y formularios personalizables
app.get('/api/enlaces-rapidos', autenticarToken, async (req, res) => {
    try {
        const enlaces = await allQuery("SELECT * FROM enlaces_rapidos ORDER BY orden ASC, id ASC");
        res.json(enlaces);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Guardar o editar enlace rápido o formulario
app.post('/api/enlaces-rapidos', autenticarToken, async (req, res) => {
    try {
        const { id, titulo, descripcion, url, icono, color } = req.body;
        if (!titulo || !url) return res.status(400).json({ error: 'Título y URL son obligatorios' });

        if (id) {
            await runQuery(
                "UPDATE enlaces_rapidos SET titulo = ?, descripcion = ?, url = ?, icono = ?, color = ? WHERE id = ?",
                [titulo.trim(), (descripcion || '').trim(), url.trim(), icono || 'fa-link', color || 'text-indigo-400', id]
            );
        } else {
            const maxOrd = (await getQuery("SELECT MAX(orden) as max_ord FROM enlaces_rapidos"))?.max_ord || 0;
            await runQuery(
                "INSERT INTO enlaces_rapidos (titulo, descripcion, url, icono, color, orden) VALUES (?, ?, ?, ?, ?, ?)",
                [titulo.trim(), (descripcion || '').trim(), url.trim(), icono || 'fa-link', color || 'text-indigo-400', maxOrd + 1]
            );
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Eliminar enlace rápido
app.delete('/api/enlaces-rapidos/:id', autenticarToken, async (req, res) => {
    try {
        await runQuery("DELETE FROM enlaces_rapidos WHERE id = ?", [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// CRM: Pedidos y Cotizaciones
app.get('/api/pedidos', autenticarToken, async (req, res) => {
    try {
        const pedidos = await allQuery("SELECT * FROM pedidos_cotizaciones ORDER BY id DESC LIMIT 100");
        res.json(pedidos);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/pedidos', autenticarToken, async (req, res) => {
    try {
        const { cliente_telefono, cliente_nombre, producto_servicio, valor, estado, notas } = req.body;
        const result = await runQuery(
            "INSERT INTO pedidos_cotizaciones (cliente_telefono, cliente_nombre, producto_servicio, valor, estado, notas, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [cliente_telefono, cliente_nombre, producto_servicio, valor || 0, estado || 'Nuevo', notas || '', Date.now()]
        );
        res.json({ id: result.id, success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.patch('/api/pedidos/:id/estado', autenticarToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { estado } = req.body;
        await runQuery("UPDATE pedidos_cotizaciones SET estado = ? WHERE id = ?", [estado, id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Agenda de Citas y Google Calendar
app.get('/api/citas', autenticarToken, async (req, res) => {
    try {
        const citas = await allQuery("SELECT * FROM citas_agenda WHERE estado != 'Cancelada' ORDER BY fecha DESC, hora ASC LIMIT 150");
        res.json(citas);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// Endpoint para purgar citas borradas en Google Calendar
app.post('/api/citas/sincronizar-google', autenticarToken, async (req, res) => {
    try {
        const calIdConfig = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_calendar_id'"))?.valor;
        const credsConfig = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_service_account_json'"))?.valor;
        if (!calIdConfig || !credsConfig) return res.status(400).json({ error: 'Faltan credenciales de Google Calendar.' });

        // Traer todas las citas futuras activas que tengan un eventId
        const hoyIso = new Date().toISOString().split('T')[0];
        const citasActivas = await allQuery("SELECT * FROM citas_agenda WHERE estado != 'Cancelada' AND google_event_id IS NOT NULL AND google_event_id != '' AND fecha >= ?", [hoyIso]);
        
        if (citasActivas.length === 0) return res.json({ success: true, canceladas: 0 });

        const eventIds = citasActivas.map(c => c.google_event_id);
        const estados = await calendarService.verificarEstadoEventos(calIdConfig, credsConfig, eventIds);

        let canceladasCont = 0;
        for (const cita of citasActivas) {
            if (estados[cita.google_event_id] === 'cancelled') {
                await runQuery("UPDATE citas_agenda SET estado = 'Cancelada' WHERE id = ?", [cita.id]);
                canceladasCont++;
            }
        }
        res.json({ success: true, canceladas: canceladasCont });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/citas', autenticarToken, async (req, res) => {
    try {
        const { cliente_telefono, cliente_nombre, fecha, hora, servicio, estado, notas, duracion, origen_jid } = req.body;
        
        let googleEventId = '';
        let googleCalendarId = '';
        let linkEvento = '';

        // Verificar si el módulo de Google Calendar está encendido
        const moduloActivo = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'modulo_agenda_activo'"))?.valor === '1';
        const calIdConfig = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_calendar_id'"))?.valor;
        const credsConfig = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_service_account_json'"))?.valor;
        let duracionCita = parseInt(duracion) || parseInt((await getQuery("SELECT valor FROM configuracion WHERE clave = 'agenda_duracion_cita'"))?.valor) || 30;
        
        // Logica personalizada de duración
        const servicioNorm = (servicio || '').toLowerCase();
        if (!duracion && (servicioNorm.includes('vasectom') || servicioNorm.includes('embarazo'))) {
            duracionCita = 60;
        }

        const [hIni, mIni] = (hora || '10:00').split(':').map(Number);
        const totalMinFin = hIni * 60 + mIni + duracionCita;
        const pad = (num) => String(num).padStart(2, '0');
        let horaFin = `${pad(Math.floor(totalMinFin / 60))}:${pad(totalMinFin % 60)}`;

        const timezone = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'timezone'"))?.valor || 'America/Mexico_City';

        if (moduloActivo && calIdConfig && credsConfig) {
            try {
                const resGoogle = await calendarService.crearCita({
                    calendarId: calIdConfig,
                    credentials: credsConfig,
                    nombre: cliente_nombre || 'Cliente',
                    telefono: cliente_telefono || '',
                    fecha,
                    hora,
                    duracionMinutos: isNaN(parseInt(duracionCita)) ? 30 : parseInt(duracionCita),
                    servicio: servicio || 'Consulta General',
                    notas: notas || '',
                    timezone
                });
                if (resGoogle.success) {
                    googleEventId = resGoogle.eventId;
                    googleCalendarId = calIdConfig;
                    horaFin = resGoogle.horaFin;
                    linkEvento = resGoogle.htmlLink || '';
                }
            } catch (errG) {
                console.warn("⚠️ No se pudo sincronizar cita con Google Calendar:", errG.message);
            }
        }

        const result = await runQuery(
            `INSERT INTO citas_agenda (
                cliente_telefono, cliente_nombre, fecha, hora, servicio, estado, notas,
                google_event_id, google_calendar_id, hora_fin, origen, link_evento, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'panel', ?, ?)`,
            [
                cliente_telefono, cliente_nombre, fecha, hora, servicio, estado || 'Confirmada', notas || '',
                googleEventId, googleCalendarId, horaFin, linkEvento, Date.now()
            ]
        );

        if (origen_jid && cliente_telefono) {
            await runQuery("UPDATE contactos SET telefono = ?, nombre = ? WHERE jid = ?", [cliente_telefono.replace(/[^0-9]/g, ''), cliente_nombre, origen_jid]);
        }

        io.emit('cita_actualizada');
        res.json({ id: result.id, success: true, googleEventId, linkEvento });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Cancelar cita en SQLite y Google Calendar
app.put('/api/citas/:id', autenticarToken, async (req, res) => {
    try {
        const idCita = req.params.id;
        const { fecha, hora, duracion, servicio, notas } = req.body;
        const citaVieja = await getQuery("SELECT * FROM citas_agenda WHERE id = ?", [idCita]);
        if (!citaVieja) return res.status(404).json({ error: "Cita no encontrada" });

        const calIdConfig = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_calendar_id'"))?.valor;
        const credsConfig = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_service_account_json'"))?.valor;
        const moduloActivo = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'modulo_agenda_activo'"))?.valor === '1';

        // 1. Cancelar evento anterior si existe
        if (citaVieja.google_event_id && citaVieja.google_calendar_id && credsConfig) {
            try {
                await calendarService.cancelarCita({
                    calendarId: citaVieja.google_calendar_id,
                    credentials: credsConfig,
                    eventId: citaVieja.google_event_id
                });
            } catch (e) {
                console.warn("Aviso: No se pudo cancelar evento anterior en Google", e.message);
            }
        }

        // 2. Calcular nueva duración
        let duracionCita = parseInt(duracion);
        if (!duracionCita) {
            const servicioNorm = (servicio || citaVieja.servicio || '').toLowerCase();
            duracionCita = (servicioNorm.includes('vasectom') || servicioNorm.includes('embarazo')) ? 60 : parseInt((await getQuery("SELECT valor FROM configuracion WHERE clave = 'agenda_duracion_cita'"))?.valor) || 30;
        }

        const [hIni, mIni] = (hora || citaVieja.hora || '10:00').split(':').map(Number);
        const totalMinFin = hIni * 60 + mIni + duracionCita;
        const pad = (num) => String(num).padStart(2, '0');
        let nuevaHoraFin = `${pad(Math.floor(totalMinFin / 60))}:${pad(totalMinFin % 60)}`;

        let nuevoEvId = '';
        let nuevoLink = '';
        const timezone = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'timezone'"))?.valor || 'America/Mexico_City';

        // 3. Crear nuevo evento
        if (moduloActivo && calIdConfig && credsConfig) {
            const resGoogle = await calendarService.crearCita({
                calendarId: calIdConfig,
                credentials: credsConfig,
                fecha: fecha || citaVieja.fecha,
                hora: hora || citaVieja.hora,
                duracionMinutos: duracionCita,
                nombre: citaVieja.cliente_nombre,
                telefono: citaVieja.cliente_telefono,
                servicio: servicio || citaVieja.servicio,
                notas: notas !== undefined ? notas : citaVieja.notas,
                timezone
            });
            if (resGoogle.success) {
                nuevoEvId = resGoogle.eventId;
                nuevaHoraFin = resGoogle.horaFin;
                nuevoLink = resGoogle.link;
            }
        }

        await runQuery(
            `UPDATE citas_agenda SET 
             fecha = ?, hora = ?, servicio = ?, notas = ?, 
             google_event_id = ?, google_calendar_id = ?, hora_fin = ?, link_evento = ?
             WHERE id = ?`,
            [
                fecha || citaVieja.fecha, 
                hora || citaVieja.hora, 
                servicio || citaVieja.servicio, 
                notas !== undefined ? notas : citaVieja.notas, 
                nuevoEvId || '', 
                calIdConfig || '', 
                nuevaHoraFin, 
                nuevoLink || '', 
                idCita
            ]
        );

        io.emit('cita_actualizada');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/citas/:id', autenticarToken, async (req, res) => {
    try {
        const idCita = req.params.id;
        const cita = await getQuery("SELECT * FROM citas_agenda WHERE id = ?", [idCita]);
        if (!cita) {
            return res.status(404).json({ error: "Cita no encontrada" });
        }

        // Si tiene evento vinculado en Google Calendar, eliminarlo
        if (cita.google_event_id && cita.google_calendar_id) {
            const credsConfig = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_service_account_json'"))?.valor;
            if (credsConfig) {
                try {
                    await calendarService.cancelarCita({
                        calendarId: cita.google_calendar_id,
                        credentials: credsConfig,
                        eventId: cita.google_event_id
                    });
                } catch (eCal) {
                    console.warn("Aviso al cancelar evento en Google Calendar:", eCal.message);
                }
            }
        }

        await runQuery("UPDATE citas_agenda SET estado = 'Cancelada' WHERE id = ?", [idCita]);
        io.emit('cita_actualizada');
        res.json({ success: true, message: "Cita cancelada con éxito" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Diagnóstico y prueba en vivo de conexión con Google Calendar
app.post('/api/agenda/probar-conexion', autenticarToken, async (req, res) => {
    try {
        let { calendarId, credentials } = req.body;
        if (!calendarId) {
            calendarId = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_calendar_id'"))?.valor;
        }
        if (!credentials) {
            credentials = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_service_account_json'"))?.valor;
        }

        if (!calendarId || !credentials) {
            return res.status(400).json({
                success: false,
                error: "Por favor proporciona el Calendar ID y las credenciales JSON de la cuenta de servicio."
            });
        }

        const resultado = await calendarService.verificarConexion(calendarId, credentials);
        res.json(resultado);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Consultar disponibilidad de horarios para una fecha
app.get('/api/agenda/disponibilidad', autenticarToken, async (req, res) => {
    try {
        const { fecha } = req.query;
        if (!fecha) return res.status(400).json({ error: "El parámetro fecha (YYYY-MM-DD) es requerido" });

        const calIdConfig = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_calendar_id'"))?.valor;
        const credsConfig = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_service_account_json'"))?.valor;
        const duracionCita = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'agenda_duracion_cita'"))?.valor || 30;
        const bufferMinutos = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'agenda_buffer_minutos'"))?.valor || 10;
        const timezone = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'timezone'"))?.valor || 'America/Mexico_City';

        const turno1_inicio = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'agenda_turno1_inicio'"))?.valor || (await getQuery("SELECT valor FROM configuracion WHERE clave = 'hora_inicio_semana'"))?.valor || '14:00';
        const turno1_fin = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'agenda_turno1_fin'"))?.valor || '17:00';
        const turno2_activo = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'agenda_turno2_activo'"))?.valor === '1';
        const turno2_inicio = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'agenda_turno2_inicio'"))?.valor || '18:00';
        const turno2_fin = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'agenda_turno2_fin'"))?.valor || (await getQuery("SELECT valor FROM configuracion WHERE clave = 'hora_fin_semana'"))?.valor || '20:00';
        const sabado_activo = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'agenda_sabado_activo'"))?.valor !== '0';
        const sabado_inicio = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'agenda_sabado_inicio'"))?.valor || (await getQuery("SELECT valor FROM configuracion WHERE clave = 'hora_inicio_sab'"))?.valor || '09:00';
        const sabado_fin = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'agenda_sabado_fin'"))?.valor || (await getQuery("SELECT valor FROM configuracion WHERE clave = 'hora_fin_sab'"))?.valor || '14:00';
        const domingo_activo = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'agenda_domingo_activo'"))?.valor === '1';

        // Citas locales ocupadas
        const citasLocales = await allQuery("SELECT fecha, hora FROM citas_agenda WHERE fecha = ? AND estado != 'Cancelada'", [fecha]);

        const resp = await calendarService.obtenerHuecosDisponibles({
            calendarId: calIdConfig,
            credentials: credsConfig,
            fecha,
            duracionMinutos: isNaN(parseInt(duracionCita)) ? 30 : parseInt(duracionCita),
            bufferMinutos: isNaN(parseInt(bufferMinutos)) ? 10 : parseInt(bufferMinutos),
            timezone,
            horarioLaboral: {
                turno1_inicio,
                turno1_fin,
                turno2_activo,
                turno2_inicio,
                turno2_fin,
                sabado_activo,
                sabado_inicio,
                sabado_fin,
                atiendeSabado: sabado_activo,
                atiendeDomingo: domingo_activo
            },
            citasLocalesOcupadas: citasLocales
        });

        res.json(resp);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Configuración General
app.get('/api/configuracion', autenticarToken, async (req, res) => {
    try {
        const rows = await allQuery("SELECT * FROM configuracion");
        const configMap = {};
        rows.forEach(r => configMap[r.clave] = r.valor);
        res.json(configMap);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/configuracion', autenticarToken, async (req, res) => {
    try {
        const updates = req.body;
        for (const [clave, valor] of Object.entries(updates)) {
            await runQuery(
                "INSERT INTO configuracion (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor",
                [clave, valor]
            );
        }
        res.json({ success: true, message: 'Configuración actualizada en vivo' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Agregar o Remover contacto de la lista de ignorados
app.post('/api/configuracion/ignorar', autenticarToken, async (req, res) => {
    try {
        const { jid, telefono, es_ignorado } = req.body;
        await runQuery(
            "INSERT INTO contactos (jid, telefono, es_ignorado) VALUES (?, ?, ?) ON CONFLICT(jid) DO UPDATE SET es_ignorado = excluded.es_ignorado",
            [jid, telefono || jid.replace(/[^0-9]/g, ''), es_ignorado ? 1 : 0]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Renombrar Contacto / Cliente desde el Dashboard o Chat en Vivo
app.put('/api/contactos/:jid/nombre', autenticarToken, async (req, res) => {
    try {
        const { nombre } = req.body;
        if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Nombre es requerido' });
        await runQuery("UPDATE contactos SET nombre = ? WHERE jid = ?", [nombre.trim(), req.params.jid]);
        res.json({ success: true, nombre: nombre.trim() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Gestión de Solicitudes de Asesor / Clientes en Espera
app.get('/api/solicitudes-asesor', autenticarToken, async (req, res) => {
    try {
        const solicitudes = await allQuery("SELECT * FROM solicitudes_asesor ORDER BY id DESC");
        res.json(solicitudes);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const cambiarEstadoSolicitudHandler = async (req, res) => {
    try {
        const { estado } = req.body; // 'atendido' o 'pendiente'
        await runQuery("UPDATE solicitudes_asesor SET estado = ? WHERE id = ?", [estado || 'atendido', req.params.id]);
        io.emit('solicitud_asesor_actualizada');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};
app.post('/api/solicitudes-asesor/:id/estado', autenticarToken, cambiarEstadoSolicitudHandler);
app.put('/api/solicitudes-asesor/:id/estado', autenticarToken, cambiarEstadoSolicitudHandler);

app.delete('/api/solicitudes-asesor/:id', autenticarToken, async (req, res) => {
    try {
        await runQuery("DELETE FROM solicitudes_asesor WHERE id = ?", [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Subida de Logo de la Empresa (compatible con ambas rutas)
app.post(['/api/upload/logo', '/api/configuracion/logo'], autenticarToken, uploadLogo.single('logo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });
        const logoUrl = '/uploads/' + req.file.filename;
        await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('linktree_logo_url', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [logoUrl]);
        res.json({ success: true, logo_url: logoUrl });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Gestión de Documentos de Conocimiento (PDFs, Excel/CSV, TXT)
app.get('/api/documentos', autenticarToken, (req, res) => {
    try {
        if (!fs.existsSync(DIR_DOCS)) return res.json([]);
        const files = fs.readdirSync(DIR_DOCS).map(f => {
            const stats = fs.statSync(path.join(DIR_DOCS, f));
            return {
                nombre: f,
                tamano: (stats.size / 1024).toFixed(1) + ' KB',
                fecha: stats.mtime.toLocaleDateString('es-MX')
            };
        });
        res.json(files);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/documentos/upload', autenticarToken, uploadDoc.single('documento'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });
        res.json({ success: true, filename: req.file.filename });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/documentos/:nombre', autenticarToken, (req, res) => {
    try {
        const filePath = path.join(DIR_DOCS, req.params.nombre);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Gestión de Galería de Imágenes e Infografías (.png, .jpg, .webp)
app.get('/api/imagenes', autenticarToken, (req, res) => {
    try {
        if (!fs.existsSync(DIR_IMAGENES)) return res.json([]);
        const files = fs.readdirSync(DIR_IMAGENES).map(f => {
            const stats = fs.statSync(path.join(DIR_IMAGENES, f));
            return {
                nombre: f,
                url: '/imagenes/' + f,
                tamano: (stats.size / 1024).toFixed(1) + ' KB',
                fecha: stats.mtime.toLocaleDateString('es-MX')
            };
        });
        res.json(files);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/imagenes/upload', autenticarToken, uploadImagen.single('imagen'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No se subió ninguna imagen' });
        res.json({ success: true, filename: req.file.filename, url: '/imagenes/' + req.file.filename });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/imagenes/:nombre', autenticarToken, (req, res) => {
    try {
        const filePath = path.join(DIR_IMAGENES, req.params.nombre);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Auto-descubrimiento dinámico de modelos oficiales de Google Gemini
let cacheModelosValidos = [];
let ultimoFetchModelos = 0;

// Sistema de Respaldo Local Inteligente ante caídas o saturación (503) de Google AI
function generarRespuestaEmergencia(textoUsuario, config, estadoHorario) {
    const txt = (textoUsuario || '').toLowerCase();
    const icono = config.icono_asistente || '🤖';
    const negocio = config.nombre_negocio || 'nuestro establecimiento';

    if (txt.includes('donde') || txt.includes('dónde') || txt.includes('ubicacion') || txt.includes('ubicación') || txt.includes('direccion') || txt.includes('dirección') || txt.includes('llegar')) {
        let resp = `${icono} 📍 *UBICACIÓN DE ${negocio.toUpperCase()}*\n\n${config.ubicacion_direccion || 'Consulta con nuestro personal para indicaciones exactas.'}`;
        if (config.ubicacion_maps_link) resp += `\n\n🗺️ *Ver en Google Maps:*\n${config.ubicacion_maps_link}`;
        return resp;
    }

    if (txt.includes('horario') || txt.includes('hora') || txt.includes('abren') || txt.includes('cierran') || txt.includes('atienden') || txt.includes('dias') || txt.includes('días')) {
        return `${icono} ⏰ *HORARIOS DE ATENCIÓN*\n\n${config.horario_sucursal_fisica || 'Lunes a Viernes en horario de atención habitual.'}`;
    }

    if (txt.includes('costo') || txt.includes('precio') || txt.includes('cobran') || txt.includes('gratis') || txt.includes('pagar')) {
        let resp = `${icono} 💰 *INFORMACIÓN DE COSTOS / SERVICIOS*\n\n`;
        if (config.catalogo_servicios) resp += `${config.catalogo_servicios}\n\n`;
        if (config.datos_bancarios) resp += `💳 *Métodos de pago:* ${config.datos_bancarios}`;
        return resp.trim();
    }

    if (txt.includes('requisito') || txt.includes('papel') || txt.includes('documento') || txt.includes('ine') || txt.includes('curp')) {
        return `${icono} 📋 *REQUISITOS GENERALES*\n\nPara tu atención gratuita, presenta:\n• Copia de INE o identificación oficial con fotografía\n• Copia de CURP\n\n_Para mayores informes acude en nuestro horario de atención o escribe *5* para solicitar un asesor._`;
    }

    return `${icono} 🏥 *¡Hola!* En este momento la red de servidores de Google AI está experimentando una saturación temporal de alta demanda (503).\n\n` +
        `Para ayudarte de inmediato:\n` +
        `• Envía *Menú* para explorar todas nuestras opciones disponibles.\n` +
        `• Envía *5* para solicitar atención personalizada con un asesor.\n\n` +
        `_En breve el motor de IA responderá tus preguntas con total normalidad._ ✨`;
}

async function obtenerModelosDisponibles(apiKey) {
    if (!apiKey) return ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-flash-latest', 'gemini-3.5-pro'];
    if (cacheModelosValidos.length > 0 && (Date.now() - ultimoFetchModelos < 3600000)) {
        return cacheModelosValidos;
    }

    try {
        const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        if (!resp.ok) throw new Error(`Status ${resp.status}`);
        const data = await resp.json();
        
        if (data && data.models && Array.isArray(data.models)) {
            // Filtrar modelos compatibles con generateContent
            const modelosSoportados = data.models
                .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
                .map(m => m.name.replace('models/', ''))
                .filter(name => !name.includes('embedding') && !name.includes('aqa') && !name.includes('imagen') && !name.includes('tts') && !name.includes('transcribe'));

            // Priorizar explícitamente gemini-3.6-flash y gemini-3-flash-preview (alta disponibilidad verificada)
            const flashModernos = ['gemini-3.6-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash', 'gemini-3.5-flash-lite']
                .filter(m => modelosSoportados.includes(m));

            const otrosFlash = modelosSoportados.filter(name => name.includes('flash') && !flashModernos.includes(name) && !name.includes('-exp'));
            const proModernos = modelosSoportados.filter(name => name.includes('pro') && !name.includes('-exp'));
            const otrosModelos = modelosSoportados.filter(name => !flashModernos.includes(name) && !otrosFlash.includes(name) && !proModernos.includes(name));

            const listaFinal = Array.from(new Set([...flashModernos, ...otrosFlash, ...proModernos, ...otrosModelos]));
            if (listaFinal.length > 0) {
                cacheModelosValidos = listaFinal;
                ultimoFetchModelos = Date.now();
                return listaFinal;
            }
        }
    } catch (e) {
        console.warn("⚠️ No se pudo consultar la lista dinámica de modelos de Google:", e.message);
    }

    return cacheModelosValidos.length > 0 ? cacheModelosValidos : ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite', 'gemini-flash-latest'];
}

// ============================================================================
// ENDPOINTS DEL SUPERADMIN (Auditoría)
// ============================================================================
app.get('/api/superadmin/auditoria', async (req, res) => {
    try {
        const registros = await allQuery("SELECT * FROM auditoria_sistema ORDER BY timestamp DESC LIMIT 50");
        res.json({ success: true, data: registros });
    } catch (error) {
        console.error("Error obteniendo auditoría:", error);
        res.status(500).json({ success: false, message: "Error interno" });
    }
});

app.get('/api/gemini/modelos', autenticarToken, async (req, res) => {
    try {
        const customApiKey = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'gemini_api_key'"))?.valor;
        const activeKey = (customApiKey && customApiKey.trim()) ? customApiKey.trim() : geminiApiKey;
        const modelos = await obtenerModelosDisponibles(activeKey);
        res.json({ success: true, modelos });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Mini-Sitio Linktree
app.get('/api/linktree', async (req, res) => {
    try {
        const links = await allQuery("SELECT * FROM linktree_links WHERE activo = 1 ORDER BY orden ASC");
        const titulo = await getQuery("SELECT valor FROM configuracion WHERE clave = 'linktree_titulo'");
        const descripcion = await getQuery("SELECT valor FROM configuracion WHERE clave = 'linktree_descripcion'");
        const logoUrl = await getQuery("SELECT valor FROM configuracion WHERE clave = 'linktree_logo_url'");
        res.json({
            titulo: titulo?.valor || 'Mi Empresa',
            descripcion: descripcion?.valor || '',
            logo_url: logoUrl?.valor || '',
            links
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/linktree/links', autenticarToken, async (req, res) => {
    try {
        const { titulo, url, icono, orden } = req.body;
        const result = await runQuery(
            "INSERT INTO linktree_links (titulo, url, icono, orden) VALUES (?, ?, ?, ?)",
            [titulo, url, icono || 'link', orden || 0]
        );
        res.json({ id: result.id, success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/linktree/links/:id', autenticarToken, async (req, res) => {
    try {
        await runQuery("DELETE FROM linktree_links WHERE id = ?", [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Descargar Respaldo de Base de Datos SQLite (1 Clic)
app.get('/api/backup/descargar', autenticarToken, (req, res) => {
    if (fs.existsSync(DB_PATH)) {
        res.download(DB_PATH, `respaldo_omnibot_${new Date().toISOString().split('T')[0]}.sqlite`);
    } else {
        res.status(404).json({ error: 'Archivo de base de datos no encontrado' });
    }
});

// ------------------------------------------------------------------------------
// 4.1 ENDPOINTS DE CONTROL RÁPIDO DEL BOT (1 CLIC EN DASHBOARD)
// ------------------------------------------------------------------------------
app.get('/api/bot/estado-control', autenticarToken, async (req, res) => {
    try {
        const pausadoConf = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'bot_pausado_global'"))?.valor === '1';
        const ausenciaActivaManual = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'ausencia_activa'"))?.valor === '1';
        const ausenciaTipoManual = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'ausencia_tipo'"))?.valor || 'vacaciones';
        const ausenciaMsgManual = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'ausencia_mensaje'"))?.valor || '';
        const ausenciaFechaManual = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'ausencia_fecha_fin'"))?.valor || '';
        const ignoradosCount = (await getQuery("SELECT COUNT(*) as total FROM contactos WHERE es_ignorado = 1"))?.total || 0;
        
        const estadoHorarioActual = await obtenerEstadoHorarioMexico();
        const estaEnReceso = ausenciaActivaManual || !!estadoHorarioActual.enReceso;
        const tipoFinal = estadoHorarioActual.enReceso ? estadoHorarioActual.tipoReceso : ausenciaTipoManual;
        const msgFinal = estadoHorarioActual.enReceso ? estadoHorarioActual.motivoReceso : ausenciaMsgManual;
        const fechaFinal = estadoHorarioActual.enReceso ? estadoHorarioActual.proximoTexto : ausenciaFechaManual;

        res.json({
            wsClienteConectado,
            botPausadoGlobal: botPausadoGlobal || pausadoConf,
            ausenciaActiva: estaEnReceso,
            ausenciaTipo: tipoFinal,
            ausenciaMsg: msgFinal,
            ausenciaFecha: fechaFinal,
            esProgramado: !!estadoHorarioActual.esProgramado,
            chatsPausadosCount: chatsPausados.size,
            ignoradosCount
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Parser Inteligente de Expresiones de Tiempo y Motivo para Modo Receso / Curso / Festivo
function parsearComandoReceso(textoCompleto, tipoPorDefecto = 'curso') {
    const partes = textoCompleto.trim().split(/\s+/);
    const resto = partes.slice(1).join(' ').trim();

    const getMotivoDefault = (t) => {
        if (t === 'curso') return 'Capacitación y Actualización Continua';
        if (t === 'festivo') return 'Día Festivo Oficial / Inhábil';
        return 'Periodo Vacacional';
    };

    if (!resto) {
        return {
            activo: true,
            tipo: tipoPorDefecto,
            motivo: getMotivoDefault(tipoPorDefecto),
            fechaFin: tipoPorDefecto === 'festivo' ? 'mañana a primera hora' : 'en breve'
        };
    }

    const restoLower = resto.toLowerCase();
    if (restoLower === 'off' || restoLower === 'desactivar' || restoLower === 'no') {
        return { activo: false, tipo: tipoPorDefecto };
    }

    let motivo = getMotivoDefault(tipoPorDefecto);
    let fechaFin = '';

    const diasSemana = {
        'lunes': 1, 'martes': 2, 'miercoles': 3, 'miércoles': 3,
        'jueves': 4, 'viernes': 5, 'sabado': 6, 'sábado': 6, 'domingo': 0
    };

    const ahora = new Date();
    const matchDias = restoLower.match(/(\d+)\s*(dias|días)/);
    const matchSemana = restoLower.match(/(\d+)\s*semanas?/);

    if (matchDias) {
        const numDias = parseInt(matchDias[1], 10);
        const fechaRegreso = new Date(ahora.getTime() + numDias * 24 * 60 * 60 * 1000);
        const formatFecha = new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', weekday: 'long', day: 'numeric', month: 'long' });
        fechaFin = formatFecha.format(fechaRegreso);
        const motivoLimpio = resto.replace(new RegExp(`(\\bpor\\s+)?${matchDias[0]}`, 'gi'), '').trim();
        if (motivoLimpio && motivoLimpio.length > 2) motivo = motivoLimpio;
    } else if (matchSemana) {
        const numSemanas = parseInt(matchSemana[1], 10);
        const fechaRegreso = new Date(ahora.getTime() + numSemanas * 7 * 24 * 60 * 60 * 1000);
        const formatFecha = new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', weekday: 'long', day: 'numeric', month: 'long' });
        fechaFin = formatFecha.format(fechaRegreso);
        const motivoLimpio = resto.replace(new RegExp(`(\\bpor\\s+)?${matchSemana[0]}`, 'gi'), '').trim();
        if (motivoLimpio && motivoLimpio.length > 2) motivo = motivoLimpio;
    } else if (restoLower.includes('mañana') || restoLower.includes('manana')) {
        const fechaRegreso = new Date(ahora.getTime() + 24 * 60 * 60 * 1000);
        const formatFecha = new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', weekday: 'long', day: 'numeric', month: 'long' });
        fechaFin = `mañana (${formatFecha.format(fechaRegreso)})`;
        const motivoLimpio = resto.replace(/\b(hasta\s+)?(el\s+)?mañana\b/gi, '').trim();
        if (motivoLimpio && motivoLimpio.length > 2) motivo = motivoLimpio;
    } else {
        let encontradoDia = false;
        for (const [dia, diaNum] of Object.entries(diasSemana)) {
            const regexDia = new RegExp(`\\b(hasta\\s+)?(el\\s+)?${dia}\\b`, 'i');
            if (regexDia.test(restoLower)) {
                encontradoDia = true;
                fechaFin = `el próximo ${dia} a primera hora`;
                const partesMotivo = resto.split(new RegExp(`\\b(hasta\\s+el|hasta|el)\\s+${dia}\\b`, 'i'));
                if (partesMotivo[0] && partesMotivo[0].trim().length > 2) {
                    motivo = partesMotivo[0].trim();
                }
                break;
            }
        }

        if (!encontradoDia) {
            const matchHasta = resto.match(/\bhasta\s+(el\s+)?(.+)/i);
            if (matchHasta) {
                fechaFin = matchHasta[2].trim();
                const partesMotivo = resto.split(/\bhasta\b/i);
                if (partesMotivo[0] && partesMotivo[0].trim().length > 2) {
                    motivo = partesMotivo[0].trim();
                }
            } else {
                motivo = resto;
                fechaFin = 'próximamente';
            }
        }
    }

    return {
        activo: true,
        tipo: tipoPorDefecto,
        motivo: motivo || getMotivoDefault(tipoPorDefecto),
        fechaFin: fechaFin || 'próximamente'
    };
}

// Motor de Cálculo Inteligente de Horario en México (America/Mexico_City)
async function obtenerEstadoHorarioMexico() {
    const ahora = new Date();
    const formatter = new Intl.DateTimeFormat('es-MX', {
        timeZone: 'America/Mexico_City',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });
    const parts = formatter.formatToParts(ahora);
    let diaSemana = '';
    let hora = 0;
    let minuto = 0;
    for (const p of parts) {
        if (p.type === 'weekday') diaSemana = p.value.toLowerCase();
        if (p.type === 'hour') hora = parseInt(p.value, 10);
        if (p.type === 'minute') minuto = parseInt(p.value, 10);
    }

    const minutosActuales = hora * 60 + minuto;

    // Obtener horarios para reemplazar "a primera hora"
    const horaInicioStr = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'hora_inicio_semana'"))?.valor || '14:00';
    const horaFinStr = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'hora_fin_semana'"))?.valor || '20:30';
    
    const [hIni, mIni] = horaInicioStr.split(':').map(n => parseInt(n, 10) || 0);
    const [hFin, mFin] = horaFinStr.split(':').map(n => parseInt(n, 10) || 0);
    const minInicio = hIni * 60 + mIni;
    const minFin = hFin * 60 + mFin;
    const formatoHoraInicio = hIni >= 12 ? `${hIni > 12 ? hIni - 12 : 12}:${mIni.toString().padStart(2, '0')} PM` : `${hIni === 0 ? 12 : hIni}:${mIni.toString().padStart(2, '0')} AM`;

    // 1. Verificar si hay Receso / Vacaciones / Curso / Festivo activo (Manual o Programado en Calendario)
    const ausenciaActivaManual = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'ausencia_activa'"))?.valor === '1';
    const ausenciaTipoManual = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'ausencia_tipo'"))?.valor || 'vacaciones';
    const ausenciaMsgManual = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'ausencia_mensaje'"))?.valor || '';
    const ausenciaFechaFinManual = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'ausencia_fecha_fin'"))?.valor || '';

    let eventoActivo = null;
    if (ausenciaActivaManual) {
        eventoActivo = {
            tipo: ausenciaTipoManual,
            motivo: ausenciaMsgManual,
            fechaFin: ausenciaFechaFinManual,
            esProgramado: false
        };
    } else {
        // Consultar si hay algún evento programado en el calendario para el día de hoy (hora de México)
        const hoyMexicoStr = ahora.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' }); // 'YYYY-MM-DD'
        try {
            const ev = await getQuery(`
                SELECT * FROM eventos_ausencia 
                WHERE activo = 1 
                  AND date(fecha_inicio) <= date(?) 
                  AND date(fecha_fin) >= date(?)
                ORDER BY id DESC LIMIT 1
            `, [hoyMexicoStr, hoyMexicoStr]);
            if (ev) {
                eventoActivo = {
                    tipo: ev.tipo || 'festivo',
                    motivo: ev.titulo,
                    fechaFin: ev.reanudacion_texto || ev.fecha_fin,
                    esProgramado: true
                };
            } else {
                // Si no hay evento local, verificar si hay evento de ausencia activo en Google Calendar
                try {
                    const configAgendaActivo = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'modulo_agenda_activo'"))?.valor === '1';
                    if (configAgendaActivo) {
                        const calId = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_calendar_id'"))?.valor;
                        const creds = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_service_account_json'"))?.valor;
                        const tz = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'timezone'"))?.valor || 'America/Mexico_City';
                        if (calId && creds) {
                            const calEv = await calendarService.obtenerEventoAusenciaActivoHoy({
                                calendarId: calId,
                                credentials: creds,
                                timezone: tz
                            });
                            if (calEv && calEv.activo) {
                                eventoActivo = {
                                    tipo: calEv.tipo || 'festivo',
                                    motivo: calEv.titulo,
                                    fechaFin: calEv.fechaFin || 'próximamente',
                                    esProgramado: true,
                                    origen: 'google_calendar'
                                };
                            }
                        }
                    }
                } catch (eCal) {}
            }
        } catch(eEv) {}
    }

    if (eventoActivo) {
        const tipoReceso = eventoActivo.tipo || 'vacaciones';
        const esCurso = (tipoReceso === 'curso');
        const esFestivo = (tipoReceso === 'festivo');
        let proximoTexto = esCurso
            ? 'al reanudar actividades tras la jornada de capacitación'
            : (esFestivo ? 'al reanudar labores tras el día festivo oficial' : 'al reanudar actividades tras el periodo vacacional');

        if (eventoActivo.fechaFin) {
            const fFinLower = eventoActivo.fechaFin.toLowerCase().trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(fFinLower)) {
                const partes = fFinLower.split('-');
                proximoTexto = `el día ${partes[2]}/${partes[1]}/${partes[0]} a las ${formatoHoraInicio}`;
            } else if (fFinLower.startsWith('mañana') || fFinLower.startsWith('hoy') || fFinLower.startsWith('el ') || fFinLower.startsWith('en ') || fFinLower.startsWith('al ')) {
                proximoTexto = `${eventoActivo.fechaFin.replace('a primera hora', '')} a las ${formatoHoraInicio}`.replace('  ', ' ');
            } else {
                proximoTexto = `el próximo ${eventoActivo.fechaFin.replace('a primera hora', '')} a las ${formatoHoraInicio}`.replace('  ', ' ');
            }
        }
        return {
            enHorario: false,
            enReceso: true,
            esCurso,
            esFestivo,
            tipoReceso,
            motivoReceso: eventoActivo.motivo || (esCurso ? 'Capacitación y Actualización Continua' : (esFestivo ? 'Día Festivo Oficial / Inhábil' : 'Periodo Vacacional')),
            proximoTexto,
            esProgramado: !!eventoActivo.esProgramado
        };
    }

    // Obtener configuración de textos para detectar fines de semana
    const horarioFisico = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'horario_sucursal_fisica'"))?.valor || '';
    const horarioOnline = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'horario_asesor_en_linea'"))?.valor || '';
    const difiereOnline = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'horario_online_diferente'"))?.valor === '1';
    
    // Para saber si "los asesores" trabajan fin de semana, evaluamos estrictamente el horario en línea (si está activo el switch)
    const textoBaseRevisar = difiereOnline ? horarioOnline.toLowerCase() : horarioFisico.toLowerCase();
    
    // Heurística simple para saber si abren fines de semana basándose en el texto descriptivo
    let abreSabado = textoBaseRevisar.includes('sabado') || textoBaseRevisar.includes('sábado') || textoBaseRevisar.includes('lunes a sabado') || textoBaseRevisar.includes('lunes a sábado') || textoBaseRevisar.includes('lunes a domingo') || textoBaseRevisar.includes('todos los dias') || textoBaseRevisar.includes('todos los días');
    let abreDomingo = textoBaseRevisar.includes('domingo') || textoBaseRevisar.includes('lunes a domingo') || textoBaseRevisar.includes('todos los dias') || textoBaseRevisar.includes('todos los días');

    const esCerrado = (dia) => {
        const regex = new RegExp(`(?:(?:${dia})[^\\w]*(?:cerrado|descanso|no abrimos|inactivo))|(?:(?:cerrado|descanso|no abrimos|inactivo)[^\\w]*(?:los\\s*)?(?:${dia}))`, 'i');
        return regex.test(textoBaseRevisar);
    };

    if (esCerrado('s[aá]bado|s[aá]b')) abreSabado = false;
    if (esCerrado('domingo|dom')) abreDomingo = false;

    // Días laborables dinámicos
    let diasLaborables = ['lun', 'mar', 'mié', 'jue', 'vie'];
    
    if (esCerrado('lunes|lun')) diasLaborables = diasLaborables.filter(d => d !== 'lun');
    if (esCerrado('martes|mar')) diasLaborables = diasLaborables.filter(d => d !== 'mar');
    if (esCerrado('mi[eé]rcoles|mi[eé]')) diasLaborables = diasLaborables.filter(d => d !== 'mié');
    if (esCerrado('jueves|jue')) diasLaborables = diasLaborables.filter(d => d !== 'jue');
    if (esCerrado('viernes|vie')) diasLaborables = diasLaborables.filter(d => d !== 'vie');

    if (abreSabado) diasLaborables.push('sáb', 'sab');
    if (abreDomingo) diasLaborables.push('dom');

    const esDiaLaboral = diasLaborables.some(d => diaSemana.startsWith(d));

    let minInicioEfectivo = minInicio;
    let minFinEfectivo = minFin;

    // Heurística avanzada: si es fin de semana, intentar extraer el horario específico del texto
    if (esDiaLaboral && (diaSemana.startsWith('s') || diaSemana.startsWith('d'))) {
        const regexDia = diaSemana.startsWith('s') 
            ? /(?:s[aá]bado|s[aá]b)[^\d]*(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)\s*(?:a|al|hasta|-)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)/i 
            : /(?:domingo|dom)[^\d]*(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)\s*(?:a|al|hasta|-)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)/i;
        
        const match = textoBaseRevisar.match(regexDia);
        if (match) {
            const parseTimeStr = (t) => {
                let h = 0, m = 0;
                const isPm = t.includes('pm') || t.includes('p.m');
                const isAm = t.includes('am') || t.includes('a.m');
                const nums = t.replace(/[^\d:]/g, '').split(':');
                if (nums[0]) h = parseInt(nums[0], 10);
                if (nums[1]) m = parseInt(nums[1], 10);
                if (isPm && h < 12) h += 12;
                if (isAm && h === 12) h = 0;
                return { h, m, total: h * 60 + m, isAm, isPm };
            };
            const iniParsed = parseTimeStr(match[1]);
            const finParsed = parseTimeStr(match[2]);
            
            let ini = iniParsed.total;
            let fin = finParsed.total;
            
            if (!iniParsed.isAm && !iniParsed.isPm) {
                if (iniParsed.h < 7) ini += 12 * 60; // ej "1 a 3" -> 1 PM
            }
            if (!finParsed.isAm && !finParsed.isPm) {
                if (finParsed.h < 12) fin += 12 * 60; // ej "12 a 3" -> 3 PM
            }
            
            if (ini > 0 && fin > 0) {
                minInicioEfectivo = ini;
                minFinEfectivo = fin;
            }
        }
    }

    if (esDiaLaboral && minutosActuales >= minInicioEfectivo && minutosActuales <= minFinEfectivo) {
        return {
            enHorario: true,
            enReceso: false,
            proximoTexto: 'actualmente en horario de atención'
        };
    }

    // Fuera de horario: calcular retorno amigable
    let proximoTexto = `en nuestro próximo horario de atención (${formatoHoraInicio})`;
    
    if (!esDiaLaboral) {
        if (diaSemana.startsWith('s') && abreDomingo) {
            proximoTexto = `mañana domingo a partir de las ${formatoHoraInicio}`;
        } else if ((diaSemana.startsWith('s') || diaSemana.startsWith('d')) && (!abreSabado && !abreDomingo)) {
            proximoTexto = `el próximo lunes a partir de las ${formatoHoraInicio}`;
        } else if (diaSemana.startsWith('d') && !abreDomingo) {
            proximoTexto = `mañana lunes a partir de las ${formatoHoraInicio}`;
        } else {
            proximoTexto = `mañana a partir de las ${formatoHoraInicio}`;
        }
    } else if (minutosActuales > minFinEfectivo) {
        if (diaSemana.startsWith('v') && !abreSabado && !abreDomingo) {
            proximoTexto = `el próximo lunes a partir de las ${formatoHoraInicio}`;
        } else if (diaSemana.startsWith('v') && !abreSabado && abreDomingo) {
            proximoTexto = `el domingo a partir de las ${formatoHoraInicio}`;
        } else if (diaSemana.startsWith('s') && !abreDomingo) {
            proximoTexto = `el próximo lunes a partir de las ${formatoHoraInicio}`;
        } else {
            proximoTexto = `mañana a partir de las ${formatoHoraInicio}`;
        }
    } else if (minutosActuales < minInicio) {
        proximoTexto = `hoy a partir de las ${formatoHoraInicio}`;
    }

    return {
        enHorario: false,
        enReceso: false,
        proximoTexto
    };
}

app.post('/api/bot/pausar', autenticarToken, async (req, res) => {
    try {
        botPausadoGlobal = true;
        await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('bot_pausado_global', '1') ON CONFLICT(clave) DO UPDATE SET valor = '1'");
        io.emit('estado_control_actualizado', { botPausadoGlobal: true });
        res.json({ success: true, botPausadoGlobal: true, mensaje: "Bot pausado globalmente" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/bot/reactivar', autenticarToken, async (req, res) => {
    try {
        botPausadoGlobal = false;
        chatsPausados.clear();
        await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('bot_pausado_global', '0') ON CONFLICT(clave) DO UPDATE SET valor = '0'");
        await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_activa', '0') ON CONFLICT(clave) DO UPDATE SET valor = '0'");
        io.emit('estado_control_actualizado', { botPausadoGlobal: false, ausenciaActiva: false, chatsPausadosCount: 0 });
        res.json({ success: true, botPausadoGlobal: false, ausenciaActiva: false, mensaje: "Bot reactivado exitosamente y pausas eliminadas" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/bot/ausencia', autenticarToken, async (req, res) => {
    try {
        const { activa, tipo, mensaje, fecha_fin } = req.body;
        const tipoFinal = ['curso', 'festivo', 'vacaciones'].includes(tipo) ? tipo : 'vacaciones';
        await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_activa', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [activa ? '1' : '0']);
        await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_tipo', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [tipoFinal]);
        if (mensaje !== undefined) {
            await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_mensaje', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [mensaje]);
        }
        if (fecha_fin !== undefined) {
            await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_fecha_fin', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [fecha_fin]);
        }
        chatsPausados.clear();
        io.emit('estado_control_actualizado', {
            ausenciaActiva: !!activa,
            ausenciaTipo: tipoFinal,
            ausenciaMsg: mensaje,
            ausenciaFecha: fecha_fin,
            mensaje,
            fecha_fin
        });
        res.json({ success: true, ausenciaActiva: !!activa, ausenciaTipo: tipoFinal });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/bot/festivo', autenticarToken, async (req, res) => {
    try {
        const { activa, motivo, fecha_fin } = req.body;
        const motivoFinal = motivo || 'Día Festivo Oficial / Inhábil';
        await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_activa', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [activa ? '1' : '0']);
        await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_tipo', 'festivo') ON CONFLICT(clave) DO UPDATE SET valor = 'festivo'");
        if (motivo !== undefined) {
            await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_mensaje', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [motivoFinal]);
        }
        if (fecha_fin !== undefined) {
            await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_fecha_fin', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [fecha_fin]);
        }
        chatsPausados.clear();
        io.emit('estado_control_actualizado', {
            ausenciaActiva: !!activa,
            ausenciaTipo: 'festivo',
            ausenciaMsg: motivoFinal,
            ausenciaFecha: fecha_fin,
            mensaje: motivoFinal,
            fecha_fin
        });
        res.json({ success: true, ausenciaActiva: !!activa, ausenciaTipo: 'festivo' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ------------------------------------------------------------------------------
// ENDPOINTS PARA CALENDARIO DE EVENTOS Y FESTIVOS PROGRAMADOS CON ANTERIORIDAD
// ------------------------------------------------------------------------------
app.get('/api/bot/eventos-ausencia', autenticarToken, async (req, res) => {
    try {
        const eventos = await allQuery("SELECT * FROM eventos_ausencia ORDER BY fecha_inicio ASC, id ASC");
        res.json(eventos || []);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/bot/eventos-ausencia', autenticarToken, async (req, res) => {
    try {
        const { tipo, titulo, fecha_inicio, fecha_fin, reanudacion_texto } = req.body;
        if (!titulo || !fecha_inicio) {
            return res.status(400).json({ error: "Título y fecha de inicio son requeridos" });
        }
        const tipoFinal = ['curso', 'festivo', 'vacaciones'].includes(tipo) ? tipo : 'festivo';
        const fechaFinFinal = fecha_fin || fecha_inicio;
        const reanudacionFinal = reanudacion_texto || `al concluir ${titulo}`;

        let googleEventId = null;
        try {
            const configAgendaActivo = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'modulo_agenda_activo'"))?.valor === '1';
            if (configAgendaActivo) {
                const calId = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_calendar_id'"))?.valor;
                const creds = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_service_account_json'"))?.valor;
                const tz = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'timezone'"))?.valor || 'America/Mexico_City';
                if (calId && creds) {
                    const bloqRes = await calendarService.crearBloqueoAusencia({
                        calendarId: calId,
                        credentials: creds,
                        titulo: titulo.trim(),
                        tipo: tipoFinal,
                        fechaInicio: fecha_inicio,
                        fechaFin: fechaFinFinal,
                        timezone: tz
                    });
                    if (bloqRes && bloqRes.success) {
                        googleEventId = bloqRes.eventId;
                    }
                }
            }
        } catch (eG) {
            console.error("⚠️ Error creando bloqueo en Google Calendar:", eG.message);
        }

        const resultado = await runQuery(`
            INSERT INTO eventos_ausencia (tipo, titulo, fecha_inicio, fecha_fin, reanudacion_texto, activo, google_event_id, creado_en)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        `, [tipoFinal, titulo.trim(), fecha_inicio, fechaFinFinal, reanudacionFinal.trim(), googleEventId || '', Date.now()]);

        io.emit('eventos_ausencia_actualizados');
        res.json({ success: true, id: resultado.id, google_event_id: googleEventId, mensaje: "Evento programado con éxito" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/bot/eventos-ausencia/:id', autenticarToken, async (req, res) => {
    try {
        const ev = await getQuery("SELECT * FROM eventos_ausencia WHERE id = ?", [req.params.id]);
        if (ev && ev.google_event_id) {
            try {
                const configAgendaActivo = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'modulo_agenda_activo'"))?.valor === '1';
                if (configAgendaActivo) {
                    const calId = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_calendar_id'"))?.valor;
                    const creds = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_service_account_json'"))?.valor;
                    if (calId && creds) {
                        await calendarService.cancelarCita({
                            calendarId: calId,
                            credentials: creds,
                            eventId: ev.google_event_id
                        });
                    }
                }
            } catch (eG) {
                console.error("⚠️ Error al eliminar bloqueo de Google Calendar:", eG.message);
            }
        }

        await runQuery("DELETE FROM eventos_ausencia WHERE id = ?", [req.params.id]);
        io.emit('eventos_ausencia_actualizados');
        res.json({ success: true, mensaje: "Evento eliminado con éxito" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/bot/curso', autenticarToken, async (req, res) => {
    try {
        const { activa, motivo, fecha_fin } = req.body;
        const motivoFinal = motivo || 'Capacitación y Actualización Continua';
        await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_activa', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [activa ? '1' : '0']);
        await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_tipo', 'curso') ON CONFLICT(clave) DO UPDATE SET valor = 'curso'");
        if (motivo !== undefined) {
            await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_mensaje', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [motivoFinal]);
        }
        if (fecha_fin !== undefined) {
            await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_fecha_fin', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [fecha_fin]);
        }
        io.emit('estado_control_actualizado', {
            ausenciaActiva: !!activa,
            ausenciaTipo: 'curso',
            ausenciaMsg: motivoFinal,
            ausenciaFecha: fecha_fin,
            mensaje: motivoFinal,
            fecha_fin
        });
        res.json({ success: true, ausenciaActiva: !!activa, ausenciaTipo: 'curso' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/contactos/ignorados', autenticarToken, async (req, res) => {
    try {
        const lista = await allQuery("SELECT * FROM contactos WHERE es_ignorado = 1 ORDER BY id DESC");
        res.json(lista);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/contactos/toggle-ignorar', autenticarToken, async (req, res) => {
    try {
        const { jid, es_ignorado } = req.body;
        await runQuery("UPDATE contactos SET es_ignorado = ? WHERE jid = ?", [es_ignorado ? 1 : 0, jid]);
        res.json({ success: true, es_ignorado: !!es_ignorado });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Helper para detectar la ruta nativa de Chromium en Linux ARM64 (Oracle Ampere) / Windows
function obtenerRutaChromium() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH.replace(/"/g, '');
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH.replace(/"/g, '');
    if (process.platform === 'linux') {
        const rutas = [
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome'
        ];
        for (const r of rutas) {
            if (fs.existsSync(r)) return r;
        }
    }
    return undefined;
}

// ------------------------------------------------------------------------------
// 5. MOTOR DE WHATSAPP WEB CON IA Y SISTEMA ANTI-BAN RECEPTIVO
// ------------------------------------------------------------------------------
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
    puppeteer: {
        headless: true,
        timeout: 120000,
        executablePath: obtenerRutaChromium(),
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-extensions',
            '--disable-component-update',
            '--disable-sync',
            '--mute-audio'
        ]
    }
});

// Contador global de envíos en vuelo (pendientes de resolución)
// Cuando message_create detecta que hay envíos pendientes, sabe que ES un mensaje del bot.
let botEnviosPendientes = 0;
let ultimoEnvioBotMs = 0;

// Interceptor seguro de client.sendMessage
const origSendMessage = client.sendMessage.bind(client);
client.sendMessage = async function(chatId, content, options) {
    try {
        const textContent = typeof content === 'string' ? content : (options?.caption || '');
        if (typeof registrarEnvioBot === 'function') registrarEnvioBot(chatId, textContent);
    } catch(eReg) {}

    botEnviosPendientes++;   // ← marca: hay un envío en vuelo
    try {
        const res = await origSendMessage(chatId, content, options);
        try {
            if (res && res.id && res.id._serialized) {
                idsMensajesEnviadosBot.add(res.id._serialized);
            }
        } catch(eId) {}
        return res;
    } finally {
        ultimoEnvioBotMs = Date.now();                         // ← timestamp del último envío completado
        botEnviosPendientes = Math.max(0, botEnviosPendientes - 1);
    }
};

let tiempoInicioLoadingSaaS = null;
let ultimoPorcentajeSaaS = null;

client.on('loading_screen', (percent, message) => {
    console.log(`⏳ Cargando WhatsApp... ${percent}% - ${message}`);
    
    // Si el bot YA está conectado y en ejecución, las sincronizaciones de fondo (50%, 99%) son normales y no deben recargar la página
    if (wsClienteConectado) {
        tiempoInicioLoadingSaaS = null;
        ultimoPorcentajeSaaS = null;
        return;
    }

    // Guardián Universal: Si se queda en CUALQUIER porcentaje antes de 'ready' por más de 75 segundos sin avanzar, forzar recarga limpia
    if (ultimoPorcentajeSaaS !== percent) {
        tiempoInicioLoadingSaaS = Date.now();
        ultimoPorcentajeSaaS = percent;
    }

    if (tiempoInicioLoadingSaaS && (Date.now() - tiempoInicioLoadingSaaS > 75000)) {
        console.warn(`⚠️ ALERTA WATCHDOG: WhatsApp Web atascado en ${percent}% durante el inicio por más de 75s. Reiniciando proceso limpio con PM2...`);
        tiempoInicioLoadingSaaS = null;
        ultimoPorcentajeSaaS = null;
        process.exit(1);
    }
});

client.on('qr', (qr) => {
    ultimoQrCode = qr;
    wsClienteConectado = false;
    tiempoInicioLoadingSaaS = null;
    ultimoPorcentajeSaaS = null;
    qrcode.generate(qr, { small: true });
    io.emit('qr_actualizado', { qr });
    console.log('📲 Escanea el código QR en tu aplicación de WhatsApp o en el Dashboard.');
});

client.on('ready', () => {
    wsClienteConectado = true;
    ultimoQrCode = null;
    tiempoInicioLoadingSaaS = null;
    ultimoPorcentajeSaaS = null;
    io.emit('estado_whatsapp', { conectado: true });
    io.emit('estado_control_actualizado', { wsClienteConectado: true });
    console.log('🚀 ¡Motor OmniBot conectado y listo para atender clientes!');
});

client.on('disconnected', (reason) => {
    wsClienteConectado = false;
    ultimoQrCode = null;
    tiempoInicioLoadingSaaS = null;
    ultimoPorcentajeSaaS = null;
    io.emit('estado_whatsapp', { conectado: false, reason });
    io.emit('estado_control_actualizado', { wsClienteConectado: false });
    console.log('❌ WhatsApp se ha desconectado:', reason);
    
    // Auto-reparación vía Auditor al detectar desconexión fuerte
    if (typeof Auditor !== 'undefined') {
        Auditor.registrarEvento('CRITICO', `Desconexión de WhatsApp detectada. Razón: ${reason}. Forzando reinicio para sanar...`).then(async () => {
            try { await client.destroy(); } catch(e) {}
            setTimeout(() => process.exit(1), 2000);
        });
    } else {
        setTimeout(async () => {
            try { await client.destroy(); } catch(e) {}
            process.exit(1);
        }, 2000);
    }
});

// Guardián Activo y Keep-Alive periódico cada 60 segundos
setInterval(async () => {
    try {
        // El watchdog de carga solo aplica si el bot NO ha logrado conectarse
        if (!wsClienteConectado && tiempoInicioLoadingSaaS && (Date.now() - tiempoInicioLoadingSaaS > 90000)) {
            console.warn(`⚠️ ALERTA WATCHDOG: El proceso de carga inicial lleva más de 90s atascado en ${ultimoPorcentajeSaaS}%. Reiniciando proceso limpio con PM2...`);
            tiempoInicioLoadingSaaS = null;
            ultimoPorcentajeSaaS = null;
            process.exit(1);
        }

        // Mantener despierto el WebSocket de Chromium en madrugadas
        if (wsClienteConectado && client.pupPage && !client.pupPage.isClosed()) {
            await client.pupPage.evaluate(() => {
                return window.Store && window.Store.AppState ? true : false;
            }).catch(() => {});
        }
    } catch (e) {}
}, 60000);

// Helper seguro para simular "escribiendo..." sin que falle si el contexto de Puppeteer está ocupado
async function simularEscribiendoSeguro(msg, ms = 1000) {
    try {
        if (msg && typeof msg.getChat === 'function') {
            const chat = await msg.getChat().catch(() => null);
            if (chat && typeof chat.sendStateTyping === 'function') {
                await chat.sendStateTyping().catch(() => {});
            }
        }
    } catch (e) {}
    await delay(ms);
}

// Procesador Inteligente de Mensajes Entrantes
async function procesarMensajeEntrante(msg) {
    let remitente = null;
    try {
        if (!msg || msg.from === 'status@broadcast') return;
        remitente = msg.from;
        // NOTA: No se checa idsMensajesEnviadosBot en mensajes entrantes
        // (event 'message' solo dispara para fromMe=false, no puede tener IDs del bot)

        // Deduplicación estricta por ID de mensaje de WhatsApp
        if (msg.id && msg.id._serialized) {
            if (idsMensajesRecibidos.has(msg.id._serialized)) {
                return;
            }
            idsMensajesRecibidos.add(msg.id._serialized);
            if (idsMensajesRecibidos.size > 3000) {
                const prim = idsMensajesRecibidos.values().next().value;
                idsMensajesRecibidos.delete(prim);
            }
        }

        // 1. Descartar mensajes antiguos (más de 2 minutos) que WhatsApp entrega al reconectar o reiniciar
        if (msg.timestamp) {
            const antiguedadSegundos = (Date.now() / 1000) - msg.timestamp;
            if (antiguedadSegundos > 120) {
                console.log(`⏳ Omitiendo mensaje antiguo (${Math.round(antiguedadSegundos)}s de antigüedad) de ${msg.from}`);
                return;
            }
        }

        const esGrupo = msg.from.endsWith('@g.us');
        const texto = msg.body ? msg.body.trim() : '';

        // COMANDO MAESTRO DE RESETEO - BYPASS TOTAL
        if (texto && (texto.toLowerCase().includes('!reset') || texto.toLowerCase().includes('/reset') || texto.toLowerCase().includes('!borrar'))) {
            try {
                await runQuery("DELETE FROM mensajes WHERE chat_id = ? OR chat_id LIKE ?", [remitente, `%${remitente.slice(-10)}%`]);
                await client.sendMessage(remitente, '✅ *Memoria de Inteligencia Artificial borrada exitosamente.* El historial de este chat ha sido eliminado. Ya puedes enviar tu mensaje para iniciar de cero.');
            } catch(e) {}
            return;
        }

    // En grupos normales, el bot se mantiene 100% sordo y mudo
    if (esGrupo) {
        const tagGrupo = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'grupo_control'"))?.valor || '[CONTROL-BOT]';
        try {
            const chat = await msg.getChat();
            if (!chat.name.toLowerCase().includes(tagGrupo.toLowerCase())) return;
        } catch (e) {
            return;
        }
    }

// Función para limpiar nombres y evitar saludos con códigos alfanuméricos, fechas, emojis o IDs técnicos
function limpiarNombreParaSaludo(nombre) {
    if (!nombre) return '';
    const n = nombre.trim();
    // Extraer únicamente letras humanas (elimina emojis como 😈🖤😋🐺, símbolos y números)
    const soloLetras = n.replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ\s]/g, '').trim();
    if (
        soloLetras.length < 2 ||
        n.toLowerCase() === 'cliente' ||
        n.toLowerCase().includes('usuario desconocido') ||
        n.toLowerCase().startsWith('cliente') ||
        /\d{2,}/.test(n)
    ) {
        return '';
    }
    return soloLetras.split(' ')[0];
}

    // Registrar o actualizar Contacto en la Base de Datos
    let nombreContacto = 'Cliente';
    let pushname = '';
    let telefonoReal = remitente.replace(/[^0-9]/g, '');
    try {
        const contact = await msg.getContact();
        if (contact) {
            let nRaw = contact.name || contact.pushname || 'Cliente';
            if (nRaw.toLowerCase().includes('usuario desconocido')) nRaw = 'Cliente';
            nombreContacto = nRaw;
            pushname = contact.pushname || '';
            if (contact.number && !contact.number.startsWith('1660') && contact.number.length >= 10) {
                telefonoReal = contact.number;
            }
        }
    } catch (e) {}

    // Si el contacto ya existía con un nombre editado o número limpio, conservarlo
    const contactoPrevio = await getQuery("SELECT nombre, telefono FROM contactos WHERE jid = ?", [remitente]);
    if (contactoPrevio) {
        if (contactoPrevio.telefono && !contactoPrevio.telefono.startsWith('1660') && telefonoReal.startsWith('1660')) {
            telefonoReal = contactoPrevio.telefono;
        }
        if (contactoPrevio.nombre && contactoPrevio.nombre !== 'Cliente' && !contactoPrevio.nombre.toLowerCase().includes('usuario desconocido') && !contactoPrevio.nombre.startsWith('Cliente (+')) {
            nombreContacto = contactoPrevio.nombre;
        }
    }

    await runQuery(
        "INSERT INTO contactos (jid, telefono, nombre, pushname, ultimo_contacto) VALUES (?, ?, ?, ?, ?) ON CONFLICT(jid) DO UPDATE SET telefono = excluded.telefono, ultimo_contacto = excluded.ultimo_contacto, pushname = excluded.pushname, nombre = CASE WHEN excluded.nombre != 'Cliente' THEN excluded.nombre ELSE contactos.nombre END",
        [remitente, telefonoReal, nombreContacto, pushname, Date.now()]
    );

    // Guardar mensaje recibido en historial
    await runQuery(
        "INSERT INTO mensajes (chat_id, emisor, emisor_nombre, cuerpo, tipo, es_mio, es_ia, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [remitente, remitente, nombreContacto, texto, msg.type, 0, 0, Date.now()]
    );

    io.emit('nuevo_mensaje', {
        chat_id: remitente,
        emisor: remitente,
        emisor_nombre: nombreContacto,
        cuerpo: texto,
        tipo: msg.type,
        es_mio: 0,
        es_ia: 0,
        timestamp: Date.now()
    });

    // --------------------------------------------------------------------------
    // COMANDOS DE CONTROL MÓVIL Y GRUPO [CONTROL-BOT] (vCards y Comandos !)
    // --------------------------------------------------------------------------
    const esVCard = msg.type === 'vcard' || msg.type === 'multi_vcard' || (msg.vCards && msg.vCards.length > 0);
    // Sanitizar texto: quitar espacios invisibles Unicode y normalizar
    const textoLimpio = (texto || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    const textoLower = textoLimpio.toLowerCase().trim();

    // Comprobar si el remitente es un teléfono Administrador registrado (o tiene su LID vinculado)
    const adminsRaw = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'numeros_admins'"))?.valor || '';
    const adminsArray = adminsRaw.split(',').map(n => n.trim().replace(/[^0-9]/g, '')).filter(Boolean);
    const lidsRaw = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'lids_admins_vinculados'"))?.valor || '';
    const lidsArray = lidsRaw.split(',').filter(Boolean);

    const remitenteNum = remitente.replace(/[^0-9]/g, '');
    let esAdminRemitente = lidsArray.includes(remitente) || adminsArray.some(adminNum => {
        const suffix = (adminNum.length >= 10 && !adminNum.startsWith('1660')) ? adminNum.slice(-10) : adminNum;
        return (remitenteNum && remitenteNum.endsWith(suffix)) || (telefonoReal && telefonoReal.endsWith(suffix));
    });

    if (textoLower.startsWith('!soyadmin ')) {
        const numAlegado = textoLower.replace('!soyadmin ', '').replace(/[^0-9]/g, '');
        const esValido = adminsArray.some(a => a.endsWith(numAlegado) || numAlegado.endsWith(a));
        if (esValido) {
            if (!lidsArray.includes(remitente)) {
                lidsArray.push(remitente);
                await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('lids_admins_vinculados', ?) ON CONFLICT(clave) DO UPDATE SET valor = ?", [lidsArray.join(','), lidsArray.join(',')]);
            }
            await client.sendMessage(remitente, "✅ Tu dispositivo (LID) ha sido vinculado exitosamente a tu número de Administrador. Ya recibirás alertas.");
            esAdminRemitente = true;
        } else {
            await client.sendMessage(remitente, "❌ El número que ingresaste no coincide con los configurados en el panel.");
        }
        return;
    }

    // --------------------------------------------------------------------------
    // COMANDO UNIVERSAL DE AUTORREGISTRO ADMIN (!admin <clave> o !clave <clave>)
    // --------------------------------------------------------------------------
    if (textoLower.startsWith('!admin ') || textoLower.startsWith('!clave ') || textoLower.startsWith('!vincularadmin ')) {
        const partes = textoLimpio.split(/\s+/);
        const passIngresada = partes.slice(1).join(' ').trim();
        
        if (!passIngresada) {
            const sent = await client.sendMessage(remitente, "⚠️ *Uso correcto:* Envía `!admin TU_CONTRASEÑA` (la contraseña que utilizas para entrar al panel web).");
            if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
            return;
        }

        const usuariosAdmin = await allQuery("SELECT username, password_hash, rol FROM usuarios WHERE rol IN ('admin', 'superadmin', 'cliente')");
        let passCorrecta = false;
        let adminUser = null;

        for (const u of usuariosAdmin) {
            if (u.password_hash && bcrypt.compareSync(passIngresada, u.password_hash)) {
                passCorrecta = true;
                adminUser = u;
                break;
            }
        }

        if (passCorrecta) {
            let currentAdmins = adminsArray.slice();
            const idsToAdd = [remitenteNum];
            if (telefonoReal && telefonoReal !== remitenteNum) idsToAdd.push(telefonoReal);

            idsToAdd.forEach(id => {
                if (!currentAdmins.includes(id)) currentAdmins.push(id);
            });

            const nuevoValorAdmins = currentAdmins.join(', ');
            await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('numeros_admins', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [nuevoValorAdmins]);
            io.emit('config_actualizada', { numeros_admins: nuevoValorAdmins });

            const sent = await client.sendMessage(remitente, 
                `✅ *¡ADMINISTRADOR VINCULADO CON ÉXITO!*\n\n` +
                `👤 *Usuario validado:* ${adminUser.username}\n` +
                `📱 *Tu identificador registrado:* ${remitenteNum}\n\n` +
                `Tu chat ahora cuenta con *permisos totales de administrador* en este bot.\n\n` +
                `📌 *Comandos disponibles listos para usar:*\n` +
                `• *!ayuda* -> Ver todos los comandos de control\n` +
                `• *!pausa* -> Pausar el bot globalmente\n` +
                `• *!reactivar* -> Reactivar y quitar pausas\n` +
                `• *!probar* -> Probar el bot como cliente\n` +
                `• *!menu* -> Probar el menú de bienvenida\n` +
                `• *!curso [días]* -> Activar modo capacitación\n` +
                `• *!auditoria* -> Reporte de servidor y RAM`
            );
            if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
            return;
        } else {
            const sent = await client.sendMessage(remitente, "❌ *Contraseña incorrecta.* Verifica la clave de acceso de tu panel web y vuelve a intentarlo con `!admin TU_CONTRASEÑA`.");
            if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
            return;
        }
    }

    if (textoLower === '!debugyo') {
        const adminTestSuffixes = adminsArray.map(a => a.length >= 10 ? a.slice(-10) : a);
        await client.sendMessage(remitente, 
            `🛠️ *DEBUG INFO*\n` +
            `JID: ${remitente}\n` +
            `Num: ${remitenteNum}\n` +
            `TelReal: ${telefonoReal}\n` +
            `Admins DB: ${adminsRaw}\n` +
            `Suffixes: ${adminTestSuffixes.join(', ')}\n` +
            `esAdmin: ${esAdminRemitente}\n` +
            `Texto: [${textoLower}]\n\n` +
            `💡 _Para vincularte como admin envía:_ \`!admin TU_CONTRASEÑA\``
        );
        return;
    }

    if (esGrupo || (textoLower.startsWith('!') && esAdminRemitente) || (esVCard && esAdminRemitente)) {
        // 1. Tarjetas de contacto compartidas para ignorar al instante
        if (esVCard) {
            let numExtraido = null;
            if (msg.vCards && msg.vCards[0]) {
                const match = msg.vCards[0].match(/waid=(\d+)/i) || msg.vCards[0].match(/TEL[^:]*:([+\d\s-]+)/i);
                if (match) numExtraido = match[1].replace(/[^0-9]/g, '');
            }
            if (numExtraido) {
                const jidTarget = numExtraido.length === 10 ? `521${numExtraido}@c.us` : `${numExtraido}@c.us`;
                await runQuery("INSERT INTO contactos (jid, telefono, nombre, es_ignorado, ultimo_contacto) VALUES (?, ?, 'Contacto Excluido', 1, ?) ON CONFLICT(jid) DO UPDATE SET es_ignorado = 1", [jidTarget, numExtraido, Date.now()]);
                const sent = await msg.reply(`🚫 *Contacto Ignorado con éxito:*\n📱 Número: +${numExtraido}\n\nEl bot ya no le responderá a esta persona.`);
                if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                return;
            }
        }

        // 2. Comandos con signo de exclamación (!)
        if (textoLower.startsWith('!')) {
            if (textoLower === '!reactivar' || textoLower === '!activar' || textoLower === '!unpause') {
                botPausadoGlobal = false;
                chatsPausados.clear();
                await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('bot_pausado_global', '0') ON CONFLICT(clave) DO UPDATE SET valor = '0'");
                await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_activa', '0') ON CONFLICT(clave) DO UPDATE SET valor = '0'");
                io.emit('estado_control_actualizado', { botPausadoGlobal: false, ausenciaActiva: false, chatsPausadosCount: 0 });
                const sent = await client.sendMessage(remitente, "✅ *BOT COMPLETAMENTE REACTIVADO.*\n\nSe han eliminado todas las pausas y el modo ausencia / curso. El bot vuelve a responder con normalidad a todos los clientes.");
                if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                return;
            }

            if (textoLower === '!probar' || textoLower === '!prueba' || textoLower === '!probar on' || textoLower === '!prueba on' || textoLower === '!modo prueba on' || textoLower === '!modo prueba') {
                await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('modo_prueba_admins', '1') ON CONFLICT(clave) DO UPDATE SET valor = '1'");
                io.emit('estado_control_actualizado', { modoPruebaAdmins: true });
                const sent = await client.sendMessage(remitente, "🧪 *MODO PRUEBA ACTIVADO.*\n\nAhora el bot te responderá en este chat exactamente como si fueras un cliente o cliente nuevo.\n\n_Para desactivarlo envía `!probar off` o `!reactivar`._");
                if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                return;
            }

            if (textoLower === '!probar off' || textoLower === '!prueba off' || textoLower === '!modo prueba off') {
                await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('modo_prueba_admins', '0') ON CONFLICT(clave) DO UPDATE SET valor = '0'");
                io.emit('estado_control_actualizado', { modoPruebaAdmins: false });
                const sent = await client.sendMessage(remitente, "🛡️ *MODO PRUEBA DESACTIVADO.*\n\nEl bot vuelve a guardar silencio contigo para que puedas usar este chat con normalidad.");
                if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                return;
            }

            if (textoLower === '!pausa' || textoLower === '!pausar' || textoLower === '!pause') {
                botPausadoGlobal = true;
                await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('bot_pausado_global', '1') ON CONFLICT(clave) DO UPDATE SET valor = '1'");
                io.emit('estado_control_actualizado', { botPausadoGlobal: true });
                const sent = await client.sendMessage(remitente, "⏸️ *BOT PAUSADO GLOBALMENTE.*\n\nEl bot no responderá a ningún cliente hasta que envíes `!reactivar`.");
                if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                return;
            }

            if (textoLower.startsWith('!pausa ') || textoLower.startsWith('!pausar ')) {
                const partes = texto.split(' ');
                const numRaw = partes[1] ? partes[1].replace(/[^0-9]/g, '') : '';
                if (numRaw) {
                    const jidTarget = numRaw.length === 10 ? `521${numRaw}@c.us` : `${numRaw}@c.us`;
                    chatsPausados.set(jidTarget, Date.now());
                    const sent = await client.sendMessage(remitente, `⏸️ Chat +${numRaw} pausado temporalmente.`);
                    if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                    return;
                }
            }

            // ------------------------------------------------------------------
            // COMANDO: !curso / !congreso / !capacitacion / !taller (Modo Actualización Médica)
            // ------------------------------------------------------------------
            if (textoLower.startsWith('!curso') || textoLower.startsWith('!congreso') || textoLower.startsWith('!capacitacion') || textoLower.startsWith('!capacitación') || textoLower.startsWith('!taller')) {
                const parsed = parsearComandoReceso(texto, 'curso');
                if (!parsed.activo) {
                    await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_activa', '0') ON CONFLICT(clave) DO UPDATE SET valor = '0'");
                    io.emit('estado_control_actualizado', { ausenciaActiva: false, ausenciaTipo: 'curso' });
                    const sent = await client.sendMessage(remitente, "🎓 *MODO CURSO / CONGRESO DESACTIVADO.*\n\nEl bot y el equipo de salud reanudan la atención y agenda de citas presenciales habitual.");
                    if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                    return;
                }

                await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_activa', '1') ON CONFLICT(clave) DO UPDATE SET valor = '1'");
                await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_tipo', 'curso') ON CONFLICT(clave) DO UPDATE SET valor = 'curso'");
                await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_mensaje', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [parsed.motivo]);
                await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_fecha_fin', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [parsed.fechaFin]);

                io.emit('estado_control_actualizado', {
                    ausenciaActiva: true,
                    ausenciaTipo: 'curso',
                    ausenciaMsg: parsed.motivo,
                    ausenciaFecha: parsed.fechaFin,
                    mensaje: parsed.motivo,
                    fecha_fin: parsed.fechaFin
                });

                const sent = await client.sendMessage(remitente,
                    `🎓 *MODO CURSO / CONGRESO MÉDICO ACTIVADO*\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `📌 *Motivo:* ${parsed.motivo}\n` +
                    `🗓️ *Reanudación estimada:* ${parsed.fechaFin}\n` +
                    `🤖 *Rol de la IA:* Activa 24/7 explicando con calidez que el equipo está en Actualización Continua, resolviendo dudas sobre métodos y apartando citas con prioridad para el regreso.\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `💡 _Para desactivar envía \`!curso off\` o \`!reactivar\`._`
                );
                if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                return;
            }

            // ------------------------------------------------------------------
            // COMANDO: !vacaciones / !ausencia (Modo Receso Vacacional)
            // ------------------------------------------------------------------
            if (textoLower.startsWith('!vacaciones') || textoLower.startsWith('!ausencia')) {
                const parsed = parsearComandoReceso(texto, 'vacaciones');
                if (!parsed.activo) {
                    await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_activa', '0') ON CONFLICT(clave) DO UPDATE SET valor = '0'");
                    io.emit('estado_control_actualizado', { ausenciaActiva: false, ausenciaTipo: 'vacaciones' });
                    const sent = await client.sendMessage(remitente, "🏖️ *MODO VACACIONES DESACTIVADO.* El bot reanuda la atención normal.");
                    if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                    return;
                }

                await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_activa', '1') ON CONFLICT(clave) DO UPDATE SET valor = '1'");
                await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_tipo', 'vacaciones') ON CONFLICT(clave) DO UPDATE SET valor = 'vacaciones'");
                await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_mensaje', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [parsed.motivo]);
                await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_fecha_fin', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [parsed.fechaFin]);

                io.emit('estado_control_actualizado', {
                    ausenciaActiva: true,
                    ausenciaTipo: 'vacaciones',
                    ausenciaMsg: parsed.motivo,
                    ausenciaFecha: parsed.fechaFin,
                    mensaje: parsed.motivo,
                    fecha_fin: parsed.fechaFin
                });

                const sent = await client.sendMessage(remitente,
                    `🌴 *MODO VACACIONES ACTIVADO*\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `📌 *Motivo:* ${parsed.motivo}\n` +
                    `🗓️ *Reanudación:* ${parsed.fechaFin}\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `💡 _Para desactivar envía \`!reactivar\` o \`!vacaciones off\`._`
                );
                if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                return;
            }

            // ------------------------------------------------------------------
            // COMANDO: !festivo / !feriado / !asueto / !inhabil (Modo Suspensión Oficial de Labores)
            // ------------------------------------------------------------------
            if (textoLower.startsWith('!festivo') || textoLower.startsWith('!feriado') || textoLower.startsWith('!asueto') || textoLower.startsWith('!inhabil') || textoLower.startsWith('!inhábil')) {
                const parsed = parsearComandoReceso(texto, 'festivo');
                if (!parsed.activo) {
                    await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_activa', '0') ON CONFLICT(clave) DO UPDATE SET valor = '0'");
                    io.emit('estado_control_actualizado', { ausenciaActiva: false, ausenciaTipo: 'festivo' });
                    const sent = await client.sendMessage(remitente, "🇲🇽 *MODO DÍA FESTIVO DESACTIVADO.*\n\nEl bot y el personal reanudan la atención y agenda de citas presenciales habitual.");
                    if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                    return;
                }

                await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_activa', '1') ON CONFLICT(clave) DO UPDATE SET valor = '1'");
                await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_tipo', 'festivo') ON CONFLICT(clave) DO UPDATE SET valor = 'festivo'");
                await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_mensaje', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [parsed.motivo]);
                await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_fecha_fin', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [parsed.fechaFin]);

                io.emit('estado_control_actualizado', {
                    ausenciaActiva: true,
                    ausenciaTipo: 'festivo',
                    ausenciaMsg: parsed.motivo,
                    ausenciaFecha: parsed.fechaFin,
                    mensaje: parsed.motivo,
                    fecha_fin: parsed.fechaFin
                });

                const sent = await client.sendMessage(remitente,
                    `🇲🇽 *MODO DÍA FESTIVO / INHÁBIL ACTIVADO*\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `📌 *Conmemoración / Motivo:* ${parsed.motivo}\n` +
                    `🗓️ *Reanudación estimada:* ${parsed.fechaFin}\n` +
                    `🤖 *Rol de la IA:* Activa 24/7 resolviendo dudas sobre el catálogo y servicios del negocio, anotando solicitudes en lista prioritaria para el regreso.\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `💡 _Para desactivar envía \`!festivo off\` o \`!reactivar\`._`
                );
                if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                return;
            }

            if (textoLower.startsWith('!ignorar')) {
                const partes = texto.split(' ');
                const num = partes[1] ? partes[1].replace(/[^0-9]/g, '') : '';
                if (num) {
                    const jidTarget = num.length === 10 ? `521${num}@c.us` : `${num}@c.us`;
                    await runQuery("INSERT INTO contactos (jid, telefono, nombre, es_ignorado, ultimo_contacto) VALUES (?, ?, 'Contacto Excluido', 1, ?) ON CONFLICT(jid) DO UPDATE SET es_ignorado = 1", [jidTarget, num, Date.now()]);
                    const sent = await client.sendMessage(remitente, `🚫 *Contacto +${num} agregado a la lista de ignorados.*`);
                    if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                }
                return;
            }

            if (textoLower.startsWith('!atender')) {
                const partes = texto.split(' ');
                const num = partes[1] ? partes[1].replace(/[^0-9]/g, '') : '';
                if (num) {
                    const jidTarget = num.length === 10 ? `521${num}@c.us` : `${num}@c.us`;
                    await runQuery("UPDATE contactos SET es_ignorado = 0 WHERE jid = ? OR telefono = ?", [jidTarget, num]);
                    const sent = await client.sendMessage(remitente, `✅ *Contacto +${num} removido de ignorados.* El bot volverá a atenderlo.`);
                    if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                }
                return;
            }

            if (textoLower === '!pendientes' || textoLower === '!resumen') {
                const ultimos = await allQuery("SELECT nombre, pushname, telefono, jid, ultimo_contacto FROM contactos WHERE es_ignorado = 0 AND telefono NOT LIKE '1660%' AND jid NOT LIKE '%@lid' ORDER BY ultimo_contacto DESC LIMIT 10");
                let rep = `📋 *REPORTE DE CONTACTOS RECIENTES (${ultimos.length}):*\n\n`;
                if (ultimos.length === 0) {
                    rep += `_Aún no hay clientes recientes registrados (los registros de prueba se han limpiado)._\n`;
                } else {
                    ultimos.forEach((u, i) => {
                        const nom = u.nombre !== 'Cliente' ? u.nombre : (u.pushname || 'Cliente');
                        const telLimpio = u.telefono && !u.telefono.startsWith('1660') ? u.telefono : u.jid.replace(/[^0-9]/g, '');
                        rep += `${i + 1}️⃣ 👤 *${nom}*\n   📱 +${telLimpio}\n`;
                    });
                }
                rep += `\n_💡 Puedes abrir sus chats en WhatsApp Web para dar seguimiento personal._`;
                const sent = await client.sendMessage(remitente, rep);
                if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                return;
            }

            if (textoLower === '!ayuda' || textoLower === '!help') {
                const sent = await client.sendMessage(remitente, 
                    "🤖 *COMANDOS DISPONIBLES DE CONTROL OMNIBOT:*\n\n" +
                    "▶️ `!reactivar` -> Reactiva el bot, quita pausas y desactiva vacaciones/cursos.\n" +
                    "⏸️ `!pausa` -> Pausa globalmente el bot de forma indefinida.\n" +
                    "⏸️ `!pausa 4111234567` -> Pausa a un cliente específico.\n" +
                    "🎓 `!curso hasta el viernes` -> Activa Modo Curso / Congreso (la IA atiende 24/7 y anota citas en lista prioritaria).\n" +
                    "🌴 `!vacaciones [mensaje/fecha]` -> Activa modo receso vacacional.\n" +
                    "🧪 `!probar` (o `!prueba`) -> Activa Modo Prueba (el bot te responde como cliente).\n" +
                    "🛡️ `!probar off` -> Desactiva Modo Prueba.\n" +
                    "📋 `!menu` -> Muestra el menú numérico interactivo.\n" +
                    "🚫 `!ignorar 4111234567` -> Agrega a la lista de ignorados.\n" +
                    "✅ `!atender 4111234567` -> Remueve de ignorados.\n" +
                    "📋 `!resumen` -> Lista los últimos clientes atendidos.\n" +
                    "🛡️ `!auditoria` -> Diagnóstico del servidor, memoria RAM y salud del bot.\n" +
                    "🔑 `!admin [contraseña]` -> Vincular tu WhatsApp como Administrador."
                );
                if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                return;
            }

            if (textoLower === '!menu' || textoLower === '!menú') {
                const nombreMostrar = (nombreContacto && nombreContacto !== 'Cliente') ? nombreContacto : null;
                const saludoHeader = nombreMostrar ?
                    `${iconoAsistente ? iconoAsistente + ' ' : ''}👋 *¡Hola, ${nombreMostrar}! Bienvenido(a) a ${nombreNegocio}.*` :
                    `${iconoAsistente ? iconoAsistente + ' ' : ''}👋 *¡Hola! Bienvenido(a) a ${nombreNegocio}.*`;

                const horarioFisico = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'horario_sucursal_fisica'"))?.valor || '';
                let textoMenu = `${saludoHeader}\n\n¡Estamos para servirte! 🤖\n\nElige una opción:\n\n`;
                try {
                    const menuRaw = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'menu_numerico'"))?.valor;
                    if (menuRaw) {
                        const menuOpts = JSON.parse(menuRaw);
                        menuOpts.forEach(o => {
                            textoMenu += `${o.opcion}️⃣ *${o.titulo}*\n`;
                        });
                    } else {
                        textoMenu += `1️⃣ 📋 *Catálogo / Servicios*\n2️⃣ 💰 *Precios y promociones*\n3️⃣ ⏰ *Horarios de atención*\n4️⃣ 📍 *Ubicación / Envíos*\n5️⃣ 👤 *Solicitar Asesor / Hacer pedido*\n`;
                    }
                } catch(e) {
                    textoMenu += `1️⃣ 📋 *Catálogo / Servicios*\n2️⃣ 💰 *Precios y promociones*\n3️⃣ ⏰ *Horarios de atención*\n4️⃣ 📍 *Ubicación / Envíos*\n5️⃣ 👤 *Solicitar Asesor / Hacer pedido*\n`;
                }
                textoMenu += `\n_Escribe el número de la opción o tu pregunta libremente y con gusto te responderé._`;

                registrarTextoEnviadoBot(textoMenu);
                const sent = await client.sendMessage(remitente, textoMenu);
                if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                return;
            }

            if (textoLower === '!auditoria') {
                const reporte = await Auditor.generarReporte();
                await client.sendMessage(remitente, reporte);
                return;
            }


            // Fallback para cualquier comando no reconocido que empiece con !
            const sent = await client.sendMessage(remitente, "❓ *Comando no reconocido.*\n\nEnvía *!ayuda* para consultar la lista de comandos disponibles.");
            if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
            return;
        }

        if (esGrupo) return; // En grupos no responder como asistente de IA
    }

    // --------------------------------------------------------------------------
    // FILTROS: Contactos Ignorados / Pausas Humanas / Filtro de Audios
    // --------------------------------------------------------------------------
    let modoPruebaActivo = false;
    if (esAdminRemitente) {
        modoPruebaActivo = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'modo_prueba_admins'"))?.valor === '1';
        if (!modoPruebaActivo) {
            // El bot guarda silencio con sus administradores para no interferir en sus conversaciones personales
            return;
        }
    }

    // Pausa Global
    const pausadoConf = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'bot_pausado_global'"))?.valor === '1';
    if (botPausadoGlobal || pausadoConf) return;

    const contactoBD = await getQuery("SELECT es_ignorado FROM contactos WHERE jid = ?", [remitente]);
    if (contactoBD && contactoBD.es_ignorado === 1) return;

    // --------------------------------------------------------------------------
    // VERIFICACIÓN DE PAUSA INDIVIDUAL POR INTERVENCIÓN HUMANA
    // --------------------------------------------------------------------------
    let estaPausado = chatsPausados.has(remitente);
    let tiempoPausa = chatsPausados.get(remitente) || 0;

    // Buscar si está pausado bajo su número limpio (si remitente es @lid o viceversa)
    if (!estaPausado && telefonoReal && telefonoReal.length >= 10) {
        for (const [pJid, pTime] of chatsPausados.entries()) {
            if (pJid.includes('_') || pJid.includes('esperando')) continue; // Ignorar claves de control
            if (pJid.includes(telefonoReal) || remitente.includes(pJid.replace(/[^0-9]/g, ''))) {
                estaPausado = true;
                tiempoPausa = pTime;
                break;
            }
        }
    }

    if (estaPausado) {
        const minsPausa = parseInt((await getQuery("SELECT valor FROM configuracion WHERE clave = 'tiempo_pausa_humano_mins'"))?.valor || '30', 10);
        const transcurrido = Date.now() - tiempoPausa;
        if (transcurrido < minsPausa * 60 * 1000) {
            const minutosRestantes = Math.ceil(((minsPausa * 60 * 1000) - transcurrido) / 60000);
            console.log(`⏸️ Chat ${remitente} (Tel: ${telefonoReal}) en PAUSA por intervención humana (quedan ${minutosRestantes} mins). Silencio total.`);
            return;
        }
        chatsPausados.delete(remitente);
    }

    if (msg.type === 'ptt' || msg.type === 'audio' || msg.type === 'voice') {
        await simularEscribiendoSeguro(msg, 1200);
        const resp = "🎙️ *Hola. Por el momento nuestro sistema atiende por mensaje escrito y fotos.*\n\nPor favor, escríbeme tu duda para poder ayudarte.";
        const sent = await msg.reply(resp);
        if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
        return;
    }

    if (!texto) return;

    // Bloqueo de concurrencia inteligente con expiración automática TTL (12s)
    if (!esGrupo) {
        const tiempoInicioProc = chatsEnProceso.get(remitente);
        if (tiempoInicioProc && (Date.now() - tiempoInicioProc < 12000)) {
            console.log(`⏳ Chat ${remitente} ya está siendo procesado concurrentemente. Omitiendo respuesta duplicada.`);
            return;
        }
        chatsEnProceso.set(remitente, Date.now());
        if (typeof registrarEnvioBot === 'function') registrarEnvioBot(remitente);
    }

    const iconoAsistente = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'icono_asistente'"))?.valor || '🤖';
    const nombreNegocio = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'nombre_negocio'"))?.valor || 'nuestro negocio';
    const enlacePrivacidad = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'enlace_formulario_privacidad'"))?.valor || 'https://forms.gle/zJxZeXXj1TwWGF9N8';
    const mostrarMenuNumerico = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'mostrar_menu_numerico'"))?.valor !== '0';
    const estadoHorario = await obtenerEstadoHorarioMexico();
    const textoLowerNorm = texto.toLowerCase();

    // --------------------------------------------------------------------------
    // ALERTA A ADMINISTRADORES POR PALABRAS CLAVE DETECTADAS
    // --------------------------------------------------------------------------
    try {
        const notificarActiva = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'notificar_admins_activa'"))?.valor === '1';
        const palabrasRaw = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'palabras_clave_alerta'"))?.valor || '';
        const destinoAlerta = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'destino_alerta_admins'"))?.valor || 'ambos';

        if (notificarActiva && palabrasRaw.trim()) {
            const palabrasLista = palabrasRaw.split(',').map(p => p.trim().toLowerCase()).filter(p => p.length >= 2);
            const palabraEncontrada = palabrasLista.find(p => textoLowerNorm.includes(p));

            if (palabraEncontrada) {
                if (!global.alertasAdminsMemoria) global.alertasAdminsMemoria = new Map();
                const claveCooldown = `${remitente}_${palabraEncontrada}`;
                const ultimoEnvio = global.alertasAdminsMemoria.get(claveCooldown) || 0;

                // Cooldown de 15 minutos por el mismo cliente y palabra clave
                if (Date.now() - ultimoEnvio > 15 * 60 * 1000) {
                    global.alertasAdminsMemoria.set(claveCooldown, Date.now());

                    const telLimpio = telefonoReal && !telefonoReal.startsWith('1660') ? telefonoReal : remitente.replace(/[^0-9]/g, '');
                    const nombreLimpio = nombreContacto && nombreContacto !== 'Cliente' ? nombreContacto : (pushname || 'Cliente / Cliente');

                    const alertaMsg = `🚨 *ALERTA OMNIBOT - PALABRA CLAVE DETECTADA* 🚨\n\n` +
                        `👤 *Cliente / Cliente:* ${nombreLimpio}\n` +
                        `📱 *WhatsApp:* +${telLimpio}\n` +
                        `🔑 *Palabra detectada:* *"${palabraEncontrada.toUpperCase()}"*\n` +
                        `💬 *Mensaje recibido:*\n"${texto}"\n\n` +
                        `⏰ *Fecha:* ${obtenerFechaHoraLocal()}\n` +
                        `👉 _Puedes responderle directamente abriendo su conversación en WhatsApp o en el Panel._`;

                    // 1. Enviar a Números Administradores y LIDs vinculados
                    if (destinoAlerta === 'ambos' || destinoAlerta === 'numeros') {
                        // Enviar a los configurados de forma manual asumiendo @c.us
                        for (const numAdm of adminsArray) {
                            const jidAdm = numAdm.length === 10 ? `521${numAdm}@c.us` : `${numAdm}@c.us`;
                            try {
                                const sentAdm = await client.sendMessage(jidAdm, alertaMsg);
                                if (sentAdm?.id) idsMensajesEnviadosBot.add(sentAdm.id._serialized);
                            } catch (eAdm) {
                                console.error(`Error notificando al administrador +${numAdm}:`, eAdm.message);
                            }
                        }
                        
                        // Enviar a los LIDs vinculados para que no falle Multi-Device
                        const lidsRaw = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'lids_admins_vinculados'"))?.valor || '';
                        const lidsArray = lidsRaw.split(',').filter(Boolean);
                        for (const lidAdm of lidsArray) {
                            try {
                                const sentAdm = await client.sendMessage(lidAdm, alertaMsg);
                                if (sentAdm?.id) idsMensajesEnviadosBot.add(sentAdm.id._serialized);
                            } catch (eAdm) {
                                console.error(`Error notificando al administrador LID ${lidAdm}:`, eAdm.message);
                            }
                        }
                    }

                    // 2. Enviar al Grupo de Control
                    if (destinoAlerta === 'ambos' || destinoAlerta === 'grupo') {
                        try {
                            const grupoCtrlNombre = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'grupo_control'"))?.valor || '[CONTROL-BOT]';
                            if (grupoCtrlNombre && client) {
                                const chats = await client.getChats();
                                const grupo = chats.find(c => c.isGroup && (c.name.includes(grupoCtrlNombre) || c.id._serialized === grupoCtrlNombre));
                                if (grupo) {
                                    const sentGrp = await client.sendMessage(grupo.id._serialized, alertaMsg);
                                    if (sentGrp?.id) idsMensajesEnviadosBot.add(sentGrp.id._serialized);
                                }
                            }
                        } catch (eGrp) {
                            console.error("Error enviando alerta al grupo de control:", eGrp.message);
                        }
                    }
                }
            }
        }
    } catch (errAlerta) {
        console.error("Error evaluando alerta a administradores:", errAlerta.message);
    }

    // --------------------------------------------------------------------------
    // A. CAPTURA Y REGISTRO AUTOMÁTICO DE NOMBRE DEL PACIENTE
    // --------------------------------------------------------------------------
    if (chatsEsperandoNombre.has(remitente) && !texto.startsWith('!')) {
        const txtClean = texto.replace(/[\n\r]/g, ' ').trim();
        const txtLower = txtClean.toLowerCase();

        // Lista de frases o confirmaciones comunes que NO son un nombre real
        const frasesNoNombre = [
            'ya lo hice', 'ya lo llene', 'ya lo llené', 'ya quedo', 'ya quedó', 'listo', 'ya está', 'ya esta',
            'ya envie', 'ya envié', 'ya mande', 'ya mandé', 'ok', 'si', 'ya', 'gracias', 'hola', 'buenas',
            'hecho', 'completado', 'registrado', 'formulario', 'link', 'enlace', 'ya registre', 'ya registré',
            'ya puse', 'listo ya', 'ya fue', 'ya terminé', 'ya termine'
        ];

        const esConfirmacionSinNombre = frasesNoNombre.some(f => txtLower === f || txtLower.startsWith(f + ' ') || txtLower.endsWith(' ' + f));
        const esPreguntaOServicio = /\b(qu[eé]|cu[aá]nto|cu[aá]ndo|c[oó]mo|d[oó]nde|por qu[eé]|tienen|tienes|costo|precio|servicio|horario|ubicaci[oó]n|requisito|cat[aá]logo|producto|disponible|pedido|entrega|env[ií]o|cita|talla|oferta|descuento)\b/i.test(txtLower);

        if (esPreguntaOServicio) {
            // Si el cliente envía una duda o duda o pregunta, liberar la espera y responderle su duda
            chatsEsperandoNombre.delete(remitente);
        } else if (esConfirmacionSinNombre || txtClean.length < 3 || /^\d+$/.test(txtClean)) {
            // No es un nombre: insistir amablemente en el nombre para poder registrarlo correctamente
            await simularEscribiendoSeguro(msg, 1000);

            const msjPedirNombre = `${iconoAsistente ? iconoAsistente + ' ' : ''}¡Excelente! ✍️ Para registrarte e identificarte con nuestro equipo, por favor indícame **cuál es tu nombre** (o cómo te gustaría que te llamemos):`;
            const sent = await client.sendMessage(remitente, msjPedirNombre);
            if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
            return;
        }

        // Es un nombre real: limpiamos prefijos ("Me llamo...", "Soy...")
        chatsEsperandoNombre.delete(remitente);
        let nombreLimpio = txtClean;
        const prefijos = [/^(me llamo|soy|mi nombre es|nombre:?|yo soy)\s+/i];
        for (const pref of prefijos) {
            nombreLimpio = nombreLimpio.replace(pref, '').trim();
        }
        if (!nombreLimpio) nombreLimpio = txtClean;

        // Formatear Capitalize
        nombreLimpio = nombreLimpio.split(' ').map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');

        await runQuery("UPDATE contactos SET nombre = ? WHERE jid = ?", [nombreLimpio, remitente]);
        nombreContacto = nombreLimpio;

        await simularEscribiendoSeguro(msg, 1000);

        let msjConfirmado = '';
        if (estadoHorario.enReceso) {
            if (estadoHorario.esFestivo) {
                msjConfirmado = `${iconoAsistente ? iconoAsistente + ' ' : ''}¡Muchas gracias, *${nombreLimpio}*! Tu registro y aviso de privacidad han sido confirmados con éxito. ✍️✅\n\n` +
                    `🇲🇽 Con motivo del día festivo oficial (*${estadoHorario.motivoReceso}*), has quedado registrado(a) con prioridad en nuestra **Lista de Espera Prioritaria** y te contactaremos **${estadoHorario.proximoTexto}**.\n\n` +
                    `💬 *¡El asistente virtual sigue activo para ti!* Puedes preguntarme sobre nuestros productos, catálogo, precios o disponibilidad y con gusto resolveré tus dudas al instante. ☺️`;
            } else if (estadoHorario.esCurso) {
                msjConfirmado = `${iconoAsistente ? iconoAsistente + ' ' : ''}¡Muchas gracias, *${nombreLimpio}*! Tu registro y aviso de privacidad han sido confirmados con éxito. ✍️✅\n\n` +
                    `🎓 nuestro equipo se encuentra en jornadas de capacitación continua (*${estadoHorario.motivoReceso}*). Has quedado registrado(a) con prioridad en nuestra **Lista de Espera Prioritaria** y te contactaremos **${estadoHorario.proximoTexto}**.\n\n` +
                    `💬 *¡El asistente virtual sigue activo para ti!* Puedes preguntarme sobre nuestros productos, catálogo, precios o disponibilidad y con gusto resolveré tus dudas al instante. ☺️`;
            } else {
                msjConfirmado = `${iconoAsistente ? iconoAsistente + ' ' : ''}¡Muchas gracias, *${nombreLimpio}*! Tu registro y aviso de privacidad han sido confirmados con éxito. ✍️✅\n\n` +
                    `📌 Actualmente nuestro personal se encuentra en: ${estadoHorario.motivoReceso}. Te atenderemos prioritariamente **${estadoHorario.proximoTexto}**.\n\n` +
                    `_Mientras tanto, el asistente virtual se mantiene activo 24/7 por si deseas consultar nuestros servicios o requisitos._`;
            }
        } else if (!estadoHorario.enHorario) {
            msjConfirmado = `${iconoAsistente ? iconoAsistente + ' ' : ''}¡Muchas gracias, *${nombreLimpio}*! Tu registro y aviso de privacidad han sido confirmados con éxito. ✍️✅\n\n` +
                `⏰ *Fuera de horario de atención en línea:* He dejado tu solicitud registrada. Nuestro personal te responderá por este chat **${estadoHorario.proximoTexto}**.\n\n` +
                `_Mientras tanto, el asistente virtual se mantiene activo 24/7 por si deseas consultar nuestros servicios, requisitos o disponibilidad._`;
        } else {
            msjConfirmado = `${iconoAsistente ? iconoAsistente + ' ' : ''}¡Muchas gracias, *${nombreLimpio}*! Tu registro y aviso de privacidad han sido confirmados con éxito. ✍️✅\n\n` +
                `He notificado a nuestro equipo de ${nombreNegocio}. En un momento te atenderán de forma personalizada.\n\n` +
                `_Mientras tanto, el asistente virtual se mantiene activo 24/7 por si deseas consultar nuestros servicios o requisitos._`;
        }

        const sent = await client.sendMessage(remitente, msjConfirmado);
        if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);

        // Si fue fuera de horario o en receso, registrar en solicitudes pendientes de asesor
        if (!estadoHorario.enHorario || estadoHorario.enReceso) {
            try {
                const telLimpio = telefonoReal && !telefonoReal.startsWith('1660') ? telefonoReal : remitente.replace(/[^0-9]/g, '');
                const yaExiste = await getQuery("SELECT id FROM solicitudes_asesor WHERE jid = ? AND estado = 'pendiente'", [remitente]);
                if (!yaExiste) {
                    await runQuery(
                        "INSERT INTO solicitudes_asesor (jid, telefono, nombre, motivo, fecha_hora, timestamp, estado) VALUES (?, ?, ?, ?, ?, ?, 'pendiente')",
                        [remitente, telLimpio, nombreLimpio, 'Solicitud de Asesor (Formulario Confirmado)', obtenerFechaHoraLocal(), Date.now()]
                    );
                }
            } catch(eSol) {}
        }

        await runQuery(
            "INSERT INTO mensajes (chat_id, emisor, emisor_nombre, cuerpo, es_mio, es_ia, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [remitente, 'bot', 'Registro Cliente', msjConfirmado, 1, 1, Date.now()]
        );
        return;
    }

    // --------------------------------------------------------------------------
    // B. SALUDO INICIAL Y MENÚ INTERACTIVO DE BIENVENIDA (OPCIONAL)
    // --------------------------------------------------------------------------
    const saludos = [
        'hola', 'buenas', 'buenos dias', 'buen dia', 'buenos días', 'buen día',
        'buenas tardes', 'buenas noches', 'menu', 'menú', 'inicio', 'opciones',
        'empezar', 'hola!', 'hola buenas', 'hola buen dia', 'hola buenos dias',
        'hola buenas tardes', 'hola buenas noches', 'saludos', 'ola', 'holaa', 'holaaa',
        'que tal', 'qué tal', 'saludos cordiales'
    ];
    
    // Inactividad: si pasaron más de 60 minutos (1 hora) sin interacción, o si es primera vez, o si está en modo prueba
    const telUltimos8Sal = (telefonoReal && telefonoReal.length >= 8 && !telefonoReal.startsWith('1660')) ? telefonoReal.slice(-8) : '';
    const ultimoMsgPrevio = await getQuery(`
        SELECT timestamp FROM mensajes 
        WHERE (chat_id = ? OR (? != '' AND chat_id LIKE ?))
        ORDER BY id DESC LIMIT 1 OFFSET 1
    `, [remitente, telUltimos8Sal, `%${telUltimos8Sal}%`]);

    const tiempoInactivo = ultimoMsgPrevio ? (Date.now() - ultimoMsgPrevio.timestamp) : Infinity;
    const esNuevaConversacion = tiempoInactivo > (12 * 60 * 60 * 1000); // 12 horas (máximo 1 menú de bienvenida por jornada/día)
    const pideMenuExplicito = ['menu', 'menú', 'inicio', 'opciones', 'empezar', '!menu', '!menú', 'ver menu', 'ver menú'].includes(textoLowerNorm);
    const esSaludoPuro = saludos.includes(textoLowerNorm);

    if ((pideMenuExplicito || esNuevaConversacion) && mostrarMenuNumerico) {
        await simularEscribiendoSeguro(msg, 1000);

        const nombreMostrar = (nombreContacto && nombreContacto !== 'Cliente') ? nombreContacto : null;
        const saludoHeader = nombreMostrar ?
            `${iconoAsistente ? iconoAsistente + ' ' : ''}👋 *¡Hola, ${nombreMostrar}! Bienvenido(a) a ${nombreNegocio}.*` :
            `${iconoAsistente ? iconoAsistente + ' ' : ''}👋 *¡Hola! Bienvenido(a) a ${nombreNegocio}.*`;

        const horarioFisico = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'horario_sucursal_fisica'"))?.valor || '';
        let textoMenu = `${saludoHeader}\n\n¡Estamos para servirte! 🤖\n\nElige una opción:\n\n`;
        try {
            const menuRaw = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'menu_numerico'"))?.valor;
            if (menuRaw) {
                const menuOpts = JSON.parse(menuRaw);
                menuOpts.forEach(o => {
                    textoMenu += `${o.opcion}️⃣ *${o.titulo}*\n`;
                });
            } else {
                textoMenu += `1️⃣ 📋 *Catálogo / Servicios*\n2️⃣ 💰 *Precios y promociones*\n3️⃣ ⏰ *Horarios de atención*\n4️⃣ 📍 *Ubicación / Envíos*\n5️⃣ 👤 *Solicitar Asesor / Hacer pedido*\n`;
            }
        } catch(e) {
            textoMenu += `1️⃣ 📋 *Catálogo / Servicios*\n2️⃣ 💰 *Precios y promociones*\n3️⃣ ⏰ *Horarios de atención*\n4️⃣ 📍 *Ubicación / Envíos*\n5️⃣ 👤 *Solicitar Asesor / Hacer pedido*\n`;
        }
        textoMenu += `\n_Escribe el número de la opción o tu pregunta libremente y con gusto te responderé._`;

        registrarTextoEnviadoBot(textoMenu);
        const sent = await client.sendMessage(remitente, textoMenu);
        if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);

        await runQuery(
            "INSERT INTO mensajes (chat_id, emisor, emisor_nombre, cuerpo, es_mio, es_ia, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [remitente, 'bot', 'Menú Bienvenida', textoMenu, 1, 1, Date.now()]
        );
        return;
    }

    // --------------------------------------------------------------------------
    // C. SOLICITUD DIRECTA DE ASESOR / AGENDAR CITA
    // --------------------------------------------------------------------------
    let esOpcionMenuAsesor = false;
    let tituloOpcionAsesor = 'Solicitud de Asesor';
    try {
        const menuConfigRaw = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'menu_numerico'"))?.valor;
        if (menuConfigRaw) {
            const menuOpts = JSON.parse(menuConfigRaw);
            const opcionAsesorObj = menuOpts.find(o => /\b(asesor|humano|persona|agente|personal|transferir|agendar|cita|cotizaci[oó]n|cotizaciones)\b/i.test(o.titulo + ' ' + (o.respuesta || '')));
            if (opcionAsesorObj && opcionAsesorObj.opcion.toString().trim() === texto.trim()) {
                esOpcionMenuAsesor = true;
                tituloOpcionAsesor = `Menú Opción ${opcionAsesorObj.opcion}: ${opcionAsesorObj.titulo}`;
            }
        }
    } catch(e) {}

    const regexPideAsesor = /\b(asesor|humano|persona|agente|personal|transferir|agendar|cita|atenci[oó]n presencial|cotizaci[oó]n|cotizaciones)\b/i;
    
    // Pide asesor si es opción de menú o si solicita hablar con alguien/agendar cita
    const pideAsesorDirecto = esOpcionMenuAsesor || (
        regexPideAsesor.test(textoLowerNorm) && (
            textoLowerNorm.length < 40 || 
            textoLowerNorm.includes('hablar') || 
            textoLowerNorm.includes('quiero') || 
            textoLowerNorm.includes('comunicar') || 
            textoLowerNorm.includes('solicitar') ||
            textoLowerNorm.includes('con un') ||
            textoLowerNorm.includes('con una') ||
            textoLowerNorm.includes('por favor') ||
            textoLowerNorm.includes('pasar')
        )
    );

    if (pideAsesorDirecto) {
        await simularEscribiendoSeguro(msg, 1000);

        const nomSaludo = limpiarNombreParaSaludo(nombreContacto);
        const saludoPersonal = nomSaludo ? `Hola, *${nomSaludo}*.` : 'Hola, un gusto saludarte.';
        const saludoEntendido = nomSaludo ? `Entendido, *${nomSaludo}*.` : 'Entendido.';
        const horarioFisicoGlobal = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'horario_sucursal_fisica'"))?.valor || '';
        const horarioOnlineGlobal = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'horario_asesor_en_linea'"))?.valor || '';
        const difiereOnlineGlobal = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'horario_online_diferente'"))?.valor === '1';
        const horarioAtencionFinal = difiereOnlineGlobal && horarioOnlineGlobal ? horarioOnlineGlobal : horarioFisicoGlobal;

        let msjTransferido = '';

        if (estadoHorario.enReceso) {
            if (estadoHorario.esFestivo) {
                msjTransferido = `${iconoAsistente ? iconoAsistente + ' ' : ''}🇲🇽 *Aviso de Día Festivo / Inhábil Oficial:*\n` +
                    `${saludoPersonal} Te informamos que hoy es día festivo oficial con suspensión de labores presenciales (*${estadoHorario.motivoReceso}*).\n\n` +
                    `🗓️ Tu solicitud para atención personalizada ha quedado registrada en nuestra **Lista de Espera Prioritaria**. nuestro equipo se comunicará contigo **${estadoHorario.proximoTexto}**.\n\n` +
                    `💬 *¡El asistente virtual sigue 100% activo en este chat!* Puedo resolverte al instante cualquier duda sobre el catálogo, productos, precios o disponibilidad. ¡Con gusto te ayudo de inmediato! ☺️`;
            } else if (estadoHorario.esCurso) {
                msjTransferido = `${iconoAsistente ? iconoAsistente + ' ' : ''}🎓 *Aviso de Capacitación / Actualización:*\n` +
                    `${saludoPersonal} En este momento nuestro equipo se encuentra en jornadas de capacitación continua (*${estadoHorario.motivoReceso}*) para brindarte el mejor servicio.\n\n` +
                    `🗓️ Tu solicitud para atención personalizada ha quedado registrada en nuestra **Lista de Espera Prioritaria**. nuestro equipo se comunicará contigo **${estadoHorario.proximoTexto}**.\n\n` +
                    `💬 *¡El asistente virtual sigue 100% activo en este chat!* Puedo resolverte cualquier duda sobre el catálogo, productos, precios o disponibilidad. ¡Con gusto te ayudo! ☺️`;
            } else {
                msjTransferido = `${iconoAsistente ? iconoAsistente + ' ' : ''}🌴 *Aviso de Receso / Vacaciones:*\n` +
                    `${saludoPersonal} Por el momento nuestro personal se encuentra en receso (*${estadoHorario.motivoReceso}*).\n\n` +
                    `🗓️ Tu solicitud para atención personalizada ha quedado registrada en espera. El equipo de atención se comunicará contigo **${estadoHorario.proximoTexto}**.\n\n` +
                    `💬 *¡El asistente virtual sigue 100% activo 24/7!* Con gusto puedo resolver cualquier duda sobre el catálogo, productos o precios.`;
            }
        } else if (!estadoHorario.enHorario) {
            msjTransferido = `${iconoAsistente ? iconoAsistente + ' ' : ''}⏰ *Fuera de Horario de Atención en Línea:*\n` +
                `${saludoPersonal} Nuestro horario de atención en línea es: ${horarioAtencionFinal || 'en nuestro horario habitual'}.\n\n` +
                `🕒 Tu solicitud ha quedado registrada. Nuestro equipo te responderá y atenderá **${estadoHorario.proximoTexto}**.`;
        } else {
            msjTransferido = `${iconoAsistente ? iconoAsistente + ' ' : ''}👨‍⚕️ ${saludoEntendido} He notificado a nuestro equipo de ${nombreNegocio} por este chat.\n\n` +
                `🕒 Nuestro equipo en turno revisará tus mensajes y te responderá por aquí en cuanto se desocupe.\n\n` +
                `📌 *Nota importante:* Es posible que nuestro equipo tarde un momento en responderte ya que pueden estar atendiendo a otros clientes.`;
        }

        // Si el cliente aún no tiene su nombre registrado o no ha llenado el formulario de privacidad:
        if (!nombreContacto || nombreContacto === 'Cliente' || nombreContacto.startsWith('Cliente (+')) {
            msjTransferido += `\n\n📋 *Para agilizar tu turno al reanudar:* Si aún no has llenado tu registro previo, por favor completa este enlace:\n👉 ${enlacePrivacidad}\n\n✍️ Y escríbenos aquí tu *Nombre Completo* para apartar tu lugar en la lista.`;
            chatsEsperandoNombre.set(remitente, Date.now());
        }

        msjTransferido += `\n\n_Mientras tanto, el asistente virtual se mantiene activo 24/7 por si deseas consultar nuestros servicios, requisitos o disponibilidad._`;

        registrarTextoEnviadoBot(msjTransferido);
        const sent = await client.sendMessage(remitente, msjTransferido);
        if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);

        // Guardar respuesta del bot en SQLite y emitir al panel en tiempo real
        await runQuery(
            "INSERT INTO mensajes (chat_id, emisor, emisor_nombre, cuerpo, tipo, es_mio, es_ia, timestamp) VALUES (?, ?, ?, ?, 'chat', 1, 1, ?)",
            [remitente, 'bot', 'Asistente IA', msjTransferido, Date.now()]
        );
        io.emit('nuevo_mensaje', {
            chat_id: remitente,
            emisor: 'bot',
            emisor_nombre: 'Asistente IA',
            cuerpo: msjTransferido,
            tipo: 'chat',
            es_mio: 1,
            es_ia: 1,
            timestamp: Date.now()
        });

        // Registrar SIEMPRE en solicitudes pendientes de asesor para que aparezca en el panel (tanto en turno como fuera de horario)
        try {
            const telLimpio = telefonoReal && !telefonoReal.startsWith('1660') ? telefonoReal : remitente.replace(/[^0-9]/g, '');
            const yaExiste = await getQuery("SELECT id FROM solicitudes_asesor WHERE (jid = ? OR telefono LIKE ?) AND estado = 'pendiente'", [remitente, `%${telLimpio}%`]);
            if (!yaExiste) {
                await runQuery(
                    "INSERT INTO solicitudes_asesor (jid, telefono, nombre, motivo, fecha_hora, timestamp, estado) VALUES (?, ?, ?, ?, ?, ?, 'pendiente')",
                    [remitente, telLimpio, (nombreContacto && nombreContacto !== 'Cliente') ? nombreContacto : 'Cliente', (esOpcionMenuAsesor ? tituloOpcionAsesor : texto), obtenerFechaHoraLocal(), Date.now()]
                );
                io.emit('solicitud_asesor_actualizada');
            }
        } catch(eSol) {
            console.error("Error al registrar solicitud de asesor:", eSol.message);
        }

        return;
    }


    // --------------------------------------------------------------------------
    // D. EVALUACIÓN DE OPCIONES DEL MENÚ NUMÉRICO (1, 2, 3...)
    // --------------------------------------------------------------------------
    try {
        const menuConfigRaw = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'menu_numerico'"))?.valor;
        if (menuConfigRaw) {
            const menuOpciones = JSON.parse(menuConfigRaw);
            const opcionEncontrada = menuOpciones.find(o => o.opcion && o.opcion.toString().trim() === texto.trim());
            if (opcionEncontrada) {
                await simularEscribiendoSeguro(msg, 1000);

                let respMenu = `${iconoAsistente ? iconoAsistente + ' ' : ''}📌 *${opcionEncontrada.titulo}*\n\n${opcionEncontrada.respuesta}`;
                if (opcionEncontrada.enlace) {
                    respMenu += `\n\n🔗 ${opcionEncontrada.enlace}`;
                }

                registrarTextoEnviadoBot(respMenu);
                const sent = await client.sendMessage(remitente, respMenu);
                if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);

                await runQuery(
                    "INSERT INTO mensajes (chat_id, emisor, emisor_nombre, cuerpo, es_mio, es_ia, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [remitente, 'bot', 'Menú Interactivo', respMenu, 1, 1, Date.now()]
                );

                io.emit('nuevo_mensaje', {
                    chat_id: remitente,
                    emisor: 'bot',
                    emisor_nombre: 'Menú Interactivo',
                    cuerpo: respMenu,
                    es_mio: 1,
                    es_ia: 1,
                    timestamp: Date.now()
                });

                // Si la opción seleccionada es específicamente para solicitar asesor o humano, registrar la solicitud
                const esOpcionAsesor = /\b(asesor|humano|persona|agente|personal|transferir|agendar|cita)\b/i.test(opcionEncontrada.titulo + ' ' + opcionEncontrada.respuesta);
                if (esOpcionAsesor) {
                    try {
                        const telLimpio = telefonoReal && !telefonoReal.startsWith('1660') ? telefonoReal : remitente.replace(/[^0-9]/g, '');
                        const yaExiste = await getQuery("SELECT id FROM solicitudes_asesor WHERE (jid = ? OR telefono LIKE ?) AND estado = 'pendiente'", [remitente, `%${telLimpio}%`]);
                        if (!yaExiste) {
                            await runQuery(
                                "INSERT INTO solicitudes_asesor (jid, telefono, nombre, motivo, fecha_hora, timestamp, estado) VALUES (?, ?, ?, ?, ?, ?, 'pendiente')",
                                [remitente, telLimpio, (nombreContacto && nombreContacto !== 'Cliente') ? nombreContacto : 'Cliente', `Menú Opción ${opcionEncontrada.opcion}: ${opcionEncontrada.titulo}`, obtenerFechaHoraLocal(), Date.now()]
                            );
                            io.emit('solicitud_asesor_actualizada');
                        }
                    } catch(eSol) {}
                }

                return;
            }
        }
    } catch (errMenu) {}

    // --------------------------------------------------------------------------
    // 2. EVALUACIÓN Y ENVÍO AUTOMÁTICO DE INFOGRAFÍAS Y FOTOGRAFÍAS (.png, .jpg)
    // --------------------------------------------------------------------------
    const infografiasEnviadasMemoria = global.infografiasEnviadasMemoria || (global.infografiasEnviadasMemoria = new Set());

    async function enviarImagenSiExiste(palabraClave, captionTitulo) {
        const claveTracking = `${remitente}_${palabraClave}`;
        const pideExplicito = textoLowerNorm.includes('ver') || textoLowerNorm.includes('imagen') || textoLowerNorm.includes('foto') || textoLowerNorm.includes('infografia') || textoLowerNorm.includes('infografía');
        if (infografiasEnviadasMemoria.has(claveTracking) && !pideExplicito) return false;

        const extensiones = ['.png', '.jpg', '.jpeg', '.webp'];
        for (const ext of extensiones) {
            const ruta = path.join(DIR_IMAGENES, `${palabraClave}${ext}`);
            if (fs.existsSync(ruta)) {
                try {
                    const media = MessageMedia.fromFilePath(ruta);
                    const sent = await client.sendMessage(remitente, media, { caption: captionTitulo || `🖼️ *${palabraClave.toUpperCase()}*` });
                    if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                    infografiasEnviadasMemoria.add(claveTracking);
                    return true;
                } catch(e) {
                    console.error("Error al enviar imagen:", e.message);
                }
            }
        }
        return false;
    }

    // Auto-detección dinámica de cualquier imagen en la carpeta según las palabras del cliente
    try {
        if (fs.existsSync(DIR_IMAGENES)) {
            const archivosGaleria = fs.readdirSync(DIR_IMAGENES);
            for (const archivo of archivosGaleria) {
                const parsed = path.parse(archivo);
                const baseName = parsed.name.toLowerCase(); // ej: 'promocion', 'vasectomia', 'calzado'
                // Si el mensaje incluye el nombre completo del archivo (sin guiones/guiones bajos)
                const nombreNormalizado = baseName.replace(/[-_]+/g, ' ');
                const coincide = textoLowerNorm.includes(nombreNormalizado) || textoLowerNorm.includes(baseName);
                if (coincide) {
                    const tituloLimpio = nombreNormalizado.toUpperCase();
                    await enviarImagenSiExiste(parsed.name, `🖼️ *${tituloLimpio}*`);
                }
            }
        }
    } catch (errGaleria) {
        console.error("Error buscando imágenes automáticas:", errGaleria);
    }

    // Las imágenes se detectan automáticamente por nombre de archivo (sistema auto-detección arriba).
    // Para añadir imágenes por palabra clave, configúralas en el panel → Infografías, o
    // sube archivos a /imagenes con nombres descriptivos (ej: "uniforme_quirurgico.jpg", "calzado_enfermeria.jpg").
    if (textoLowerNorm.includes('catalogo') || textoLowerNorm.includes('catálogo') || textoLowerNorm.includes('productos')) {
        await enviarImagenSiExiste('catalogo', '🖼️ *Catálogo de Productos*');
        await enviarImagenSiExiste('catalogo_general', '🖼️ *Catálogo General*');
    } else if (textoLowerNorm.includes('promocion') || textoLowerNorm.includes('promociones') || textoLowerNorm.includes('promo') || textoLowerNorm.includes('descuento') || textoLowerNorm.includes('oferta')) {
        await enviarImagenSiExiste('promociones', '🎉 *Nuestras Promociones y Descuentos*');
        await enviarImagenSiExiste('promocion', '🎉 *Nuestras Promociones y Descuentos*');
    }

    try {
        const infografiasRaw = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'infografias_config'"))?.valor;
        if (infografiasRaw) {
            const infografias = JSON.parse(infografiasRaw);
            const infoEncontrada = infografias.find(item => 
                item.palabras && item.palabras.some(p => textoLowerNorm.includes(p.toLowerCase().trim()))
            );

            if (infoEncontrada) {
                const chat = await msg.getChat();
                await chat.sendStateTyping();
                await delay(1500);

                let respInfo = `🖼️ ${infoEncontrada.respuesta}`;
                if (infoEncontrada.enlace) {
                    respInfo += `\n\n🔗 Ver documento / imagen: ${infoEncontrada.enlace}`;
                }

                const sent = await msg.reply(respInfo);
                if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);

                await runQuery(
                    "INSERT INTO mensajes (chat_id, emisor, emisor_nombre, cuerpo, es_mio, es_ia, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [remitente, 'bot', 'Infografía IA', respInfo, 1, 1, Date.now()]
                );
                return;
            }
        }
    } catch (errInfo) {}

    // --------------------------------------------------------------------------
    // 3. GENERACIÓN DE RESPUESTA CON GEMINI AI (MODELOS DINÁMICOS Y API KEY PROPIA)
    // --------------------------------------------------------------------------
    try {
        const customApiKey = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'gemini_api_key'"))?.valor;
        const activeKey = (customApiKey && customApiKey.trim()) ? customApiKey.trim() : geminiApiKey;
        if (!activeKey) return;

        const aiClient = new GoogleGenerativeAI(activeKey);




        const configPrompt = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'prompt_ia'"))?.valor || 'Eres un asistente cordial.';
        const catalogo = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'catalogo_servicios'"))?.valor || '';
        const datosBancos = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'datos_bancarios'"))?.valor || '';
        const ubicacion = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'ubicacion_direccion'"))?.valor || '';
        const mapsLink = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'ubicacion_maps_link'"))?.valor || '';
        const horarioFisico = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'horario_sucursal_fisica'"))?.valor || '';
        const horarioOnline = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'horario_asesor_en_linea'"))?.valor || '';
        const difiereOnline = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'horario_online_diferente'"))?.valor === '1';
        const horarioAtencionFinal = difiereOnline && horarioOnline ? horarioOnline : horarioFisico;
        
        const menuConfigRawIA = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'menu_numerico'"))?.valor;
        let textoOpcionesMenuIA = '';
        if (menuConfigRawIA) {
            try {
                const menuOpts = JSON.parse(menuConfigRawIA);
                menuOpts.forEach(o => {
                    if (o.titulo) textoOpcionesMenuIA += `- Opción ${o.opcion}: ${o.titulo} | Respuesta: ${o.respuesta || ''} | Enlace exacto: ${o.enlace || 'Ninguno'}\n`;
                });
            } catch(e) {}
        }
        
        // Estado de ausencia gestionado en reglaHorarioIA (bloque único, sin redundancias)

        // Historial reciente de la conversación (unificando por JID y teléfono)
        const telUltimos8H = (telefonoReal && telefonoReal.length >= 8 && !telefonoReal.startsWith('1660')) ? telefonoReal.slice(-8) : '';
        const ultimosMensajes = await allQuery(`
            SELECT id, emisor, emisor_nombre, cuerpo, es_mio, es_ia, timestamp 
            FROM mensajes 
            WHERE (chat_id = ? OR (? != '' AND chat_id LIKE ?))
              AND cuerpo NOT LIKE '%e2e_notification%'
            ORDER BY id DESC 
            LIMIT 16
        `, [remitente, telUltimos8H, `%${telUltimos8H}%`]);

        // Evitar duplicar en el historial el mensaje que acaba de enviar el cliente
        const historialSinUltimo = (ultimosMensajes.length > 0 && !ultimosMensajes[0].es_mio) ? ultimosMensajes.slice(1) : ultimosMensajes;
        let contextoHistorial = historialSinUltimo.reverse().map(m => {
            let txt = m.cuerpo || '';
            if (txt.startsWith('/9j/') || txt.startsWith('data:image')) txt = '📷 (Infografía / Imagen enviada)';
            let emisorTag = 'Cliente';
            if (m.es_mio) {
                emisorTag = (m.emisor_nombre === 'Asesor Humano' || m.emisor === 'yo') ? 'Asesor Humano' : 'Asistente IA';
            }
            return `${emisorTag}: ${txt}`;
        }).join('\n');

// Cache para Google Sheets en vivo (TTL de 60 segundos)
let cacheGoogleSheets = { url: '', contenido: '', timestamp: 0 };
async function obtenerContenidoGoogleSheets(url) {
    if (!url || !url.trim()) return '';
    try {
        if (cacheGoogleSheets.url === url && (Date.now() - cacheGoogleSheets.timestamp < 60000)) {
            return cacheGoogleSheets.contenido;
        }
        let csvUrl = url.trim();
        if (csvUrl.includes('docs.google.com/spreadsheets') && !csvUrl.includes('output=csv') && !csvUrl.includes('format=csv')) {
            const match = csvUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
            if (match && match[1]) {
                csvUrl = `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv`;
            }
        }
        const resp = await fetch(csvUrl);
        if (!resp.ok) return '';
        const textoCsv = await resp.text();
        cacheGoogleSheets = { url, contenido: textoCsv, timestamp: Date.now() };
        return textoCsv;
    } catch (e) {
        console.error("Error al consultar Google Sheets en vivo:", e.message);
        return '';
    }
}

        // Carga de Documentos Externos de Conocimiento (PDFs, TXT, Catálogos)
        let textoDocumentosAdicionales = '';
        const dirDocs = path.join(__dirname, 'documentos');
        if (fs.existsSync(dirDocs)) {
            const archivos = fs.readdirSync(dirDocs);
            for (const arch of archivos) {
                const rutaArch = path.join(dirDocs, arch);
                if (arch.endsWith('.txt') || arch.endsWith('.csv') || arch.endsWith('.md')) {
                    try {
                        textoDocumentosAdicionales += `\n--- CONTENIDO DOCUMENTO ${arch} ---\n` + fs.readFileSync(rutaArch, 'utf8');
                    } catch (e) {}
                }
            }
        }

        // Carga de Inventario en Vivo desde Google Sheets
        const googleSheetsUrl = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_sheets_url'"))?.valor;
        if (googleSheetsUrl) {
            const contenidoSheets = await obtenerContenidoGoogleSheets(googleSheetsUrl);
            if (contenidoSheets) {
                textoDocumentosAdicionales += `\n\n--- INVENTARIO Y PRECIOS EN VIVO (GOOGLE SHEETS) ---\n` + contenidoSheets;
            }
        }

        let reglaHorarioIA = '';
        if (estadoHorario.enReceso) {
            if (estadoHorario.esFestivo) {
                reglaHorarioIA = `
🇲🇽 ESTADO DE DÍA FESTIVO OFICIAL / INHÁBIL:
- Con motivo de: "${estadoHorario.motivoReceso}".
- REGLAS DE ATENCIÓN CON IA:
  1. ¡HAZ TU TRABAJO NORMAL! Responde con calidez y detalle cualquier duda sobre los productos, servicios o catálogo del negocio, costos, disponibilidad y requisitos.
  2. NO menciones que hoy es festivo de forma proactiva a menos que el cliente pida un turno presencial, una cita o hablar con una persona.
  3. SÓLO si el cliente pide turno presencial o asesor humano, aclara que la atención humana se reanuda ${estadoHorario.proximoTexto} por día festivo oficial, y que queda anotado(a) en la Lista de Espera Prioritaria.
  4. PROHIBIDO ofrecer un asesor para hoy; la atención humana será hasta ${estadoHorario.proximoTexto}.`;
            } else if (estadoHorario.esCurso) {
                reglaHorarioIA = `
🎓 ESTADO DE CAPACITACIÓN / CONGRESO MÉDICO:
- El equipo de atención se encuentra en: "${estadoHorario.motivoReceso}".
- REGLAS DE ATENCIÓN CON IA:
  1. ¡HAZ TU TRABAJO NORMAL! Responde de inmediato cualquier duda sobre el catálogo, productos, servicios, costos y disponibilidad.
  2. NO menciones que el equipo está en capacitación a menos que el cliente pida un turno presencial o hablar con el personal.
  3. SÓLO si solicita turno presencial o hablar con un asesor, explica que el equipo se encuentra en actualización continua y que la atención humana se reanuda ${estadoHorario.proximoTexto}, dejándolo anotado en la Lista de Espera Prioritaria.
  4. PROHIBIDO ofrecer un asesor para hoy; la atención humana será hasta ${estadoHorario.proximoTexto}.`;
            } else {
                reglaHorarioIA = `
🔴 ESTADO DE RECESO / VACACIONES:
- Personal en receso debido a: "${estadoHorario.motivoReceso}".
- REGLA: Responde normalmente las dudas sobre el catálogo. SÓLO si pide cita o asesor, aclara que se reanudan ${estadoHorario.proximoTexto}.`;
            }
        } else if (!estadoHorario.enHorario) {
            reglaHorarioIA = `
🔴 ESTADO DE HORARIO DE ATENCIÓN (FUERA DE HORARIO DE ATENCIÓN POR CHAT):
- Fecha y hora actual en México: ${obtenerFechaHoraLocal()}.
- Actualmente estamos FUERA del horario en que el personal humano responde mensajes por este chat. El personal responderá mensajes por WhatsApp: ${estadoHorario.proximoTexto}.
- REGLAS ESTRICTAS DE HORARIO Y CITAS (NO CONFUNDIR ATENCIÓN EN LÍNEA CON ATENCIÓN FÍSICA):
  1. NUNCA le digas al cliente que puede acudir o presentarse físicamente sin haber coordinado previamente por este chat.
  2. Aclara que el horario de atención en línea (${horarioAtencionFinal || 'el horario habitual de atención'}) es para responder dudas por WhatsApp y atención humana.
  3. Para cualquier atención presencial, el cliente debe tener una cita confirmada.
  4. Adviértele amablemente que no visite las instalaciones sin haber coordinado previamente.
  5. SI CUENTAS CON EL MÓDULO DE AGENDAMIENTO AUTOMÁTICO (lee más abajo), puedes ofrecerle los horarios disponibles y agendar su cita de inmediato. Si NO cuentas con disponibilidad, confírmale que su solicitud quedó registrada para coordinarla en cuanto el personal inicie su turno.`;
        } else {
            reglaHorarioIA = `
🟢 ESTADO DE HORARIO DE ATENCIÓN (DENTRO DE HORARIO DE CHAT):
- Fecha y hora actual en México: ${obtenerFechaHoraLocal()}.
- Actualmente el equipo humano del negocio está EN TURNO atendiendo mensajes por este chat.
- REGLA DE CONTINUIDAD: Responde tú con calidez y precisión cualquier duda del cliente sobre el catálogo, productos, servicios, requisitos y disponibilidad. NUNCA le digas que 'escriba asesor' o que 'hable con un asesor' si tú tienes la información para resolver su duda o si la conversación ya está en curso.`;
        }

        const etiquetasBD = await allQuery("SELECT e.nombre FROM etiquetas e INNER JOIN contactos_etiquetas ce ON e.id = ce.etiqueta_id WHERE ce.jid = ?", [msg.from]);
        const listaEtiquetas = etiquetasBD.map(e => e.nombre);
        const tagsString = listaEtiquetas.length > 0 ? listaEtiquetas.join(', ') : 'Ninguna';
        const tieneExpediente = listaEtiquetas.some(t => t.toLowerCase().includes('expediente') || t.toLowerCase().includes('privacidad'));

        const nomLimpioIA = limpiarNombreParaSaludo(nombreContacto);
        const instruccionNombreBase = nomLimpioIA
            ? `- Nombre del cliente: ${nomLimpioIA} (Usa su nombre de pila con naturalidad y calidez cuando sea oportuno).`
            : `- Nombre del cliente: No especificado (REGLA ESTRICTA: NO utilices n�meros, c�digos alfanum�ricos, tel�fonos, emojis ni identificadores para llamarlo o saludarlo; dir�gete a �l con calidez o ll�malo "estimado(a)").`;

        const telDelContacto = (contacto && contacto.telefono && contacto.telefono.length >= 10 && !contacto.telefono.includes('@lid')) ? contacto.telefono.replace(/[^0-9]/g, '') : '';
        const instruccionTelefono = telDelContacto.length >= 10 && !telDelContacto.startsWith('2047')
            ? `\n- Tel�fono registrado del cliente: ${telDelContacto}. Ya cuentas con su tel�fono en tu base de datos, NO SE LO PIDAS para agendar citas. Usa este n�mero directo en la etiqueta.`
            : `\n- Tel�fono del cliente: No registrado en BD. Es obligatorio ped�rselo antes de agendar.`;

        const instruccionNombre = instruccionNombreBase + instruccionTelefono;

        const reglaHorarioBase = estadoHorario.enReceso
            ? `3. REGLA ESTRICTA POR ${estadoHorario.esFestivo ? 'DÍA FESTIVO OFICIAL' : (estadoHorario.esCurso ? 'capacitación' : 'RECESO')}: Actualmente ${estadoHorario.esFestivo ? 'es día festivo oficial no laborable' : (estadoHorario.esCurso ? 'el equipo de atención se encuentra en jornadas de capacitación' : 'el personal se encuentra en receso vacacional')}. Las citas presenciales y la agenda se reanudan: ${estadoHorario.proximoTexto}. PROHIBIDO TERMINANTEMENTE decir que el personal atenderá a las 2:00 PM de hoy mientras estemos en festivo/receso.`
            : `3. El horario configurado (${horarioAtencionFinal || 'el horario habitual de atención'}) es de ATENCIÓN EN LÍNEA POR WHATSAPP para resolver dudas y coordinar citas o pedidos.`;

        // Módulo Universal de Agendamiento Automatizado con Google Calendar
        const moduloAgendaActivo = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'modulo_agenda_activo'"))?.valor === '1';
        const calIdConfig = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_calendar_id'"))?.valor;
        const credsConfig = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_service_account_json'"))?.valor;
        const duracionCitaConfig = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'agenda_duracion_cita'"))?.valor || 30;
        const bufferMinConfig = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'agenda_buffer_minutos'"))?.valor || 10;
        const timezoneNegocio = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'timezone'"))?.valor || 'America/Mexico_City';

        let seccionAgendaIA = '';
        const textoBusquedaCitas = (texto || '').toLowerCase();
        const consultaCitas = /cita|citas|agend|turno|apart|horario|disponib|reserv|reprogram|cancelar/.test(textoBusquedaCitas);

        if (moduloAgendaActivo && calIdConfig && credsConfig) {
            let disponibilidadContexto = '';
            if (consultaCitas) {
                try {
                    const fechasConsultar = calendarService.resolverFechasRelevantes(texto, timezoneNegocio, 3);
                    const turno1_inicio = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'agenda_turno1_inicio'"))?.valor || (await getQuery("SELECT valor FROM configuracion WHERE clave = 'hora_inicio_semana'"))?.valor || '14:00';
                    const turno1_fin = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'agenda_turno1_fin'"))?.valor || '17:00';
                    const turno2_activo = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'agenda_turno2_activo'"))?.valor === '1';
                    const turno2_inicio = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'agenda_turno2_inicio'"))?.valor || '18:00';
                    const turno2_fin = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'agenda_turno2_fin'"))?.valor || (await getQuery("SELECT valor FROM configuracion WHERE clave = 'hora_fin_semana'"))?.valor || '20:00';
                    const sabado_activo = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'agenda_sabado_activo'"))?.valor !== '0';
                    const sabado_inicio = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'agenda_sabado_inicio'"))?.valor || (await getQuery("SELECT valor FROM configuracion WHERE clave = 'hora_inicio_sab'"))?.valor || '09:00';
                    const sabado_fin = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'agenda_sabado_fin'"))?.valor || (await getQuery("SELECT valor FROM configuracion WHERE clave = 'hora_fin_sab'"))?.valor || '14:00';
                    const domingo_activo = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'agenda_domingo_activo'"))?.valor === '1';

                    const citasLocales = await allQuery("SELECT fecha, hora FROM citas_agenda WHERE fecha IN (" + fechasConsultar.map(() => '?').join(',') + ") AND estado != 'Cancelada'", fechasConsultar);

                    disponibilidadContexto = await calendarService.obtenerContextoDisponibilidadParaPrompt({
                        calendarId: calIdConfig,
                        credentials: credsConfig,
                        fechas: fechasConsultar,
                        duracionMinutos: isNaN(parseInt(duracionCitaConfig)) ? 30 : parseInt(duracionCitaConfig),
                        bufferMinutos: isNaN(parseInt(bufferMinConfig)) ? 10 : parseInt(bufferMinConfig),
                        timezone: timezoneNegocio,
                        horarioLaboral: {
                            turno1_inicio,
                            turno1_fin,
                            turno2_activo,
                            turno2_inicio,
                            turno2_fin,
                            sabado_activo,
                            sabado_inicio,
                            sabado_fin,
                            atiendeSabado: sabado_activo,
                            atiendeDomingo: domingo_activo
                        },
                        citasLocalesOcupadas: citasLocales
                    });
                } catch (eDisp) {
                    console.warn("⚠️ Error al obtener disponibilidad para IA:", eDisp.message);
                }
            }

            seccionAgendaIA = `
  ?? SISTEMA DE AGENDAMIENTO AUTOMATIZADO CON GOOGLE CALENDAR (ACTIVO):
  Cuentas con sincronizaci�n en vivo con Google Calendar.
  ${disponibilidadContexto ? `DISPONIBILIDAD REAL EN GOOGLE CALENDAR:\n${disponibilidadContexto}\n` : ''}
  
  ?? CANDADO DE SEGURIDAD PARA CITAS (ESTRICTO):
  ${tieneExpediente 
    ? `? EL PACIENTE CUENTA CON EXPEDIENTE/AVISO FIRMADO. TIENES PERMISO PARA AGENDAR.\nREGLAS ESTRICTAS DE AGENDAMIENTO:\n1. Si el cliente solicita una cita, DEBES ofrecer 3 o 4 opciones de los horarios reales mostrados arriba. NUNCA inventes horarios.
2. UNA VEZ QUE EL CLIENTE ELIJA UN HORARIO, es ESTRICTAMENTE OBLIGATORIO que re�nas los siguientes datos ANTES de dar por agendada la cita: Su Nombre completo, N�mero de Expediente (si lo tiene), N�mero de tel�fono (si no lo tienes registrado arriba), y Motivo de la consulta. P�dele �nicamente los datos que te falten.
3. CUANDO EL CLIENTE YA TE HAYA ESCRITO ESOS DATOS, conf�rmale la cita e INCLUYE obligatoriamente al final de tu mensaje esta etiqueta oculta (respeta las barras |):
   [AGENDAR_CITA: YYYY-MM-DD|HH:MM|Nombre Completo proporcionado|Motivo de consulta|Expediente: {numero}, Tel: {telefono}]
   (Ejemplo: [AGENDAR_CITA: 2026-09-24|17:30|Maria Lopez|Revision de DIU|Exp: 1234, Tel: 5551234567])
3. Si el cliente pide cancelar una cita existente, conf�rmale la cancelaci�n e incluye:
   [CANCELAR_CITA: YYYY-MM-DD]\n4. SOLO si el cliente EXPL�CITAMENTE usa las palabras 'asesor' o 'humano', incluye [REQUERIR_HUMANO]. NUNCA incluyas [REQUERIR_HUMANO] si solo piden cita.` 
    : `? ? EL PACIENTE A�N NO TIENE LA ETIQUETA 'EXPEDIENTE COMPLETO' O 'AVISO DE PRIVACIDAD'.\n
EMBUDO DE ATENCI�N (REGLAS ESTRICTAS):\n
1. SALUDOS INICIALES ("Hola", "Buen d�a"): Tienes PROHIBIDO hablar de avisos de privacidad, expedientes o requisitos de citas si el paciente solo est� saludando o haciendo una pregunta general. Solo dale la bienvenida amablemente e inv�talo a elegir una opci�n del men� num�rico o a hacer su pregunta (Ej: m�todos anticonceptivos).\n
2. RESOLUCI�N DE DUDAS: Responde sus dudas sobre m�todos o precios usando la base de conocimiento, sin mencionar requisitos de expediente.\n
3. SOLICITUD EXPL�CITA DE ASESOR: SOLO si el paciente pide hablar con un 'asesor' o 'humano', incluye [REQUERIR_HUMANO] y dile que en un momento lo atender�n. Si quieres, inv�talo amablemente a ir llenando su aviso de privacidad en este enlace: ${enlacePrivacidad}.\n
4. SOLICITUD EXPL�CITA DE CITA: SOLO si el paciente PIDE EXPL�CITAMENTE AGENDAR UNA CITA, se activa el candado: EST� ESTRICTAMENTE PROHIBIDO ofrecerle horarios o agendarle. En este �nico caso, le pedir�s que env�e sus documentos de identidad y domicilio, y que llene su aviso de privacidad en este enlace: ${enlacePrivacidad}.`}
`;
        } else {
            seccionAgendaIA = `
- REGLA DE DETECCIÓN DE CITAS (CRÍTICO): Si el usuario te confirma que desea agendar una cita, apartar un turno, o solicita hablar con el personal humano, DEBES incluir obligatoriamente la etiqueta oculta [REQUERIR_HUMANO] al final de tu mensaje. Esto le avisará al sistema que debe anotar al cliente de inmediato en el panel.`;
        }

        
        const reminderRule = `\n\n[REGLA DE RECORDATORIOS AUTOM�TICOS]\nSi en tu historial de mensajes notas que T� acabas de enviar un recordatorio de cita ("te recordamos tu cita", etc) y el usuario te est� respondiendo a ese recordatorio:\n- Si el usuario CONFIRMA la cita: Resp�ndele brevemente d�ndole las gracias y confirmando que lo esperan (no mandes todo el men� inicial de nuevo).\n- Si el usuario QUIERE CANCELAR o REAGENDAR: Resp�ndele diciendo que lamentas el inconveniente, que has dejado registrada su petici�n de cambio, y que pronto se notificar� al personal m�dico para que se comuniquen y reprogramen. Termina la conversaci�n de forma educada. No trates de reagendarlo t� mismo en este momento.\n\nIMPORTANTE: Solo aplica esta regla si la conversaci�n reciente trata sobre un recordatorio de cita.`;

        const systemInstruction = `
${configPrompt}
${reminderRule}
${reglaHorarioIA}

CLIENTE ACTUAL:
${instruccionNombre}
- Icono distintivo: ${iconoAsistente}

CATÁLOGO DE PRODUCTOS / SERVICIOS / PRECIOS:
${catalogo}

OPCIONES DE MENÚ Y ENLACES (IMPORTANTE):
El negocio tiene configuradas las siguientes opciones y enlaces rápidos en su panel. Si las instrucciones te piden proveer el enlace de un menú numérico específico, utiliza EXACTAMENTE la URL o texto de la respuesta indicada aquí. NUNCA inventes enlaces de Google Drive u otros externos si no están explícitamente aquí:
${textoOpcionesMenuIA || 'No hay opciones de menú configuradas.'}

DOCUMENTOS Y ARCHIVOS DE CONOCIMIENTO (LISTAS DE PRECIOS, INVENTARIO, MANUALES, GOOGLE SHEETS):
${textoDocumentosAdicionales}

INFORMACIÓN DE UBICACIÓN Y HORARIOS:
- Ubicación física: ${ubicacion}
- Google Maps: ${mapsLink}
- Horario de Atención en Línea (WhatsApp): ${horarioAtencionFinal}

INFORMACIÓN DE PAGOS / BANCOS:
${datosBancos}

INSTRUCCIONES CLAVE DE ATENCIÓN Y SEGURIDAD:
- REGLA DE ORO DE CITAS / TURNOS Y ATENCIÓN PRESENCIAL:
  1. Cualquier atención, entrega o servicio que requiera agenda debe realizarse CON CITA / TURNO PREVIO COORDINADO POR ESTE CHAT.
  2. NUNCA le digas al cliente que puede llegar sin un turno o cita previamente coordinada por este chat.
  ${reglaHorarioBase}
  4. Si aplica para el tipo de negocio, recuerda al cliente que ciertos servicios o atenciones presenciales requieren turno o cita previa coordinada por este chat.
- REGLA DE FLUIDEZ: Si la conversación ya está en curso (no es el primer saludo), NO repitas saludos largos o de bienvenida. Ve directo a responder la duda de forma fluida.
- REGLA DE RESPUESTAS TÉCNICAS O DE PRODUCTOS: Si te preguntan sobre detalles específicos de un producto o servicio, DEBES responder la duda con información directa y precisa basada en tu base de conocimientos.
- REGLA DE FORMATO ÚNICO: Proporciona tu respuesta completa en un texto continuo. NO dividas tu respuesta en párrafos desconectados ni saludes varias veces en el mismo mensaje.
${seccionAgendaIA}
- REGLA ESTRICTA DE CONTINUIDAD Y REANUDACIÓN TRAS INTERVENCIÓN HUMANA:
  * Si un asesor humano estuvo platicando con el cliente, toma el relevo naturalmente.
  * PROHIBICIÓN TOTAL: NO reinicies la plática ni envíes menús largos.
- REGLA ESTRICTA DE ASESORES Y HORARIO: Respeta SIEMPRE la regla de horario indicada arriba. Si estamos fuera de horario, NO ofrezcas hablar con un asesor en vivo como primera opción; responde tú la duda con el catálogo e información disponible.
- Brinda respuestas directas y concisas. Evita rodeos innecesarios.
- Si el cliente solicita cotizar o comprar, toma en cuenta los precios del catálogo y proporciona información clara.
- Si el cliente envía una imagen (foto de producto o comprobante), analízala visualmente y responde en consecuencia.
- La fecha y hora actual en México es: ${obtenerFechaHoraLocal()}.
        `;

        // Preparar contenido multimodal (Texto + Imagen)
        let promptContenido = [`Historial reciente:\n${contextoHistorial}\n\nCliente: ${texto}\nAsistente:`];

        if (msg.hasMedia) {
            try {
                const media = await msg.downloadMedia();
                if (media && media.mimetype && media.mimetype.includes('image')) {
                    promptContenido.push({
                        inlineData: {
                            data: media.data,
                            mimeType: media.mimetype
                        }
                    });
                }
            } catch (errMedia) {
                console.error("Error al procesar imagen recibida:", errMedia.message);
            }
        }

        // Auto-detección dinámica de modelos vigentes en Google AI
        const modelosDisponibles = await obtenerModelosDisponibles(activeKey);
        const modeloGuardado = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'gemini_modelo_ia'"))?.valor || 'gemini-3.6-flash';
        
        const listaModelos = Array.from(new Set([
            'gemini-3.6-flash',
            'gemini-3.1-flash-lite',
            'gemini-flash-latest',
            'gemini-3-flash-preview',
            modeloGuardado,
            ...modelosDisponibles,
            'gemini-3.5-flash',
            'gemini-3.5-flash-lite',
            'gemini-3.5-pro',
            'gemini-pro-latest'
        ])).filter(Boolean);

        let respuestaIA = null;
        let modeloExitoso = null;
        for (const modName of listaModelos) {
            let intentos = 2;
            while (intentos > 0) {
                try {
                    let model;
                    try {
                        model = aiClient.getGenerativeModel({
                            model: modName,
                            systemInstruction,
                            generationConfig: {
                                thinkingConfig: {
                                    thinkingLevel: 'low'
                                }
                            }
                        });
                    } catch (eMod) {
                        model = aiClient.getGenerativeModel({ model: modName, systemInstruction });
                    }

                    let result;
                    try {
                        const tiempoInicioIA = Date.now();
                        
                        // Envoltorio con Timeout estricto de 15 segundos para evitar retrasos de minutos
                        const fetchIA = async (modeloEval) => {
                            const promesaAPI = modeloEval.generateContent(promptContenido);
                            const promesaTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT_API_GEMINI')), 15000));
                            return await Promise.race([promesaAPI, promesaTimeout]);
                        };

                        result = await fetchIA(model);
                        
                        // Auditoría de lentitud
                        const latencia = Date.now() - tiempoInicioIA;
                        if (latencia > 10000 && typeof Auditor !== 'undefined') {
                            Auditor.registrarEvento('SISTEMA', 'Google API (' + modName + ') respondió lento: ' + (latencia/1000).toFixed(1) + 's');
                        }

                    } catch (errGen) {
                        if (errGen.message === 'TIMEOUT_API_GEMINI') {
                            console.warn('⚠️ Timeout de 15s excedido para ' + modName + '. La API de Google está colgada.');
                            if (typeof Auditor !== 'undefined') Auditor.registrarEvento('ALERTA', 'Google API (' + modName + ') excedió el tiempo límite (15s). Ignorando modelo para evitar retraso al cliente.');
                            throw errGen; // Pasa al siguiente intento o modelo
                        }

                        if (errGen.message && (errGen.message.includes('thinkingConfig') || errGen.message.includes('invalid argument'))) {
                            const modelFallback = aiClient.getGenerativeModel({ model: modName, systemInstruction });
                            const promesaFallback = modelFallback.generateContent(promptContenido);
                            const promesaTimeoutFall = new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT_API_GEMINI')), 15000));
                            result = await Promise.race([promesaFallback, promesaTimeoutFall]);
                        } else {
                            throw errGen;
                        }
                    }

                    respuestaIA = result.response.text();
                    if (respuestaIA) {
                        modeloExitoso = modName;
                        break;
                    }
                } catch (errModel) {
                    intentos--;
                    const es503o429 = errModel.message && (errModel.message.includes('503') || errModel.message.includes('429'));
                    if (intentos > 0 && es503o429) {
                        // Spikes temporales de demanda en Google AI: reintento rápido tras 500ms
                        await delay(500);
                    } else {
                        console.warn(`[Modelo ${modName} no disponible]:`, errModel.message);
                        break;
                    }
                }
            }
            if (respuestaIA) break;
        }

        if (modeloExitoso && modeloExitoso !== modeloGuardado) {
            await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('gemini_modelo_ia', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [modeloExitoso]);
            console.log(`🤖 [Auto-Reparación IA]: Modelo actualizado dinámicamente a: ${modeloExitoso}`);
        }

        // Si todos los servidores fallaron, enviamos el mensaje de emergencia cortés
        if (!respuestaIA) {
            console.warn("⚠️ Google AI experimentó saturación. Entregando respuesta local de contingencia...");
            const configObj = {
                icono_asistente: iconoAsistente,
                nombre_negocio: nombreNegocio
            };
            respuestaIA = generarRespuestaEmergencia(texto, configObj, estadoHorario);
        }

        if (respuestaIA) {
            let textoRespuestaFinal = respuestaIA.trim();

            // Interceptar etiqueta oculta de la IA para agendar cita automáticamente en Google Calendar
            const matchAgendar = textoRespuestaFinal.match(/\[AGENDAR_CITA:\s*([^\|\]]+)\|([^\|\]]+)\|([^\|\]]+)\|([^\|\]]+)(?:\|([^\]]*))?\]/);
            if (matchAgendar) {
                textoRespuestaFinal = textoRespuestaFinal.replace(matchAgendar[0], '').trim();
                try {
                    const citaFecha = matchAgendar[1].trim();
                    const citaHora = matchAgendar[2].trim();
                    const nomCliente = matchAgendar[3].trim();
                    const citaServicio = matchAgendar[4].trim();
                    const citaNotas = (matchAgendar[5] || 'Agendada por WhatsApp AI').trim();
                    const telLimpio = remitente.replace(/[^0-9]/g, '');


                    let gEventId = '';
                    let gCalId = '';
                    let gHoraFin = '';
                    let gLink = '';

                    if (moduloAgendaActivo && calIdConfig && credsConfig) {
                        const resCal = await calendarService.crearCita({
                            calendarId: calIdConfig,
                            credentials: credsConfig,
                            nombre: nomCliente,
                            telefono: telLimpio,
                            fecha: citaFecha,
                            hora: citaHora,
                            duracionMinutos: isNaN(parseInt(duracionCitaConfig)) ? 30 : parseInt(duracionCitaConfig),
                            servicio: citaServicio,
                            notas: citaNotas,
                            timezone: timezoneNegocio
                        });

                        if (resCal.success) {
                            gEventId = resCal.eventId;
                            gCalId = calIdConfig;
                            gHoraFin = resCal.horaFin;
                            gLink = resCal.htmlLink || '';
                        }
                    }

                    await runQuery(
                        `INSERT INTO citas_agenda (
                            cliente_telefono, cliente_nombre, fecha, hora, servicio, estado, notas,
                            google_event_id, google_calendar_id, hora_fin, origen, link_evento, timestamp
                        ) VALUES (?, ?, ?, ?, ?, 'Confirmada', ?, ?, ?, ?, 'ia', ?, ?)`,
                        [telLimpio, nomCliente, citaFecha, citaHora, citaServicio, citaNotas, gEventId, gCalId, gHoraFin, gLink, Date.now()]
                    );

                    console.log(`📅 [Cita IA Confirmada]: ${nomCliente} - ${citaFecha} ${citaHora} (${citaServicio})`);
                    io.emit('cita_actualizada');
                } catch (eCita) {
                    console.error("❌ Error al procesar agendamiento automático desde IA:", eCita.message);
                }
            }

            // Interceptar etiqueta oculta de cancelación de citas
            const matchCancelar = textoRespuestaFinal.match(/\[CANCELAR_CITA:\s*([^\]]+)\]/);
            if (matchCancelar) {
                textoRespuestaFinal = textoRespuestaFinal.replace(matchCancelar[0], '').trim();
                try {
                    const fechaCancel = matchCancelar[1].trim();
                    const telLimpio = remitente.replace(/[^0-9]/g, '');
                    const citaExistente = await getQuery(
                        "SELECT * FROM citas_agenda WHERE (cliente_telefono LIKE ? OR cliente_telefono = ?) AND (fecha = ? OR ? = '') AND estado != 'Cancelada' ORDER BY fecha DESC LIMIT 1",
                        [`%${telLimpio.slice(-8)}%`, telLimpio, fechaCancel, fechaCancel]
                    );

                    if (citaExistente) {
                        if (citaExistente.google_event_id && citaExistente.google_calendar_id && credsConfig) {
                            try {
                                await calendarService.cancelarCita({
                                    calendarId: citaExistente.google_calendar_id,
                                    credentials: credsConfig,
                                    eventId: citaExistente.google_event_id
                                });
                            } catch (eCanCal) {
                                console.warn("Aviso al cancelar evento en Google Calendar desde IA:", eCanCal.message);
                            }
                        }
                        await runQuery("UPDATE citas_agenda SET estado = 'Cancelada' WHERE id = ?", [citaExistente.id]);
                        console.log(`🚫 [Cita Cancelada vía IA]: ID ${citaExistente.id} para ${citaExistente.cliente_nombre}`);
                        io.emit('cita_actualizada');
                    }
                } catch (eCan) {
                    console.error("Error al cancelar cita desde IA:", eCan.message);
                }
            }

            // Interceptar etiqueta oculta de la IA para registrar cita/asesor humano automáticamente
            if (textoRespuestaFinal.includes('[REQUERIR_HUMANO]')) {
                textoRespuestaFinal = textoRespuestaFinal.replace(/\[REQUERIR_HUMANO\]/g, '').trim();
                try {
                    const telLimpioIA = remitente.replace(/[^0-9]/g, '');
                    // Buscar si ya existe la solicitud pendiente
                    const yaExisteIA = await getQuery("SELECT id FROM solicitudes_asesor WHERE (jid = ? OR telefono LIKE ?) AND estado = 'pendiente'", [remitente, `%${telLimpioIA}%`]);
                    if (!yaExisteIA) {
                        const nomContactoIA = (nombreContacto && nombreContacto !== 'Cliente') ? nombreContacto : (pushname || 'Cliente / Cliente');
                        await runQuery(
                            "INSERT INTO solicitudes_asesor (jid, telefono, nombre, motivo, fecha_hora, timestamp, estado) VALUES (?, ?, ?, ?, ?, ?, 'pendiente')",
                            [remitente, telLimpioIA, nomContactoIA, 'Cita/Asesor (Detectado por IA)', obtenerFechaHoraLocal(), Date.now()]
                        );
                        // Emitir al SuperAdmin en tiempo real
                        io.emit('solicitud_asesor_actualizada');
                    }
                } catch(eIA) {
                    console.error("Error al registrar solicitud de asesor desde IA:", eIA.message);
                }
            }

            if (iconoAsistente && !textoRespuestaFinal.startsWith(iconoAsistente)) {
                textoRespuestaFinal = `${iconoAsistente} ${textoRespuestaFinal}`;
            }
            // Registrar texto y destinatario antes de enviar para garantizar que coincida en message_create y no auto-pause
            registrarEnvioBot(remitente, textoRespuestaFinal);

            // Simulación de escritura humana anti-ban
            await simularEscribiendoSeguro(msg, Math.min(Math.max(textoRespuestaFinal.length * 20, 1500), 3500));

            const sent = await client.sendMessage(remitente, textoRespuestaFinal);
            if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);

            // Guardar respuesta de IA en base de datos
            await runQuery(
                "INSERT INTO mensajes (chat_id, emisor, emisor_nombre, cuerpo, tipo, es_mio, es_ia, timestamp) VALUES (?, ?, ?, ?, 'chat', 1, 1, ?)",
                [remitente, 'bot', 'Asistente IA', textoRespuestaFinal, Date.now()]
            );

            io.emit('nuevo_mensaje', {
                chat_id: remitente,
                emisor: 'bot',
                emisor_nombre: 'Asistente IA',
                cuerpo: textoRespuestaFinal,
                tipo: 'chat',
                es_mio: 1,
                es_ia: 1,
                timestamp: Date.now()
            });
        }
    } catch (e) {
        console.error("Error al procesar con IA:", e.message);
    }
    } catch (errGlobalMsg) {
        console.error("Error no fatal en procesamiento de mensaje:", errGlobalMsg.message);
    } finally {
        if (remitente) chatsEnProceso.delete(remitente);
    }
}

// ------------------------------------------------------------------------------
// WORKER CRON SEGURO: PROCESAMIENTO AUTOMÁTICO DE SEGUIMIENTOS DIARIOS
// ------------------------------------------------------------------------------
async function procesarSeguimientosAutomaticos() {
    try {
        if (!wsClienteConectado || !client) return;

        const ahoraMX = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
        const horaActual = `${String(ahoraMX.getHours()).padStart(2, '0')}:${String(ahoraMX.getMinutes()).padStart(2, '0')}`;
        const fechaHoyStr = ahoraMX.toLocaleDateString('es-MX');

        // Buscar reglas automáticas activas
        const reglas = await allQuery("SELECT * FROM reglas_seguimiento WHERE activo = 1 AND modo_envio = 'automatico'");
        if (!reglas || reglas.length === 0) return;

        const nombreNegocio = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'nombre_negocio'"))?.valor || 'nuestro negocio';

        for (const r of reglas) {
            const horaRegla = r.hora_envio || '10:30';
            const [hRegla, mRegla] = horaRegla.split(':').map(Number);
            const [hActual, mActual] = horaActual.split(':').map(Number);
            
            const minDiff = Math.abs((hActual * 60 + mActual) - (hRegla * 60 + mRegla));
            if (minDiff > 25) continue; // Solo procesar en la ventana horaria

            let contactosCandidatos = [];
            if (r.etiqueta_id) {
                contactosCandidatos = await allQuery(`
                    SELECT c.jid, c.telefono, c.nombre, c.pushname, c.ultimo_contacto, ce.asignado_en
                    FROM contactos c
                    INNER JOIN contactos_etiquetas ce ON c.jid = ce.jid
                    WHERE ce.etiqueta_id = ? AND c.es_ignorado = 0
                `, [r.etiqueta_id]);
            } else {
                contactosCandidatos = await allQuery(`
                    SELECT jid, telefono, nombre, pushname, ultimo_contacto, ultimo_contacto as asignado_en
                    FROM contactos
                    WHERE es_ignorado = 0
                `);
            }

            for (const c of contactosCandidatos) {
                const fechaBase = c.asignado_en || c.ultimo_contacto || Date.now();
                const difDias = Math.floor((Date.now() - fechaBase) / (1000 * 60 * 60 * 24));

                // Si aún no cumple los días requeridos, ignorar
                if (difDias < r.dias_espera) continue;

                // Verificar si ya se envió hoy o anteriormente
                const yaEnviado = await getQuery("SELECT id FROM historial_seguimientos WHERE jid = ? AND regla_id = ? AND estado = 'enviado'", [c.jid, r.id]);
                if (yaEnviado) continue;

                const nombreLimpio = c.nombre || c.pushname || 'Estimado(a)';
                const mensajePersonalizado = r.mensaje_plantilla
                    .replace(/{nombre}/gi, nombreLimpio)
                    .replace(/{negocio}/gi, nombreNegocio)
                    .replace(/{dias}/gi, r.dias_espera);

                try {
                    await client.sendMessage(c.jid, mensajePersonalizado);

                    // Registrar en historial y en mensajes
                    await runQuery(`
                        INSERT INTO historial_seguimientos (jid, regla_id, telefono, nombre, mensaje_enviado, fecha_programada, fecha_enviado, timestamp, estado)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'enviado')
                    `, [c.jid, r.id, c.telefono || c.jid, nombreLimpio, mensajePersonalizado, new Date().toISOString(), fechaHoyStr, Date.now()]);

                    await runQuery(
                        "INSERT INTO mensajes (chat_id, emisor, emisor_nombre, cuerpo, tipo, es_mio, es_ia, timestamp) VALUES (?, ?, ?, ?, 'chat', 1, 1, ?)",
                        [c.jid, 'bot', 'Seguimiento Automático', mensajePersonalizado, Date.now()]
                    );

                    io.emit('nuevo_mensaje', {
                        chat_id: c.jid,
                        emisor: 'bot',
                        emisor_nombre: 'Seguimiento Automático',
                        cuerpo: mensajePersonalizado,
                        tipo: 'chat',
                        es_mio: 1,
                        es_ia: 1,
                        timestamp: Date.now()
                    });

                    // Pausa de 15 segundos entre envíos para proteger WhatsApp
                    await delay(15000);
                } catch (errEnvio) {
                    console.error(`Error enviando seguimiento a ${c.jid}:`, errEnvio.message);
                }
            }
        }
    } catch (errWorker) {
        console.error("Error en worker de seguimientos:", errWorker.message);
    }
}

// Ejecutar worker cada 15 minutos
setInterval(procesarSeguimientosAutomaticos, 15 * 60 * 1000);


// --------------------------------------------------------------------------
// CRON: RECORDATORIOS AUTOM�TICOS DE CITAS
// --------------------------------------------------------------------------
let ultimoMinutoRecordatorio = -1;

setInterval(async () => {
    try {
        const ahora = new Date();
        const minActual = ahora.getMinutes();
        const strHoraActual = String(ahora.getHours()).padStart(2, '0') + ':' + String(minActual).padStart(2, '0');
        
        // Evitar que se ejecute varias veces en el mismo minuto
        if (ultimoMinutoRecordatorio === minActual) return;
        
        const configActivo = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'recordatorios_activo'"))?.valor === '1';
        if (!configActivo) return;
        
        const configHora = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'recordatorios_hora'"))?.valor;
        if (!configHora || configHora !== strHoraActual) return;
        
        ultimoMinutoRecordatorio = minActual;
        
        const configTexto = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'recordatorios_texto'"))?.valor || 'Hola {nombre}, te recordamos tu cita hoy a las {hora} para {servicio}.';
        
        const hoyIso = ahora.toISOString().split('T')[0];
        
        const citasDeHoy = await allQuery("SELECT * FROM citas_agenda WHERE fecha = ? AND estado != 'Cancelada' AND (recordatorio_enviado = 0 OR recordatorio_enviado IS NULL) AND cliente_telefono != ''", [hoyIso]);
        
        if (citasDeHoy && citasDeHoy.length > 0) {
            console.log(`[CRON RECORDATORIOS] Iniciando env�o de ${citasDeHoy.length} recordatorios...`);
            for (const cita of citasDeHoy) {
                // Formatear JID
                let jid = cita.cliente_telefono.replace(/\D/g, '');
                if (jid.length === 10) jid = '521' + jid; // Default a M�xico celular (o 52 sin 1)
                if (!jid.includes('@s.whatsapp.net')) jid += '@s.whatsapp.net';
                
                // Formatear Mensaje
                let mensaje = configTexto;
                mensaje = mensaje.replace(/\{nombre\}/g, cita.cliente_nombre || 'Paciente');
                mensaje = mensaje.replace(/\{hora\}/g, cita.hora || '');
                mensaje = mensaje.replace(/\{servicio\}/g, cita.servicio || 'consulta');
                
                // Enviar
                if (client && client.user) {
                    await client.sendMessage(jid, { text: mensaje });
                    
                    // Insertar en mensajes como 'bot' (para que la IA lo vea)
                    await runQuery(
                        "INSERT INTO mensajes (jid, nombre, origen, texto, timestamp) VALUES (?, ?, 'bot', ?, ?)",
                        [jid, cita.cliente_nombre || 'Paciente', mensaje, Date.now()]
                    );
                    
                    // Marcar en DB
                    await runQuery("UPDATE citas_agenda SET recordatorio_enviado = 1 WHERE id = ?", [cita.id]);
                    console.log(`[CRON RECORDATORIOS] Recordatorio enviado a ${jid}`);
                    
                    // Peque�a pausa para no saturar WhatsApp
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }
    } catch (e) {
        console.error('[CRON RECORDATORIOS] Error:', e);
    }
}, 30000); // Check every 30 seconds

client.on('message', async (msg) => {
    try {
        await procesarMensajeEntrante(msg);
    } catch (err) {
        console.error("Error en evento message:", err.message);
    }
});

// ------------------------------------------------------------------------------
// DETECCIÓN EN VIVO DE INTERVENCIÓN HUMANA DESDE EL TELÉFONO DEL BOT
// ------------------------------------------------------------------------------
client.on('message_create', async (msg) => {
    try {
        if (!msg || !msg.fromMe) return; // Solo mensajes que salen de nuestra propia cuenta
        if (msg.to === 'status@broadcast') return;

        // ── CHECK #0: ¿Hay un sendMessage del bot en vuelo ahora mismo? ──────────────
        // message_create SIEMPRE dispara MIENTRAS origSendMessage aún está en await.
        // Si botEnviosPendientes > 0, este evento ES del bot — sin importar JID o formato.
        // También cubre la ventana de 2s post-envío por si el evento llega tarde.
        if (botEnviosPendientes > 0 || Date.now() - ultimoEnvioBotMs < 2000) {
            // ⚠️ NO añadir aquí: contamina el set con IDs de mensajes del USUARIO
            return;
        }

        // ── Para mensajes enviados > 2s atrás, aplicar checks de respaldo ────────────
        // Esperar 2000ms para dar tiempo a que los sendMessage registren sus IDs y evitar falsos positivos por latencia de red
        await new Promise(r => setTimeout(r, 2000));

        // 1. Check por ID
        if (msg.id && idsMensajesEnviadosBot.has(msg.id._serialized)) return;

        // 2. Check por JID del destinatario — maneja mismatch @lid vs @c.us
        const targetJid = msg.to || msg.from;
        if (targetJid && targetJid !== 'status@broadcast') {
            const telClean = targetJid.replace(/[^0-9]/g, '');
            const ultimos8 = (telClean && telClean.length >= 8) ? telClean.slice(-8) : '';

            // Búsqueda exacta O por subcadena de 8 dígitos dentro de cualquier JID registrado
            const ahoraMs = Date.now();
            let jidBotActivo = false;
            
            if (ultimosJidsEnviadosBot.has(targetJid) && (ahoraMs - ultimosJidsEnviadosBot.get(targetJid) < 5000)) {
                jidBotActivo = true;
            } else if (ultimos8) {
                for (const [k, ts] of ultimosJidsEnviadosBot.entries()) {
                    if (k.includes(ultimos8) && (ahoraMs - ts < 5000)) {
                        jidBotActivo = true;
                        break;
                    }
                }
            }

            if (jidBotActivo) {
                return;
            }
        }

        const cuerpoMsg = (msg.body || '').trim();

        // 3. Check por texto registrado (el interceptor registra el texto antes de enviar)
        let coincideTextoBot = ultimosTextosEnviadosBot.has(cuerpoMsg);
        if (!coincideTextoBot && cuerpoMsg.length >= 10) {
            const prefix = cuerpoMsg.slice(0, 40);
            for (const [t] of ultimosTextosEnviadosBot.entries()) {
                if (t.startsWith(prefix) || cuerpoMsg.startsWith(t.slice(0, 40))) {
                    coincideTextoBot = true;
                    break;
                }
            }
        }
        if (coincideTextoBot) {
            return;
        }

        // 4. Check por emoji/palabra clave de inicio (mensajes del sistema del bot)
        const iconoConf = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'icono_asistente'"))?.valor || '🤖';
        const esMensajeIA = (
            (iconoConf && cuerpoMsg.startsWith(iconoConf)) ||
            cuerpoMsg.startsWith('🤖') ||
            cuerpoMsg.startsWith('👨‍⚕️') ||
            cuerpoMsg.startsWith('👤') ||
            cuerpoMsg.startsWith('🏥') ||
            cuerpoMsg.startsWith('🛍️') ||
            cuerpoMsg.startsWith('👋') ||
            cuerpoMsg.startsWith('🎓') ||
            cuerpoMsg.startsWith('🇲🇽') ||
            cuerpoMsg.startsWith('🌴') ||
            cuerpoMsg.startsWith('🏖️') ||
            cuerpoMsg.startsWith('✅') ||
            cuerpoMsg.startsWith('🧪') ||
            cuerpoMsg.startsWith('🛡️') ||
            cuerpoMsg.startsWith('🖼️') ||
            cuerpoMsg.startsWith('🎙️') ||
            cuerpoMsg.startsWith('📋') ||
            cuerpoMsg.startsWith('🎉') ||
            cuerpoMsg.startsWith('📌') ||
            cuerpoMsg.startsWith('⏰') ||
            cuerpoMsg.startsWith('⚠️') ||
            cuerpoMsg.startsWith('🗓️') ||
            cuerpoMsg.startsWith('💬') ||
            cuerpoMsg.startsWith('🚨') ||
            cuerpoMsg.includes('Lista de Espera Prioritaria') ||
            cuerpoMsg.includes('asistente virtual') ||
            cuerpoMsg.includes('reanudarán') ||
            cuerpoMsg.includes('reanudará') ||
            (cuerpoMsg.startsWith('!') && (cuerpoMsg.includes('reactivar') || cuerpoMsg.includes('curso') || cuerpoMsg.includes('festivo') || cuerpoMsg.includes('feriado') || cuerpoMsg.includes('asueto') || cuerpoMsg.includes('inhabil') || cuerpoMsg.includes('vacaciones') || cuerpoMsg.includes('probar') || cuerpoMsg.includes('pausar')))
        );

        if (esMensajeIA) {
            return;
        }

        // Mensaje enviado manualmente por el usuario desde el teléfono físico o WhatsApp Web
        if (!targetJid || targetJid.endsWith('@g.us')) return; // No pausar por mensajes en grupos

        const minsPausa = parseInt((await getQuery("SELECT valor FROM configuracion WHERE clave = 'tiempo_pausa_humano_mins'"))?.valor || '30', 10);

        // 1. Pausar inmediatamente el chat para este destinatario
        chatsPausados.set(targetJid, Date.now());

        // 2. Si el número tiene otros identificadores asociados (ej: @c.us y @lid), pausar ambos y emitir a ambos
        let jidsAsociados = [targetJid];
        let telClean = targetJid.replace(/[^0-9]/g, '');

        try {
            const c = await msg.getContact();
            if (c) {
                if (c.number) telClean = c.number;
                if (c.id?._serialized && !jidsAsociados.includes(c.id._serialized)) {
                    jidsAsociados.push(c.id._serialized);
                }
            }
        } catch(eC) {}

        const ultimos8 = (telClean && !telClean.startsWith('1660') && telClean.length >= 8) ? telClean.slice(-8) : '';
        if (ultimos8) {
            try {
                const asociados = await allQuery("SELECT jid FROM contactos WHERE telefono LIKE ? OR jid LIKE ?", [`%${ultimos8}%`, `%${ultimos8}%`]);
                for (const a of asociados) {
                    chatsPausados.set(a.jid, Date.now());
                    if (!jidsAsociados.includes(a.jid)) jidsAsociados.push(a.jid);
                }
            } catch(e) {}
        }

        console.log(`🛑 [AUTO-PAUSA ACTIVADA] Intervención humana detectada desde el teléfono hacia ${targetJid}. Chat pausado por ${minsPausa} minutos.`);

        // 3. Guardar el mensaje humano en la BD para que aparezca en el panel web
        try {
            let textoCuerpo = msg.body || '';
            const esBase64Img = textoCuerpo.startsWith('/9j/') || textoCuerpo.startsWith('data:image') || (textoCuerpo.length > 200 && !textoCuerpo.includes(' '));

            if (esBase64Img) {
                textoCuerpo = '📷 (Infografía / Imagen enviada)';
            } else if (msg.hasMedia) {
                textoCuerpo = msg.caption ? `📷 ${msg.caption}` : '📷 (Infografía / Imagen enviada)';
            }

            const tsMs = (msg.timestamp || Math.floor(Date.now() / 1000)) * 1000;

            for (const jidDestino of jidsAsociados) {
                // Deduplicar si en los últimos 4 segundos ya se guardó un mensaje multimedia idéntico
                const yaGuardado = await getQuery(`
                    SELECT id FROM mensajes 
                    WHERE chat_id = ? 
                      AND (
                          timestamp = ? 
                          OR (timestamp >= ? AND (cuerpo LIKE '📷%' OR cuerpo = ?))
                      )
                `, [jidDestino, tsMs, tsMs - 4000, textoCuerpo]);

                if (!yaGuardado) {
                    await runQuery(
                        "INSERT INTO mensajes (chat_id, emisor, emisor_nombre, cuerpo, tipo, es_mio, es_ia, timestamp) VALUES (?, ?, ?, ?, 'chat', 1, 0, ?)",
                        [jidDestino, 'yo', 'Asesor Humano', textoCuerpo, tsMs]
                    );
                }

                io.emit('nuevo_mensaje', {
                    chat_id: jidDestino,
                    emisor: 'yo',
                    emisor_nombre: 'Asesor Humano',
                    cuerpo: textoCuerpo,
                    tipo: 'chat',
                    es_mio: 1,
                    es_ia: 0,
                    timestamp: tsMs
                });
            }
        } catch(eMsg) {}

        // Si el cliente tenía una solicitud de asesor pendiente, marcarla como atendida
        await runQuery("UPDATE solicitudes_asesor SET estado = 'atendido' WHERE (jid = ? OR telefono LIKE ?) AND estado = 'pendiente'", [targetJid, `%${telClean}%`]);
        io.emit('solicitud_asesor_actualizada');

        io.emit('chat_pausado', { jid: targetJid, pausado_hasta: Date.now() + (minsPausa * 60 * 1000) });
    } catch (err) {
        console.error("Error en evento message_create:", err.message);
    }
});

// Iniciar Servidor Web y Base de Datos
inicializarBD().then(async () => {
    try {
        // 1. Eliminar cualquier mensaje de notificación o residuo de WhatsApp Web
        await runQuery("DELETE FROM mensajes WHERE cuerpo LIKE '%e2e_notification%' OR cuerpo = '(e2e_notification)'");

        // 2. Normalizar cualquier mensaje de base64 que se haya guardado
        await runQuery("UPDATE mensajes SET cuerpo = '📷 (Infografía / Imagen enviada)' WHERE cuerpo LIKE '/9j/%' OR cuerpo LIKE 'data:image%'");

        // 2.1. Corregir retroactivamente mensajes de IA que hayan quedado clasificados erróneamente como 'Asesor Humano'
        await runQuery(`
            UPDATE mensajes 
            SET es_ia = 1, emisor_nombre = 'Asistente IA', emisor = 'bot' 
            WHERE es_mio = 1 
              AND (
                  cuerpo LIKE '🤖%' 
                  OR cuerpo LIKE '👨‍⚕️%' 
                  OR cuerpo LIKE '🏥%' 
                  OR cuerpo LIKE '🎓%' 
                  OR cuerpo LIKE '🌴%'
                  OR emisor = 'bot'
              )
              AND (es_ia = 0 OR emisor_nombre = 'Asesor Humano')
        `);

        // 3. Eliminar contactos @lid vacíos (sin mensajes) para limpiar completamente la lista de chats fantasma
        await runQuery("DELETE FROM contactos WHERE jid LIKE '%@lid' AND (SELECT COUNT(*) FROM mensajes WHERE chat_id = contactos.jid) = 0");

        // 4. Resetear ultimo_contacto a 0 para cualquier contacto sin mensajes
        await runQuery("UPDATE contactos SET ultimo_contacto = 0 WHERE (SELECT COUNT(*) FROM mensajes WHERE chat_id = contactos.jid) = 0");

        // 5. Alinear canónicamente ultimo_contacto con el último mensaje real existente
        await runQuery(`
            UPDATE contactos 
            SET ultimo_contacto = (SELECT MAX(timestamp) FROM mensajes WHERE chat_id = contactos.jid AND cuerpo NOT LIKE '%e2e_notification%')
            WHERE (SELECT COUNT(*) FROM mensajes WHERE chat_id = contactos.jid AND cuerpo NOT LIKE '%e2e_notification%') > 0
        `);

                // 6. Limpiar numeros falsos y limpiar fantasmas
        await runQuery("DELETE FROM contactos_etiquetas WHERE jid IN (SELECT jid FROM contactos WHERE (SELECT COUNT(*) FROM mensajes WHERE chat_id = contactos.jid) = 0)");
        await runQuery("UPDATE contactos SET telefono = '' WHERE jid LIKE '%@lid' AND LENGTH(telefono) > 12");
        await runQuery("UPDATE contactos SET nombre = CASE WHEN pushname != '' THEN pushname ELSE 'Cliente' END WHERE nombre LIKE 'Cliente (+%' AND (jid LIKE '%@lid' OR LENGTH(telefono) > 12)");
        await runQuery("DELETE FROM contactos_etiquetas WHERE jid = '0@s.whatsapp.net'");
        console.log("🧹 [DB-CLEAN] Limpieza integral de BD completada: sin notificaciones, sin códigos base64 y chats ordenados canónicamente.");
    } catch (eClean) {
        console.error("Error en auto-limpieza BD:", eClean.message);
    }

    client.initialize().catch(err => {
        console.error("Error inicializando WhatsApp Web:", err.message);
        console.warn("⚠️ FALLO CRÍTICO DE INICIO: Forzando reinicio para PM2...");
        setTimeout(() => process.exit(1), 1000);
    });

// Iniciar Auditor Centinela (Watchdog)
Auditor.iniciar(client, getQuery, runQuery);
    
// ==========================================
// WEBHOOK PARA FORMULARIOS DE GOOGLE (AVISO DE PRIVACIDAD / EXPEDIENTE)
// ==========================================
app.post('/api/webhook/google-forms', async (req, res) => {
    try {
        const { telefono, etiqueta_asignar } = req.body;
        if (!telefono) return res.status(400).json({ error: "Telefono es requerido en el cuerpo (JSON)" });
        
                let num = telefono.replace(/[^0-9]/g, '');
        let last10 = num.slice(-10);
        if (last10.length !== 10) return res.status(400).json({ error: 'El n�mero debe tener al menos 10 d�gitos' });
        
        let jid = '521' + last10 + '@c.us';
        const contactoBD = await getQuery('SELECT jid FROM contactos WHERE jid LIKE ? ORDER BY ultimo_contacto DESC LIMIT 1', ['%' + last10 + '@c.us']);
        if (contactoBD && contactoBD.jid) {
            jid = contactoBD.jid;
        }

        const tagName = etiqueta_asignar || "?? Aviso de Privacidad";
        const color = '#10b981'; // Verde por defecto

        // 1. Crear etiqueta si no existe
        await runQuery("INSERT OR IGNORE INTO etiquetas (nombre, color, creado_en) VALUES (?, ?, ?)", [tagName, color, Date.now()]);
        
        // 2. Obtener el ID de la etiqueta
        const etiquetaBD = await getQuery("SELECT id FROM etiquetas WHERE nombre = ?", [tagName]);
        
        if (etiquetaBD) {
            // 3. Asignarla al contacto
            await runQuery("INSERT OR IGNORE INTO contactos_etiquetas (jid, etiqueta_id, asignado_en) VALUES (?, ?, ?)", [jid, etiquetaBD.id, Date.now()]);
            console.log(`? Webhook: Etiqueta '${tagName}' asignada a ${jid} autom�ticamente.`);
            
            // Emitir evento por socket.io para que el panel se actualice en vivo
            if (typeof io !== 'undefined') {
                io.emit('etiqueta_actualizada', { jid, tagName });
            }

            res.json({ success: true, message: `Etiqueta asignada al contacto ${jid}` });
        } else {
            res.status(500).json({ error: "No se pudo crear o encontrar la etiqueta en SQLite." });
        }
    } catch (e) {
        console.error("? Error en webhook google forms:", e);
        res.status(500).json({ error: e.message });
    }
});


    server.listen(PORT, () => {
        console.log(`🌐 Servidor OmniBot SaaS activo en: http://localhost:${PORT}`);
        console.log(`📱 Mini-Sitio Linktree público en: http://localhost:${PORT}/pagina.html`);
    });
});


// ==============================================================================
// CRON: SINCRONIZACION AUTOMATICA DE CITAS BORRADAS EN GOOGLE CALENDAR
// ==============================================================================
setInterval(async () => {
    try {
        const calIdConfig = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_calendar_id'"))?.valor;
        const credsConfig = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_service_account_json'"))?.valor;
        if (!calIdConfig || !credsConfig) return;

        const hoyIso = new Date().toISOString().split('T')[0];
        const citasActivas = await allQuery("SELECT * FROM citas_agenda WHERE estado != 'Cancelada' AND google_event_id IS NOT NULL AND google_event_id != '' AND fecha >= ?", [hoyIso]);
        
        if (citasActivas.length === 0) return;

        const eventIds = citasActivas.map(c => c.google_event_id);
        const estados = await calendarService.verificarEstadoEventos(calIdConfig, credsConfig, eventIds);

        let canceladasCont = 0;
        for (const cita of citasActivas) {
            if (estados[cita.google_event_id] === 'cancelled') {
                await runQuery("UPDATE citas_agenda SET estado = 'Cancelada' WHERE id = ?", [cita.id]);
                canceladasCont++;
            }
        }
        if(canceladasCont > 0) {
            console.log(`Sincronizaci�n autom�tica: ${canceladasCont} citas borradas en Google Calendar fueron canceladas en la BD.`);
        }
    } catch (e) {
        console.error("Error en sincronizacion automatica de calendario:", e.message);
    }
}, 5 * 60 * 1000); // Cada 5 minutos
