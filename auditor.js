const os = require('os');

class Auditor {
    /**
     * Inicializa el módulo Auditor. Debe llamarse después de conectar SQLite y WhatsApp.
     */
    static async iniciar(client, getQuery, runQuery) {
        this.client = client;
        this.getQuery = getQuery;
        this.runQuery = runQuery;
        this.fallaConsecutiva = 0;
        
        // 1. Crear tabla oculta de auditoría automáticamente si no existe (Universalidad)
        await this.runQuery(`
            CREATE TABLE IF NOT EXISTS auditoria_sistema (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tipo TEXT,
                mensaje TEXT,
                timestamp INTEGER
            )
        `);

        await this.registrarEvento('SISTEMA', 'Auditor inicializado y en guardia.');

        // 2. Iniciar el Watchdog (Chequeo cada 60 segundos)
        setInterval(() => this.chequeoDeSalud(), 60000);
    }

    /**
     * Guarda eventos en la bitácora silenciosa.
     */
    static async registrarEvento(tipo, mensaje) {
        try {
            console.log(`🛡️ [AUDITOR] ${tipo}: ${mensaje}`);
            if (this.runQuery) {
                await this.runQuery(
                    "INSERT INTO auditoria_sistema (tipo, mensaje, timestamp) VALUES (?, ?, ?)",
                    [tipo, mensaje, Date.now()]
                );
                
                // Mantener la bitácora ligera (borrar registros con más de 7 días)
                const limiteTiempo = Date.now() - (7 * 24 * 60 * 60 * 1000);
                await this.runQuery("DELETE FROM auditoria_sistema WHERE timestamp < ?", [limiteTiempo]);
            }
        } catch (error) {
            console.error("Error del Auditor al registrar evento:", error);
        }
    }

    /**
     * El corazón del Watchdog: verifica que Chromium y WhatsApp sigan vivos.
     */
    static async chequeoDeSalud() {
        if (!this.client || !this.client.pupPage) return;

        try {
            // Promesa con Timeout estricto: Si getState tarda más de 8s, Chromium está "Zombie"
            const estado = await Promise.race([
                this.client.getState(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT_ZOMBIE')), 8000))
            ]);

            // Si llegamos aquí, respondió a tiempo.
            this.fallaConsecutiva = 0; // Resetear contador

        } catch (error) {
            // Evaluamos el error
            this.fallaConsecutiva++;
            
            if (error.message === 'TIMEOUT_ZOMBIE') {
                await this.registrarEvento('ALERTA', `La pestaña de WhatsApp no responde (Zombie). Falla #${this.fallaConsecutiva}`);
            } else {
                await this.registrarEvento('ALERTA', `Falla al leer estado de WhatsApp: ${error.message}. Falla #${this.fallaConsecutiva}`);
            }

            // AUTO-REPARACIÓN (Self-Healing)
            // Si falla 3 veces seguidas (3 minutos muerto), forzamos reinicio limpio
            if (this.fallaConsecutiva >= 3) {
                await this.registrarEvento('CRITICO', 'Bot colgado irremediablemente. Ejecutando auto-reparación (PM2 Restart)...');
                setTimeout(() => {
                    process.exit(1); // PM2 lo revivirá inmediatamente
                }, 2000);
            }
        }
    }

    /**
     * Genera el reporte diagnóstico cuando un SuperAdmin envía el comando !auditoria
     */
    static async generarReporte() {
        const uptimeSys = Math.floor(os.uptime() / 3600); // Horas de encendido del VPS
        const memUsada = Math.round(process.memoryUsage().rss / 1024 / 1024); // RAM en MB
        
        let estadoWA = "DESCONOCIDO";
        try {
            estadoWA = await Promise.race([
                this.client.getState(),
                new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 3000))
            ]);
        } catch (e) {
            estadoWA = "ERROR_LECTURA";
        }

        return `🛡️ *REPORTE DEL AUDITOR (Watchdog)* 🛡️

📡 *Estado WhatsApp:* ${estadoWA || 'SIN VINCULAR'}
💻 *RAM Consumida:* ${memUsada} MB
⏱️ *Uptime VPS:* ${uptimeSys} hrs
🚨 *Fallas en curso:* ${this.fallaConsecutiva}/3

*Diagnóstico de Salud:*
${this.fallaConsecutiva === 0 ? '✅ Sistema estable y comunicando perfectamente.' : '⚠️ Anomalías detectadas, evaluando reinicio.'}
        `.trim();
    }
}

module.exports = Auditor;
