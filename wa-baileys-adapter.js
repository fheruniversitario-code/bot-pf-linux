const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');

class MessageMedia {
    constructor(mimetype, data, filename) {
        this.mimetype = mimetype;
        this.data = data; // base64
        this.filename = filename;
    }
    static fromFilePath(filePath) {
        if (!fs.existsSync(filePath)) throw new Error('File not found: ' + filePath);
        const data = fs.readFileSync(filePath).toString('base64');
        const ext = path.extname(filePath).toLowerCase();
        let mime = 'application/octet-stream';
        if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
        else if (ext === '.png') mime = 'image/png';
        else if (ext === '.pdf') mime = 'application/pdf';
        else if (ext === '.mp4') mime = 'video/mp4';
        else if (ext === '.ogg') mime = 'audio/ogg';
        
        return new MessageMedia(mime, data, path.basename(filePath));
    }
}

class LocalAuth {
    constructor(options) {
        this.dataPath = options.dataPath;
    }
}

class Client extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = options;
        this.sock = null;
        this.pupPage = {
            isClosed: () => false,
            evaluate: async (fn) => {
                // mock battery or anything else
                return { battery: 100, plugged: true };
            }
        };
        
        // Caches para que no rompa si `server.js` pide chats/contactos
        this.contacts = {};
        this.chats = {};
    }

    async initialize() {
        console.log("Inicializando Baileys Adapter...");
        const authPath = path.join(process.cwd(), 'baileys_auth');
        
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: Browsers.macOS('Desktop'),
            syncFullHistory: false
        });

        this.sock = sock;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                // Emitir QR a server.js
                this.emit('qr', qr);
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    console.log('Desconexión de Baileys, reconectando...');
                    setTimeout(() => this.initialize(), 3000);
                } else {
                    console.log('Sesión cerrada (logged out).');
                    this.emit('disconnected', 'LOGOUT');
                }
            } else if (connection === 'open') {
                console.log('Baileys conectado y listo!');
                this.emit('ready');
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            if (m.type !== 'notify') return;
            for (const msg of m.messages) {
                if (!msg.message) continue;

                // Construir objeto Mock de WWebJS Message
                const jid = msg.key.remoteJid;
                const isGroup = jid.endsWith('@g.us');
                const fromMe = msg.key.fromMe;
                const from = fromMe ? sock.user.id.replace(/:.*@/, '@') : jid;
                const to = fromMe ? jid : sock.user.id.replace(/:.*@/, '@');
                
                let body = '';
                let type = 'chat';
                let hasMedia = false;
                
                const msgType = Object.keys(msg.message)[0];
                if (msgType === 'conversation') {
                    body = msg.message.conversation;
                } else if (msgType === 'extendedTextMessage') {
                    body = msg.message.extendedTextMessage.text;
                } else if (msgType === 'imageMessage') {
                    body = msg.message.imageMessage.caption || '';
                    type = 'image';
                    hasMedia = true;
                } else if (msgType === 'videoMessage') {
                    body = msg.message.videoMessage.caption || '';
                    type = 'video';
                    hasMedia = true;
                } else if (msgType === 'documentMessage') {
                    body = msg.message.documentMessage.caption || msg.message.documentMessage.fileName || '';
                    type = 'document';
                    hasMedia = true;
                } else if (msgType === 'audioMessage') {
                    type = msg.message.audioMessage.ptt ? 'ptt' : 'audio';
                    hasMedia = true;
                }

                // Si es un status o broadcast, lo ignoramos para mantener compatibilidad
                if (jid === 'status@broadcast') continue;

                const mockMsg = {
                    id: { _serialized: msg.key.id },
                    from: from,
                    to: to,
                    body: body,
                    type: type,
                    hasMedia: hasMedia,
                    fromMe: fromMe,
                    timestamp: msg.messageTimestamp,
                    author: isGroup ? msg.key.participant : undefined,
                    getContact: async () => {
                        return {
                            number: (fromMe ? sock.user.id : (isGroup ? msg.key.participant : jid)).split('@')[0],
                            pushname: msg.pushName || 'Usuario'
                        };
                    },
                    downloadMedia: async () => {
                        if (!hasMedia) return null;
                        try {
                            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                            return new MessageMedia('application/octet-stream', buffer.toString('base64'), 'media_file');
                        } catch(e) {
                            return null;
                        }
                    },
                    reply: async (text) => {
                        return await this.sendMessage(jid, text, { quotedMessageId: msg.key.id });
                    }
                };

                if (fromMe) {
                    this.emit('message_create', mockMsg);
                } else {
                    this.emit('message', mockMsg);
                }
            }
        });
    }

    async sendMessage(chatId, content, options = {}) {
        if (!this.sock) throw new Error("Baileys no está inicializado");
        
        let messagePayload = {};
        
        if (content instanceof MessageMedia) {
            const buffer = Buffer.from(content.data, 'base64');
            if (content.mimetype.includes('image')) {
                messagePayload = { image: buffer, caption: options.caption || '' };
            } else if (content.mimetype.includes('video')) {
                messagePayload = { video: buffer, caption: options.caption || '' };
            } else if (content.mimetype.includes('audio')) {
                messagePayload = { audio: buffer, ptt: content.mimetype.includes('ogg') };
            } else {
                messagePayload = { document: buffer, fileName: content.filename, mimetype: content.mimetype, caption: options.caption || '' };
            }
        } else {
            messagePayload = { text: content };
        }

        const sent = await this.sock.sendMessage(chatId, messagePayload);
        return {
            id: { _serialized: sent.key.id }
        };
    }

    async getChats() {
        return []; 
    }

    async getChatById(jid) {
        return {
            id: { _serialized: jid },
            name: jid.split('@')[0],
            isGroup: jid.endsWith('@g.us'),
            fetchMessages: async () => []
        };
    }

    async getContactById(jid) {
        return {
            number: jid.split('@')[0],
            pushname: 'Usuario'
        };
    }

    async getLabels() {
        return [];
    }

    async addOrRemoveLabels(labelIds, jids) {
        // Ignorado en baileys
    }
}

module.exports = { Client, LocalAuth, MessageMedia };
