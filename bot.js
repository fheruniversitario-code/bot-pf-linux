require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Polyfill para Linux sin entorno gráfico (evita error "DOMMatrix is not defined" de pdf-parse)
if (typeof globalThis.DOMMatrix === 'undefined') {
    globalThis.DOMMatrix = class DOMMatrix {
        constructor() { this.m = Array(16).fill(0); this.m[0]=1; this.m[5]=1; this.m[10]=1; this.m[15]=1; }
    };
}
const pdfParse = require('pdf-parse');

// Archivos y directorios de estado persistente
const ARCHIVO_PACIENTES = path.join(__dirname, 'pacientes.json');
const ARCHIVO_VACACIONES = path.join(__dirname, 'vacaciones.json');
const ARCHIVO_INFOGRAFIAS = path.join(__dirname, 'infografias_enviadas.json');
const ARCHIVO_PAUSAS = path.join(__dirname, 'pausas.json');
const CARPETA_IMAGENES = path.join(__dirname, 'imagenes');

if (!fs.existsSync(CARPETA_IMAGENES)) {
    fs.mkdirSync(CARPETA_IMAGENES, { recursive: true });
}

// Cargar y guardar pausas humanas en pausas.json
function cargarPausas() {
    try {
        if (fs.existsSync(ARCHIVO_PAUSAS)) {
            const data = fs.readFileSync(ARCHIVO_PAUSAS, 'utf-8');
            const obj = JSON.parse(data);
            const mapa = new Map();
            const TIEMPO_MAX = 2 * 60 * 60 * 1000;
            const ahora = Date.now();
            for (const [jid, timestamp] of Object.entries(obj)) {
                const numTime = Number(timestamp);
                if (numTime && (ahora - numTime < TIEMPO_MAX)) {
                    mapa.set(jid, numTime);
                }
            }
            return mapa;
        }
    } catch (err) {
        console.error('Error al leer pausas.json:', err.message);
    }
    return new Map();
}

function guardarPausas() {
    try {
        const obj = Object.fromEntries(chatsPausados);
        fs.writeFileSync(ARCHIVO_PAUSAS, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (err) {
        console.error('Error al guardar pausas.json:', err.message);
    }
}

// Mapas y variables de estado en memoria
const chatsPausados = cargarPausas();
const historialesChat = new Map(); // Memoria conversacional por usuario
const ultimasSolicitudesAdmin = new Map();
const pendientesRegistro = new Map(); // Para rastrear a quién se le envió el aviso de privacidad
const idsMensajesEnviadosBot = new Set(); // Para registrar IDs de mensajes del bot
const chatsAtendidosBot = new Map(); // Rastrear pacientes atendidos por el bot para el resumen !pendientes
const cacheNumerosTelefono = new Map(); // Caché en memoria para evitar evaluar DOM repetidamente en @lid

// Cola de mensajes asíncrona para evitar congelamientos en CPUs de 4GB RAM
const colaMensajes = [];
let procesandoCola = false;

let botPausadoGlobal = false; // Pausa global indefinida (!pausa / !reactivar)
let ultimoEnvioBotTimestamp = 0; // Timestamp para evitar carreras en el evento message_create

// Helpers de Fecha y Hora con zona horaria estricta de México (America/Mexico_City / GMT-6)
function obtenerHoraMexico() {
    return new Date().toLocaleTimeString('es-MX', {
        timeZone: 'America/Mexico_City',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    });
}

function obtenerFechaMexico(fecha = new Date()) {
    const d = typeof fecha === 'string' || typeof fecha === 'number' ? new Date(fecha) : fecha;
    return d.toLocaleDateString('es-MX', {
        timeZone: 'America/Mexico_City',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
}

// Helper para formatear números de WhatsApp (@c.us)
function formatearNumeroWhatsApp(numeroRaw) {
    let num = numeroRaw.toString().trim().replace(/[^0-9]/g, '');
    if (!num) return null;
    
    if (numeroRaw.includes('@c.us')) return numeroRaw.trim();

    if (num.length === 10) {
        num = '521' + num;
    } else if (num.length === 12 && num.startsWith('52') && !num.startsWith('521')) {
        num = '521' + num.substring(2);
    }

    return num + '@c.us';
}

// Cargar y guardar pacientes en pacientes.json
function cargarPacientes() {
    try {
        if (fs.existsSync(ARCHIVO_PACIENTES)) {
            const data = fs.readFileSync(ARCHIVO_PACIENTES, 'utf-8');
            return JSON.parse(data);
        }
    } catch (err) {
        console.error('Error al leer pacientes.json:', err.message);
    }
    return {};
}

function guardarPaciente(remitente, nombre) {
    const pacientes = cargarPacientes();
    pacientes[remitente] = {
        nombre: nombre,
        fechaRegistro: new Date().toISOString()
    };
    try {
        fs.writeFileSync(ARCHIVO_PACIENTES, JSON.stringify(pacientes, null, 2), 'utf-8');
        console.log(`✅ Paciente registrado en pacientes.json: ${nombre} (${remitente})`);
    } catch (err) {
        console.error('Error al guardar en pacientes.json:', err.message);
    }
}

// Cargar y guardar infografías enviadas (persistente en JSON)
function cargarInfografiasEnviadas() {
    try {
        if (fs.existsSync(ARCHIVO_INFOGRAFIAS)) {
            const data = JSON.parse(fs.readFileSync(ARCHIVO_INFOGRAFIAS, 'utf-8'));
            return new Set(data);
        }
    } catch (err) {}
    return new Set();
}

function guardarInfografiaEnviada(key) {
    try {
        const actual = cargarInfografiasEnviadas();
        actual.add(key);
        fs.writeFileSync(ARCHIVO_INFOGRAFIAS, JSON.stringify([...actual], null, 2), 'utf-8');
    } catch (err) {}
}

// Cargar y guardar estado de Vacaciones y Cursos
function cargarEstadoVacaciones() {
    try {
        if (fs.existsSync(ARCHIVO_VACACIONES)) {
            const data = fs.readFileSync(ARCHIVO_VACACIONES, 'utf-8');
            const estado = JSON.parse(data);
            if (estado.activo && estado.fechaFin) {
                if (new Date() > new Date(estado.fechaFin)) {
                    estado.activo = false;
                    estado.fechaFin = null;
                    guardarEstadoVacaciones(estado);
                    console.log('⏰ El periodo de vacaciones/curso expiró automáticamente.');
                }
            }
            return estado;
        }
    } catch (err) {
        console.error('Error al leer vacaciones.json:', err.message);
    }
    return { activo: false, tipo: null, mensaje: null, fechaFin: null };
}

function guardarEstadoVacaciones(estado) {
    try {
        fs.writeFileSync(ARCHIVO_VACACIONES, JSON.stringify(estado, null, 2), 'utf-8');
        console.log(`🌴 Estado de receso (vacaciones/curso) actualizado: ${estado.activo ? 'ACTIVADO' : 'DESACTIVADO'}`);
    } catch (err) {
        console.error('Error al guardar vacaciones.json:', err.message);
    }
}

function obtenerMensajeReceso(estadoVacaciones) {
    const esCurso = estadoVacaciones && estadoVacaciones.tipo === 'curso';
    const titulo = esCurso ?
        '🎓 *AVISO DE CURSO DE ACTUALIZACIÓN Y CAPACITACIÓN (CAISES JARAL)* 📚' :
        '🌴 *AVISO DE PERIODO VACACIONAL (CAISES JARAL)* 🏖️';

    const razon = esCurso ?
        'Por el momento, el personal de consejería presencial se encuentra en *curso de capacitación profesional* para brindarte una atención de la mejor calidad.' :
        'Por el momento, nuestro personal de consejería presencial se encuentra en periodo de receso vacacional.';

    const detallePeriodo = estadoVacaciones && estadoVacaciones.mensaje ? `\n📌 *Nota del personal:* ${estadoVacaciones.mensaje}` : '';
    const detalleFecha = estadoVacaciones && estadoVacaciones.fechaFin ? `\n🗓️ *Fecha estimada de reanudación:* ${obtenerFechaMexico(estadoVacaciones.fechaFin)}` : '';

    return `🤖 ${titulo}

${razon} ${detallePeriodo}${detalleFecha}

*¡Sin embargo, tu atención médica y entrega de métodos no se detiene!* Te ofrecemos las siguientes alternativas:

🏥 *CITAS DEL DÍA (CONSULTA GENERAL EN VENTANILLA):*
Puedes acudir directamente a la *Ventanilla de Archivo Clínico* del CAISES Jaral a solicitar una "Cita del Día". En tu módulo asignado se te brindará la consulta y la entrega de tus métodos anticonceptivos.

_Mientras tanto, yo como asistente virtual disponible 24/7 para responder todas tus preguntas._`;
}

// Helper para buscar y enviar una infografía si existe en la carpeta 'imagenes'
// No repite la misma infografía para el mismo chat a menos que la pida explícitamente ("ver", "imagen", "infografía")
async function enviarInfografiaSiExiste(client, remitente, palabraClave, tituloPersonalizado = null, forzarEnvio = false, msgRef = null) {
    const claveTracking = `${remitente}_${palabraClave}`;
    const infografiasEnviadas = cargarInfografiasEnviadas();

    if (infografiasEnviadas.has(claveTracking) && !forzarEnvio) {
        console.log(`ℹ️ Infografía ${palabraClave} ya fue enviada previamente a ${remitente}. Omitiendo envío repetido.`);
        return false;
    }

    const extensiones = ['.png', '.jpg', '.jpeg', '.webp'];
    const titulo = tituloPersonalizado || palabraClave.toUpperCase();

    for (const ext of extensiones) {
        const rutaImagen = path.join(CARPETA_IMAGENES, `${palabraClave}${ext}`);
        if (fs.existsSync(rutaImagen)) {
            try {
                ultimoEnvioBotTimestamp = Date.now();
                const media = MessageMedia.fromFilePath(rutaImagen);
                const sentMsg = await client.sendMessage(remitente, media, { caption: `🤖 🖼️ *Infografía: ${titulo}*` });
                if (sentMsg && sentMsg.id) idsMensajesEnviadosBot.add(sentMsg.id._serialized);
                guardarInfografiaEnviada(claveTracking);
                console.log(`🖼️ Infografía enviada a ${remitente}: ${palabraClave}${ext}`);
                return true;
            } catch (errImg) {
                console.error(`Error al enviar imagen ${palabraClave}${ext}:`, errImg.message);
            }
        }
    }
    return false;
}

// Helper para el envío inteligente y fraccionado de infografías de inyectables
async function procesarInfografiasInyectables(client, remitente, textoLower, msgRef = null) {
    const forzar = textoLower.includes('ver') || textoLower.includes('imagen') || textoLower.includes('infografia') || textoLower.includes('infografía') || textoLower.includes('foto');

    // 1. PRIMERO TRIMESTRAL (evita coincidencia errónea con la sílaba "mes")
    if (textoLower.includes('trimestral') || textoLower.includes('tres meses') || textoLower.includes('3 meses') || textoLower.includes('trimestre') || textoLower.includes('depoprovera') || textoLower.includes('depo-provera') || textoLower.includes('medroxiprogesterona')) {
        await enviarInfografiaSiExiste(client, remitente, 'inyeccion_trimestral', 'Inyección Anticonceptiva Trimestral', forzar, msgRef);
        return;
    }

    // 2. SEGUNDO BIMENSUAL
    if (textoLower.includes('bimensual') || textoLower.includes('dos meses') || textoLower.includes('2 meses') || textoLower.includes('bimestral') || textoLower.includes('noristerat')) {
        await enviarInfografiaSiExiste(client, remitente, 'inyeccion_bimensual', 'Inyección Anticonceptiva Bimensual', forzar, msgRef);
        return;
    }

    // 3. TERCERO MENSUAL (con palabras clave que no colisionen con las anteriores)
    if (textoLower.includes('mensual') || textoLower.includes('cada mes') || textoLower.includes('1 mes') || textoLower.includes('un mes') || textoLower.includes('mesigyna') || textoLower.includes('cyclofem') || /\bmes\b/.test(textoLower)) {
        await enviarInfografiaSiExiste(client, remitente, 'inyeccion_mensual', 'Inyección Anticonceptiva Mensual', forzar, msgRef);
        return;
    }
}

// Helper para el envío inteligente de infografías de DIU (Cobre vs Medicado)
async function procesarInfografiasDiu(client, remitente, textoLower, msgRef = null) {
    const forzar = textoLower.includes('ver') || textoLower.includes('imagen') || textoLower.includes('infografia') || textoLower.includes('infografía');

    if (textoLower.includes('cobre') || textoLower.includes('t de cobre') || textoLower.includes('te de cobre') || textoLower.includes('cruz') || textoLower.includes('aparatito de metal')) {
        await enviarInfografiaSiExiste(client, remitente, 'diu_cobre', 'DIU de Cobre', forzar, msgRef);
        return;
    }

    if (textoLower.includes('medicado') || textoLower.includes('mirena') || textoLower.includes('levonorgestrel') || textoLower.includes('hormonal') || textoLower.includes('diu de plastico')) {
        await enviarInfografiaSiExiste(client, remitente, 'diu_medicado', 'DIU Medicado (Levonorgestrel)', forzar, msgRef);
        return;
    }
}

// Cargar dinámicamente los documentos desde la carpeta 'documentos'
async function cargarDocumentosConocimiento() {
    const carpetaDoc = path.join(__dirname, 'documentos');
    let textoAcumulado = '';

    if (!fs.existsSync(carpetaDoc)) {
        fs.mkdirSync(carpetaDoc, { recursive: true });
        console.log('📂 Se creó la carpeta "documentos". Agrega tus archivos .txt, .md o .pdf ahí.');
        return '';
    }

    const archivos = fs.readdirSync(carpetaDoc);
    console.log(`📁 Leyendo la carpeta 'documentos'... (${archivos.length} archivo(s) encontrado(s))`);

    for (const archivo of archivos) {
        const rutaCompleta = path.join(carpetaDoc, archivo);
        const ext = path.extname(archivo).toLowerCase();

        try {
            if (ext === '.txt' || ext === '.md') {
                const contenido = fs.readFileSync(rutaCompleta, 'utf-8');
                textoAcumulado += `\n--- INICIO DOCUMENTO (${archivo}) ---\n${contenido}\n--- FIN DOCUMENTO (${archivo}) ---\n`;
                console.log(`  ✅ Documento cargado: ${archivo}`);
            } else if (ext === '.pdf') {
                const dataBuffer = fs.readFileSync(rutaCompleta);
                const pdfData = await pdfParse(dataBuffer);
                textoAcumulado += `\n--- INICIO PDF (${archivo}) ---\n${pdfData.text}\n--- FIN PDF (${archivo}) ---\n`;
                console.log(`  ✅ Documento PDF cargado: ${archivo}`);
            }
        } catch (err) {
            console.error(`  ❌ Error al leer el archivo ${archivo}:`, err.message);
        }
    }

    return textoAcumulado;
}

// Obtener la lista de números administradores desde .env
function obtenerNumerosAdmin() {
    const envVar = process.env.NUMEROS_NOTIFICACIONES || process.env.NUMERO_NOTIFICACIONES || '';
    return envVar.split(',').map(n => n.trim()).filter(Boolean);
}

// Evaluar si un número o JID pertenece a un administrador (comparando los últimos 10 dígitos)
function esNumeroAdmin(remitente) {
    if (!remitente) return false;
    const rawRemitente = remitente.toString().replace(/[^0-9]/g, '');
    if (!rawRemitente || rawRemitente.length < 10) return false;

    const ultimos10Remitente = rawRemitente.slice(-10);
    const listaAdmins = obtenerNumerosAdmin();

    for (const adminJid of listaAdmins) {
        const rawAdmin = adminJid.toString().replace(/[^0-9]/g, '');
        if (rawAdmin.length >= 10 && rawAdmin.slice(-10) === ultimos10Remitente) {
            return true;
        }
    }
    return false;
}

// Evaluar si estamos en Horario Laboral (Lunes a Viernes de 2:00 PM a 8:30 PM)
function esHorarioLaboral() {
    const ahora = new Date();
    const opcionesHora = { timeZone: 'America/Mexico_City', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' };
    const formateador = new Intl.DateTimeFormat('es-MX', opcionesHora);
    const partes = formateador.formatToParts(ahora);
    
    let diaSemana = '';
    let hora = 0;
    let minuto = 0;

    for (const parte of partes) {
        if (parte.type === 'weekday') diaSemana = parte.value.toLowerCase();
        if (parte.type === 'hour') hora = parseInt(parte.value, 10);
        if (parte.type === 'minute') minuto = parseInt(parte.value, 10);
    }

    const diasLaborables = ['lun', 'mar', 'mié', 'jue', 'vie'];
    const esDiaLaboral = diasLaborables.some(d => diaSemana.startsWith(d));

    if (!esDiaLaboral) return false;

    const minutosTotales = hora * 60 + minuto;
    const inicioLaboral = 14 * 60;       // 14:00 PM (840 mins)
    const finLaboral = 20 * 60 + 30;     // 20:30 PM (1230 mins)

    return minutosTotales >= inicioLaboral && minutosTotales <= finLaboral;
}

// Función inteligente para decir cuándo vuelve el asesor según el día y hora exactos
function obtenerTextoProximoHorario() {
    const ahora = new Date();
    const opcionesHora = { timeZone: 'America/Mexico_City', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' };
    const formateador = new Intl.DateTimeFormat('es-MX', opcionesHora);
    const partes = formateador.formatToParts(ahora);
    
    let diaSemana = '';
    let hora = 0;

    for (const parte of partes) {
        if (parte.type === 'weekday') diaSemana = parte.value.toLowerCase();
        if (parte.type === 'hour') hora = parseInt(parte.value, 10);
    }

    const esFinDeSemana = diaSemana.startsWith('s') || diaSemana.startsWith('d'); // sab, dom
    const esViernes = diaSemana.startsWith('v');

    if (esFinDeSemana) {
        return "el próximo lunes a partir de las 2:00 PM";
    } else if (esViernes && hora >= 20) {
        return "el próximo lunes a partir de las 2:00 PM";
    } else if (hora >= 20) {
        return "mañana a partir de las 2:00 PM";
    } else if (hora < 14) {
        return "hoy a partir de las 2:00 PM";
    }
    return "en nuestro próximo horario laboral (2:00 PM)"; // Fallback de seguridad
}

// Texto del Menú Interactivo de Bienvenida
function obtenerMenuBienvenida(nombrePaciente = null) {
    const saludoHeader = nombrePaciente ?
        `🏥 *¡Hola, ${nombrePaciente}! Bienvenido/a al servicio de Planificación Familiar del CAISES Jaral.*` :
        `🏥 *¡Hola! Bienvenido/a al servicio de Planificación Familiar del CAISES Jaral.*`;

    return `${saludoHeader}

De Lunes a Viernes de 2:00 PM a 8:30 PM estamos para servirte. ☺️

Elige una opción:

1️⃣ 📋 *Requisitos para atención*
2️⃣ 💊 *Métodos disponibles*
3️⃣ ⏰ *Horarios de atención*
4️⃣ 📍 *Ubicación del CAISES*
5️⃣ 👨‍⚕️ *Solicitar Asesor / Agendar Cita*

_Escribe el número de la opción o tu pregunta libremente y con gusto te responderé._`;
}

const MENSAJE_REGISTRO_PRIMERA_VEZ = `📋 *REGISTRO Y AVISO DE PRIVACIDAD* 🔒

Para comunicarte con nuestro personal de salud del CAISES Jaral, completa estos 2 rápidos pasos:

1️⃣ *Abre este enlace y llena tus datos (1 min):*
👉 https://forms.gle/zJxZeXXj1TwWGF9N8

2️⃣ *Escribe aquí tu NOMBRE COMPLETO* para confirmar tu registro y transferirte. ✍️✅

_(Tu información es 100% confidencial y protegida)_ 🏥✨`;

// Helper para resolver el número telefónico real de 10 dígitos (incluso si WhatsApp envía un identificador @lid)
async function obtenerNumeroTelefonoReal(client, msgRef, remitente) {
    if (!remitente) return 'No disponible';

    // 0. Si ya está en caché de memoria, retornar instantáneamente sin tocar la CPU
    if (cacheNumerosTelefono.has(remitente)) {
        return cacheNumerosTelefono.get(remitente);
    }

    // 1. Si es un número administrador registrado, resolver directamente sus 10 dígitos
    const listaAdmins = obtenerNumerosAdmin();
    const rawRem = remitente.replace(/[^0-9]/g, '');
    if (rawRem.length >= 10) {
        const ult10 = rawRem.slice(-10);
        for (const adm of listaAdmins) {
            const rawAdm = adm.replace(/[^0-9]/g, '');
            if (rawAdm.length >= 10 && rawAdm.slice(-10) === ult10) {
                return `+52 ${ult10}`;
            }
        }
    }

    // 2. Si el remitente NO es @lid y tiene 10 o más dígitos
    if (!remitente.includes('@lid')) {
        const rawDigits = remitente.replace(/[^0-9]/g, '');
        if (rawDigits.length >= 10) {
            return `+52 ${rawDigits.slice(-10)}`;
        }
    }

    // 3. Probar getContact() y getFormattedNumber() de whatsapp-web.js
    try {
        if (msgRef && typeof msgRef.getContact === 'function') {
            const contact = await msgRef.getContact();
            if (contact) {
                if (typeof contact.getFormattedNumber === 'function') {
                    const fmt = await contact.getFormattedNumber();
                    if (fmt && fmt.includes('+') && !fmt.includes('@lid')) return fmt;
                }
                if (contact.number && !contact.number.toString().includes('lid')) {
                    return `+52 ${contact.number.toString().slice(-10)}`;
                }
            }
        }
    } catch (e) {}

    // 4. Buscar en la memoria interna de WhatsApp Web (Puppeteer) recorriendo todos los modelos
    if (client && client.pupPage) {
        try {
            const phoneFound = await client.pupPage.evaluate(async (targetId, msgId) => {
                try {
                    if (window.Store && window.Store.Contact && window.Store.Contact.models) {
                        for (const c of window.Store.Contact.models) {
                            if (c.id && c.id._serialized === targetId) {
                                if (c.phoneNumber) return c.phoneNumber;
                                if (c.user && !c.user.includes('lid') && c.user.length >= 10) return c.user;
                            }
                        }
                    }

                    if (window.Store && window.Store.Chat && window.Store.Chat.models) {
                        for (const ch of window.Store.Chat.models) {
                            if (ch.id && ch.id._serialized === targetId) {
                                if (ch.contact) {
                                    if (ch.contact.phoneNumber) return ch.contact.phoneNumber;
                                    if (ch.contact.user && !ch.contact.user.includes('lid') && ch.contact.user.length >= 10) return ch.contact.user;
                                }
                                if (ch.phoneNumber) return ch.phoneNumber;
                            }
                        }
                    }

                    if (msgId && window.Store.Msg) {
                        const m = window.Store.Msg.get(msgId);
                        if (m) {
                            if (m.author && !m.author.includes('@lid')) return m.author.split('@')[0];
                            if (m.sender && m.sender.id && !m.sender.id._serialized.includes('@lid')) return m.sender.id.user;
                        }
                    }
                } catch (e) {}
                return null;
            }, remitente, msgRef && msgRef.id ? msgRef.id._serialized : null);

            if (phoneFound) {
                const digits = phoneFound.toString().replace(/[^0-9]/g, '');
                if (digits.length >= 10) {
                    const resFmt = `+52 ${digits.slice(-10)}`;
                    cacheNumerosTelefono.set(remitente, resFmt);
                    return resFmt;
                }
            }
        } catch (e) {}
    }

    // 5. Si está registrado en pacientes.json, obtener sus datos
    const pacientesBD = cargarPacientes();
    if (pacientesBD[remitente] && pacientesBD[remitente].nombre) {
        const resBD = `Paciente Registrado (${pacientesBD[remitente].nombre})`;
        cacheNumerosTelefono.set(remitente, resBD);
        return resBD;
    }

    return 'Chat Directo de WhatsApp';
}

// Notificación silenciosa EXCLUSIVA para consultas sobre VASECTOMÍA
async function notificarAlertaVasectomia(client, remitente, nombrePaciente, mensajeUsuario, msgRef = null) {
    const listaAdmins = obtenerNumerosAdmin();
    if (listaAdmins.length === 0) return;

    const numeroFormateado = await obtenerNumeroTelefonoReal(client, msgRef, remitente);

    const mensajeAlerta = `✂️ *INTERÉS EN VASECTOMÍA (CAISES JARAL)* ✂️\n\n` +
        `👤 *Paciente:* ${nombrePaciente}\n` +
        `📱 *WhatsApp:* ${numeroFormateado}\n` +
        `💬 *Consulta:* "${mensajeUsuario}"\n` +
        `⏰ *Hora:* ${obtenerHoraMexico()}\n\n` +
        `ℹ️ *Nota:* El bot sigue respondiendo sus dudas normalmente sin pausarse. Puedes ingresar a su chat cuando gustes para agendar su cita personal.`;

    for (const adminNum of listaAdmins) {
        try {
            ultimoEnvioBotTimestamp = Date.now();
            const sent = await client.sendMessage(adminNum, mensajeAlerta);
            if (sent && sent.id) idsMensajesEnviadosBot.add(sent.id._serialized);
            console.log(`🔔 Notificación silenciosa de Vasectomía enviada a ${adminNum}`);
        } catch (err) {
            console.error(`❌ Error al notificar Vasectomía a ${adminNum}:`, err.message);
        }
    }
}

// Función auxiliar para responder mensajes registrando ID y marca distintiva de bot 🤖
async function responderMensajeSeguro(client, msg, contenido) {
    try {
        ultimoEnvioBotTimestamp = Date.now();

        // Agregar distintivo visual 🤖 si no está presente
        const mensajeFinal = contenido.startsWith('🤖') ? contenido : `🤖 ${contenido}`;

        const sent = await msg.reply(mensajeFinal);
        if (sent && sent.id) idsMensajesEnviadosBot.add(sent.id._serialized);

        // Registrar en la lista de chats atendidos en ausencia para el comando !pendientes
        const remitente = msg.from;
        chatsAtendidosBot.set(remitente, {
            id: remitente,
            mensajeUltimo: msg.body,
            hora: obtenerHoraMexico()
        });

        return sent;
    } catch (err) {
        console.error('Error al responder mensaje:', err.message);
    }
}

// Helper para limpiar automáticamente procesos huérfanos de Chrome y bloqueos de sesión tras cerrar la laptop
function limpiarProcesosHuerfanosYBloqueos() {
    try {
        if (process.platform === 'win32') {
            const { execSync } = require('child_process');
            execSync('taskkill /F /IM chrome.exe /T 2>NUL', { stdio: 'ignore' });
        }
    } catch (e) {}

    try {
        const lockPath = path.join(__dirname, '.wwebjs_auth', 'session', 'SingletonLock');
        if (fs.existsSync(lockPath)) {
            fs.unlinkSync(lockPath);
            console.log('🧹 Bloqueo de sesión previo eliminado con éxito.');
        }
    } catch (eLock) {}
}

async function iniciarBot() {
    limpiarProcesosHuerfanosYBloqueos();
    const conocimientoDocumentos = await cargarDocumentosConocimiento();

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error('❌ ERROR CRÍTICO: No se encontró la variable GEMINI_API_KEY en el archivo .env');
        process.exit(1);
    }

    const genAI = new GoogleGenerativeAI(apiKey);

    const systemInstruction = `Eres un asistente virtual de salud del área de planificación familiar del CAISES Jaral. Tu tono debe ser empático, amable, profesional, claro y muy conversacional.

REGLAS DE ATENCIÓN E INSTRUCCIONES ESPECÍFICAS DE RESPUESTA:

1. REGLA DE ORO DE INFORMACIÓN MÉDICA Y ORIENTACIÓN PROFESIONAL:
   - Tienes estrictamente prohibido inventar información médica de métodos que no tengamos o inventar disponibilidad.
   - Si te preguntan sobre un tema médico general de salud reproductiva (ej. puerperio, menstruación, anatomía) que no esté en tus documentos, SÍ puedes dar una explicación muy breve y general basada en tu conocimiento médico, pero aclarando que es solo información educativa y que para un diagnóstico o valoración siempre se requiere acudir presencialmente.
   - Si un usuario pregunta si se puede colocar o usar un método específico, explícale de forma amigable, respetuosa y muy resumida que para utilizar cualquier método debe recibir primero una adecuada orientación y consejería presencial por un profesional de la salud, con el fin de que el paciente y el personal de salud tomen la mejor decisión de forma conjunta basándose en criterios científicos y en las características propias de cada persona. (No menciones explícitamente las siglas de la OMS al paciente).

2. PROHIBICIÓN ABSOLUTA DE ASEGURAR CITAS O ATENCIONES INMEDIATAS:
   - JAMÁS asegures o prometas atenciones el mismo día, retirado, colocación o servicios inmediatos.
   - Aclara siempre de forma cordial que cualquier atención, colocación o retiro queda estrictamente sujeta a disponibilidad de horario y fechas, previa consejería con el personal de salud.

3. ATENCIÓN FRACCIONADA Y BREVE (NUNCA DE GOLPE):
   - Tus respuestas deben ser breves (máximo 1 a 2 frases cortas por mensaje).
   - NUNCA des toda la información de un método o vasectomía de golpe.
   - Cuando un paciente pregunte sobre un método (ej. pastillas, parche, implante, DIU, inyecciones), dale una breve introducción de 1 o 2 frases y PREGÚNTALE qué detalle específico le gustaría conocer (ej. su duración, cómo se coloca o sus posibles efectos secundarios).
   - Si un paciente pregunta de forma genérica sobre "inyecciones" o "inyectables" (sin especificar si es de 1 mes, 2 meses o 3 meses), menciónale brevemente que contamos con inyecciones de 1 mes, 2 meses y 3 meses, y pregúntale cuál de ellas le gustaría conocer para darle la información adecuada.
   - Si un método NO ESTÁ DISPONIBLE en la clínica (ej. parches anticonceptivos), infórmaselo amablemente de inmediato en 1 frase y ofrécele alternativas que SÍ estén disponibles y que sean ADECUADAS para el paciente, tomando siempre en cuenta lo que te haya platicado en su historial (por ejemplo, si te dijo que está lactando, ofrécele DIU o Implante, NUNCA pastillas tradicionales). No expliques su uso a menos que te lo pidan explícitamente.
   - Si el paciente te pide ver una imagen, foto o infografía de algún método, dile amablemente que en un momento el sistema automatizado le hará llegar la ilustración (NUNCA digas que no puedes enviar imágenes).

4. SOLICITUD DE ASESOR Y RECONOCIMIENTO DE HORARIOS:
   - Toma en cuenta siempre el [ESTADO ACTUAL DEL SERVICIO] que viene al inicio del mensaje del paciente:
     * Si estamos FUERA DE HORARIO, recuérdale que el personal le atenderá en su próximo horario laboral y NUNCA prometas atención inmediata en ese momento.
     * Si estamos EN HORARIO LABORAL, coméntale amablemente que es posible que la respuesta demore un poco debido a que el personal se encuentra atendiendo consulta presencial o realizando algún procedimiento médico.
   - Si no ha llenado su registro de privacidad, invítalo amablemente a completar el formulario previo.
   - Aclara siempre que mientras tanto tú te mantienes activo 24/7 para responder cualquier duda adicional.

A CONTINUACIÓN TIENES LA INFORMACIÓN Y DOCUMENTOS OFICIALES PARA RESPONDER:
${conocimientoDocumentos ? conocimientoDocumentos : 'Actualmente no hay documentos específicos cargados en el sistema.'}`;

    const client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: true,
            executablePath: process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
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
                '--disable-breakpad',
                '--disable-client-side-phishing-detection',
                '--disable-default-apps',
                '--disable-hang-monitor',
                '--disable-popup-blocking',
                '--disable-prompt-on-repost',
                '--disable-sync',
                '--disable-translate',
                '--metrics-recording-only',
                '--mute-audio',
                '--safebrowsing-disable-auto-update'
            ]
        }
    });

    let tiempoInicioLoading = null;
    let ultimoPorcentaje = null;
    let botConectadoEstado = false;

    client.on('loading_screen', (percent, message) => {
        console.log(`⏳ Cargando WhatsApp... ${percent}% - ${message}`);
        
        // Si el bot YA está conectado y en ejecución, las sincronizaciones de fondo (50%, 99%) son normales y no deben recargar la página
        if (botConectadoEstado) {
            tiempoInicioLoading = null;
            ultimoPorcentaje = null;
            return;
        }

        // Guardián Universal: Si se queda en CUALQUIER porcentaje antes de 'ready' por más de 2.5 minutos sin avanzar, forzar recarga
        if (ultimoPorcentaje !== percent) {
            tiempoInicioLoading = Date.now();
            ultimoPorcentaje = percent;
        }

        if (tiempoInicioLoading && (Date.now() - tiempoInicioLoading > 150000)) {
            console.warn(`⚠️ ALERTA: WhatsApp Web atascado en ${percent}% durante el inicio por más de 2.5 minutos. Forzando recarga de página interna...`);
            tiempoInicioLoading = null;
            ultimoPorcentaje = null;
            if (client.pupPage && !client.pupPage.isClosed()) {
                client.pupPage.reload({ waitUntil: 'networkidle0' }).catch(() => {});
            }
        }
    });

    client.on('qr', (qr) => {
        qrcode.generate(qr, { small: true });
        botConectadoEstado = false;
        tiempoInicioLoading = null;
        ultimoPorcentaje = null;
        console.log('📲 Escanea el código QR anterior en tu aplicación de WhatsApp.');
    });

    client.on('ready', () => {
        const admins = obtenerNumerosAdmin();
        botConectadoEstado = true;
        tiempoInicioLoading = null;
        ultimoPorcentaje = null;
        console.log('🚀 ¡Conectado con éxito! El bot de CAISES Jaral está en ejecución...');
        console.log(`👑 Administradores registrados para alertas de Vasectomía (${admins.length}):`, admins.join(', '));
    });

    client.on('disconnected', (reason) => {
        botConectadoEstado = false;
        tiempoInicioLoading = null;
        ultimoPorcentaje = null;
        console.log('❌ El bot de WhatsApp se ha desconectado:', reason);
    });

    // Guardián Activo y Keep-Alive periódico cada 60 segundos
    setInterval(async () => {
        try {
            // El watchdog de carga solo aplica si el bot NO ha logrado conectarse
            if (!botConectadoEstado && tiempoInicioLoading && (Date.now() - tiempoInicioLoading > 180000)) {
                console.warn(`⚠️ ALERTA WATCHDOG: El proceso de carga inicial lleva más de 3 minutos atascado en ${ultimoPorcentaje}%. Forzando recarga...`);
                tiempoInicioLoading = null;
                ultimoPorcentaje = null;
                if (client.pupPage && !client.pupPage.isClosed()) {
                    client.pupPage.reload({ waitUntil: 'networkidle0' }).catch(() => {});
                }
            }

            // Mantener despierto el WebSocket de Chromium en madrugadas
            if (botConectadoEstado && client.pupPage && !client.pupPage.isClosed()) {
                await client.pupPage.evaluate(() => {
                    return window.Store && window.Store.AppState ? true : false;
                }).catch(() => {});
            }
        } catch (e) {}
    }, 60000);

    // Procesador universal de mensajes de WhatsApp
    async function procesarMensaje(msg) {
        if (!msg || msg.from === 'status@broadcast' || msg.from.endsWith('@g.us')) return;

        // 1. Descartar mensajes antiguos (más de 2 minutos) que WhatsApp entrega al reconectar o reiniciar
        if (msg.timestamp) {
            const antiguedadSegundos = (Date.now() / 1000) - msg.timestamp;
            if (antiguedadSegundos > 120) {
                console.log(`⏳ Omitiendo mensaje antiguo (${Math.round(antiguedadSegundos)}s de antigüedad) de ${msg.from}`);
                return;
            }
        }

        // 2. Evitar procesar mensajes generados por las respuestas automáticas del bot
        if (msg.id && idsMensajesEnviadosBot.has(msg.id._serialized)) return;

        const remitente = msg.from;

        // 3. FILTRO DE AUDIOS / NOTAS DE VOZ (se procesa antes de validar texto para que no sea ignorado)
        if (msg.type === 'ptt' || msg.type === 'audio' || msg.type === 'voice') {
            console.log(`🎙️ [AUDIO RECIBIDO] De: ${remitente} | Tipo: ${msg.type}`);
            await responderMensajeSeguro(client, msg, "🎙️ *Hola. Por el momento mi sistema de Inteligencia Artificial solo puede leer mensajes de texto.*\n\nPor favor, escríbeme tu duda o consulta por escrito para poder ayudarte.");
            return;
        }

        // 4. Validar que tenga texto para el resto de los módulos
        if (!msg.body || typeof msg.body !== 'string' || !msg.body.trim()) return;

        const texto = msg.body.trim();
        const textoLower = texto.toLowerCase();

        console.log(`💬 [MENSAJE RECIBIDO] De: ${remitente} | Tipo: ${msg.type} | Texto: "${texto}"`);

        // -------------------------------------------------------------
        // EXCEPCIÓN PARA TELÉFONOS ADMINISTRADORES SECUNDARIOS Y COMANDOS (!)
        // -------------------------------------------------------------
        const esAdminSecundario = esNumeroAdmin(remitente);

        if (esAdminSecundario || msg.fromMe || texto.startsWith('!')) {
            if (texto.startsWith('!')) {
                console.log(`👑 Ejecutando Comando de Administrador desde ${remitente}: ${texto}`);

                if (textoLower === '!pendientes' || textoLower === '!resumen' || textoLower === '!reporte') {
                    const pacientesBD = cargarPacientes();
                    if (chatsAtendidosBot.size === 0) {
                        await responderMensajeSeguro(client, msg, "📋 *REPORTE DE AUSENCIA:* No se han registrado nuevas consultas atendidas por el bot recientemente.");
                        return;
                    }

                    let reporte = `📋 *REPORTE DE CHATS ATENDIDOS POR EL BOT EN TU AUSENCIA (${chatsAtendidosBot.size}):*\n\n`;
                    let idx = 1;
                    for (const [jid, data] of chatsAtendidosBot.entries()) {
                        const infoBD = pacientesBD[jid];
                        const nombreFinal = infoBD ? infoBD.nombre : "Paciente (Primera Vez / Consulta Anónima)";
                        const numLimpio = await obtenerNumeroTelefonoReal(client, null, jid);
                        reporte += `${idx}️⃣ 👤 *${nombreFinal}*\n📱 WhatsApp: ${numLimpio}\n💬 Último mensaje: "${data.mensajeUltimo}"\n⏰ Hora: ${data.hora}\n\n`;
                        idx++;
                    }

                    reporte += `_💡 Puedes ingresar directamente a sus chats en WhatsApp Web para darles seguimiento o agendar cita._`;
                    await responderMensajeSeguro(client, msg, reporte);
                    return;
                }

                if (textoLower.startsWith('!vacaciones')) {
                    const partes = texto.split(' ');
                    const accion = partes[1] ? partes[1].toLowerCase() : '';
                    const estado = cargarEstadoVacaciones();

                    if (accion === 'desactivar' || accion === 'off') {
                        estado.activo = false;
                        estado.tipo = null;
                        estado.mensaje = null;
                        estado.fechaFin = null;
                        guardarEstadoVacaciones(estado);
                        await responderMensajeSeguro(client, msg, "🏖️ *MODO VACACIONES DESACTIVADO.* El bot reanuda la atención normal.");
                        return;
                    }

                    if (accion === 'activar' || accion === 'on' || !isNaN(parseInt(accion, 10))) {
                        estado.activo = true;
                        estado.tipo = 'vacaciones';
                        if (!isNaN(parseInt(accion, 10))) {
                            const dias = parseInt(accion, 10);
                            const fechaFin = new Date();
                            fechaFin.setDate(fechaFin.getDate() + dias);
                            estado.fechaFin = fechaFin.toISOString();
                            estado.mensaje = partes.slice(2).join(' ') || null;
                        } else {
                            estado.mensaje = partes.slice(2).join(' ') || null;
                            estado.fechaFin = null;
                        }

                        guardarEstadoVacaciones(estado);
                        await responderMensajeSeguro(client, msg, 
                            `🌴 *MODO VACACIONES ACTIVADO CON ÉXITO.*\n\n` +
                            `📌 Nota opcional: ${estado.mensaje ? estado.mensaje : 'En receso vacacional'}\n` +
                            `🗓️ Fecha fin: ${estado.fechaFin ? obtenerFechaMexico(estado.fechaFin) : 'Indefinido'}`
                        );
                        return;
                    }

                    await responderMensajeSeguro(client, msg, 
                        "🌴 *COMANDOS DE GESTIÓN DE VACACIONES:*\n\n" +
                        "• `!vacaciones 10` (10 días a partir de hoy)\n" +
                        "• `!vacaciones activar [mensaje opcional]`\n" +
                        "• `!vacaciones desactivar`"
                    );
                    return;
                }

                if (textoLower.startsWith('!curso') || textoLower.startsWith('!capacitacion') || textoLower.startsWith('!capacitación')) {
                    const partes = texto.split(' ');
                    const accion = partes[1] ? partes[1].toLowerCase() : '';
                    const estado = cargarEstadoVacaciones();

                    if (accion === 'desactivar' || accion === 'off') {
                        estado.activo = false;
                        estado.tipo = null;
                        estado.mensaje = null;
                        estado.fechaFin = null;
                        guardarEstadoVacaciones(estado);
                        await responderMensajeSeguro(client, msg, "🎓 *MODO CURSO / CAPACITACIÓN DESACTIVADO.* El bot reanuda la atención normal.");
                        return;
                    }

                    if (accion === 'activar' || accion === 'on' || !isNaN(parseInt(accion, 10))) {
                        estado.activo = true;
                        estado.tipo = 'curso';
                        if (!isNaN(parseInt(accion, 10))) {
                            const dias = parseInt(accion, 10);
                            const fechaFin = new Date();
                            fechaFin.setDate(fechaFin.getDate() + dias);
                            estado.fechaFin = fechaFin.toISOString();
                            estado.mensaje = partes.slice(2).join(' ') || null;
                        } else {
                            estado.mensaje = partes.slice(2).join(' ') || null;
                            estado.fechaFin = null;
                        }

                        guardarEstadoVacaciones(estado);
                        await responderMensajeSeguro(client, msg, 
                            `🎓 *MODO CURSO / CAPACITACIÓN ACTIVADO CON ÉXITO.*\n\n` +
                            `📌 Tipo: Curso de Actualización Profesional\n` +
                            `📌 Nota opcional: ${estado.mensaje ? estado.mensaje : 'En curso de capacitación'}\n` +
                            `🗓️ Fecha fin: ${estado.fechaFin ? obtenerFechaMexico(estado.fechaFin) : 'Indefinido'}`
                        );
                        return;
                    }

                    await responderMensajeSeguro(client, msg, 
                        "🎓 *COMANDOS DE GESTIÓN DE CURSO Y CAPACITACIÓN:*\n\n" +
                        "• `!curso 1` (1 día de curso)\n" +
                        "• `!curso 3` (3 días de curso)\n" +
                        "• `!curso activar [nota opcional]`\n" +
                        "• `!curso desactivar`"
                    );
                    return;
                }

                if (textoLower.startsWith('!registrar ') || textoLower.startsWith('!nombre ') || textoLower.startsWith('!renombrar ')) {
                    const partes = texto.split(' ');
                    let targetId = null;
                    let nombreIngresado = "";

                    // Opción A: Proporcionó un número de teléfono explícito
                    const posibleNumero = partes[1] ? formatearNumeroWhatsApp(partes[1]) : null;
                    if (posibleNumero) {
                        targetId = posibleNumero;
                        nombreIngresado = partes.slice(2).join(' ').trim() || "Paciente Registrado Directamente";
                    } else {
                        // Opción B: Se escribió el comando directamente dentro de un chat
                        targetId = (msg.fromMe && msg.to && msg.to !== 'status@broadcast') ? msg.to : msg.from;
                        nombreIngresado = partes.slice(1).join(' ').trim();
                    }

                    if (!targetId || !nombreIngresado) {
                        await responderMensajeSeguro(client, msg, "❌ *Formato incorrecto.*\n\n• En el chat del paciente: `!nombre Juan Pérez`\n• Desde cualquier chat: `!nombre 4111234567 Juan Pérez`");
                        return;
                    }

                    guardarPaciente(targetId, nombreIngresado);
                    await responderMensajeSeguro(client, msg, `✅ *Paciente Registrado en Sistema:*\n📱 Número: +${targetId.replace('@c.us', '')}\n👤 Nombre: ${nombreIngresado}`);
                    return;
                }

                if (textoLower.startsWith('!pausa') || textoLower.startsWith('!pausar')) {
                    const partes = texto.split(' ');
                    const numRaw = partes[1] ? partes[1].trim() : '';

                    if (!numRaw || numRaw.toLowerCase() === 'global' || numRaw.toLowerCase() === 'todo') {
                        botPausadoGlobal = true;
                        await responderMensajeSeguro(client, msg, "⏸️ *BOT PAUSADO GLOBALMENTE DE FORMA INDEFINIDA.*\n\nEl bot no responderá a ningún paciente hasta que envíes `!reactivar`.");
                        return;
                    }

                    const targetId = formatearNumeroWhatsApp(numRaw);
                    if (targetId) {
                        chatsPausados.set(targetId, Date.now());
                        guardarPausas();
                        await responderMensajeSeguro(client, msg, `⏸️ Chat +${targetId.replace('@c.us', '')} pausado por 2 horas.`);
                    } else {
                        await responderMensajeSeguro(client, msg, "⚠️ Especifica un número válido de 10 dígitos o escribe `!pausa` solo para pausar todo de forma indefinida.");
                    }
                    return;
                }

                if (textoLower.startsWith('!reactivar') || textoLower === '!unpause' || textoLower === '!activar') {
                    // Desactivar estado de vacaciones o curso en vacaciones.json
                    const estadoVacaciones = cargarEstadoVacaciones();
                    estadoVacaciones.activo = false;
                    estadoVacaciones.tipo = null;
                    estadoVacaciones.mensaje = null;
                    estadoVacaciones.fechaFin = null;
                    guardarEstadoVacaciones(estadoVacaciones);

                    // Desactivar pausas globales e individuales
                    botPausadoGlobal = false;
                    chatsPausados.clear();
                    guardarPausas();

                    await responderMensajeSeguro(client, msg, "✅ *BOT COMPLETAMENTE REACTIVADO.*\n\nSe han desactivado las vacaciones/curso y todas las pausas. El bot reanuda la atención normal.");
                    return;
                }

                if (textoLower === '!ayuda' || textoLower === '!help') {
                    await responderMensajeSeguro(client, msg, 
                        "🤖 *COMANDOS DE ADMINISTRADOR (CAISES JARAL):*\n\n" +
                        "🌴 `!vacaciones 10` -> Activa receso por vacaciones (10 días).\n" +
                        "🎓 `!curso 1` -> Activa aviso de Curso/Capacitación (1 o 3 días).\n" +
                        "⏸️ `!pausa` -> Pausa GLOBALMENTE el bot de forma indefinida.\n" +
                        "▶️ `!reactivar` -> COMANDO ÚNICO para reanudar la atención (desactiva vacaciones, curso y pausas).\n" +
                        "📋 `!pendientes` -> Muestra el resumen de chats atendidos en tu ausencia.\n" +
                        "📝 `!registrar 4111234567 María López` -> Registra paciente en sistema."
                    );
                    return;
                }
            }

            if (esAdminSecundario) return;
        }

        // -------------------------------------------------------------
        // B. CHATS PAUSADOS (GLOBAL O POR INTERVENCIÓN HUMANA)
        // -------------------------------------------------------------
        if (botPausadoGlobal) {
            console.log(`⏸️ Bot pausado globalmente. Omitiendo respuesta a ${remitente}`);
            return;
        }

        if (chatsPausados.has(remitente)) {
            const tiempoPausa = chatsPausados.get(remitente);
            
            // -------------------------------------------------------------
            // ? MODIFICAR AQUI EL TIEMPO DE PAUSA POR ATENCION HUMANA ?
            // El tiempo est en milisegundos.
            // Ejemplo 2 horas = 2 * 60 * 60 * 1000
            // Ejemplo 30 minutos = 30 * 60 * 1000
            // -------------------------------------------------------------
            const TIEMPO_DE_PAUSA = 2 * 60 * 60 * 1000; 

            if (Date.now() - tiempoPausa < TIEMPO_DE_PAUSA) {
                console.log(`⏸️ Chat ${remitente} está pausado por atención humana.`);
                return;
            } else {
                chatsPausados.delete(remitente);
                guardarPausas();
            }
        }

        // Cargar pacientes registrados
        const pacientesBD = cargarPacientes();
        const pacienteExistente = pacientesBD[remitente];

        // -------------------------------------------------------------
        // C. PROCESO DE REGISTRO TRAS SOLICITAR ASESOR Y LLENAR FORMULARIO
        // -------------------------------------------------------------
        if (pendientesRegistro.has(remitente)) {
            const nombreIngresado = texto;
            guardarPaciente(remitente, nombreIngresado);
            pendientesRegistro.delete(remitente);

            const estadoVacaciones = cargarEstadoVacaciones();
            if (estadoVacaciones.activo) {
                await responderMensajeSeguro(client, msg, `¡Muchas gracias, *${nombreIngresado}*! Tu registro ha sido confirmado. ✍️✅`);
                await responderMensajeSeguro(client, msg, obtenerMensajeReceso(estadoVacaciones));
                return;
            }

            const enHorario = esHorarioLaboral();
            if (enHorario) {
                await responderMensajeSeguro(client, msg, `¡Muchas gracias, *${nombreIngresado}*! Tu registro y aviso de privacidad han sido confirmados con éxito. ✍️✅\n\n👨‍⚕️ He notificado a nuestro personal de salud del CAISES Jaral por este chat.\n\n📌 *Nota importante:* Es posible que nuestro personal demore un poco en responderte ya que se encuentran atendiendo consulta presencial o en algún procedimiento médico.\n\n🤖 *Mientras tanto, el asistente virtual se mantiene activo por si tienes más dudas.*`);
            } else {
                const proximo = obtenerTextoProximoHorario();
                await responderMensajeSeguro(client, msg, `¡Muchas gracias, *${nombreIngresado}*! Tu registro y aviso de privacidad han sido confirmados con éxito. ✍️✅\n\n⏰ *Fuera de horario de atención personalizada:* He dejado tu solicitud registrada. Nuestro personal revisará tus datos y te atenderá **${proximo}**.\n\n🤖 *Mientras tanto, el asistente virtual se mantiene activo por si deseas consultar métodos o requisitos.*`);
            }
            return;
        }

        // -------------------------------------------------------------
        // D. ENVÍO AUTOMÁTICO Y CONTROLADO DE INFOGRAFÍAS
        // -------------------------------------------------------------
        const forzarImagen = textoLower.includes('ver') || textoLower.includes('imagen') || textoLower.includes('infografia') || textoLower.includes('infografía');
        const pideDisponibilidadGeneral = textoLower.includes('tienen') || textoLower.includes('hay') || textoLower.includes('disponible') || textoLower.includes('cuentan');

        if (textoLower.includes('vasectomia') || textoLower.includes('vasectomía')) {
            const nombreVasectomia = pacienteExistente ? pacienteExistente.nombre : "Paciente (Consulta Anónima)";
            await notificarAlertaVasectomia(client, remitente, nombreVasectomia, msg.body, msg);

            // Si pregunta por requisitos/preparación o cita, se envía preparacion_vasectomia
            if (textoLower.includes('requisito') || textoLower.includes('preparac') || textoLower.includes('cita') || textoLower.includes('rasurar')) {
                await enviarInfografiaSiExiste(client, remitente, 'preparacion_vasectomia', 'Preparación para Vasectomía Sin Bisturí', forzarImagen, msg);
            } else if (forzarImagen) {
                await enviarInfografiaSiExiste(client, remitente, 'vasectomia', 'Vasectomía Sin Bisturí', forzarImagen, msg);
            }
        }

        await procesarInfografiasInyectables(client, remitente, textoLower, msg);
        await procesarInfografiasDiu(client, remitente, textoLower, msg);

        if (textoLower.includes('metodos') || textoLower.includes('métodos') || textoLower.includes('catalogo') || textoLower.includes('catálogo')) {
            await enviarInfografiaSiExiste(client, remitente, 'metodos', 'Catálogo General de Métodos Anticonceptivos', forzarImagen, msg);
        }
        if ((textoLower.includes('implante') || textoLower.includes('implente') || textoLower.includes('chip') || textoLower.includes('aparatito del brazo')) && !pideDisponibilidadGeneral) {
            await enviarInfografiaSiExiste(client, remitente, 'implante', 'Implante Subdérmico', forzarImagen, msg);
        }
        
        // NO enviar parche.png si pregunta disponibilidad o si el método no está disponible
        if ((textoLower.includes('parche') || textoLower.includes('parchesito')) && forzarImagen) {
            await enviarInfografiaSiExiste(client, remitente, 'parche', 'Parche Anticonceptivo', true, msg);
        }

        if (textoLower.includes('condon') || textoLower.includes('condón') || textoLower.includes('preservativo')) await enviarInfografiaSiExiste(client, remitente, 'condon', 'Condón Masculino y Femenino', forzarImagen, msg);
        if (textoLower.includes('pastilla') || textoLower.includes('pastillas') || textoLower.includes('pildora') || textoLower.includes('píldora')) await enviarInfografiaSiExiste(client, remitente, 'pastillas', 'Pastillas Anticonceptivas', forzarImagen, msg);
        if (textoLower.includes('emergencia') || textoLower.includes('dia despues') || textoLower.includes('día después')) await enviarInfografiaSiExiste(client, remitente, 'emergencia', 'Anticoncepción de Emergencia', forzarImagen, msg);
        if (textoLower.includes('ubicacion') || textoLower.includes('mapa') || textoLower.includes('donde estan') || textoLower.includes('dónde están')) await enviarInfografiaSiExiste(client, remitente, 'ubicacion', 'Ubicación CAISES Jaral', forzarImagen, msg);

        // -------------------------------------------------------------
        // E. MENÚ INTERACTIVO DE BIENVENIDA O SELECCIÓN RÁPIDA (LIBRE PARA TODOS)
        // -------------------------------------------------------------
        const saludos = ['hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'menu', 'menú', 'inicio', 'opciones', 'empezar', 'hola!'];
        if (saludos.includes(textoLower)) {
            const nombreMostrar = pacienteExistente ? pacienteExistente.nombre : null;
            await responderMensajeSeguro(client, msg, obtenerMenuBienvenida(nombreMostrar));
            return;
        }

        // Respuestas inmediatas por número de menú
        if (textoLower === '1') {
            const reqMsg = `📋 *REQUISITOS PARA ATENCIÓN EN CAISES JARAL:*

En caso de no contar con expediente se requiere enviar por foto o traer copias impresas de:
🪪 CREDENCIAL DE ELECTOR (solo si cuenta con ella) o bien
📃 CURP y
🏠 COMPROBANTE DE DOMICILIO RECIENTE

✨ *NO ES NECESARIO SER MAYOR DE EDAD Y EL SERVICIO DE PLANIFICACIÓN FAMILIAR ES GRATUITO Y CONFIDENCIAL SIN IMPORTAR DERECHOHABIENCIA O LUGAR DE RESIDENCIA.*
Si ya tiene número de expediente📄, otorgarlo para dar continuidad.

_💡 Si deseas agendar cita directa o atención personal, escribe la palabra *asesor*._`;
            await responderMensajeSeguro(client, msg, reqMsg);
            return;
        }

        if (textoLower === '2') {
            await enviarInfografiaSiExiste(client, remitente, 'metodos', 'Catálogo General de Métodos Anticonceptivos', forzarImagen, msg);
            const metodosMsg = `💊 *MÉTODOS ANTICONCEPTIVOS DISPONIBLES (100% GRATIS):*\n\n` +
                `• Condón masculino y femenino.\n` +
                `• Pastillas anticonceptivas orales.\n` +
                `• Inyecciones anticonceptivas (mensuales, bimensuales y trimestrales).\n` +
                `• Implante subdérmico.\n` +
                `• Dispositivo Intrauterino (DIU) de cobre.\n` +
                `• Dispositivo Intrauterino (DIU) Medicado (Levonorgestrel).\n` +
                `• Vasectomía sin bisturí.\n` +
                `• Método de emergencia.\n\n` +
                `_¿Deseas información sobre alguno en específico? Pregúntame libremente o escribe *asesor* para agendar una cita._`;
            await responderMensajeSeguro(client, msg, metodosMsg);
            return;
        }

        if (textoLower === '3') {
            const horarioMsg = `⏰ *HORARIOS DE ATENCIÓN Y CONSULTA DE PLANIFICACIÓN FAMILIAR:*

🗓️ *Atención presencial y por chat:* Lunes a Viernes de 2:00 PM a 8:30 PM.
⛔ *Sábados, Domingos y Días Festivos:* No hay consulta externa.

_💡 Si deseas agendar una cita directa o hablar con nuestro personal, escribe la palabra *asesor*._`;
            await responderMensajeSeguro(client, msg, horarioMsg);
            return;
        }

        if (textoLower === '4') {
            await enviarInfografiaSiExiste(client, remitente, 'ubicacion', 'Ubicación CAISES Jaral', forzarImagen, msg);
            const ubicaMsg = `📍 *UBICACIÓN Y DOMICILIO DEL CAISES JARAL:*

Puedes abrir la ubicación exacta en Google Maps aquí:
🔗 https://maps.app.goo.gl/S51vXVfHb3kihpjp9

_💡 Si deseas agendar cita directa o atención personal, escribe la palabra *asesor*._`;
            await responderMensajeSeguro(client, msg, ubicaMsg);
            return;
        }

        // -------------------------------------------------------------
        // F. SOLICITUD DIRECTA DE ASESOR HUMANO / TRANSFERENCIA A PERSONAL
        // -------------------------------------------------------------
        const esOpcionCinco = textoLower === '5';
        const esComandoAsesor = textoLower === 'asesor' || textoLower === '!asesor' || textoLower === 'humano' || textoLower === 'agente';

        const frasesDirectasAsesor = [
            'hablar con alguien', 'hablar con un asesor', 'hablar con una persona', 'hablar con un humano',
            'atencion personal', 'atención personal', 'atencion personalizada', 'atención personalizada',
            'comunicar con asesor', 'comunicarme con asesor', 'comunicarme con alguien', 'comunicar con alguien',
            'pasame a un asesor', 'pásame a un asesor', 'pasame con un asesor', 'pásame con un asesor',
            'quiero hablar con una enfermera', 'quiero hablar con un doctor', 'quiero un asesor', 'necesito un asesor',
            'pedir asesor', 'solicitar asesor', 'solicito asesor', 'transferir con asesor', 'transferirme'
        ];

        const pideAsesorDirecto = esOpcionCinco || esComandoAsesor || frasesDirectasAsesor.some(f => textoLower.includes(f));

        // Detectar si el mensaje es una pregunta o consulta informativa amplia (para no secuestrar preguntas médicas o de requisitos)
        const palabrasPreguntaOInformacion = [
            'que', 'qué', 'como', 'cómo', 'donde', 'dónde', 'cuando', 'cuándo', 'cuanto', 'cuánto',
            'requisito', 'requisitos', 'papel', 'papeles', 'documento', 'documentos', 'informacion', 'información',
            'vencido', 'retirar', 'retiro', 'colocar', 'poner', 'duele', 'sirve', 'tienen', 'hay', 'costo', 'precio', 'gratis'
        ];
        const esConsultaInformativa = palabrasPreguntaOInformacion.some(p => textoLower.includes(p));

        // Solo activar el traspaso de asesor si NO es una consulta que la IA deba responder
        const solicitaAsesor = pideAsesorDirecto && (!esConsultaInformativa || esOpcionCinco || esComandoAsesor);

        if (solicitaAsesor) {
            const estadoVacaciones = cargarEstadoVacaciones();
            if (estadoVacaciones.activo) {
                await responderMensajeSeguro(client, msg, obtenerMensajeReceso(estadoVacaciones));
                return;
            }

            const enHorario = esHorarioLaboral();

            if (enHorario) {
                // Si NO está registrado, le enviamos el aviso de privacidad
                if (!pacienteExistente) {
                    pendientesRegistro.set(remitente, true);
                    await responderMensajeSeguro(client, msg, MENSAJE_REGISTRO_PRIMERA_VEZ);
                    return;
                }

                await responderMensajeSeguro(client, msg, `👨‍⚕️ Entendido, *${pacienteExistente.nombre}*. He notificado a nuestro personal del CAISES Jaral por este chat.\n\n📌 *Nota importante:* Es posible que nuestro personal demore un poco en responderte ya que se encuentran atendiendo consulta presencial o en algún procedimiento médico.\n\n🤖 *Mientras tanto, el asistente virtual se mantiene activo por si deseas hacer más preguntas o consultar cualquier otro tema.*`);
                return;
            } else {
                const proximo = obtenerTextoProximoHorario();
                await responderMensajeSeguro(client, msg, `🤖 Hola. Por el momento nos encontramos *fuera de nuestro horario de atención personalizada*.\n\n` +
                    `🕒 Nuestro personal te podrá atender **${proximo}**.\n\n` +
                    `Mientras tanto, el asistente virtual sigue activo. Puedes hacerme cualquier consulta sobre métodos o requisitos y con gusto te informaré.`);
                return;
            }
        }

        // -------------------------------------------------------------
        // G. CONSULTA NORMAL CON GEMINI AI (CON RESPALDO CASCADA DE MODELOS)
        // -------------------------------------------------------------
        try {
            let respuestaIA = null;
            const modelosPrueba = [
                "gemini-flash-latest",
                "gemini-2.5-flash",
                "gemini-2.0-flash",
                "gemini-1.5-flash",
                "gemini-1.5-pro"
            ];
            let ultimoError = null;

            // Obtener o crear historial para el usuario
            if (!historialesChat.has(remitente)) {
                historialesChat.set(remitente, []);
            }
            const historial = historialesChat.get(remitente);
            
            // Construir el prompt con contexto y estado de horario en tiempo real
            const enHorario = esHorarioLaboral();
            const estadoVac = cargarEstadoVacaciones();
            let contextoHorario = '';
            if (estadoVac.activo) {
                contextoHorario = `[ESTADO DEL SERVICIO: EN RECESO/CURSO. Actualmente no hay atención médica presencial.]`;
            } else if (enHorario) {
                contextoHorario = `[ESTADO DEL SERVICIO: HORARIO LABORAL ACTIVO (Lunes a Viernes de 2:00 PM a 8:30 PM). El personal está en clínica atendiendo.]`;
            } else {
                const proximo = obtenerTextoProximoHorario();
                contextoHorario = `[ESTADO DEL SERVICIO: FUERA DE HORARIO DE ATENCIÓN PRESENCIAL. Si el paciente pregunta por hablar con un asesor o agendar, indícale amablemente que nuestro personal le atenderá ${proximo}. NUNCA prometas atención inmediata en este momento.]`;
            }

            let promptConMemoria = `${contextoHorario}\n\nMensaje del paciente: ${msg.body}`;
            if (historial.length > 0) {
                promptConMemoria = `${contextoHorario}\n\nHistorial de la conversación reciente con este paciente:\n${historial.join('\n')}\n\nPaciente: ${msg.body}\nAsistente:`;
            }

            // Simular que el bot está escribiendo en WhatsApp
            try {
                const chat = await msg.getChat();
                await chat.sendStateTyping();
            } catch(e) {}

            for (const nombreModelo of modelosPrueba) {
                try {
                    const m = genAI.getGenerativeModel({
                        model: nombreModelo,
                        systemInstruction: systemInstruction
                    });
                    const res = await m.generateContent(promptConMemoria);
                    respuestaIA = res.response.text();
                    if (respuestaIA) break;
                } catch (e) {
                    ultimoError = e;
                }
            }

            if (respuestaIA) {
                // Guardar en la memoria
                historial.push(`Paciente: ${msg.body}`);
                historial.push(`Asistente: ${respuestaIA}`);
                if (historial.length > 20) historial.splice(0, 2); // Mantener hasta 10 idas y vueltas (20 mensajes)

                let respuestaConSalida = respuestaIA;
                
                // Manejo inteligente de la sugerencia del asesor
                const estadoVac = cargarEstadoVacaciones();
                if (!respuestaIA.toLowerCase().includes('asesor')) {
                    if (esHorarioLaboral() && !estadoVac.activo) {
                        respuestaConSalida += `\n\n_💡 Si deseas agendar una cita directa o hablar con nuestro personal, escribe la palabra *asesor* en cualquier momento._`;
                    } else {
                        const proximo = obtenerTextoProximoHorario();
                        respuestaConSalida += `\n\n_🕒 Si requieres atención presencial, nuestro personal te puede atender ${proximo}. Escribe la palabra *asesor* en ese momento._`;
                    }
                }
                await responderMensajeSeguro(client, msg, respuestaConSalida);
                console.log(`🤖 Respuesta enviada a ${remitente}`);
            } else {
                throw ultimoError || new Error("No se pudo obtener respuesta de Gemini");
            }

        } catch (error) {
            console.error("❌ Error de comunicación con Gemini:", error.message);
            try {
                if (msg && typeof msg.reply === 'function') {
                    await responderMensajeSeguro(client, msg, "Hola, disculpa la molestia. En este momento el servicio de respuestas por IA está experimentando alta demanda. Por favor intenta enviarme tu mensaje nuevamente en un momento.");
                }
            } catch (errReply) {
                console.error("Error al enviar respuesta de falla por WhatsApp:", errReply.message);
            }
        }
    }

    // Función para procesar la cola de mensajes secuencialmente
    async function encolarMensaje(msg) {
        colaMensajes.push(msg);
        if (!procesandoCola) {
            procesandoCola = true;
            while (colaMensajes.length > 0) {
                const siguienteMsg = colaMensajes.shift();
                try {
                    await procesarMensaje(siguienteMsg);
                } catch (err) {
                    console.error("Error al procesar mensaje en cola:", err.message);
                }
            }
            procesandoCola = false;
        }
    }

    // Escuchar mensajes entrantes (message)
    client.on('message', async (msg) => {
        await encolarMensaje(msg);
    });

    // Escuchar y rechazar llamadas entrantes (voz/video)
    client.on('call', async (call) => {
        try {
            console.log(`📞 Llamada entrante rechazada de: ${call.from}`);
            await call.reject();
            await client.sendMessage(call.from, "📞 *Hola. Este número es administrado por un asistente virtual y no puede recibir llamadas de voz ni de video.*\n\nPor favor, escríbeme tu duda por mensaje de texto para poder ayudarte.");
        } catch (err) {
            console.error("Error al rechazar llamada:", err.message);
        }
    });

    // Escuchar mensajes salientes manuales del teléfono principal para pausar automáticamente
    client.on('message_create', async (msg) => {
        try {
            if (msg.fromMe && msg.to && msg.to !== 'status@broadcast') {
                const txt = msg.body ? msg.body.trim() : '';
                
                // 1. Si es un comando de administrador (!), procesarlo de inmediato
                if (txt.startsWith('!')) {
                    await procesarMensaje(msg);
                    return;
                }

                // 2. Si el mensaje contiene el emoji del bot 🤖 o coincide con respuestas automáticas, NUNCA pausar
                if (txt.includes('🤖') || 
                    txt.includes('¡Hola, muy buenos días!') || 
                    txt.includes('Hola, disculpa la molestia') ||
                    txt.includes('MÉTODOS ANTICONCEPTIVOS') ||
                    txt.includes('HORARIOS DE ATENCIÓN') ||
                    txt.includes('UBICACIÓN Y DOMICILIO') ||
                    txt.includes('REPORTE DE AUSENCIA') ||
                    txt.includes('INTERÉS EN VASECTOMÍA') ||
                    txt.includes('¡Muchas gracias,')) {
                    return;
                }

                // 3. Ignorar mensajes si el bot acaba de enviar uno en los últimos 30 segundos
                if (Date.now() - ultimoEnvioBotTimestamp < 30000) {
                    return;
                }

                // 4. Si el ID ya fue registrado por el bot
                if (msg.id && (idsMensajesEnviadosBot.has(msg.id._serialized) || idsMensajesEnviadosBot.has(msg.id.id))) {
                    return;
                }

                // 5. Si fue enviado a un administrador, no pausar
                if (esNumeroAdmin(msg.to)) {
                    return;
                }

                // Solo si fue escrito manualmente por un humano en el teclado
                chatsPausados.set(msg.to, Date.now());
                guardarPausas();
                console.log(`⏸️ Pausa automática activada en chat ${msg.to} por mensaje manual enviado desde el teléfono principal.`);
            }
        } catch (err) {
            console.error("Error en evento message_create:", err.message);
        }
    });

    console.log('🤖 Inicializando motor de WhatsApp Web...');
    client.initialize();
}

iniciarBot();