const { google } = require('googleapis');
const { getQuery, runQuery } = require('./db');

/**
 * Obtiene el cliente OAuth2 configurado con las credenciales de la DB
 */
async function getOAuthClient() {
    const clientId = await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_calendar_client_id'");
    const clientSecret = await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_calendar_client_secret'");
    const redirectUri = await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_calendar_redirect_uri'");

    if (!clientId?.valor || !clientSecret?.valor) {
        throw new Error("Faltan credenciales de Google Calendar en la base de datos.");
    }

    const oAuth2Client = new google.auth.OAuth2(
        clientId.valor,
        clientSecret.valor,
        redirectUri?.valor || "http://localhost:3001/api/calendar/callback"
    );

    const refreshToken = await getQuery("SELECT valor FROM configuracion WHERE clave = 'google_calendar_refresh_token'");
    if (refreshToken?.valor) {
        oAuth2Client.setCredentials({ refresh_token: refreshToken.valor });
    }

    return oAuth2Client;
}

/**
 * Genera la URL para que el SuperAdmin inicie sesion
 */
async function generateAuthUrl() {
    const oAuth2Client = await getOAuthClient();
    const scopes = [
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/calendar.readonly'
    ];

    const url = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent', // Fuerza a pedir refresh token
        scope: scopes
    });

    return url;
}

/**
 * Intercambia el codigo por tokens y guarda el Refresh Token en la DB
 */
async function authenticateWithCode(code) {
    const oAuth2Client = await getOAuthClient();
    const { tokens } = await oAuth2Client.getToken(code);
    
    if (tokens.refresh_token) {
        await runQuery("UPDATE configuracion SET valor = ? WHERE clave = 'google_calendar_refresh_token'", [tokens.refresh_token]);
        console.log("✅ Refresh Token de Google Calendar guardado en SQLite.");
    }
    
    oAuth2Client.setCredentials(tokens);
    return tokens;
}

/**
 * Agenda una cita autonoma (Por ahora solo devuelve exito simulado)
 * @param {string} resumen Titulo del evento
 * @param {string} inicio ISO string
 * @param {string} fin ISO string
 */
async function agendarCita(resumen, inicio, fin) {
    const oAuth2Client = await getOAuthClient();
    const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });

    const event = {
        summary: resumen,
        description: 'Agendado automaticamente por OmniBot IA.',
        start: {
            dateTime: inicio,
            timeZone: 'America/Mexico_City',
        },
        end: {
            dateTime: fin,
            timeZone: 'America/Mexico_City',
        },
    };

    try {
        const res = await calendar.events.insert({
            calendarId: 'primary',
            resource: event,
        });
        return res.data;
    } catch (error) {
        console.error('Error agendando cita:', error);
        throw error;
    }
}

module.exports = {
    getOAuthClient,
    generateAuthUrl,
    authenticateWithCode,
    agendarCita
};
