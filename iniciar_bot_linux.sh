#!/bin/bash
# ====================================================================
#   🤖 SCRIPT DE INICIO OPTIMIZADO PARA LINUX (LUBUNTU - 4GB RAM) 🤖
#                       CAISES JARAL DEL PROGRESO
# ====================================================================

echo "🚀 Iniciando Bot PF (Versión Optimizada para Lubuntu / ASUS E402S)..."

# Limitar memoria V8 de Node.js a 512MB máximo para liberar RAM al sistema
export NODE_OPTIONS="--max-old-space-size=512"
export UV_THREADPOOL_SIZE=4

# Limpiar posibles bloqueos de sesión huérfanos tras apagar o cerrar la laptop
if [ -f ".wwebjs_auth/session/SingletonLock" ]; then
    rm -f .wwebjs_auth/session/SingletonLock
    echo "🧹 Bloqueo de sesión previo eliminado."
fi

# Bucle de ejecución continua con auto-reinicio si ocurre alguna desconexión
until node bot.js; do
    echo "⚠️ El bot se detuvo con código $?. Reiniciando en 3 segundos..." >&2
    sleep 3
done
