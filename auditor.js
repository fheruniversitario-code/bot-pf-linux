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
            
            // FOTOGRAFIA FORENSE DE MEMORIA (Detectar si es asfixia del servidor)
            const memLibreMB = Math.round(os.freemem() / 1024 / 1024);
            const memTotalMB = Math.round(os.totalmem() / 1024 / 1024);
            const ramWarning = memLibreMB < 200 ? ` [⚠️ PELIGRO: RAM baja (${memLibreMB}MB libres de ${memTotalMB}MB)]` : ` [RAM ok: ${memLibreMB}MB libres]`;

            if (error.message === 'TIMEOUT_ZOMBIE') {
                await this.registrarEvento('ALERTA', `La pestaña de WhatsApp no responde (Zombie). Falla #${this.fallaConsecutiva}${ramWarning}`);
            } else {
                await this.registrarEvento('ALERTA', `Falla al leer estado de WhatsApp: ${error.message}. Falla #${this.fallaConsecutiva}${ramWarning}`);
            }

            // AUTO-REPARACIÓN (Self-Healing) + CAZADOR DE ZOMBIS
            // Si falla 3 veces seguidas (3 minutos muerto), forzamos reinicio limpio
            if (this.fallaConsecutiva >= 3) {
                await this.registrarEvento('CRITICO', 'Bot colgado irremediablemente. Ejecutando cazador de zombis y auto-reparación (PM2 Restart)...');
                
                // 1. Programar incondicionalmente el reinicio para evitar que `destroy()` o cuelgues bloqueen el exit.
                setTimeout(() => {
                    process.exit(1); 
                }, 3000);

                try {
                    // CAZADOR DE ZOMBIS: Buscar y aniquilar el proceso de Chrome específico de este bot
                    if (this.client && this.client.pupBrowser) {
                        const browserProcess = this.client.pupBrowser.process();
                        if (browserProcess && browserProcess.pid) {
                            await this.registrarEvento('SISTEMA', `Asesinando proceso Chromium zombie (PID: ${browserProcess.pid})`);
                            process.kill(browserProcess.pid, 'SIGKILL'); // Fuego a discreción
                        }
                    }

                    // Destruir archivo SingletonLock (candado huérfano) que bloquea el reinicio si SIGKILL fue violento
                    const fs = require('fs');
                    const path = require('path');
                    const lockPath = path.join(process.cwd(), '.wwebjs_auth', 'session', 'SingletonLock');
                    if (fs.existsSync(lockPath)) {
                        fs.unlinkSync(lockPath);
                        console.log("Candado SingletonLock huérfano destruido.");
                    }
                    
                    // Cierre elegante si el proceso aún escucha
                    if (this.client) {
                        await this.client.destroy().catch(() => {});
                    }
                } catch (e) {
                    console.log("Error al limpiar al zombi:", e.message);
                }
            }
        }
    }

    /**
     * Genera el reporte diagnóstico cuando un SuperAdmin envía el comando !auditoria
     */
    static async generarReporte() {
        const uptimeSys = Math.floor(os.uptime() / 3600); // Horas de encendido del VPS
        const memUsada = Math.round(process.memoryUsage().rss / 1024 / 1024); // RAM en MB
        const memLibre = Math.round(os.freemem() / 1024 / 1024); // RAM Libre
        
        let estadoWA = "DESCONOCIDO";
        try {
            estadoWA = await Promise.race([
                this.client.getState(),
                new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 3000))
            ]);
        } catch (e) {
            estadoWA = "ERROR_LECTURA";
        }

        return `🛡️ *REPORTE DEL AUDITOR FORENSE* 🛡️

📱 *Estado WhatsApp:* ${estadoWA || 'SIN VINCULAR'}
🧠 *RAM Bot:* ${memUsada} MB
🔋 *RAM Libre Servidor:* ${memLibre} MB
⏱️ *Uptime VPS:* ${uptimeSys} hrs
⚠️ *Fallas en curso:* ${this.fallaConsecutiva}/3

*Diagnóstico de Salud:*
${this.fallaConsecutiva === 0 ? '✅ Sistema estable y comunicando perfectamente.' : '🚨 Anomalías detectadas, evaluando reinicio.'}
        `.trim();
    }
}

module.exports = Auditor;
