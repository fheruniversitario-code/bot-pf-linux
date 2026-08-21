require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

// Parche para DOMMatrix en Node.js
if (typeof globalThis.DOMMatrix === 'undefined') {
    globalThis.DOMMatrix = class DOMMatrix {
        constructor() {
            this.m = Array(16).fill(0);
            this.m[0] = 1; this.m[5] = 1; this.m[10] = 1; this.m[15] = 1;
        }
    };
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const historialesChat = new Map();
const chatsPausados = new Map();
let vacacionesGlobales = false;

const idsMensajesEnviadosBot = new Set();
let ultimoEnvioBotTimestamp = 0;

const NUMEROS_ADMIN = ["5214112688857", "5214111120637"];

function esNumeroAdmin(remitente) {
    const raw = remitente.replace(/[^0-9]/g, '');
    if (raw.length < 10) return false;
    const ultimos10 = raw.slice(-10);
    return NUMEROS_ADMIN.some(numAdmin => {
        const rawAdmin = numAdmin.replace(/[^0-9]/g, '');
        return rawAdmin.endsWith(ultimos10);
    });
}

function esHorarioLaboral() {
    const ahora = new Date();
    const dia = ahora.getDay(); // 0 = Domingo, 1 = Lunes, ..., 6 = Sábado
    const horaDecimal = ahora.getHours() + (ahora.getMinutes() / 60);

    // Lunes a Viernes de 2:00 PM (14.00) a 8:30 PM (20.50)
    if (dia >= 1 && dia <= 5) {
        if (horaDecimal >= 14.00 && horaDecimal <= 20.50) {
            return true;
        }
    }
    return false;
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => {
    console.log('Escanea este QR con tu teléfono para iniciar sesión:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('¡El bot está listo y conectado!');
});

// Rechazar llamadas
client.on('call', async (call) => {
    console.log(`Llamada entrante rechazada de: ${call.from}`);
    await call.reject();
    await client.sendMessage(call.from, "⚠️ Lo siento, este es un sistema automatizado y no puede recibir llamadas ni audios. Por favor, escríbeme tu duda por mensaje de texto. 📝");
});

client.on('message', async msg => {
    if (msg.fromMe) return;
    if (msg.to === 'status@broadcast' || msg.isStatus) return;

    const remitente = msg.from;
    const texto = msg.body;
    const textoLower = texto.toLowerCase();
    
    // Rechazar notas de voz
    if (msg.type === 'ptt' || msg.type === 'audio') {
        await client.sendMessage(remitente, "🎙️ Lo siento, no puedo escuchar audios. Por favor escríbeme tu mensaje. 📝");
        return;
    }

    const isAdmin = esNumeroAdmin(remitente);

    // PARCHE DE SEGURIDAD
    if (isAdmin && texto.startsWith('!')) {
        if (textoLower === '!pausar') {
            chatsPausados.set(remitente, true);
            await client.sendMessage(remitente, "⏸️ Bot pausado manualmente en este chat.");
            return;
        }
        if (textoLower === '!reactivar') {
            chatsPausados.clear();
            vacacionesGlobales = false;
            await client.sendMessage(remitente, "🤖 ✅ *BOT COMPLETAMENTE REACTIVADO.*\n\nSe han desactivado las vacaciones/curso y todas las pausas. El bot reanuda la atención normal.");
            return;
        }
        if (textoLower === '!vacaciones') {
            vacacionesGlobales = true;
            await client.sendMessage(remitente, "🌴 Modo vacaciones global ACTIVADO. El bot ya no contestará clientes.");
            return;
        }
        return; 
    }

    if (chatsPausados.has(remitente)) return;

    if (vacacionesGlobales) {
        await client.sendMessage(remitente, "Nos encontramos de vacaciones. Reanudaremos labores próximamente. Gracias por su comprensión. 🌴");
        return;
    }

    // Gatillos de Infografias
    if (["ubicacion", "ubicación", "donde estan", "dónde están"].some(w => textoLower.includes(w))) {
        await client.sendMessage(remitente, "Nos encontramos en el CAISES Jaral del Progreso.\n📍 *Ubicación:* https://maps.app.goo.gl/EjxR5FvJ2YyA8h3j6");
        return;
    }

    const palabrasHumano = ["humano", "asesor", "persona", "queja", "agendar", "cita"];
    const solicitaHumano = palabrasHumano.some(palabra => textoLower.includes(palabra));
    if (solicitaHumano) {
        if (!esHorarioLaboral()) {
            await client.sendMessage(remitente, "Hola, por el momento estamos fuera de horario. Trabajamos de Lunes a Viernes de 2:00 PM a 8:30 PM. 🌙");
            return;
        }
        chatsPausados.set(remitente, true);
        await client.sendMessage(remitente, "Entendido. Un asesor humano leerá tu mensaje y te contestará en breve. 👨‍⚕️");
        return;
    }

    // Menú Principal (IVR PF)
    if (textoLower === '1' || textoLower === '2' || textoLower === '3' || textoLower === '4' || textoLower === '5' || textoLower === 'hola' || textoLower === 'buenas tardes') {
        const menu = `🤖 🩺 *¡Hola de nuevo! Bienvenido/a al servicio de Planificación Familiar del CAISES Jaral.*\n\nDe Lunes a Viernes de 2:00 PM a 8:30 PM estamos para servirte. ☺️\n\nElige una opción enviando el número o escribe tu duda directamente:\n\n1️⃣ 📋 *Requisitos para atención*\n2️⃣ 💊 *Métodos anticonceptivos disponibles*\n3️⃣ ⌚ *Horarios de atención*\n4️⃣ 📍 *Ubicación del CAISES*\n5️⃣ 👨‍⚕️ *Solicitar Asesor Humano / Agendar Cita*\n\n_Escribe el número de la opción o tu pregunta libremente y con gusto te responderé._`;
        
        if (textoLower === '1') {
            await client.sendMessage(remitente, "📋 *Requisitos para atención:*\n- CURP\n- INE\n- Ser mayor de edad (o venir acompañado de un tutor si eres menor)\n- Presentarse limpio(a) y con disposición de tiempo.");
            return;
        }
        if (textoLower === '2') {
            await client.sendMessage(remitente, "💊 *Métodos disponibles:*\n- Pastillas\n- Inyecciones (Mensual/Bimestral)\n- Parches\n- Implante Subdérmico\n- DIU (Cobre y Hormonal)\n- Condones");
            return;
        }
        if (textoLower === '3') {
            await client.sendMessage(remitente, "⌚ *Horarios:*\nLunes a Viernes de 2:00 PM a 8:30 PM.");
            return;
        }
        if (textoLower === '4') {
            await client.sendMessage(remitente, "📍 *Ubicación CAISES Jaral:*\nhttps://maps.app.goo.gl/EjxR5FvJ2YyA8h3j6");
            return;
        }
        if (textoLower === '5') {
            chatsPausados.set(remitente, true);
            await client.sendMessage(remitente, "Entendido. Un asesor tomará tu chat en breve para agendarte. 👨‍⚕️");
            return;
        }
        
        if (textoLower === 'hola' || textoLower === 'buenas tardes') {
            if (!esHorarioLaboral()) {
                await client.sendMessage(remitente, "Hola, por el momento estamos fuera de horario. Déjanos tu mensaje y lo veremos el próximo día hábil a las 2:00 PM. 🌙");
                return;
            }
            await client.sendMessage(remitente, menu);
            return;
        }
    }

    if (!esHorarioLaboral()) {
        await client.sendMessage(remitente, "Hola, por el momento estamos fuera de horario. Trabajamos de Lunes a Viernes de 2:00 PM a 8:30 PM. 🌙");
        return;
    }

    // Inteligencia Artificial Gemini
    if (!historialesChat.has(remitente)) {
        historialesChat.set(remitente, []);
    }
    const historial = historialesChat.get(remitente);
    historial.push(`Cliente: ${texto}`);
    if (historial.length > 20) historial.splice(0, 2);

    const instruccionSistema = `Eres un asesor de salud experto del CAISES Jaral del Progreso, Guanajuato. Tu objetivo es orientar sobre salud sexual y planificación familiar. Eres médico, respetuoso y clínico. Sé breve en tus respuestas (1-2 párrafos).`;

    try {
        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash-latest",
            systemInstruction: instruccionSistema
        });

        const promptText = `Historial de la conversación:\n${historial.join('\n')}\n\nPor favor, responde de forma breve, empática y basándote en la información médica correcta.`;

        const result = await model.generateContent(promptText);
        const respuesta = result.response.text();
        
        if (respuesta) {
            historial.push(`Bot: ${respuesta}`);
            ultimoEnvioBotTimestamp = Date.now();
            const sentMsg = await client.sendMessage(remitente, respuesta);
            if (sentMsg && sentMsg.id) {
                idsMensajesEnviadosBot.add(sentMsg.id._serialized);
            }
        }

    } catch (error) {
        console.error("Error al obtener respuesta de Gemini:", error);
    }
});

client.on('message_create', async (msg) => {
    if (msg.fromMe && msg.to && msg.to !== 'status@broadcast') {
        if (Date.now() - ultimoEnvioBotTimestamp < 15000) return;
        if (msg.id && idsMensajesEnviadosBot.has(msg.id._serialized)) return;
        chatsPausados.set(msg.to, true);
    }
});

client.initialize();