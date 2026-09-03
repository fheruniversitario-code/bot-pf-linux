require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');

const { db, runQuery, getQuery, allQuery, inicializarBD, DB_PATH } = require('./db');

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

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'omnibot_super_secret_jwt_key_2026';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(DIR_UPLOADS));
app.use('/imagenes', express.static(DIR_IMAGENES));

// Estado de WhatsApp Web en Memoria
let wsClienteConectado = false;
let ultimoQrCode = null;
let botPausadoGlobal = false;
const chatsPausados = new Map(); // JID -> Timestamp de inicio de pausa
const idsMensajesEnviadosBot = new Set();
const colasProcesamiento = new Map();

// ------------------------------------------------------------------------------
// 1. CONFIGURACIÓN DE GEMINI AI
// ------------------------------------------------------------------------------
const geminiApiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || '';
const genAI = geminiApiKey ? new GoogleGenerativeAI(geminiApiKey) : null;
const MODELOS_GEMINI = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];

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

// Lista de Conversaciones Mejorada (Live Chat con Etiquetas y Tiempo Relativo)
app.get('/api/conversaciones', autenticarToken, async (req, res) => {
    try {
        const chats = await allQuery(`
            SELECT c.jid, c.telefono, c.nombre, c.pushname, c.es_ignorado, c.ultimo_contacto,
                   (SELECT cuerpo FROM mensajes WHERE chat_id = c.jid ORDER BY id DESC LIMIT 1) as ultimo_mensaje,
                   (SELECT timestamp FROM mensajes WHERE chat_id = c.jid ORDER BY id DESC LIMIT 1) as hora_ultimo_mensaje,
                   (SELECT es_ia FROM mensajes WHERE chat_id = c.jid ORDER BY id DESC LIMIT 1) as ultimo_fue_ia
            FROM contactos c
            ORDER BY c.ultimo_contacto DESC
            LIMIT 100
        `);

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
        res.json({ success: true });
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

// Bandeja de Pacientes/Clientes con Seguimiento Pendiente o Próximo
app.get('/api/seguimientos/pendientes', autenticarToken, async (req, res) => {
    try {
        const reglas = await allQuery("SELECT * FROM reglas_seguimiento WHERE activo = 1");
        const nombreNegocio = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'nombre_negocio'"))?.valor || 'Planificación Familiar';
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

// Mensajes de un Chat específico
app.get('/api/conversaciones/:jid/mensajes', autenticarToken, async (req, res) => {
    try {
        const { jid } = req.params;
        const mensajes = await allQuery("SELECT * FROM mensajes WHERE chat_id = ? ORDER BY id ASC LIMIT 100", [jid]);
        const contacto = await getQuery("SELECT * FROM contactos WHERE jid = ?", [jid]);
        const pedido = await getQuery("SELECT * FROM pedidos_cotizaciones WHERE cliente_telefono LIKE ? ORDER BY id DESC LIMIT 1", [`%${jid.replace(/[^0-9]/g, '')}%`]);
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

// Agenda de Citas
app.get('/api/citas', autenticarToken, async (req, res) => {
    try {
        const citas = await allQuery("SELECT * FROM citas_agenda ORDER BY fecha ASC, hora ASC LIMIT 100");
        res.json(citas);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/citas', autenticarToken, async (req, res) => {
    try {
        const { cliente_telefono, cliente_nombre, fecha, hora, servicio, estado, notas } = req.body;
        const result = await runQuery(
            "INSERT INTO citas_agenda (cliente_telefono, cliente_nombre, fecha, hora, servicio, estado, notas, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [cliente_telefono, cliente_nombre, fecha, hora, servicio, estado || 'Confirmada', notas || '', Date.now()]
        );
        res.json({ id: result.id, success: true });
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

// Renombrar Contacto / Paciente desde el Dashboard o Chat en Vivo
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

app.post('/api/solicitudes-asesor/:id/estado', autenticarToken, async (req, res) => {
    try {
        const { estado } = req.body; // 'atendido' o 'pendiente'
        await runQuery("UPDATE solicitudes_asesor SET estado = ? WHERE id = ?", [estado || 'atendido', req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

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
        return `${icono} 📋 *REQUISITOS GENERALES*\n\nPara tu atención médica gratuita, presenta:\n• Copia de INE o identificación oficial con fotografía\n• Copia de CURP\n\n_Para mayores informes acude en nuestro horario de atención o escribe *5* para solicitar un asesor._`;
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
            // Filtrar modelos compatibles con generateContent, preferir Flash estables (bajo costo y máxima velocidad)
            const modelosSoportados = data.models
                .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
                .map(m => m.name.replace('models/', ''))
                .filter(name => !name.includes('embedding') && !name.includes('aqa') && !name.includes('imagen') && !name.includes('1.5') && !name.includes('2.0') && !name.includes('2.5'));

            // Priorizar modelos Flash y Pro estables (no experimentales -exp que sufren más 503)
            const flashEstables = modelosSoportados.filter(name => name.includes('flash') && !name.includes('-exp'));
            const proEstables = modelosSoportados.filter(name => name.includes('pro') && !name.includes('-exp'));
            const otrosModelos = modelosSoportados.filter(name => !flashEstables.includes(name) && !proEstables.includes(name));

            const listaFinal = Array.from(new Set([...flashEstables, ...proEstables, ...otrosModelos]));
            if (listaFinal.length > 0) {
                cacheModelosValidos = listaFinal;
                ultimoFetchModelos = Date.now();
                return listaFinal;
            }
        }
    } catch (e) {
        console.warn("⚠️ No se pudo consultar la lista dinámica de modelos de Google:", e.message);
    }

    return cacheModelosValidos.length > 0 ? cacheModelosValidos : ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-flash-latest', 'gemini-3.5-pro'];
}

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
        const ausenciaActiva = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'ausencia_activa'"))?.valor === '1';
        const ausenciaMsg = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'ausencia_mensaje'"))?.valor || '';
        const ausenciaFecha = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'ausencia_fecha_fin'"))?.valor || '';
        const ignoradosCount = (await getQuery("SELECT COUNT(*) as total FROM contactos WHERE es_ignorado = 1"))?.total || 0;
        
        res.json({
            wsClienteConectado,
            botPausadoGlobal: botPausadoGlobal || pausadoConf,
            ausenciaActiva,
            ausenciaMsg,
            ausenciaFecha,
            chatsPausadosCount: chatsPausados.size,
            ignoradosCount
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

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

    // 1. Verificar si hay Receso / Vacaciones activo
    const ausenciaActiva = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'ausencia_activa'"))?.valor === '1';
    const ausenciaMsg = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'ausencia_mensaje'"))?.valor || '';
    const ausenciaFechaFin = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'ausencia_fecha_fin'"))?.valor || '';

    if (ausenciaActiva) {
        let proximoTexto = 'al reanudar actividades tras el periodo vacacional';
        if (ausenciaFechaFin) {
            proximoTexto = `el próximo ${ausenciaFechaFin} a primera hora`;
        }
        return {
            enHorario: false,
            enReceso: true,
            motivoReceso: ausenciaMsg || 'Periodo Vacacional / Capacitación',
            proximoTexto
        };
    }

    // 2. Horarios de Trabajo (Predeterminados o configurados)
    const horaInicioStr = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'hora_inicio_semana'"))?.valor || '14:00';
    const horaFinStr = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'hora_fin_semana'"))?.valor || '20:30';
    
    const [hIni, mIni] = horaInicioStr.split(':').map(n => parseInt(n, 10) || 0);
    const [hFin, mFin] = horaFinStr.split(':').map(n => parseInt(n, 10) || 0);
    const minInicio = hIni * 60 + mIni;
    const minFin = hFin * 60 + mFin;

    // Días laborables (Lunes a Viernes)
    const diasLaborables = ['lun', 'mar', 'mié', 'jue', 'vie'];
    const esDiaLaboral = diasLaborables.some(d => diaSemana.startsWith(d));
    const esFinDeSemana = diaSemana.startsWith('s') || diaSemana.startsWith('d');
    const esViernes = diaSemana.startsWith('v');

    const formatoHoraInicio = hIni > 12 ? `${hIni - 12}:${mIni.toString().padStart(2, '0')} PM` : `${hIni}:${mIni.toString().padStart(2, '0')} AM`;

    if (esDiaLaboral && minutosActuales >= minInicio && minutosActuales <= minFin) {
        return {
            enHorario: true,
            enReceso: false,
            proximoTexto: 'actualmente en horario de atención'
        };
    }

    // Fuera de horario: calcular retorno amigable
    let proximoTexto = `en nuestro próximo horario laboral (${formatoHoraInicio})`;
    if (esFinDeSemana) {
        proximoTexto = `el próximo lunes a partir de las ${formatoHoraInicio}`;
    } else if (esViernes && minutosActuales > minFin) {
        proximoTexto = `el próximo lunes a partir de las ${formatoHoraInicio}`;
    } else if (minutosActuales > minFin) {
        proximoTexto = `mañana a partir de las ${formatoHoraInicio}`;
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
        io.emit('estado_control_actualizado', { botPausadoGlobal: false, ausenciaActiva: false });
        res.json({ success: true, botPausadoGlobal: false, ausenciaActiva: false, mensaje: "Bot reactivado exitosamente y pausas eliminadas" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/bot/ausencia', autenticarToken, async (req, res) => {
    try {
        const { activa, mensaje, fecha_fin } = req.body;
        await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_activa', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [activa ? '1' : '0']);
        if (mensaje !== undefined) {
            await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_mensaje', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [mensaje]);
        }
        if (fecha_fin !== undefined) {
            await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_fecha_fin', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [fecha_fin]);
        }
        io.emit('estado_control_actualizado', { ausenciaActiva: !!activa, mensaje, fecha_fin });
        res.json({ success: true, ausenciaActiva: !!activa });
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
    console.log('🚀 ¡Motor OmniBot conectado y listo para atender clientes!');
});

client.on('disconnected', (reason) => {
    wsClienteConectado = false;
    ultimoQrCode = null;
    tiempoInicioLoadingSaaS = null;
    ultimoPorcentajeSaaS = null;
    io.emit('estado_whatsapp', { conectado: false, reason });
    console.log('❌ WhatsApp se ha desconectado:', reason);
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
    try {
        if (!msg || msg.from === 'status@broadcast') return;
        if (msg.id && idsMensajesEnviadosBot.has(msg.id._serialized)) return;

    // 1. Descartar mensajes antiguos (más de 2 minutos) que WhatsApp entrega al reconectar o reiniciar
    if (msg.timestamp) {
        const antiguedadSegundos = (Date.now() / 1000) - msg.timestamp;
        if (antiguedadSegundos > 120) {
            console.log(`⏳ Omitiendo mensaje antiguo (${Math.round(antiguedadSegundos)}s de antigüedad) de ${msg.from}`);
            return;
        }
    }

    const esGrupo = msg.from.endsWith('@g.us');
    const remitente = msg.from;
    const texto = msg.body ? msg.body.trim() : '';

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

    // Registrar o actualizar Contacto en la Base de Datos
    let nombreContacto = 'Cliente';
    let pushname = '';
    let telefonoReal = remitente.replace(/[^0-9]/g, '');
    try {
        const contact = await msg.getContact();
        if (contact) {
            nombreContacto = contact.name || contact.pushname || 'Cliente';
            pushname = contact.pushname || '';
            if (contact.number && !contact.number.startsWith('1660') && contact.number.length >= 10) {
                telefonoReal = contact.number;
            }
        }
    } catch (e) {}

    // Si el contacto ya existía con un número limpio, conservarlo
    const contactoPrevio = await getQuery("SELECT telefono FROM contactos WHERE jid = ?", [remitente]);
    if (contactoPrevio && contactoPrevio.telefono && !contactoPrevio.telefono.startsWith('1660') && telefonoReal.startsWith('1660')) {
        telefonoReal = contactoPrevio.telefono;
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
    const textoLower = texto.toLowerCase();

    if (esGrupo || textoLower.startsWith('!') || esVCard) {
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
                io.emit('estado_control_actualizado', { botPausadoGlobal: false, ausenciaActiva: false });
                const sent = await client.sendMessage(remitente, "✅ *BOT COMPLETAMENTE REACTIVADO.*\n\nSe han eliminado todas las pausas y el modo ausencia. El bot vuelve a responder a todos los clientes.");
                if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                return;
            }

            if (textoLower === '!probar' || textoLower === '!prueba' || textoLower === '!probar on' || textoLower === '!prueba on' || textoLower === '!modo prueba on' || textoLower === '!modo prueba') {
                await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('modo_prueba_admins', '1') ON CONFLICT(clave) DO UPDATE SET valor = '1'");
                io.emit('estado_control_actualizado', { modoPruebaAdmins: true });
                const sent = await client.sendMessage(remitente, "🧪 *MODO PRUEBA ACTIVADO*\n\nEl bot te responderá a partir de ahora como si fueras un cliente normal para que pongas a prueba sus respuestas de IA, infografías y catálogo.\n\n_Para desactivar y que vuelva a guardar silencio contigo, envía `!probar off` o `!prueba off`._");
                if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                return;
            }

            if (textoLower === '!probar off' || textoLower === '!prueba off' || textoLower === '!modo prueba off') {
                await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('modo_prueba_admins', '0') ON CONFLICT(clave) DO UPDATE SET valor = '0'");
                io.emit('estado_control_actualizado', { modoPruebaAdmins: false });
                const sent = await client.sendMessage(remitente, "🛡️ *MODO PRUEBA DESACTIVADO*\n\nEl bot ya no te responderá con mensajes de IA a tus chats personales. Solo obedecerá tus comandos con signo de exclamación `!`.");
                if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                return;
            }

            if (textoLower.startsWith('!pausa') || textoLower.startsWith('!pausar')) {
                const partes = texto.split(' ');
                const numRaw = partes[1] ? partes[1].trim().replace(/[^0-9]/g, '') : '';
                if (!numRaw || numRaw === 'global' || numRaw === 'todo') {
                    botPausadoGlobal = true;
                    await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('bot_pausado_global', '1') ON CONFLICT(clave) DO UPDATE SET valor = '1'");
                    io.emit('estado_control_actualizado', { botPausadoGlobal: true });
                    const sent = await client.sendMessage(remitente, "⏸️ *BOT PAUSADO GLOBALMENTE.*\n\nNo responderá a ningún cliente hasta enviar `!reactivar` o reanudar desde el Panel.");
                    if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                    return;
                } else {
                    const jidTarget = numRaw.length === 10 ? `521${numRaw}@c.us` : `${numRaw}@c.us`;
                    chatsPausados.set(jidTarget, Date.now());
                    const sent = await client.sendMessage(remitente, `⏸️ Chat +${numRaw} pausado temporalmente.`);
                    if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                    return;
                }
            }

            if (textoLower.startsWith('!vacaciones') || textoLower.startsWith('!ausencia') || textoLower.startsWith('!curso')) {
                const partes = texto.split(' ');
                const accion = partes[1] ? partes[1].toLowerCase() : '';
                if (accion === 'off' || accion === 'desactivar') {
                    await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_activa', '0') ON CONFLICT(clave) DO UPDATE SET valor = '0'");
                    io.emit('estado_control_actualizado', { ausenciaActiva: false });
                    const sent = await client.sendMessage(remitente, "🏖️ *MODO AUSENCIA / VACACIONES DESACTIVADO.* El bot reanuda la atención normal.");
                    if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                    return;
                }
                const msj = partes.slice(1).join(' ') || 'Nos encontramos en periodo de ausencia.';
                await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_activa', '1') ON CONFLICT(clave) DO UPDATE SET valor = '1'");
                await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('ausencia_mensaje', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [msj]);
                io.emit('estado_control_actualizado', { ausenciaActiva: true, mensaje: msj });
                const sent = await client.sendMessage(remitente, `🌴 *MODO AUSENCIA ACTIVADO:*\n\n📌 Mensaje al cliente: "${msj}"\n\n_Para desactivar envía \`!reactivar\` o \`!vacaciones off\`._`);
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
                    "▶️ `!reactivar` -> Reactiva el bot, quita pausas y desactiva vacaciones.\n" +
                    "⏸️ `!pausa` -> Pausa globalmente el bot de forma indefinida.\n" +
                    "⏸️ `!pausa 4111234567` -> Pausa a un cliente específico.\n" +
                    "🧪 `!probar` (o `!prueba`) -> Activa Modo Prueba (el bot te responde como cliente).\n" +
                    "🛡️ `!probar off` (o `!prueba off`) -> Desactiva Modo Prueba (el bot guarda silencio contigo).\n" +
                    "🌴 `!vacaciones [mensaje]` -> Activa modo ausencia.\n" +
                    "🌴 `!vacaciones off` -> Desactiva modo ausencia.\n" +
                    "🚫 `!ignorar 4111234567` -> Agrega a la lista de ignorados.\n" +
                    "✅ `!atender 4111234567` -> Remueve de ignorados.\n" +
                    "📋 `!resumen` -> Lista los últimos clientes atendidos con sus teléfonos reales.\n" +
                    "📇 _(O envía una tarjeta de contacto al grupo de control para ignorarlo al instante)_"
                );
                if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
                return;
            }
        }

        if (esGrupo) return; // En grupos no responder como asistente de IA
    }

    // --------------------------------------------------------------------------
    // FILTROS: Contactos Ignorados / Pausas Humanas / Filtro de Audios
    // --------------------------------------------------------------------------
    // Comprobar si el remitente es un teléfono Administrador registrado
    const adminsRaw = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'numeros_admins'"))?.valor || '';
    const adminsArray = adminsRaw.split(',').map(n => n.trim().replace(/[^0-9]/g, '')).filter(Boolean);
    const remitenteNum = remitente.replace(/[^0-9]/g, '');
    const esAdminRemitente = adminsArray.some(adminNum => (remitenteNum && remitenteNum.includes(adminNum)) || (telefonoReal && telefonoReal.includes(adminNum)));

    if (esAdminRemitente) {
        const modoPruebaActivo = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'modo_prueba_admins'"))?.valor === '1';
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

    if (chatsPausados.has(remitente)) {
        const minsPausa = parseInt((await getQuery("SELECT valor FROM configuracion WHERE clave = 'tiempo_pausa_humano_mins'"))?.valor || '30', 10);
        if (Date.now() - chatsPausados.get(remitente) < minsPausa * 60 * 1000) return;
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

    const iconoAsistente = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'icono_asistente'"))?.valor || '🤖';
    const nombreNegocio = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'nombre_negocio'"))?.valor || 'CAISES Jaral';
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
                    const nombreLimpio = nombreContacto && nombreContacto !== 'Cliente' ? nombreContacto : (pushname || 'Paciente / Cliente');

                    const alertaMsg = `🚨 *ALERTA OMNIBOT - PALABRA CLAVE DETECTADA* 🚨\n\n` +
                        `👤 *Cliente / Paciente:* ${nombreLimpio}\n` +
                        `📱 *WhatsApp:* +${telLimpio}\n` +
                        `🔑 *Palabra detectada:* *"${palabraEncontrada.toUpperCase()}"*\n` +
                        `💬 *Mensaje recibido:*\n"${texto}"\n\n` +
                        `⏰ *Fecha:* ${obtenerFechaHoraLocal()}\n` +
                        `👉 _Puedes responderle directamente abriendo su conversación en WhatsApp o en el Panel._`;

                    // 1. Enviar a Números Administradores
                    if ((destinoAlerta === 'ambos' || destinoAlerta === 'numeros') && adminsArray.length > 0) {
                        for (const numAdm of adminsArray) {
                            const jidAdm = numAdm.length === 10 ? `521${numAdm}@c.us` : `${numAdm}@c.us`;
                            try {
                                const sentAdm = await client.sendMessage(jidAdm, alertaMsg);
                                if (sentAdm?.id) idsMensajesEnviadosBot.add(sentAdm.id._serialized);
                            } catch (eAdm) {
                                console.error(`Error notificando al administrador +${numAdm}:`, eAdm.message);
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
    const claveEsperandoNombre = `${remitente}_esperando_nombre`;
    if (chatsPausados.has(claveEsperandoNombre) && !texto.startsWith('!')) {
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

        if (esConfirmacionSinNombre || txtClean.length < 3 || /^\d+$/.test(txtClean)) {
            // No es un nombre: insistir amablemente en el nombre para poder registrarlo correctamente
            await simularEscribiendoSeguro(msg, 1000);

            const msjPedirNombre = `${iconoAsistente ? iconoAsistente + ' ' : ''}¡Excelente! ✍️ Para poder registrar tu expediente e identificarte con nuestro personal de salud, por favor indícame **cuál es tu nombre completo** (o cómo te gustaría que te llamemos):`;
            const sent = await client.sendMessage(remitente, msjPedirNombre);
            if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
            return;
        }

        // Es un nombre real: limpiamos prefijos ("Me llamo...", "Soy...")
        chatsPausados.delete(claveEsperandoNombre);
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
            msjConfirmado = `${iconoAsistente ? iconoAsistente + ' ' : ''}¡Muchas gracias, *${nombreLimpio}*! Tu registro y aviso de privacidad han sido confirmados con éxito. ✍️✅\n\n` +
                `📌 Actualmente nuestro personal se encuentra en: ${estadoHorario.motivoReceso}. Te atenderemos prioritariamente **${estadoHorario.proximoTexto}**.\n\n` +
                `_Mientras tanto, el asistente virtual se mantiene activo 24/7 por si deseas consultar métodos o requisitos._`;
        } else if (!estadoHorario.enHorario) {
            msjConfirmado = `${iconoAsistente ? iconoAsistente + ' ' : ''}¡Muchas gracias, *${nombreLimpio}*! Tu registro y aviso de privacidad han sido confirmados con éxito. ✍️✅\n\n` +
                `⏰ *Fuera de horario de atención personalizada:* He dejado tu solicitud registrada. Nuestro personal te atenderá **${estadoHorario.proximoTexto}**.\n\n` +
                `_Mientras tanto, el asistente virtual se mantiene activo 24/7 por si deseas consultar métodos o requisitos._`;
        } else {
            msjConfirmado = `${iconoAsistente ? iconoAsistente + ' ' : ''}¡Muchas gracias, *${nombreLimpio}*! Tu registro y aviso de privacidad han sido confirmados con éxito. ✍️✅\n\n` +
                `He notificado a nuestro personal de salud de ${nombreNegocio}. En un momento te atenderán de forma personalizada.\n\n` +
                `_Mientras tanto, el asistente virtual se mantiene activo 24/7 por si deseas consultar métodos o requisitos._`;
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
            [remitente, 'bot', 'Registro Paciente', msjConfirmado, 1, 1, Date.now()]
        );
        return;
    }

    // --------------------------------------------------------------------------
    // B. SALUDO INICIAL Y MENÚ INTERACTIVO DE BIENVENIDA (OPCIONAL)
    // --------------------------------------------------------------------------
    const saludos = ['hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'menu', 'menú', 'inicio', 'opciones', 'empezar', 'hola!'];
    if (saludos.includes(textoLowerNorm) && mostrarMenuNumerico) {
        await simularEscribiendoSeguro(msg, 1000);

        const nombreMostrar = (nombreContacto && nombreContacto !== 'Cliente') ? nombreContacto : null;
        const saludoHeader = nombreMostrar ?
            `${iconoAsistente ? iconoAsistente + ' ' : ''}🏥 *¡Hola, ${nombreMostrar}! Te damos la bienvenida al servicio de Planificación Familiar de ${nombreNegocio}.*` :
            `${iconoAsistente ? iconoAsistente + ' ' : ''}🏥 *¡Hola! Te damos la bienvenida al servicio de Planificación Familiar de ${nombreNegocio}.*`;

        let textoMenu = `${saludoHeader}\n\nDe Lunes a Viernes de 2:00 PM a 8:30 PM estamos para servirte. ☺️\n\nElige una opción:\n\n`;
        try {
            const menuRaw = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'menu_numerico'"))?.valor;
            if (menuRaw) {
                const menuOpts = JSON.parse(menuRaw);
                menuOpts.forEach(o => {
                    textoMenu += `${o.opcion}️⃣ *${o.titulo}*\n`;
                });
            } else {
                textoMenu += `1️⃣ 📋 *Requisitos para atención*\n2️⃣ 💊 *Métodos disponibles*\n3️⃣ ⏰ *Horarios de atención*\n4️⃣ 📍 *Ubicación del CAISES*\n5️⃣ 👨‍⚕️ *Solicitar Asesor / Agendar Cita*\n`;
            }
        } catch(e) {
            textoMenu += `1️⃣ 📋 *Requisitos para atención*\n2️⃣ 💊 *Métodos disponibles*\n3️⃣ ⏰ *Horarios de atención*\n4️⃣ 📍 *Ubicación del CAISES*\n5️⃣ 👨‍⚕️ *Solicitar Asesor / Agendar Cita*\n`;
        }
        textoMenu += `\n_Escribe el número de la opción o tu pregunta libremente y con gusto te responderé._`;

        const sent = await client.sendMessage(remitente, textoMenu);
        if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);

        await runQuery(
            "INSERT INTO mensajes (chat_id, emisor, emisor_nombre, cuerpo, es_mio, es_ia, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [remitente, 'bot', 'Menú Bienvenida', textoMenu, 1, 1, Date.now()]
        );
        return;
    }

    // --------------------------------------------------------------------------
    // C. SOLICITUD DIRECTA DE ASESOR / AGENDAR CITA (OPCIÓN 5 O PALABRAS CLAVE)
    // --------------------------------------------------------------------------
    const frasesAsesor = ['asesor', '!asesor', 'humano', 'agente', 'hablar con alguien', 'hablar con un asesor', 'hablar con una persona', 'quiero un asesor', 'solicitar asesor', 'transferir', 'cita', 'agendar'];
    const pideAsesorDirecto = textoLowerNorm === '5' || frasesAsesor.some(f => textoLowerNorm === f || (textoLowerNorm.includes(f) && !textoLowerNorm.includes('que') && !textoLowerNorm.includes('como') && !textoLowerNorm.includes('donde')));

    if (pideAsesorDirecto) {
        await simularEscribiendoSeguro(msg, 1000);

        // Si el paciente aún no está registrado con su nombre:
        if (!nombreContacto || nombreContacto === 'Cliente') {
            chatsPausados.set(claveEsperandoNombre, Date.now());
            const msjRegistro = `${iconoAsistente ? iconoAsistente + ' ' : ''}📋 *REGISTRO Y AVISO DE PRIVACIDAD* 🔒\n\n` +
                `Para comunicarte con nuestro personal de salud de ${nombreNegocio}, completa estos 2 rápidos pasos:\n\n` +
                `1️⃣ *Abre este enlace y llena tus datos (1 min):*\n👉 ${enlacePrivacidad}\n\n` +
                `2️⃣ *Escribe aquí tu NOMBRE COMPLETO* para confirmar tu registro y transferirte. ✍️✅\n\n` +
                `_(Tu información es 100% confidencial y protegida)_ 🏥✨`;

            const sent = await client.sendMessage(remitente, msjRegistro);
            if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
            return;
        }

        // Si ya está registrado con su nombre:
        let msjTransferido = '';
        if (estadoHorario.enReceso) {
            msjTransferido = `${iconoAsistente ? iconoAsistente + ' ' : ''}🌴 *AVISO DE RECESO / VACACIONES*\n\n` +
                `Hola, *${nombreContacto}*. Por el momento nuestro personal de ${nombreNegocio} se encuentra en: ${estadoHorario.motivoReceso}.\n\n` +
                `🗓️ Tu solicitud ha quedado registrada. Nuestro personal te atenderá **${estadoHorario.proximoTexto}**.\n\n` +
                `_Mientras tanto, el asistente virtual se mantiene activo 24/7 para responder todas tus preguntas sobre métodos y requisitos._`;
        } else if (!estadoHorario.enHorario) {
            msjTransferido = `${iconoAsistente ? iconoAsistente + ' ' : ''}⏰ *FUERA DE HORARIO DE ATENCIÓN PERSONALIZADA*\n\n` +
                `Hola, *${nombreContacto}*. Por el momento nos encontramos fuera de nuestro horario de atención presencial.\n\n` +
                `🕒 Tu solicitud ha quedado registrada. Nuestro personal revisará tu chat y te atenderá **${estadoHorario.proximoTexto}**.\n\n` +
                `_Mientras tanto, el asistente virtual se mantiene activo 24/7 para responder cualquier consulta sobre métodos o requisitos._`;
        } else {
            msjTransferido = `${iconoAsistente ? iconoAsistente + ' ' : ''}👨‍⚕️ Entendido, *${nombreContacto}*. He notificado a nuestro personal de salud de ${nombreNegocio} por este chat.\n\n` +
                `📌 *Nota importante:* Es posible que nuestro personal demore un poco en responderte ya que se encuentran atendiendo consulta presencial o en algún procedimiento médico.\n\n` +
                `_Mientras tanto, el asistente virtual se mantiene activo 24/7 por si deseas hacer más preguntas o consultar cualquier otro tema._`;
        }

        const sent = await client.sendMessage(remitente, msjTransferido);
        if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);

        // Si fue fuera de horario o en receso, registrar en solicitudes pendientes de asesor
        if (!estadoHorario.enHorario || estadoHorario.enReceso) {
            try {
                const telLimpio = telefonoReal && !telefonoReal.startsWith('1660') ? telefonoReal : remitente.replace(/[^0-9]/g, '');
                const yaExiste = await getQuery("SELECT id FROM solicitudes_asesor WHERE jid = ? AND estado = 'pendiente'", [remitente]);
                if (!yaExiste) {
                    await runQuery(
                        "INSERT INTO solicitudes_asesor (jid, telefono, nombre, motivo, fecha_hora, timestamp, estado) VALUES (?, ?, ?, ?, ?, ?, 'pendiente')",
                        [remitente, telLimpio, nombreContacto || 'Paciente', texto, obtenerFechaHoraLocal(), Date.now()]
                    );
                }
            } catch(eSol) {}
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
                const palabrasClave = baseName.split(/[-_ ]+/).filter(w => w.length >= 3);

                // Si el mensaje del cliente incluye alguna palabra clave del archivo o el nombre completo
                const coincide = palabrasClave.some(p => textoLowerNorm.includes(p)) || textoLowerNorm.includes(baseName);
                if (coincide) {
                    const tituloLimpio = baseName.replace(/[-_]/g, ' ').toUpperCase();
                    await enviarImagenSiExiste(parsed.name, `🖼️ *${tituloLimpio}*`);
                }
            }
        }
    } catch (errGaleria) {
        console.error("Error buscando imágenes automáticas:", errGaleria);
    }

    // Reglas específicas con títulos enriquecidos
    if (textoLowerNorm.includes('implante')) {
        await enviarImagenSiExiste('implante', '🖼️ *Infografía: Implante Subdérmico*');
    } else if (textoLowerNorm.includes('vasectomia') || textoLowerNorm.includes('vasectomía') || textoLowerNorm.includes('sin bisturi')) {
        await enviarImagenSiExiste('vasectomia', '🖼️ *Infografía: Vasectomía sin Bisturí*');
    } else if (textoLowerNorm.includes('cobre') || textoLowerNorm.includes('t de cobre')) {
        await enviarImagenSiExiste('diu_cobre', '🖼️ *Infografía: DIU de Cobre*');
    } else if (textoLowerNorm.includes('medicado') || textoLowerNorm.includes('mirena') || textoLowerNorm.includes('levonorgestrel')) {
        await enviarImagenSiExiste('diu_medicado', '🖼️ *Infografía: DIU Medicado (Mirena)*');
    } else if (textoLowerNorm.includes('trimestral') || textoLowerNorm.includes('3 meses') || textoLowerNorm.includes('depo')) {
        await enviarImagenSiExiste('inyeccion_trimestral', '🖼️ *Infografía: Inyección Trimestral*');
    } else if (textoLowerNorm.includes('bimensual') || textoLowerNorm.includes('2 meses') || textoLowerNorm.includes('noristerat')) {
        await enviarImagenSiExiste('inyeccion_bimensual', '🖼️ *Infografía: Inyección Bimensual*');
    } else if (textoLowerNorm.includes('mensual') || textoLowerNorm.includes('cada mes') || textoLowerNorm.includes('mesigyna') || textoLowerNorm.includes('cyclofem')) {
        await enviarImagenSiExiste('inyeccion_mensual', '🖼️ *Infografía: Inyección Mensual*');
    } else if (textoLowerNorm.includes('pastilla') || textoLowerNorm.includes('pastillas')) {
        await enviarImagenSiExiste('pastillas', '🖼️ *Infografía: Pastillas Anticonceptivas*');
    } else if (textoLowerNorm.includes('parche') || textoLowerNorm.includes('parches')) {
        await enviarImagenSiExiste('parche', '🖼️ *Infografía: Parches Anticonceptivos*');
    } else if (textoLowerNorm.includes('emergencia') || textoLowerNorm.includes('postday') || textoLowerNorm.includes('dia siguiente')) {
        await enviarImagenSiExiste('emergencia', '🖼️ *Infografía: Pastilla de Emergencia*');
    } else if (textoLowerNorm.includes('metodos') || textoLowerNorm.includes('métodos') || textoLowerNorm.includes('catalogo') || textoLowerNorm.includes('catálogo')) {
        await enviarImagenSiExiste('metodos', '🖼️ *Catálogo de Métodos Anticonceptivos*');
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
        
        // Estado de Ausencia / Vacaciones
        const ausenciaActiva = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'ausencia_activa'"))?.valor;
        const ausenciaMsg = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'ausencia_mensaje'"))?.valor;
        let avisoAusencia = '';
        if (ausenciaActiva === '1') {
            avisoAusencia = `\n[AVISO DE AUSENCIA / VACACIONES ACTIVO]: Actualmente el negocio se encuentra ausente temporalmente debido a: "${ausenciaMsg || 'Vacaciones / Capacitación'}". Responde las dudas del cliente amablemente basándote en el catálogo y servicios, pero recuérdale con calidez que actualmente el equipo está ausente y su solicitud será atendida prioritariamente al reanudar actividades.\n`;
        }

        // Historial reciente de la conversación
        const ultimosMensajes = await allQuery("SELECT emisor_nombre, cuerpo, es_mio FROM mensajes WHERE chat_id = ? ORDER BY id DESC LIMIT 8", [remitente]);
        let contextoHistorial = ultimosMensajes.reverse().map(m => `${m.es_mio ? 'Asistente' : 'Cliente'}: ${m.cuerpo}`).join('\n');

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
            reglaHorarioIA = `
🔴 ESTADO DE RECESO / VACACIONES:
- Actualmente el personal humano se encuentra en receso/vacaciones debido a: "${estadoHorario.motivoReceso}".
- REGLA ESTRICTA: NO ofrezcas "hablar con un asesor" o "pasar con un asesor ahora mismo". Si el cliente requiere atención personalizada o cita presencial, indícale amablemente que su solicitud será atendida prioritariamente ${estadoHorario.proximoTexto}, o invítalo a resolver sus dudas contigo directamente (asistente virtual 24/7).`;
        } else if (!estadoHorario.enHorario) {
            reglaHorarioIA = `
🔴 ESTADO DE HORARIO DE ATENCIÓN (FUERA DE HORARIO LABORAL):
- Fecha y hora actual en México: ${obtenerFechaHoraLocal()}.
- Actualmente estamos FUERA del horario de atención del personal humano. El personal atenderá nuevamente: ${estadoHorario.proximoTexto}.
- REGLA ESTRICTA DE HORARIO: En este momento es de noche / fuera de turno. NUNCA ofrezcas "hablar con un asesor" como si fuera a contestar de inmediato.
- Si el tema requiere cita médica o atención humana indispensable, aclara explícitamente que nuestro personal humano labora ${estadoHorario.proximoTexto}, pero que puede escribir 'asesor' para dejar su solicitud registrada en la bandeja de pendientes para mañana, o bien resolver todas sus preguntas de salud/servicios contigo directamente en este instante (tú estás activo 24/7).`;
        } else {
            reglaHorarioIA = `
🟢 ESTADO DE HORARIO DE ATENCIÓN (DENTRO DE HORARIO LABORAL):
- Fecha y hora actual en México: ${obtenerFechaHoraLocal()}.
- Actualmente el personal humano de salud está EN TURNO en las instalaciones.
- Puedes invitar al usuario a escribir 'asesor' si desea atención humana o agendar su cita presencial.`;
        }

        const systemInstruction = `
${configPrompt}
${avisoAusencia}
${reglaHorarioIA}

CLIENTE / PACIENTE ACTUAL:
- Nombre: ${nombreContacto} (Usa su nombre con naturalidad y calidez cuando sea oportuno).
- Icono distintivo: ${iconoAsistente}

CATÁLOGO DE PRODUCTOS / SERVICIOS / PRECIOS:
${catalogo}

DOCUMENTOS Y ARCHIVOS DE CONOCIMIENTO (LISTAS DE PRECIOS, INVENTARIO, MANUALES, GOOGLE SHEETS):
${textoDocumentosAdicionales}

INFORMACIÓN DE UBICACIÓN Y HORARIOS:
- Ubicación física: ${ubicacion}
- Google Maps: ${mapsLink}
- Horario de Sucursal: ${horarioFisico}

INFORMACIÓN DE PAGOS / BANCOS:
${datosBancos}

INSTRUCCIONES CLAVE DE ATENCIÓN:
- REGLA DE FLUIDEZ: Si la conversación ya está en curso (no es el primer saludo), NO repitas saludos largos o de bienvenida ("¡Hola! Bienvenido al servicio..."). Ve directo a responder la duda o pregunta del cliente de forma fluida, clara y cordial.
- REGLA ESTRICTA DE ASESORES Y HORARIO: Respeta SIEMPRE la regla de horario indicada arriba. Si estamos fuera de horario, NO ofrezcas hablar con un asesor en vivo como primera opción; responde tú la duda con el catálogo e información disponible.
- Brinda respuestas breves y fraccionadas (1 a 2 párrafos concisos).
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
            modeloGuardado,
            ...modelosDisponibles,
            'gemini-3.6-flash',
            'gemini-3.5-flash',
            'gemini-flash-latest',
            'gemini-3.5-pro',
            'gemini-pro-latest'
        ])).filter(Boolean);

        let respuestaIA = null;
        let modeloExitoso = null;
        for (const modName of listaModelos) {
            try {
                const model = aiClient.getGenerativeModel({ model: modName, systemInstruction });
                const result = await model.generateContent(promptContenido);
                respuestaIA = result.response.text();
                if (respuestaIA) {
                    modeloExitoso = modName;
                    break;
                }
            } catch (errModel) {
                console.warn(`[Modelo ${modName} no disponible]:`, errModel.message);
                if (errModel.message && (errModel.message.includes('503') || errModel.message.includes('429'))) {
                    await delay(800);
                }
            }
        }

        if (modeloExitoso && modeloExitoso !== modeloGuardado) {
            await runQuery("INSERT INTO configuracion (clave, valor) VALUES ('gemini_modelo_ia', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [modeloExitoso]);
            console.log(`🤖 [Auto-Reparación IA]: Modelo actualizado dinámicamente a: ${modeloExitoso}`);
        }

        // Si todos los servidores de Gemini están saturados o caídos (503/429/Offline), activar Respaldo Inteligente Local
        if (!respuestaIA) {
            console.warn("⚠️ Google AI experimentó saturación (503). Entregando respuesta local de contingencia...");
            const configObj = {
                icono_asistente: iconoAsistente,
                nombre_negocio: nombreNegocio,
                ubicacion_direccion: (await getQuery("SELECT valor FROM configuracion WHERE clave = 'ubicacion_direccion'"))?.valor || '',
                ubicacion_maps_link: (await getQuery("SELECT valor FROM configuracion WHERE clave = 'ubicacion_maps_link'"))?.valor || '',
                horario_sucursal_fisica: (await getQuery("SELECT valor FROM configuracion WHERE clave = 'horario_sucursal_fisica'"))?.valor || '',
                catalogo_servicios: (await getQuery("SELECT valor FROM configuracion WHERE clave = 'catalogo_servicios'"))?.valor || '',
                datos_bancarios: (await getQuery("SELECT valor FROM configuracion WHERE clave = 'datos_bancarios'"))?.valor || ''
            };
            respuestaIA = generarRespuestaEmergencia(texto, configObj, estadoHorario);
        }

        if (respuestaIA) {
            let textoRespuestaFinal = respuestaIA.trim();
            if (iconoAsistente && !textoRespuestaFinal.startsWith(iconoAsistente)) {
                textoRespuestaFinal = `${iconoAsistente} ${textoRespuestaFinal}`;
            }

            // Simulación de escritura humana anti-ban
            await simularEscribiendoSeguro(msg, Math.min(Math.max(textoRespuestaFinal.length * 20, 1500), 3500));

            const sent = await client.sendMessage(remitente, textoRespuestaFinal);
            if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);

            // Guardar respuesta de IA en base de datos
            await runQuery(
                "INSERT INTO mensajes (chat_id, emisor, emisor_nombre, cuerpo, es_mio, es_ia, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [remitente, 'bot', 'Asistente IA', textoRespuestaFinal, 1, 1, Date.now()]
            );

            io.emit('nuevo_mensaje', {
                chat_id: remitente,
                emisor: 'bot',
                emisor_nombre: 'Asistente IA',
                cuerpo: textoRespuestaFinal,
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

        const nombreNegocio = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'nombre_negocio'"))?.valor || 'Planificación Familiar';

        for (const r of reglas) {
            const horaRegla = r.hora_envio || '10:30';
            const [hRegla, mRegla] = horaRegla.split(':').map(Number);
            const [hActual, mActual] = horaActual.split(':').map(Number);
            
            const minDiff = Math.abs((hActual * 60 + mActual) - (hRegla * 60 + mRegla));
            if (minDiff > 25) continue; // Solo procesar en la ventana horaria

            let candidatos = [];
            if (r.etiqueta_id) {
                candidatos = await allQuery(`
                    SELECT c.jid, c.telefono, c.nombre, c.pushname, c.ultimo_contacto, ce.asignado_en
                    FROM contactos c
                    INNER JOIN contactos_etiquetas ce ON c.jid = ce.jid
                    WHERE ce.etiqueta_id = ? AND c.es_ignorado = 0
                `, [r.etiqueta_id]);
            } else {
                candidatos = await allQuery(`
                    SELECT jid, telefono, nombre, pushname, ultimo_contacto, ultimo_contacto as asignado_en
                    FROM contactos
                    WHERE es_ignorado = 0
                `);
            }

            for (const c of candidatos) {
                const fechaBase = c.asignado_en || c.ultimo_contacto || Date.now();
                const difDias = Math.floor((Date.now() - fechaBase) / (1000 * 60 * 60 * 24));

                if (difDias < r.dias_espera) continue;

                // Verificar si ya se envió este seguimiento
                const yaEnviado = await getQuery("SELECT id FROM historial_seguimientos WHERE jid = ? AND regla_id = ? AND estado = 'enviado'", [c.jid, r.id]);
                if (yaEnviado) continue;

                const nombreLimpio = c.nombre || c.pushname || 'Estimado(a)';
                const mensajePersonalizado = r.mensaje_plantilla
                    .replace(/{nombre}/gi, nombreLimpio)
                    .replace(/{negocio}/gi, nombreNegocio)
                    .replace(/{dias}/gi, r.dias_espera);

                try {
                    console.log(`📨 [Seguimiento Automático]: Enviando recordatorio a ${nombreLimpio} (${c.jid})...`);
                    await client.sendMessage(c.jid, mensajePersonalizado);

                    await runQuery(`
                        INSERT INTO historial_seguimientos (jid, regla_id, telefono, nombre, mensaje_enviado, fecha_programada, fecha_enviado, timestamp, estado)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'enviado')
                    `, [c.jid, r.id, c.telefono || c.jid, nombreLimpio, mensajePersonalizado, new Date().toISOString(), fechaHoyStr, Date.now()]);

                    await runQuery(
                        "INSERT INTO mensajes (chat_id, emisor, emisor_nombre, cuerpo, es_mio, es_ia, timestamp) VALUES (?, ?, ?, ?, 1, 1, ?)",
                        [c.jid, 'bot', 'Seguimiento Automático', mensajePersonalizado, Date.now()]
                    );

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

client.on('message', async (msg) => {
    try {
        await procesarMensajeEntrante(msg);
    } catch (err) {
        console.error("Error en evento message:", err.message);
    }
});

// Iniciar Servidor Web y Base de Datos
inicializarBD().then(() => {
    client.initialize().catch(err => console.error("Error inicializando WhatsApp Web:", err.message));
    server.listen(PORT, () => {
        console.log(`🌐 Servidor OmniBot SaaS activo en: http://localhost:${PORT}`);
        console.log(`📱 Mini-Sitio Linktree público en: http://localhost:${PORT}/pagina.html`);
    });
});
