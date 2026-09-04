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

    // Limpieza de números temporales inválidos (1660)
    await runQuery("DELETE FROM contactos WHERE telefono LIKE '1660%'");

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

    // 8. Solicitudes de Asesor Humano en Espera (Fuera de Horario / Vacaciones)
    await runQuery(`
        CREATE TABLE IF NOT EXISTS solicitudes_asesor (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            jid TEXT,
            telefono TEXT,
            nombre TEXT,
            motivo TEXT,
            fecha_hora TEXT,
            timestamp INTEGER,
            estado TEXT DEFAULT 'pendiente'
        )
    `);

    // 9. Respuestas Rápidas Preconfiguradas
    await runQuery(`
        CREATE TABLE IF NOT EXISTS respuestas_rapidas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            atajo TEXT UNIQUE,
            titulo TEXT,
            contenido TEXT
        )
    `);

    // 10. Etiquetas / Listas de WhatsApp (Labels con Colores)
    await runQuery(`
        CREATE TABLE IF NOT EXISTS etiquetas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT UNIQUE,
            color TEXT DEFAULT '#6366f1', -- Color hex (ej: #10b981 verde, #3b82f6 azul, #f59e0b amarillo, #8b5cf6 morado, #ef4444 rojo)
            creado_en INTEGER
        )
    `);

    // 11. Relación Contactos <-> Etiquetas
    await runQuery(`
        CREATE TABLE IF NOT EXISTS contactos_etiquetas (
            jid TEXT,
            etiqueta_id INTEGER,
            asignado_en INTEGER,
            PRIMARY KEY(jid, etiqueta_id)
        )
    `);

    // 12. Motor Universal de Reglas de Seguimiento y Recordatorios Programados
    await runQuery(`
        CREATE TABLE IF NOT EXISTS reglas_seguimiento (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT, -- ej: "Seguimiento 3 Meses (Vasectomía)" o "Satisfacción Post-Venta (7 días)" o "Mantenimiento Preventivo (30 días)"
            etiqueta_id INTEGER, -- Etiqueta disparadora (o null para todos los clientes)
            dias_espera INTEGER DEFAULT 90, -- Días a transcurrir desde la asignación de etiqueta o fecha de atención
            mensaje_plantilla TEXT, -- Plantilla con {nombre}, {negocio}, {dias}
            hora_envio TEXT DEFAULT '10:30', -- Hora diaria de envío
            activo INTEGER DEFAULT 1, -- 1 activo, 0 inactivo
            modo_envio TEXT DEFAULT 'automatico', -- 'automatico' o 'manual_aprobacion'
            creado_en INTEGER
        )
    `);

    // 13. Historial de Seguimientos Programados y Enviados
    await runQuery(`
        CREATE TABLE IF NOT EXISTS historial_seguimientos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            jid TEXT,
            regla_id INTEGER,
            telefono TEXT,
            nombre TEXT,
            mensaje_enviado TEXT,
            fecha_programada TEXT,
            fecha_enviado TEXT,
            timestamp INTEGER,
            estado TEXT DEFAULT 'pendiente' -- 'pendiente', 'enviado', 'cancelado'
        )
    `);

    // 14. Enlaces Rápidos y Formularios Personalizables para el Chat (mínimo 4 espacios)
    await runQuery(`
        CREATE TABLE IF NOT EXISTS enlaces_rapidos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            titulo TEXT NOT NULL,
            descripcion TEXT,
            url TEXT NOT NULL,
            icono TEXT DEFAULT 'fa-link',
            color TEXT DEFAULT 'text-indigo-400',
            orden INTEGER DEFAULT 0
        )
    `);

    // 15. Calendario de Eventos y Días Festivos Programados (Ausencias y Cursos Automáticos)
    await runQuery(`
        CREATE TABLE IF NOT EXISTS eventos_ausencia (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tipo TEXT DEFAULT 'festivo', -- 'festivo', 'curso', 'vacaciones'
            titulo TEXT,
            fecha_inicio TEXT, -- 'YYYY-MM-DD'
            fecha_fin TEXT,    -- 'YYYY-MM-DD'
            reanudacion_texto TEXT, -- ej: 'el próximo martes a primera hora'
            activo INTEGER DEFAULT 1,
            creado_en INTEGER
        )
    `);

    // Seed Inicial de Etiquetas Universales si no existen
    const totalEtiquetas = (await getQuery("SELECT COUNT(*) as total FROM etiquetas"))?.total || 0;
    if (totalEtiquetas === 0) {
        await runQuery("INSERT OR IGNORE INTO etiquetas (nombre, color, creado_en) VALUES ('Vasectomía', '#10b981', ?)", [Date.now()]);
        await runQuery("INSERT OR IGNORE INTO etiquetas (nombre, color, creado_en) VALUES ('Implante / DIU', '#8b5cf6', ?)", [Date.now()]);
        await runQuery("INSERT OR IGNORE INTO etiquetas (nombre, color, creado_en) VALUES ('Cita Agendada', '#3b82f6', ?)", [Date.now()]);
        await runQuery("INSERT OR IGNORE INTO etiquetas (nombre, color, creado_en) VALUES ('Seguimiento Pendiente', '#f59e0b', ?)", [Date.now()]);
        await runQuery("INSERT OR IGNORE INTO etiquetas (nombre, color, creado_en) VALUES ('Cliente Frecuente', '#ec4899', ?)", [Date.now()]);
    }

    // Seed Inicial de Regla de Seguimiento Universal
    const totalReglas = (await getQuery("SELECT COUNT(*) as total FROM reglas_seguimiento"))?.total || 0;
    if (totalReglas === 0) {
        const etqVasectomia = await getQuery("SELECT id FROM etiquetas WHERE nombre = 'Vasectomía'");
        await runQuery(`
            INSERT INTO reglas_seguimiento (nombre, etiqueta_id, dias_espera, mensaje_plantilla, hora_envio, activo, modo_envio, creado_en)
            VALUES (
                'Seguimiento 3 Meses (Espermatoconteo / Revisión)',
                ?,
                90,
                '🏥 Hola, *{nombre}*. Te saludamos del equipo de *{negocio}*. Han transcurrido {dias} días desde tu atención médica. Te recordamos que es momento de programar tu estudio de control para darte tu alta médica definitiva. ✍️✅ ¿Te gustaría que te agendemos o tienes alguna duda?',
                '10:30',
                1,
                'automatico',
                ?
            )
        `, [etqVasectomia ? etqVasectomia.id : null, Date.now()]);
    }

    // Seed Inicial de Respuestas Rápidas Predeterminadas si no existen
    const totalRespuestas = (await getQuery("SELECT COUNT(*) as total FROM respuestas_rapidas"))?.total || 0;
    if (totalRespuestas === 0) {
        await runQuery("INSERT OR IGNORE INTO respuestas_rapidas (atajo, titulo, contenido) VALUES (?, ?, ?)", [
            'ubicacion',
            '📍 Ubicación y Google Maps',
            '📍 *Nuestra Ubicación:* Te esperamos en nuestras instalaciones. Puedes abrir la ruta en Google Maps aquí:\n👉 https://maps.app.goo.gl/9ZpL9i'
        ]);
        await runQuery("INSERT OR IGNORE INTO respuestas_rapidas (atajo, titulo, contenido) VALUES (?, ?, ?)", [
            'registro',
            '📋 Formulario de Registro y Privacidad',
            '📋 *Registro de Paciente:* Para agilizar tu atención y expediente, por favor completa este breve formulario confidencial:\n👉 https://forms.gle/zJxZeXXj1TwWGF9N8'
        ]);
        await runQuery("INSERT OR IGNORE INTO respuestas_rapidas (atajo, titulo, contenido) VALUES (?, ?, ?)", [
            'horarios',
            '⏰ Horarios de Atención en Línea',
            '⏰ *Horarios de Atención:* Nuestro horario de atención por este chat es de Lunes a Viernes de 2:00 PM a 8:30 PM. 🏥 Recuerda que toda atención presencial médica es exclusivamente mediante cita previa confirmada.'
        ]);
        await runQuery("INSERT OR IGNORE INTO respuestas_rapidas (atajo, titulo, contenido) VALUES (?, ?, ?)", [
            'requisitos_vasectomia',
            '✂️ Requisitos Vasectomía sin Bisturí',
            '📋 *Requisitos para Vasectomía sin Bisturí:*\n1️⃣ Baño corporal previo y rasurado de la zona escrotal el día del procedimiento.\n2️⃣ Desayuno ligero.\n3️⃣ Acudir con ropa interior ajustada o suspensorio.\n4️⃣ Llevar identificación oficial.\n5️⃣ Cita previa agendada y confirmada.'
        ]);
        await runQuery("INSERT OR IGNORE INTO respuestas_rapidas (atajo, titulo, contenido) VALUES (?, ?, ?)", [
            'requisitos_implante',
            '💊 Requisitos Implante Subdérmico',
            '📋 *Requisitos para Implante Subdérmico:*\n1️⃣ Estar preferentemente dentro de los primeros días del periodo menstrual (o prueba de embarazo negativa reciente).\n2️⃣ Presentar identificación oficial (INE o CURP).\n3️⃣ Cita agendada y confirmada en nuestro horario de atención.'
        ]);
    }

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

    // Configuración Inicial por Defecto
    const configInicial = {
        nombre_negocio: "Mi Empresa / Negocio",
        descripcion_corta: "Atención personalizada y servicios profesionales",
        telefono_contacto: "",
        ubicacion_direccion: "Calle Principal #123, Colonia Centro",
        ubicacion_maps_link: "https://maps.google.com",
        grupo_control: "[CONTROL-BOT]",
        timezone: "America/Mexico_City",
        modo_receptivo_antiban: "1",
        simular_escritura_humana: "1",
        tiempo_pausa_humano_mins: "30",
        icono_asistente: "🤖",
        enlace_formulario_privacidad: "https://forms.gle/zJxZeXXj1TwWGF9N8",
        gemini_api_key: "",
        google_calendar_id: "",
        gemini_modelo_ia: "gemini-3.6-flash",
        prompt_ia: "Eres el asistente virtual oficial de la empresa. Atiende de manera cordial, profesional, clara y concisa en español.",
        catalogo_servicios: "Servicio General: $450 MXN\nConsulta Especializada: $700 MXN",
        menu_numerico: JSON.stringify([
            { opcion: "1", titulo: "Ver Catálogo y Precios", respuesta: "Aquí puedes ver nuestros catálogos completos.", enlace: "https://mi-empresa.com/catalogo" },
            { opcion: "2", titulo: "Ubicación y Horarios", respuesta: "Estamos ubicados en Calle Principal #123. Horario de 1pm a 6pm.", enlace: "https://maps.google.com" },
            { opcion: "3", titulo: "Hablar con Asesor Humano", respuesta: "En un momento nuestro personal te atenderá de forma personalizada.", enlace: "" }
        ]),
        infografias_config: JSON.stringify([
            { palabras: ["talla", "tallas", "medida", "medidas"], respuesta: "Aquí tienes nuestra tabla oficial de medidas y tallas.", enlace: "https://mi-empresa.com/guia-tallas.jpg" }
        ]),
        horario_sucursal_fisica: "Lunes a Viernes de 1:00 PM a 6:00 PM, Sábados de 10:00 AM a 2:00 PM",
        horario_asesor_en_linea: "Lunes a Viernes de 9:00 AM a 6:00 PM",
        hora_inicio_semana: "09:00",
        hora_fin_semana: "18:00",
        hora_inicio_sab: "09:00",
        hora_fin_sab: "14:00",
        mensaje_fuera_horario: "Hola. Nuestro horario de atención personalizada es de Lunes a Viernes de 9am a 6pm. Con gusto te atenderemos a primera hora.",
        datos_bancarios: "Banco: BBVA\nCuenta: 1234567890\nCLABE: 012345678901234567\nTitular: Mi Empresa",
        linktree_titulo: "Mi Empresa Oficial",
        linktree_descripcion: "Soluciones y atención inmediata por WhatsApp",
        plan_nombre: "Pro Ilimitado",
        plan_limite_mensajes: "2000"
    };

    for (const [clave, valor] of Object.entries(configInicial)) {
        const existe = await getQuery("SELECT clave FROM configuracion WHERE clave = ?", [clave]);
        if (!existe) {
            await runQuery("INSERT INTO configuracion (clave, valor) VALUES (?, ?)", [clave, valor]);
        }
    }

    // Actualización automática de modelos antiguos a Gemini 3.6
    await runQuery("UPDATE configuracion SET valor = 'gemini-3.6-flash' WHERE clave = 'gemini_modelo_ia' AND (valor LIKE '%1.5%' OR valor LIKE '%2.0%' OR valor LIKE '%2.5%')");

    // Enlaces de muestra para Linktree
    const linksCount = await getQuery("SELECT COUNT(*) as total FROM linktree_links");
    if (linksCount.total === 0) {
        await runQuery("INSERT INTO linktree_links (titulo, url, icono, orden) VALUES (?, ?, ?, ?)", ['Escríbenos por WhatsApp', 'https://wa.me/', 'whatsapp', 1]);
        await runQuery("INSERT INTO linktree_links (titulo, url, icono, orden) VALUES (?, ?, ?, ?)", ['Ver Catálogo y Precios', '#catalogo', 'catalog', 2]);
        await runQuery("INSERT INTO linktree_links (titulo, url, icono, orden) VALUES (?, ?, ?, ?)", ['Facebook Oficial', 'https://facebook.com', 'facebook', 3]);
    }

    // Semillas para Enlaces Rápidos y Formularios del Live Chat (4 espacios personalizables)
    const countEnlacesRapidos = (await getQuery("SELECT COUNT(*) as total FROM enlaces_rapidos"))?.total || 0;
    if (countEnlacesRapidos === 0) {
        await runQuery(`
            INSERT INTO enlaces_rapidos (titulo, descripcion, url, icono, color, orden) VALUES
            ('Formulario de Privacidad / Registro', 'Registro oficial de datos y aviso de privacidad', 'https://forms.gle/zJxZeXXj1TwWGF9N8', 'fa-file-signature', 'text-indigo-400', 1),
            ('Formulario de Valoración / Cuestionario', 'Cuestionario médico y antecedentes de salud', 'https://forms.gle/', 'fa-notes-medical', 'text-emerald-400', 2),
            ('Formulario de Consentimiento / Control', 'Consentimiento informado y seguimiento', 'https://forms.gle/', 'fa-file-lines', 'text-amber-400', 3),
            ('Ubicación en Google Maps', 'Ubicación física e indicaciones del CAISES', 'https://maps.google.com', 'fa-location-dot', 'text-rose-400', 4)
        `);
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
