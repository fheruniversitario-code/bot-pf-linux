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
// ENDPOINTS DE SUPERADMIN (PANEL MAESTRO)
// ------------------------------------------------------------------------------
app.get('/api/superadmin/clientes', autenticarToken, async (req, res) => {
    try {
        const clientes = await allQuery("SELECT id, username, nombre, rol, plan, estado, fecha_vencimiento FROM usuarios ORDER BY id DESC");
        res.json(clientes);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/superadmin/clientes', autenticarToken, async (req, res) => {
    try {
        const { username, password, nombre, plan, fecha_vencimiento } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña son requeridos' });

        const passHash = bcrypt.hashSync(password, 10);
        await runQuery(
            "INSERT INTO usuarios (username, password_hash, nombre, rol, plan, estado, fecha_vencimiento) VALUES (?, ?, ?, 'cliente', ?, 'activo', ?)",
            [username, passHash, nombre || username, plan || 'Pro Ilimitado', fecha_vencimiento || '']
        );
        res.json({ success: true, message: 'Cliente y bot dados de alta exitosamente' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/superadmin/clientes/:id/estado', autenticarToken, async (req, res) => {
    try {
        const { estado } = req.body; // 'activo' o 'suspendido'
        await runQuery("UPDATE usuarios SET estado = ? WHERE id = ?", [estado, req.params.id]);
        res.json({ success: true, message: `Servicio cambiado a ${estado}` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/superadmin/clientes/:id/reset-password', autenticarToken, async (req, res) => {
    try {
        const { nuevo_password } = req.body;
        if (!nuevo_password) return res.status(400).json({ error: 'Ingresa la nueva contraseña' });
        const passHash = bcrypt.hashSync(nuevo_password, 10);
        await runQuery("UPDATE usuarios SET password_hash = ? WHERE id = ?", [passHash, req.params.id]);
        res.json({ success: true, message: 'Contraseña del cliente reseteada con éxito' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/superadmin/clientes/:id', autenticarToken, async (req, res) => {
    try {
        await runQuery("DELETE FROM usuarios WHERE id = ?", [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Monitor de Instancias y Bots del Servidor en Tiempo Real
app.get('/api/superadmin/monitor-servidor', autenticarToken, async (req, res) => {
    try {
        const listaBots = [
            { id: 'nursefashion', nombre: 'Nurse Fashion (Boutique y Uniformes)', puerto: 3000, tipo: 'Comercio / Tienda Web' },
            { id: 'caises', nombre: 'CAISES Jaral (Salud Reproductiva)', puerto: 3001, tipo: 'Salud Pública / Clínica' }
        ];

        const resultado = await Promise.all(listaBots.map(async (b) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 1200);
                const resp = await fetch(`http://127.0.0.1:${b.puerto}/api/bot/estado-control`, { signal: controller.signal });
                clearTimeout(timeoutId);
                if (resp.ok) {
                    const data = await resp.json();
                    return {
                        ...b,
                        online: true,
                        botPausadoGlobal: data.botPausadoGlobal || false,
                        ausenciaActiva: data.ausenciaActiva || false
                    };
                }
            } catch (e) {}
            return { ...b, online: false, botPausadoGlobal: false, ausenciaActiva: false };
        }));

        res.json(resultado);
    } catch (e) {
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

// Lista de Conversaciones (Live Chat)
app.get('/api/conversaciones', autenticarToken, async (req, res) => {
    try {
        const chats = await allQuery(`
            SELECT c.jid, c.telefono, c.nombre, c.pushname, c.etiquetas, c.es_ignorado, c.ultimo_contacto,
                   (SELECT cuerpo FROM mensajes WHERE chat_id = c.jid ORDER BY id DESC LIMIT 1) as ultimo_mensaje,
                   (SELECT timestamp FROM mensajes WHERE chat_id = c.jid ORDER BY id DESC LIMIT 1) as hora_ultimo_mensaje,
                   (SELECT es_ia FROM mensajes WHERE chat_id = c.jid ORDER BY id DESC LIMIT 1) as ultimo_fue_ia
            FROM contactos c
            ORDER BY c.ultimo_contacto DESC
            LIMIT 50
        `);
        res.json(chats);
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

// Subida de Logo de la Empresa
app.post('/api/upload/logo', autenticarToken, uploadLogo.single('logo'), async (req, res) => {
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

    // Guardián Universal: Si se queda en CUALQUIER porcentaje antes de 'ready' por más de 2.5 minutos sin avanzar, forzar recarga
    if (ultimoPorcentajeSaaS !== percent) {
        tiempoInicioLoadingSaaS = Date.now();
        ultimoPorcentajeSaaS = percent;
    }

    if (tiempoInicioLoadingSaaS && (Date.now() - tiempoInicioLoadingSaaS > 150000)) {
        console.warn(`⚠️ ALERTA: WhatsApp Web atascado en ${percent}% durante el inicio por más de 2.5 minutos. Reiniciando proceso limpio con PM2...`);
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
        if (!wsClienteConectado && tiempoInicioLoadingSaaS && (Date.now() - tiempoInicioLoadingSaaS > 180000)) {
            console.warn(`⚠️ ALERTA WATCHDOG: El proceso de carga inicial lleva más de 3 minutos atascado en ${ultimoPorcentajeSaaS}%. Reiniciando proceso limpio con PM2...`);
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

// Procesador Inteligente de Mensajes Entrantes
async function procesarMensajeEntrante(msg) {
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
        const chat = await msg.getChat();
        await chat.sendStateTyping();
        await delay(1500);
        const resp = "🎙️ *Hola. Por el momento nuestro sistema atiende por mensaje escrito y fotos.*\n\nPor favor, escríbeme tu duda para poder ayudarte.";
        const sent = await msg.reply(resp);
        if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);
        return;
    }

    if (!texto) return;

    // --------------------------------------------------------------------------
    // 1. EVALUACIÓN DE MENÚ NUMÉRICO INTERACTIVO (1, 2, 3...)
    // --------------------------------------------------------------------------
    try {
        const menuConfigRaw = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'menu_numerico'"))?.valor;
        if (menuConfigRaw) {
            const menuOpciones = JSON.parse(menuConfigRaw);
            const opcionEncontrada = menuOpciones.find(o => o.opcion && o.opcion.toString().trim() === texto.trim());
            if (opcionEncontrada) {
                const chat = await msg.getChat();
                await chat.sendStateTyping();
                await delay(1200);

                let respMenu = `📌 *${opcionEncontrada.titulo}*\n\n${opcionEncontrada.respuesta}`;
                if (opcionEncontrada.enlace) {
                    respMenu += `\n\n🔗 ${opcionEncontrada.enlace}`;
                }

                const sent = await msg.reply(respMenu);
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
    const textoLowerNorm = texto.toLowerCase();
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

    // Auto-detección por palabras clave de salud / productos / promociones
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
    } else if (textoLowerNorm.includes('promocion') || textoLowerNorm.includes('promociones') || textoLowerNorm.includes('promo') || textoLowerNorm.includes('descuento')) {
        await enviarImagenSiExiste('promociones', '🎉 *Nuestras Promociones y Descuentos*');
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

        const systemInstruction = `
${configPrompt}
${avisoAusencia}

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

INSTRUCCIONES CLAVE:
- Responde de forma concisa, educada y profesional en español basándote en el catálogo y documentos.
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

        // Cascada completa de modelos dinámicos válidos
        const modeloGuardado = (await getQuery("SELECT valor FROM configuracion WHERE clave = 'gemini_modelo_ia'"))?.valor || 'gemini-1.5-flash';
        const listaModelos = Array.from(new Set([
            modeloGuardado,
            'gemini-1.5-flash',
            'gemini-2.0-flash',
            'gemini-1.5-pro',
            'gemini-2.5-flash'
        ])).filter(m => m && !m.includes('3.5') && !m.includes('3.6') && !m.includes('latest'));

        let respuestaIA = null;
        for (const modName of listaModelos) {
            try {
                const model = aiClient.getGenerativeModel({ model: modName, systemInstruction });
                const result = await model.generateContent(promptContenido);
                respuestaIA = result.response.text();
                if (respuestaIA) break;
            } catch (errModel) {
                console.error(`[Error Modelo IA ${modName}]:`, errModel.message);
            }
        }

        if (!respuestaIA) {
            console.error("⚠️ Ningún modelo de Gemini respondió. Posible causa: Clave API inválida o sin cuota en Google AI Studio.");
        }

        if (respuestaIA) {
            // Simulación de escritura humana anti-ban
            try {
                const chat = await msg.getChat();
                await chat.sendStateTyping();
                const delayEscritura = Math.min(Math.max(respuestaIA.length * 20, 1500), 3500);
                await delay(delayEscritura);
            } catch (eTyping) {}

            const sent = await client.sendMessage(remitente, respuestaIA);
            if (sent?.id) idsMensajesEnviadosBot.add(sent.id._serialized);

            // Guardar respuesta de IA en base de datos
            await runQuery(
                "INSERT INTO mensajes (chat_id, emisor, emisor_nombre, cuerpo, es_mio, es_ia, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [remitente, 'bot', 'Asistente IA', respuestaIA, 1, 1, Date.now()]
            );

            io.emit('nuevo_mensaje', {
                chat_id: remitente,
                emisor: 'bot',
                emisor_nombre: 'Asistente IA',
                cuerpo: respuestaIA,
                es_mio: 1,
                es_ia: 1,
                timestamp: Date.now()
            });
        }
    } catch (e) {
        console.error("Error al procesar con IA:", e.message);
    }
}

client.on('message', async (msg) => {
    await procesarMensajeEntrante(msg);
});

// Iniciar Servidor Web y Base de Datos
inicializarBD().then(() => {
    client.initialize().catch(err => console.error("Error inicializando WhatsApp Web:", err.message));
    server.listen(PORT, () => {
        console.log(`🌐 Servidor OmniBot SaaS activo en: http://localhost:${PORT}`);
        console.log(`📱 Mini-Sitio Linktree público en: http://localhost:${PORT}/pagina.html`);
    });
});
