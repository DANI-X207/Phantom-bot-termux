// Termux fournit yt-dlp via son gestionnaire de paquets. On l'utilise au lieu
// du binaire Linux téléchargé par youtube-dl-exec, qui n'est pas compatible Android.
if (process.platform === 'android') {
    const termuxPrefix = process.env.PREFIX || '/data/data/com.termux/files/usr';
    process.env.YOUTUBE_DL_DIR ??= `${termuxPrefix}/bin`;
    process.env.YOUTUBE_DL_SKIP_DOWNLOAD ??= '1';
}

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const P = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const handler = require('./handler');
const { toBuffer: qrToBuffer } = require('./lib/qr-image');

const SESSIONS_DIR = path.join(__dirname, 'sessions');
const REGISTRY_FILE = path.join(SESSIONS_DIR, 'registry.json');
const LEGACY_SESSION_DIR = path.join(__dirname, 'session');
const SUPER_SESSION_ID = 'super';
const sessions = new Map();
let registry = { superSessionId: SUPER_SESSION_ID };

process.on('uncaughtException', err => console.error('Erreur non interceptée :', err));
process.on('unhandledRejection', err => console.error('Rejet de promesse non intercepté :', err));

function normalizeJid(jid) { return (jid || '').replace(/:\d+@/, '@'); }
function numberFromJid(jid) { return normalizeJid(jid).split('@')[0].replace(/\D/g, ''); }
function sessionDirectory(id) { return path.join(SESSIONS_DIR, id); }

async function writeRegistry() {
    await fsp.mkdir(SESSIONS_DIR, { recursive: true });
    await fsp.writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

async function initialiseStorage() {
    await fsp.mkdir(SESSIONS_DIR, { recursive: true });
    try { registry = { ...registry, ...JSON.parse(await fsp.readFile(REGISTRY_FILE, 'utf8')) }; } catch (_) { /* first start */ }
    const superDir = sessionDirectory(SUPER_SESSION_ID);
    if (fs.existsSync(LEGACY_SESSION_DIR) && !fs.existsSync(superDir)) await fsp.rename(LEGACY_SESSION_DIR, superDir);
    await writeRegistry();
}

function getSuperSocket() { return sessions.get(registry.superSessionId)?.sock; }

async function startSession(id, { qrReplyTo = null } = {}) {
    if (sessions.has(id)) {
        if (qrReplyTo) sessions.get(id).qrReplyTo = qrReplyTo;
        return sessions.get(id);
    }
    const authDir = sessionDirectory(id);
    await fsp.mkdir(authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ version, logger: P({ level: 'silent' }), auth: state, browser: ['Phantom-Bot', 'Chrome', '3.0.0'], printQRInTerminal: false });
    const record = { id, sock, status: 'loading', number: null, qrDataUrl: null, qrReplyTo, qrSent: false, manuallyStopped: false, reconnecting: false };
    sessions.set(id, record);
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            record.status = 'qr';
            const image = qrToBuffer(qr);
            record.qrDataUrl = `data:image/png;base64,${image.toString('base64')}`;
            if (id === registry.superSessionId) {
                console.log('\n👻 QR de la super-session :');
                qrcodeTerminal.generate(qr, { small: true });
            }
            if (record.qrReplyTo && !record.qrSent) {
                record.qrSent = true;
                try {
                    await getSuperSocket()?.sendMessage(record.qrReplyTo, { image, caption: '🔗 *Nouvelle session prête*\n_Scanez ce QR avec le compte à connecter. Il expire rapidement._' });
                } catch (error) {
                    record.qrSent = false;
                    console.error(`Envoi du QR de ${id} impossible :`, error.message);
                }
            }
        }
        if (connection === 'open') {
            record.status = 'connected';
            record.qrDataUrl = null;
            record.number = numberFromJid(sock.user?.id);
            record.qrReplyTo = null;
            console.log(`✅ Session ${id} connectée : ${record.number}`);
            return;
        }
        if (connection === 'close') {
            record.status = 'disconnected';
            const code = lastDisconnect?.error?.output?.statusCode;
            sessions.delete(id);
            if (!record.manuallyStopped && code !== DisconnectReason.loggedOut && !record.reconnecting) {
                record.reconnecting = true;
                console.log(`🌐 Reconnexion de la session ${id}...`);
                setTimeout(() => startSession(id), 1500);
            } else if (code === DisconnectReason.loggedOut) console.log(`💀 Session ${id} déconnectée.`);
        }
    });
    sock.ev.on('messages.upsert', async m => {
        if (m.type !== 'notify' || !m.messages?.[0]?.message) return;
        await handler(sock, m, { sessionId: id, sessionManager });
    });
    return record;
}

async function createCoupledSession(replyTo) {
    const id = `session-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    await startSession(id, { qrReplyTo: replyTo });
    return id;
}
function listSessions() {
    return [...sessions.values()].map(record => ({ id: record.id, super: record.id === registry.superSessionId, number: record.number, status: record.status }));
}
async function disconnectByNumber(rawNumber) {
    const wanted = String(rawNumber || '').replace(/\D/g, '');
    const superSession = sessions.get(registry.superSessionId);
    if (superSession?.number && (superSession.number === wanted || superSession.number.startsWith(wanted))) {
        return { ok: false, reason: 'super-protected' };
    }
    const candidates = [...sessions.values()].filter(record => record.id !== registry.superSessionId && record.number && (record.number === wanted || record.number.startsWith(wanted)));
    if (candidates.length !== 1) return { ok: false, reason: candidates.length ? 'ambiguous' : 'not-found' };
    const record = candidates[0];
    record.manuallyStopped = true;
    sessions.delete(record.id);
    try { await record.sock.logout(); } catch (_) { /* already closed */ }
    await fsp.rm(sessionDirectory(record.id), { recursive: true, force: true });
    return { ok: true, session: { id: record.id, number: record.number } };
}
async function resetSuperSession() {
    const record = sessions.get(registry.superSessionId);
    if (record) {
        record.manuallyStopped = true;
        sessions.delete(record.id);
        try { await record.sock.logout(); } catch (_) { /* already closed */ }
    }
    await fsp.rm(sessionDirectory(registry.superSessionId), { recursive: true, force: true });
    return startSession(registry.superSessionId);
}
const sessionManager = { isSuperSession: id => id === registry.superSessionId, createCoupledSession, listSessions, disconnectByNumber, resetSuperSession };

async function bootSessions() {
    await initialiseStorage();
    const entries = await fsp.readdir(SESSIONS_DIR, { withFileTypes: true });
    const ids = entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
    if (!ids.includes(registry.superSessionId)) ids.unshift(registry.superSessionId);
    await Promise.all([...new Set(ids)].map(id => startSession(id)));
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/status', (_req, res) => {
    const superSession = sessions.get(registry.superSessionId);
    res.json({ status: superSession?.status || 'disconnected', qrImage: superSession?.qrDataUrl || null, sessions: listSessions() });
});
app.post('/api/reset', async (_req, res) => {
    try { await resetSuperSession(); res.status(202).json({ ok: true }); }
    catch (error) { res.status(500).json({ ok: false, error: error.message }); }
});
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`🌐 Tableau de bord : http://localhost:${port}`));
bootSessions().catch(error => { console.error('Démarrage des sessions impossible :', error); process.exitCode = 1; });
