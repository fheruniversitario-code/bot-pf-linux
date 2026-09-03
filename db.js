const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'database.sqlite');
const db = new sqlite3.Database(DB_PATH);

// Helper para ejecutar consultas con Promesas (Async/Await)
function runQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve({ id: this.lastID, changes: this.changes });
        });
    });
}

function getQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function allQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

// Inicialización de Tablas
async function inicializarBD() {
    // 1. Configuración General del Negocio e IA
    await runQuery(`
        CREATE TABLE IF NOT EXISTS configuracion (
            clave TEXT PRIMARY KEY,
            valor TEXT
        )
    `);

    // 2. Usuarios del Dashboard Web (Soporte SuperAdmin y Clientes)
    await runQuery(`
        CREATE TABLE IF NOT EXISTS usuarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password_hash TEXT,
            nombre TEXT,
            rol TEXT DEFAULT 'cliente',
            plan TEXT DEFAULT 'Pro Ilimitado',
            estado TEXT DEFAULT 'activo',
            fecha_vencimiento TEXT DEFAULT ''
        )
    `);

    // Migraciones automáticas de columnas si no existen
    try { await runQuery("ALTER TABLE usuarios ADD COLUMN plan TEXT DEFAULT 'Pro Ilimitado'"); } catch(e) {}
    try { await runQuery("ALTER TABLE usuarios ADD COLUMN estado TEXT DEFAULT 'activo'"); } catch(e) {}
    try { await runQuery("ALTER TABLE usuarios ADD COLUMN fecha_vencimiento TEXT DEFAULT ''"); } catch(e) {}

    // 3. Contactos y Clientes
    await runQuery(`
        CREATE TABLE IF NOT EXISTS contactos (
            jid TEXT PRIMARY KEY,
            telefono TEXT,
            nombre TEXT,
            pushname TEXT,
            etiquetas TEXT DEFAULT '',
            es_ignorado INTEGER DEFAULT 0,
            notas TEXT DEFAULT '',
            ultimo_contacto INTEGER
        )
    `);

    // 4. Historial de Mensajes (Live Chat)
    await runQuery(`
        CREATE TABLE IF NOT EXISTS mensajes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT,
            emisor TEXT,
            emisor_nombre TEXT,
            cuerpo TEXT,
            tipo TEXT DEFAULT 'chat',
            es_mio INTEGER DEFAULT 0,
            es_ia INTEGER DEFAULT 0,
            timestamp INTEGER
        )
    `);

    // 5. CRM de Cotizaciones y Pedidos de Venta
    await runQuery(`
        CREATE TABLE IF NOT EXISTS pedidos_cotizaciones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cliente_telefono TEXT,
            cliente_nombre TEXT,
            producto_servicio TEXT,
            valor REAL DEFAULT 0,
            estado TEXT DEFAULT 'Nuevo',
            notas TEXT DEFAULT '',
            timestamp INTEGER
        )
    `);

    // 6. Agenda de Citas (Para Doctores, Spas, Talleres, etc.)
    await runQuery(`
        CREATE TABLE IF NOT EXISTS citas_agenda (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cliente_telefono TEXT,
            cliente_nombre TEXT,
            fecha TEXT,
            hora TEXT,
            servicio TEXT,
            estado TEXT DEFAULT 'Confirmada',
            notas TEXT DEFAULT '',
            timestamp INTEGER
        )
    `);

    // 7. Enlaces para Mini-Sitio Público (Linktree)
    await runQuery(`
        CREATE TABLE IF NOT EXISTS linktree_links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            titulo TEXT,
            url TEXT,
            icono TEXT,
            orden INTEGER DEFAULT 0,
            activo INTEGER DEFAULT 1
        )
    `);

    // 8. Respuestas Rápidas Preconfiguradas
    await runQuery(`
        CREATE TABLE IF NOT EXISTS respuestas_rapidas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            atajo TEXT UNIQUE,
            titulo TEXT,
            contenido TEXT
        )
    `);

    // Crear usuario administrador por defecto si no existe (admin / admin123)
    const userAdmin = await getQuery("SELECT * FROM usuarios WHERE username = 'admin'");
    if (!userAdmin) {
        const passHash = bcrypt.hashSync('admin123', 10);
        await runQuery(
            "INSERT INTO usuarios (username, password_hash, nombre, rol) VALUES (?, ?, ?, ?)",
            ['admin', passHash, 'Administrador Principal', 'admin']
        );
        console.log("👤 Usuario administrador inicial creado: admin / admin123");
    }

    // Configuración Inicial por Defecto (CAISES Jaral del Progreso)
    const promptCaises = `Eres un asistente virtual de salud del área de planificación familiar del CAISES Jaral. Tu tono debe ser empático, amable, profesional, claro y muy conversacional.

REGLAS DE ATENCIÓN E INSTRUCCIONES ESPECÍFICAS:
1. REGLA DE ORO DE INFORMACIÓN MÉDICA:
   - Tienes estrictamente prohibido inventar información médica de métodos que no tengamos o inventar disponibilidad.
   - Si un usuario pregunta si se puede colocar o usar un método específico, explícale de forma amigable que para utilizar cualquier método debe recibir primero una adecuada orientación y consejería presencial por un profesional de la salud.
2. PROHIBICIÓN ABSOLUTA DE ASEGURAR CITAS O ATENCIONES INMEDIATAS:
   - JAMÁS asegures atenciones el mismo día, colocación o servicios inmediatos. Aclara siempre que cualquier atención queda sujeta a disponibilidad de horario y fechas previa consejería.
3. ATENCIÓN FRACCIONADA Y BREVE (MÁXIMO 1 A 2 FRASES):
   - Tus respuestas deben ser breves. NUNCA des toda la información de un método de golpe.
   - Contamos con: Implante subdérmico, DIU de cobre, DIU medicado (Mirena/Levonorgestrel), Inyecciones (1, 2 y 3 meses), Pastillas orales, Condones y Vasectomía sin bisturí (100% GRATUITOS y confidenciales para toda la población sin importar derechohabiencia o edad).
   - Si piden vasectomía o implante, da una breve introducción y pregúntales si desean agendar consejería.
4. HORARIOS Y ASESOR:
   - Horario de atención: Lunes a Viernes de 2:00 PM a 8:30 PM.
   - Si solicitan hablar con personal o agendar cita directa, recuérdales escribir la palabra 'asesor'.`;

    const configInicial = {
        nombre_negocio: "CAISES Jaral del Progreso - Planificación Familiar",
        descripcion_corta: "Servicios de salud reproductiva, métodos anticonceptivos y vasectomía sin bisturí gratuitos",
        telefono_contacto: "",
        ubicacion_direccion: "CAISES Jaral del Progreso, Guanajuato",
        ubicacion_maps_link: "https://maps.app.goo.gl/S51vXVfHb3kihpjp9",
        grupo_control: "[CONTROL-BOT]",
        numeros_admins: "5214111120637, 5214112688857",
        timezone: "America/Mexico_City",
        modo_receptivo_antiban: "1",
        simular_escritura_humana: "1",
        tiempo_pausa_humano_mins: "120",
        gemini_api_key: "",
        gemini_modelo_ia: "gemini-2.5-flash",
        google_calendar_id: "",
        prompt_ia: promptCaises,
        catalogo_servicios: "• Implante Subdérmico (Gratuito)\n• DIU de Cobre y DIU Medicado (Gratuito)\n• Inyecciones Anticonceptivas (Gratuito)\n• Pastillas y Condones (Gratuito)\n• Vasectomía sin Bisturí (Gratuito)",
        menu_numerico: JSON.stringify([
            { opcion: "1", titulo: "Requisitos de Atención", respuesta: "Requisitos: Identificación oficial o CURP y comprobante de domicilio. El servicio es 100% gratuito y confidencial sin importar edad.", enlace: "" },
            { opcion: "2", titulo: "Métodos Anticonceptivos", respuesta: "Contamos con Implantes, DIUs, Inyecciones, Pastillas, Condones y Vasectomía.", enlace: "" },
            { opcion: "3", titulo: "Horarios de Consulta", respuesta: "Atención de Lunes a Viernes de 2:00 PM a 8:30 PM.", enlace: "" },
            { opcion: "4", titulo: "Ubicación de CAISES", respuesta: "Abrir ubicación en Google Maps.", enlace: "https://maps.app.goo.gl/S51vXVfHb3kihpjp9" },
            { opcion: "5", titulo: "Hablar con Personal de Salud", respuesta: "En un momento nuestro personal te atenderá.", enlace: "" }
        ]),
        horario_sucursal_fisica: "Lunes a Viernes de 2:00 PM a 8:30 PM (Sábados y Domingos cerrado)",
        horario_asesor_en_linea: "Lunes a Viernes de 2:00 PM a 8:30 PM",
        hora_inicio_semana: "14:00",
        hora_fin_semana: "20:30",
        hora_inicio_sab: "00:00",
        hora_fin_sab: "00:00",
        mensaje_fuera_horario: "Hola. Nuestro horario de atención en CAISES Jaral es de Lunes a Viernes de 2:00 PM a 8:30 PM. Con gusto te atenderemos a primera hora en nuestro próximo turno laboral.",
        datos_bancarios: "Servicio 100% Gratuito de la Secretaría de Salud",
        linktree_titulo: "CAISES Jaral - Salud Reproductiva",
        linktree_descripcion: "Orientación en Métodos Anticonceptivos y Vasectomía",
        plan_nombre: "Salud Pública / Ilimitado",
        plan_limite_mensajes: "99999"
    };

    for (const [clave, valor] of Object.entries(configInicial)) {
        const existe = await getQuery("SELECT clave FROM configuracion WHERE clave = ?", [clave]);
        if (!existe) {
            await runQuery("INSERT INTO configuracion (clave, valor) VALUES (?, ?)", [clave, valor]);
        }
    }

    // Enlaces de muestra para Linktree
    const linksCount = await getQuery("SELECT COUNT(*) as total FROM linktree_links");
    if (linksCount.total === 0) {
        await runQuery("INSERT INTO linktree_links (titulo, url, icono, orden) VALUES (?, ?, ?, ?)", ['Escríbenos por WhatsApp', 'https://wa.me/', 'whatsapp', 1]);
        await runQuery("INSERT INTO linktree_links (titulo, url, icono, orden) VALUES (?, ?, ?, ?)", ['Ver Catálogo y Precios', '#catalogo', 'catalog', 2]);
        await runQuery("INSERT INTO linktree_links (titulo, url, icono, orden) VALUES (?, ?, ?, ?)", ['Facebook Oficial', 'https://facebook.com', 'facebook', 3]);
    }

    console.log("💾 Base de Datos SQLite inicializada con éxito.");
}

module.exports = {
    db,
    runQuery,
    getQuery,
    allQuery,
    inicializarBD,
    DB_PATH,
    DATA_DIR
};
