const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

/**
 * Servicio Universal de Google Calendar para OmniBot
 * Compatible con Node.js en Windows y Linux.
 * Utiliza autenticación de Cuenta de Servicio (Service Account) para operar 24/7 sin expiración.
 */
class CalendarService {
    constructor() {
        this.cacheAuth = new Map();
        this.cacheAusenciaGoogle = { data: null, timestamp: 0, calendarId: '' };
    }

    /**
     * Obtiene una instancia autenticada de Google Calendar client.
     * @param {string|object} credentials - Cadena JSON, objeto de credenciales, o ruta al archivo json.
     */
    obtenerAuth(credentials) {
        if (!credentials) {
            throw new Error("No se han proporcionado credenciales de Google Calendar.");
        }

        let credsObj = null;
        if (typeof credentials === 'string') {
            const trimmed = credentials.trim();
            if (trimmed.startsWith('{')) {
                try {
                    credsObj = JSON.parse(trimmed);
                } catch (e) {
                    throw new Error("El JSON de credenciales de Google Service Account es inválido.");
                }
            } else if (fs.existsSync(trimmed)) {
                try {
                    credsObj = JSON.parse(fs.readFileSync(trimmed, 'utf8'));
                } catch (e) {
                    throw new Error(`Error al leer archivo de credenciales: ${e.message}`);
                }
            } else {
                throw new Error("Las credenciales deben ser un JSON válido o la ruta a un archivo existente.");
            }
        } else if (typeof credentials === 'object') {
            credsObj = credentials;
        }

        if (!credsObj || !credsObj.client_email || !credsObj.private_key) {
            throw new Error("El archivo de credenciales debe contener 'client_email' y 'private_key' de una Cuenta de Servicio de Google.");
        }

        const auth = new google.auth.JWT({
            email: credsObj.client_email,
            key: credsObj.private_key,
            scopes: ['https://www.googleapis.com/auth/calendar']
        });

        const calendar = google.calendar({ version: 'v3', auth });
        return { calendar, clientEmail: credsObj.client_email };
    }

    /**
     * Prueba la conexión y permisos de edición con el calendario especificado.
     * @param {string} calendarId - ID del calendario de Google (ej: 'ejemplo@gmail.com' o ID de recurso).
     * @param {string|object} credentials - Credenciales de Service Account.
     */
    async verificarConexion(calendarId, credentials) {
        try {
            if (!calendarId || !calendarId.trim()) {
                return { success: false, error: "El Calendar ID es requerido (ej: tu correo @gmail.com)." };
            }
            const { calendar, clientEmail } = this.obtenerAuth(credentials);
            const calIdLimpio = calendarId.trim();

            // Consultar metadatos del calendario
            const res = await calendar.calendars.get({ calendarId: calIdLimpio });
            const data = res.data;

            return {
                success: true,
                calendarId: calIdLimpio,
                summary: data.summary || calIdLimpio,
                timeZone: data.timeZone || 'America/Mexico_City',
                clientEmail: clientEmail,
                mensaje: `Conexión exitosa con el calendario "${data.summary || calIdLimpio}". Permisos verificados.`
            };
        } catch (error) {
            let mensajeAmigable = error.message;
            if (error.code === 404) {
                mensajeAmigable = `No se encontró el calendario "${calendarId}". Asegúrate de que el Calendar ID sea exacto y que hayas compartido el calendario con la cuenta de servicio de Google.`;
            } else if (error.code === 403) {
                mensajeAmigable = `Permiso denegado. Debes entrar a Google Calendar > Configuración de tu calendario > "Compartir con personas específicas" y agregar el correo de la cuenta de servicio con permiso de "Hacer cambios en eventos".`;
            }
            return {
                success: false,
                code: error.code || 500,
                error: mensajeAmigable
            };
        }
    }

    /**
     * Consulta huecos de tiempo libres (Free/Busy) en Google Calendar combinados con horarios comerciales.
     */
    async obtenerHuecosDisponibles({
        calendarId,
        credentials,
        fecha, // 'YYYY-MM-DD'
        duracionMinutos = 30,
        bufferMinutos = 10,
        timezone = 'America/Mexico_City',
        horarioLaboral = {
            inicioSemana: '09:00',
            finSemana: '18:00',
            inicioSabado: '09:00',
            finSabado: '14:00',
            atiendeDomingo: false
        },
        citasLocalesOcupadas = [] // [{ fecha, hora, duracion }]
    }) {
        try {
            if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
                return { success: false, error: "Formato de fecha inválido. Se espera YYYY-MM-DD." };
            }

            // Validar día de la semana
            // Usar partes numéricas para evitar desfases de timezone UTC
            const [ano, mes, dia] = fecha.split('-').map(Number);
            const fechaObj = new Date(ano, mes - 1, dia, 12, 0, 0); // Mediodía para evitar saltos
            const diaSemana = fechaObj.getDay(); // 0 = Domingo, 1 = Lunes, ..., 6 = Sábado

            const franjas = [];

            if (diaSemana === 0) { // Domingo
                if (!horarioLaboral.atiendeDomingo) {
                    return { success: true, fecha, disponibles: [], motivo: "Los domingos no se ofrece atención presencial." };
                }
                const dIni = horarioLaboral.domingoInicio || horarioLaboral.inicioSemana || '09:00';
                const dFin = horarioLaboral.domingoFin || horarioLaboral.finSemana || '14:00';
                franjas.push({ inicio: dIni, fin: dFin });
            } else if (diaSemana === 6) { // Sábado
                if (horarioLaboral.atiendeSabado === false || horarioLaboral.sabado_activo === '0') {
                    return { success: true, fecha, disponibles: [], motivo: "Los sábados no se ofrece atención presencial." };
                }
                const sIni = horarioLaboral.sabado_inicio || horarioLaboral.inicioSabado || '09:00';
                const sFin = horarioLaboral.sabado_fin || horarioLaboral.finSabado || '14:00';
                franjas.push({ inicio: sIni, fin: sFin });
            } else { // Lunes a Viernes
                // Turno 1 (Principal)
                const t1Ini = horarioLaboral.turno1_inicio || horarioLaboral.inicioSemana || '09:00';
                const t1Fin = horarioLaboral.turno1_fin || horarioLaboral.finSemana || '18:00';
                if (t1Ini && t1Fin) {
                    franjas.push({ inicio: t1Ini, fin: t1Fin });
                }

                // Turno 2 (Vespertino / Segundo bloque después de comida o labores administrativas)
                const t2Activo = (horarioLaboral.turno2_activo === true || horarioLaboral.turno2_activo === '1');
                if (t2Activo && horarioLaboral.turno2_inicio && horarioLaboral.turno2_fin) {
                    franjas.push({ inicio: horarioLaboral.turno2_inicio, fin: horarioLaboral.turno2_fin });
                }
            }

            if (franjas.length === 0) {
                return { success: true, fecha, disponibles: [], motivo: "El día seleccionado está fuera del horario de consulta hábil." };
            }

            // Calcular ventanas ocupadas de Google Calendar
            const [y, m, d] = fecha.split('-').map(Number);
            const minDate = new Date(Date.UTC(y, m - 1, d - 1, 0, 0, 0));
            const maxDate = new Date(Date.UTC(y, m - 1, d + 2, 0, 0, 0));
            const timeMinISO = minDate.toISOString();
            const timeMaxISO = maxDate.toISOString();

            let busyIntervals = [];

            if (calendarId && credentials) {
                try {
                    const { calendar } = this.obtenerAuth(credentials);
                    const freebusyRes = await calendar.freebusy.query({
                        requestBody: {
                            timeMin: timeMinISO,
                            timeMax: timeMaxISO,
                            timeZone: timezone,
                            items: [{ id: calendarId.trim() }]
                        }
                    });

                    const calBusy = freebusyRes.data.calendars?.[calendarId.trim()]?.busy || [];
                    calBusy.forEach(b => {
                        const startD = new Date(b.start);
                        const endD = new Date(b.end);
                        busyIntervals.push({
                            inicio: startD,
                            fin: endD
                        });
                    });
                } catch (errCal) {
                    console.warn("⚠️ Aviso al consultar FreeBusy de Google Calendar:", errCal.message);
                }
            }

            // Sumar citas locales de SQLite si existen para ese día
            if (Array.isArray(citasLocalesOcupadas)) {
                citasLocalesOcupadas.forEach(cita => {
                    if (cita.hora && cita.fecha === fecha) {
                        const [cH, cM] = cita.hora.split(':').map(Number);
                        const dur = parseInt(cita.duracion || duracionMinutos) || 30;
                        const ini = new Date(ano, mes - 1, dia, cH, cM, 0);
                        const fin = new Date(ini.getTime() + dur * 60000);
                        busyIntervals.push({ inicio: ini, fin: fin });
                    }
                });
            }

            // Generar los bloques o slots potenciales dentro de cada franja configurada
            const pasoTotal = parseInt(duracionMinutos) + parseInt(bufferMinutos || 0);
            const slotsDisponibles = [];

            // Obtener fecha/hora actual en la zona horaria del negocio para no ofrecer horas pasadas si es hoy
            const ahora = new Date();
            const hoyStr = ahora.toLocaleDateString('en-CA', { timeZone: timezone }); // 'YYYY-MM-DD'
            const esHoy = (hoyStr === fecha);
            const minAnticipacionMs = 0;

            for (const franja of franjas) {
                const [hIniH, hIniM] = franja.inicio.split(':').map(Number);
                const [hFinH, hFinM] = franja.fin.split(':').map(Number);
                const minInicioFranja = hIniH * 60 + hIniM;
                const minFinFranja = hFinH * 60 + hFinM;

                for (let minActual = minInicioFranja; minActual + parseInt(duracionMinutos) <= minFinFranja; minActual += pasoTotal) {
                    const slotH = Math.floor(minActual / 60);
                    const slotM = minActual % 60;

                    const slotInicioDate = new Date(ano, mes - 1, dia, slotH, slotM, 0);
                    const slotFinDate = new Date(ano, mes - 1, dia, slotH, slotM + parseInt(duracionMinutos), 0);

                    // Si es hoy y está en el pasado o a menos de 2 horas de anticipación, omitir
                    if (esHoy && (slotInicioDate.getTime() - ahora.getTime() < minAnticipacionMs)) {
                        continue;
                    }

                    // Verificar si choca con algún intervalo ocupado
                    const seSolapa = busyIntervals.some(inter => {
                        return (slotInicioDate < inter.fin && slotFinDate > inter.inicio);
                    });

                    if (!seSolapa) {
                        const hora24 = `${String(slotH).padStart(2, '0')}:${String(slotM).padStart(2, '0')}`;
                        const ampm = slotH >= 12 ? 'PM' : 'AM';
                        const h12 = slotH % 12 === 0 ? 12 : slotH % 12;
                        const hora12 = `${h12}:${String(slotM).padStart(2, '0')} ${ampm}`;

                        slotsDisponibles.push({
                            hora: hora24,
                            horaTexto: hora12,
                            duracion: duracionMinutos,
                            inicioISO: slotInicioDate.toISOString(),
                            finISO: slotFinDate.toISOString()
                        });
                    }
                }
            }

            return {
                success: true,
                fecha,
                disponibles: slotsDisponibles,
                totalDisponibles: slotsDisponibles.length
            };
        } catch (error) {
            console.error("Error en obtenerHuecosDisponibles:", error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Crea un evento formal en Google Calendar.
     */
    
    async verificarEstadoEventos(calendarId, credentials, eventIds) {
        const auth = this.obtenerAuth(credentials);
        const calendar = google.calendar({ version: 'v3', auth });
        const resultados = {};
        for (const eventId of eventIds) {
            try {
                const res = await calendar.events.get({ calendarId, eventId });
                resultados[eventId] = res.data.status; // 'confirmed', 'cancelled', etc.
            } catch (e) {
                if (e.code === 404 || e.code === 410) {
                    resultados[eventId] = 'cancelled';
                } else {
                    resultados[eventId] = 'error';
                }
            }
        }
        return resultados;
    }

    async crearCita({
        calendarId,
        credentials,
        nombre,
        telefono,
        fecha, // 'YYYY-MM-DD'
        hora,  // 'HH:MM'
        duracionMinutos = 30,
        servicio = 'Consulta General',
        notas = '',
        timezone = 'America/Mexico_City'
    }) {
        try {
            if (!calendarId || !credentials) {
                throw new Error("Calendar ID y credenciales son requeridos para agendar en Google Calendar.");
            }

            const { calendar } = this.obtenerAuth(credentials);
            const [ano, mes, dia] = fecha.split('-').map(Number);
            const [h, m] = (hora || '10:00').split(':').map(Number);

            // Calcular horas de inicio y fin en formato ISO compatible con Google Calendar
            const pad = (num) => String(num).padStart(2, '0');
            const fechaHoraInicioStr = `${ano}-${pad(mes)}-${pad(dia)}T${pad(h)}:${pad(m)}:00`;

            const durMin = parseInt(duracionMinutos) || 30;
            const totalMinFin = h * 60 + m + durMin;
            const finH = Math.floor(totalMinFin / 60);
            const finM = totalMinFin % 60;
            const fechaHoraFinStr = `${ano}-${pad(mes)}-${pad(dia)}T${pad(finH)}:${pad(finM)}:00`;
            const horaFinFormato = `${pad(finH)}:${pad(finM)}`;

            const eventBody = {
                summary: `Cita: ${nombre} - ${servicio}`,
                description: `👤 Cliente: ${nombre}\n📱 WhatsApp: ${telefono}\n🩺 Servicio: ${servicio}\n📝 Notas: ${notas || 'Ninguna'}\n🤖 Registrado automáticamente vía OmniBot AI`,
                start: {
                    dateTime: `${fechaHoraInicioStr}`,
                    timeZone: timezone
                },
                end: {
                    dateTime: `${fechaHoraFinStr}`,
                    timeZone: timezone
                },
                reminders: {
                    useDefault: false,
                    overrides: [
                        { method: 'popup', minutes: 120 }, // 2 horas antes
                        { method: 'popup', minutes: 1440 } // 24 horas antes
                    ]
                }
            };

            const response = await calendar.events.insert({
                calendarId: calendarId.trim(),
                requestBody: eventBody
            });

            return {
                success: true,
                eventId: response.data.id,
                htmlLink: response.data.htmlLink,
                fecha,
                hora,
                horaFin: horaFinFormato,
                duracion: durMin,
                summary: eventBody.summary
            };
        } catch (error) {
            console.error("Error al crear cita en Google Calendar:", error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Cancela o elimina un evento de Google Calendar.
     */
    async cancelarCita({ calendarId, credentials, eventId }) {
        try {
            if (!calendarId || !credentials || !eventId) {
                return { success: false, error: "Faltan parámetros requeridos para cancelar el evento." };
            }
            const { calendar } = this.obtenerAuth(credentials);
            await calendar.events.delete({
                calendarId: calendarId.trim(),
                eventId: eventId.trim()
            });
            return { success: true, message: "Evento eliminado con éxito de Google Calendar." };
        } catch (error) {
            // Si el evento ya fue borrado manualmente en Google Calendar, considerarlo éxito para mantener consistencia
            if (error.code === 404 || error.code === 410) {
                return { success: true, message: "El evento ya no existía en Google Calendar." };
            }
            console.error("Error al cancelar cita en Google Calendar:", error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Crea un evento de bloqueo de ausencia (Curso, Vacaciones, Festivo) en Google Calendar.
     */
    async crearBloqueoAusencia({ calendarId, credentials, titulo, tipo = 'festivo', fechaInicio, fechaFin, timezone = 'America/Mexico_City' }) {
        try {
            if (!calendarId || !credentials || !titulo || !fechaInicio) {
                return { success: false, error: "Faltan parámetros requeridos para crear bloqueo en Google Calendar." };
            }
            const { calendar } = this.obtenerAuth(credentials);

            // Para eventos de día completo en Google Calendar, la fecha fin debe ser el día siguiente en formato YYYY-MM-DD
            const finStr = fechaFin || fechaInicio;
            const [anoF, mesF, diaF] = finStr.split('-').map(Number);
            const fechaFinNext = new Date(anoF, mesF - 1, diaF + 1, 12, 0, 0);
            const pad = (n) => String(n).padStart(2, '0');
            const fechaFinExclusiva = `${fechaFinNext.getFullYear()}-${pad(fechaFinNext.getMonth() + 1)}-${pad(fechaFinNext.getDate())}`;

            const emojis = { curso: '🎓', vacaciones: '🏖️', festivo: '🇲🇽' };
            const emoji = emojis[tipo] || '📅';

            const eventBody = {
                summary: `${emoji} [BLOQUEO BOT] ${titulo}`,
                description: `Evento programado automáticamente desde OmniBot (${tipo.toUpperCase()}).\nDurante este periodo la IA no ofrecerá citas presenciales y avisará a los clientes de la ausencia.`,
                start: { date: fechaInicio },
                end: { date: fechaFinExclusiva },
                transparency: 'opaque' // Marca el calendario como ocupado (Busy)
            };

            const response = await calendar.events.insert({
                calendarId: calendarId.trim(),
                requestBody: eventBody
            });

            return {
                success: true,
                eventId: response.data.id,
                htmlLink: response.data.htmlLink
            };
        } catch (error) {
            console.error("Error al crear bloqueo de ausencia en Google Calendar:", error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Revisa si en Google Calendar existe algún evento de ausencia (Curso, Vacaciones, Día Festivo, Bloqueo)
     * que esté activo el día de hoy (en timezone especificado).
     * Cuenta con caché de 60 segundos para optimizar cuotas de la API.
     */
    async obtenerEventoAusenciaActivoHoy({ calendarId, credentials, timezone = 'America/Mexico_City' }) {
        try {
            if (!calendarId || !credentials) {
                return { activo: false };
            }

            const ahora = Date.now();
            if (
                this.cacheAusenciaGoogle &&
                this.cacheAusenciaGoogle.calendarId === calendarId &&
                ahora - this.cacheAusenciaGoogle.timestamp < 60000
            ) {
                return this.cacheAusenciaGoogle.data;
            }

            const { calendar } = this.obtenerAuth(credentials);

            // Obtener fecha de hoy en formato YYYY-MM-DD según la zona horaria
            const formatter = new Intl.DateTimeFormat('en-CA', {
                timeZone: timezone,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit'
            });
            const hoyStr = formatter.format(new Date());

            // Ventana de búsqueda: 24 horas antes y después para capturar eventos de día completo
            const timeMin = new Date(new Date().setHours(0, 0, 0, 0) - 24 * 3600000).toISOString();
            const timeMax = new Date(new Date().setHours(23, 59, 59, 999) + 24 * 3600000).toISOString();

            const res = await calendar.events.list({
                calendarId: calendarId.trim(),
                timeMin,
                timeMax,
                singleEvents: true,
                orderBy: 'startTime'
            });

            const items = res.data.items || [];
            let eventoDetectado = null;

            for (const item of items) {
                if (item.status === 'cancelled') continue;
                const summary = (item.summary || '').trim();
                const summaryLower = summary.toLowerCase();
                if (summaryLower.startsWith('cita:') || summaryLower.startsWith('cita ')) continue;

                let activoHoy = false;
                let fechaFinTexto = '';

                // Caso 1: Evento de día completo (start.date)
                if (item.start && item.start.date) {
                    const inicioDateStr = item.start.date;
                    const finDateStr = item.end ? item.end.date : inicioDateStr;
                    if (inicioDateStr <= hoyStr && hoyStr < finDateStr) {
                        activoHoy = true;
                        fechaFinTexto = finDateStr;
                    }
                }
                // Caso 2: Evento con fecha y hora (start.dateTime)
                else if (item.start && item.start.dateTime) {
                    const inicioStr = formatter.format(new Date(item.start.dateTime));
                    const finStr = formatter.format(new Date(item.end?.dateTime || item.start.dateTime));
                    if (inicioStr <= hoyStr && hoyStr <= finStr) {
                        const palabrasAusencia = ['curso', 'vacacion', 'vacaciones', 'festivo', 'feriado', 'congreso', 'capacitacion', 'capacitación', 'ausente', 'no disponible', 'suspension', 'suspensión', 'bloqueo'];
                        const tieneKeyword = palabrasAusencia.some(kw => summaryLower.includes(kw));
                        const duracionHoras = (new Date(item.end?.dateTime || 0) - new Date(item.start.dateTime)) / (1000 * 3600);

                        if (tieneKeyword || duracionHoras >= 5) {
                            activoHoy = true;
                            fechaFinTexto = finStr;
                        }
                    }
                }

                if (activoHoy) {
                    let tipo = 'festivo';
                    if (/curso|congreso|capacitac/i.test(summary)) {
                        tipo = 'curso';
                    } else if (/vacacion/i.test(summary)) {
                        tipo = 'vacaciones';
                    }

                    const tituloLimpio = summary.replace(/\[BLOQUEO BOT\]/gi, '').replace(/^[\p{Emoji}\s]+/gu, '').trim();

                    eventoDetectado = {
                        activo: true,
                        id: item.id,
                        titulo: tituloLimpio || summary,
                        tipo,
                        fechaFin: fechaFinTexto,
                        origen: 'google_calendar'
                    };
                    break;
                }
            }

            const resultado = eventoDetectado || { activo: false };
            this.cacheAusenciaGoogle = {
                calendarId,
                timestamp: Date.now(),
                data: resultado
            };
            return resultado;
        } catch (error) {
            console.error("Error al consultar eventos de ausencia en Google Calendar:", error);
            return { activo: false, error: error.message };
        }
    }

    /**
     * Resuelve fechas mencionadas en lenguaje natural en español (hoy, mañana, días de la semana, etc.)
     */
    resolverFechasRelevantes(texto, timezone = 'America/Mexico_City', maxDias = 3) {
        const ahora = new Date();
        const hoyStr = ahora.toLocaleDateString('en-CA', { timeZone: timezone });
        const [ano, mes, dia] = hoyStr.split('-').map(Number);
        const hoyDate = new Date(ano, mes - 1, dia, 12, 0, 0);

        const pad = (n) => String(n).padStart(2, '0');
        const formatearFecha = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

        const txt = (texto || '').toLowerCase();
        const fechasSet = new Set();

        // 1. Detectar fechas ISO directas (YYYY-MM-DD)
        const matchISO = txt.match(/\b(20\d\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/);
        if (matchISO) {
            fechasSet.add(matchISO[0]);
        }

        // 2. Detectar DD/MM o DD-MM
        const matchDDMM = txt.match(/\b([0-2]?[1-9]|3[01])[\/\-](0?[1-9]|1[0-2])\b/);
        if (matchDDMM) {
            const dNum = parseInt(matchDDMM[1]);
            const mNum = parseInt(matchDDMM[2]);
            const fechaDetectada = new Date(ano, mNum - 1, dNum, 12, 0, 0);
            if (fechaDetectada >= hoyDate) {
                fechasSet.add(formatearFecha(fechaDetectada));
            }
        }

        // 3. Palabras relativas
        if (txt.includes('pasado mañana')) {
            const d = new Date(hoyDate.getTime() + 2 * 86400000);
            fechasSet.add(formatearFecha(d));
        } else if (txt.includes('mañana')) {
            const d = new Date(hoyDate.getTime() + 86400000);
            fechasSet.add(formatearFecha(d));
        } else if (txt.includes('hoy')) {
            fechasSet.add(hoyStr);
        }

        // 4. Días de la semana
        const diasSemanaMap = {
            'domingo': 0, 'lunes': 1, 'martes': 2, 'miercoles': 3, 'miércoles': 3,
            'jueves': 4, 'viernes': 5, 'sabado': 6, 'sábado': 6
        };
        for (const [nombreDia, numDia] of Object.entries(diasSemanaMap)) {
            if (txt.includes(nombreDia)) {
                const diaActual = hoyDate.getDay();
                let dif = numDia - diaActual;
                if (dif <= 0) dif += 7; // Próximo día de la semana
                const d = new Date(hoyDate.getTime() + dif * 86400000);
                fechasSet.add(formatearFecha(d));
                break;
            }
        }

        // Si no especificó fecha, devolver los próximos `maxDias` días laborables
        if (fechasSet.size === 0) {
            for (let i = 0; i < maxDias + 2 && fechasSet.size < maxDias; i++) {
                const d = new Date(hoyDate.getTime() + i * 86400000);
                // Si es domingo, saltar a menos que atienda domingos
                if (d.getDay() !== 0) {
                    fechasSet.add(formatearFecha(d));
                }
            }
        }

        return Array.from(fechasSet).sort();
    }

    /**
     * Construye un resumen textual con la disponibilidad real de Google Calendar para inyectar en el Prompt de Gemini.
     */
    async obtenerContextoDisponibilidadParaPrompt({
        calendarId,
        credentials,
        fechas = [],
        duracionMinutos = 30,
        bufferMinutos = 10,
        timezone = 'America/Mexico_City',
        horarioLaboral,
        citasLocalesOcupadas = []
    }) {
        if (!fechas || fechas.length === 0) return '';
        const nombresDias = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
        const lineas = [];

        for (const f of fechas) {
            const [y, m, d] = f.split('-').map(Number);
            const fechaD = new Date(y, m - 1, d, 12, 0, 0);
            const diaNom = nombresDias[fechaD.getDay()];

            const res = await this.obtenerHuecosDisponibles({
                calendarId,
                credentials,
                fecha: f,
                duracionMinutos,
                bufferMinutos,
                timezone,
                horarioLaboral,
                citasLocalesOcupadas
            });

            if (res.success && res.disponibles && res.disponibles.length > 0) {
                const horas = res.disponibles.map(s => s.horaTexto).join(', ');
                lineas.push(`- ${diaNom} (${f}): Horarios disponibles: ${horas}`);
            } else {
                lineas.push(`- ${diaNom} (${f}): ${res.motivo || 'Sin horarios disponibles'}`);
            }
        }

        return lineas.join('\n');
    }
}

module.exports = new CalendarService();

