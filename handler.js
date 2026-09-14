const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { askAI, askAIWithHistory, duckSearch, youtubeSearch, MODELS } = require('./lib/functions');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ── Générateur de menu des modèles ───────────────────────────────────────────
function generateModelsList(activeAlias) {
    let result = '';
    const providers = [...new Set(MODELS.map(m => m.provider))];
    providers.forEach(prov => {
        result += `\n 🤖 *${prov.toUpperCase()}* :\n`;
        const provModels = MODELS.filter(m => m.provider === prov);
        provModels.forEach(m => {
            const activeStr = m.alias === activeAlias ? ' ← actif' : '';
            result += `  • ${m.name} (alias: *${m.alias}*)${activeStr}\n`;
        });
    });
    return result.trim();
}

let botActive = true;
let currentPrefix = '.'; // Préfixe par défaut
// ── Système d'autorisation ─────────────────────────────────────────────────────
// Numéros autorisés à exécuter des commandes (en dehors du propriétaire/bot)
const authorizedNumbers = new Set();

// Convertit un numéro brut (ex: +33612345678) en JID WhatsApp
function toJid(rawNumber) {
    const clean = rawNumber.replace(/[^\d]/g, ''); // retire +, espaces, tirets
    return clean + '@s.whatsapp.net';
}

// Normalise un JID Baileys : retire le suffixe de device (:2, :0, etc.)
// Ex: '242050271841:2@s.whatsapp.net' → '242050271841@s.whatsapp.net'
function normalizeJid(jid) {
    if (!jid) return jid;
    return jid.replace(/:\d+@/, '@');
}


// ── Mode IA Alive (IA suit la conversation) ───────────────────────────────────
// groqAliveChats : Set des JIDs où le mode alive est actif
// groqHistory    : Map<jid, Array<{role, content}>> — historique par chat
// iaModelPerChat : Map<jid, string> — modèle IA choisi par chat ('groq'|'gemini'|'nvidia')
const groqAliveChats = new Set();
const groqHistory = new Map();
const iaModelPerChat = new Map();
const HISTORY_LIMIT = 20; // nombre max de messages (user+assistant) conservés

// Mots-clés qui signalent qu'un message mérite une réponse de l'IA
const QUESTION_PATTERNS = [
    /\?/,                                              // point d'interrogation
    /^(c'est quoi|qu'est[-\s]ce|pourquoi|comment|quand|où|qui|combien|est[-\s]ce|tu peux|tu sais|explique|dis[-\s]moi|parle[-\s]moi|c'est quoi|keskon|kske|kc|kv|c kwa|c koi)/i,
    /^(what|how|why|when|where|who|can you|could you|please|tell me|explain)/i,
    /\b(aide|help|info|définis|signifie|veut dire|traduction|traduis|traduire|translate|calcul|fait combien|phantom|bot|stp)\b/i
];

const MEDIA_KEYS = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];

// ── Média du menu (Image, Vidéo ou GIF) ──────────────────────────────────────
function loadDanyMedia() {
    try {
        const imgDir = path.join(__dirname, 'img');
        if (!fs.existsSync(imgDir)) return null;
        
        // Trouver tous les fichiers qui commencent par "dany"
        const files = fs.readdirSync(imgDir).filter(f => f.toLowerCase().startsWith('dany'));
        if (files.length === 0) return null;
        
        // Choisir un fichier au hasard (pour alterner de temps en temps)
        const file = files[Math.floor(Math.random() * files.length)];
        const ext = path.extname(file).toLowerCase();
        
        return {
            buffer: fs.readFileSync(path.join(imgDir, file)),
            isVideo: ext === '.mp4',
            isGif: ext === '.gif'
        };
    } catch (_) { return null; }
}

// ── Extraction média (vue unique ouverte ou non) ──────────────────────────────
function extractMedia(quoted) {
    if (!quoted || typeof quoted !== 'object') return null;
    for (const voKey of ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension']) {
        const inner = quoted[voKey]?.message;
        if (inner) {
            for (const mk of MEDIA_KEYS) {
                if (inner[mk]) return { mediaMessage: inner[mk], mediaType: mk.replace('Message', '') };
            }
        }
    }
    for (const mk of MEDIA_KEYS) {
        if (quoted[mk]) return { mediaMessage: quoted[mk], mediaType: mk.replace('Message', '') };
    }
    const eph = quoted.ephemeralMessage?.message;
    if (eph) return extractMedia(eph);
    return null;
}

// ── Chemin vers ffmpeg local ─────────────────────────────────────────────────
const FFMPEG_PATH = process.env.FFMPEG_PATH || (process.platform === 'win32'
    ? path.join(__dirname, 'ffmpeg.exe')
    : 'ffmpeg');
const HAS_FFMPEG = process.platform === 'win32'
    ? fs.existsSync(FFMPEG_PATH)
    : !require('child_process').spawnSync(FFMPEG_PATH, ['-version'], { stdio: 'ignore' }).error;

// ── Télécharge la vidéo YouTube via yt-dlp ───────────────────────────────────
async function downloadYoutubeVideo(query) {
    const play = require('play-dl');
    const youtubedl = require('youtube-dl-exec');
    const os = require('os');

    const results = await play.search(query, { source: { youtube: 'video' }, limit: 1 });
    if (!results || results.length === 0) throw new Error('Aucun résultat trouvé');

    const video = results[0];
    console.log(`👻 [DVID] Trouvé : ${video.title} | HAS_FFMPEG=${HAS_FFMPEG}`);

    const tmpBase = path.join(os.tmpdir(), `phantom_vid_${Date.now()}`);
    const tmpFile = tmpBase + '.mp4';

    const opts = {
        output: tmpFile,
        noPlaylist: true,
        noCheckCertificates: true,
        limitRate: '2M',
        addHeader: ['referer:youtube.com', 'user-agent:Mozilla/5.0'],
        format: '18/best' // 18 = 360p mp4 avec audio/vidéo intégrés (pas besoin de ffmpeg)
    };

    await youtubedl(video.url, opts);

    // 2. Cherche le fichier téléchargé (yt-dlp peut changer l'extension)
    let finalFile = tmpFile;
    if (!fs.existsSync(finalFile)) {
        const tmpDir = os.tmpdir();
        const ts = path.basename(tmpBase).replace('phantom_vid_', '');
        const found = fs.readdirSync(tmpDir).find(f => f.includes(`phantom_vid_${ts}`));
        if (found) finalFile = path.join(tmpDir, found);
        else throw new Error('Fichier vidéo introuvable après téléchargement');
    }

    // 3. Vérifie la taille (WhatsApp limite à ~100MB)
    const stats = fs.statSync(finalFile);
    const sizeMB = stats.size / (1024 * 1024);
    if (sizeMB > 95) {
        fs.unlinkSync(finalFile);
        throw new Error(`Fichier trop lourd (${Math.round(sizeMB)}MB). Essaie un clip plus court.`);
    }

    const buffer = fs.readFileSync(finalFile);
    try { fs.unlinkSync(finalFile); } catch (_) { }

    return {
        buffer,
        title: video.title,
        author: video.channel?.name || 'Inconnu',
        duration: video.durationRaw,
        url: video.url,
        sizeMB: Math.round(sizeMB)
    };
}

// ── Télécharge un média Baileys en Buffer ────────────────────────────────────
async function downloadMedia(mediaMessage, mediaType) {
    const stream = await downloadContentFromMessage(mediaMessage, mediaType);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    return buffer;
}

// ── Recherche + Télécharge l'audio YouTube via yt-dlp ────────────────────────
async function downloadYoutubeAudio(query) {
    const play = require('play-dl');
    const youtubedl = require('youtube-dl-exec');
    const os = require('os');

    // 1. Recherche jusqu'à 3 résultats via play-dl (pour avoir des alternatives)
    let candidates = [];
    try {
        const results = await play.search(query, { source: { youtube: 'video' }, limit: 3 });
        if (results && results.length > 0) candidates = results;
    } catch (searchErr) {
        console.error('[DAUDIO] play-dl search failed:', searchErr.message);
    }

    if (candidates.length === 0) throw new Error('Aucun résultat trouvé pour : ' + query);

    // 2. Essaie chaque candidat jusqu'à ce qu'un téléchargement réussisse
    let lastErr = null;
    for (const video of candidates) {
        console.log(`👻 [DAUDIO] Essai : ${video.title} | ${video.url}`);

        const tmpBase = path.join(os.tmpdir(), `phantom_${Date.now()}`);
        const tmpFile = tmpBase + '.mp4';

        try {
            await youtubedl(video.url, {
                format: '18', // mp4 360p progressif — lisible Android sans ffmpeg
                output: tmpFile,
                noPlaylist: true,
                noCheckCertificates: true,
                limitRate: '2M', // Limite pour ne pas couper le WebSocket WhatsApp
                addHeader: ['referer:youtube.com', 'user-agent:Mozilla/5.0']
            });

            // Cherche le fichier téléchargé
            let finalFile = tmpFile;
            if (!fs.existsSync(finalFile)) {
                const tmpDir = os.tmpdir();
                const ts = path.basename(tmpBase).replace('phantom_', '');
                const found = fs.readdirSync(tmpDir).find(f => f.includes(`phantom_${ts}`));
                if (found) finalFile = path.join(tmpDir, found);
                else throw new Error('Fichier audio introuvable après téléchargement');
            }

            const buffer = fs.readFileSync(finalFile);
            try { fs.unlinkSync(finalFile); } catch (_) { }

            return {
                buffer,
                mimetype: 'audio/mp4',
                title: video.title || query,
                author: video.channel?.name || 'Inconnu',
                duration: video.durationRaw || '?'
            };

        } catch (dlErr) {
            lastErr = dlErr;
            console.error(`[DAUDIO] Échec pour ${video.url} :`, dlErr.message);
            // On nettoie le fichier temporaire si créé
            try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (_) { }
            // On essaie le candidat suivant
        }
    }

    throw new Error(lastErr?.message || 'Tous les résultats ont échoué');
}

// ════════════════════════════════════════════════════════════════════════════
// Version robuste : yt-search est déjà utilisé par .play et yt-dlp télécharge
// des flux modernes, au lieu du format YouTube historique 18.
function findDownloadedFile(tmpBase) {
    const dir = path.dirname(tmpBase);
    const prefix = path.basename(tmpBase);
    const files = fs.readdirSync(dir)
        .filter(name => name.startsWith(prefix) && !name.endsWith('.part'))
        .map(name => path.join(dir, name))
        .filter(file => fs.statSync(file).isFile());
    if (!files.length) throw new Error('yt-dlp n’a produit aucun fichier.');
    return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

async function downloadModern(url, prefix, format) {
    const youtubedl = require('youtube-dl-exec');
    const os = require('os');
    const tmpBase = path.join(os.tmpdir(), `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
    await youtubedl(url, {
        output: `${tmpBase}.%(ext)s`,
        format,
        // YouTube exige désormais l'exécution du player JavaScript pour
        // exposer certains formats. Node est déjà le runtime du bot.
        jsRuntimes: 'node',
        noPlaylist: true,
        noCheckCertificates: true,
        limitRate: '2M',
        addHeader: ['referer:youtube.com', 'user-agent:Mozilla/5.0']
    });
    return findDownloadedFile(tmpBase);
}

async function searchYoutubeModern(query, limit = 3) {
    const yts = require('yt-search');
    const result = await yts(query);
    return (result.videos || []).slice(0, limit);
}

async function downloadYoutubeVideoReliable(query) {
    const videos = await searchYoutubeModern(query);
    if (!videos.length) throw new Error('Aucun résultat YouTube trouvé.');

    // Formats tentés dans l'ordre : du plus compatible (audio+vidéo) au dernier recours
    const FORMATS = [
        '22/18',                                                          // 1. Anciens formats combinés YouTube (audio+vidéo, le mieux)
        'b[ext=mp4][acodec!=none][vcodec!=none]',                        // 2. Meilleur mp4 combiné disponible
        'b[ext=mp4][vcodec^=avc]/bv[ext=mp4][vcodec^=avc]'              // 3. Dernier recours : vidéo H.264 seule (lisible mais sans son)
    ];

    let lastError;
    for (const video of videos) {
        for (const format of FORMATS) {
            try {
                console.log(`[DVID] Tentative format "${format}" pour ${video.url}`);
                const file = await downloadModern(video.url, 'phantom_vid', format);
                const sizeMB = fs.statSync(file).size / (1024 * 1024);
                if (sizeMB > 95) { try { fs.unlinkSync(file); } catch (_) { } throw new Error(`Fichier trop lourd (${Math.round(sizeMB)}MB).`); }
                const buffer = fs.readFileSync(file);
                try { fs.unlinkSync(file); } catch (_) { }
                console.log(`[DVID] ✅ Succès avec format "${format}"`);
                return { buffer, title: video.title, author: video.author?.name || 'Inconnu', duration: video.timestamp || '?', sizeMB: Math.round(sizeMB) };
            } catch (error) {
                lastError = error;
                console.error(`[DVID] Format "${format}" échoué pour ${video.url}:`, error.message);
            }
        }
    }
    throw lastError || new Error('Aucune vidéo téléchargeable.');
}

async function downloadYoutubeAudioToBuffer(url) {
    const { spawn } = require('child_process');
    const youtubedl = require('youtube-dl-exec');
    const flags = {
        output: '-',
        format: 'bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio',
        jsRuntimes: 'node',
        noPlaylist: true,
        noCheckCertificates: true,
        limitRate: '2M',
        noProgress: true,
        addHeader: ['referer:youtube.com', 'user-agent:Mozilla/5.0']
    };

    return new Promise((resolve, reject) => {
        const child = spawn(youtubedl.constants.YOUTUBE_DL_PATH, [...youtubedl.args(flags), '--', url], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const chunks = [];
        const errors = [];
        let size = 0;
        const maxSize = 64 * 1024 * 1024;

        child.stdout.on('data', chunk => {
            size += chunk.length;
            if (size > maxSize) {
                child.kill();
                reject(new Error('Audio trop lourd pour WhatsApp (64 Mo maximum).'));
                return;
            }
            chunks.push(chunk);
        });
        child.stderr.on('data', chunk => errors.push(chunk));
        child.on('error', reject);
        child.on('close', code => {
            if (size > maxSize) return;
            if (code !== 0) return reject(new Error(Buffer.concat(errors).toString('utf8').trim() || `yt-dlp a quitté avec le code ${code}`));
            resolve(Buffer.concat(chunks));
        });
    });
}

function detectAudioMime(buffer) {
    if (buffer.subarray(0, 3).toString() === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
    if (buffer.subarray(0, 4).toString() === 'OggS') return 'audio/ogg; codecs=opus';
    if (buffer.subarray(0, 4).toString() === 'RIFF') return 'audio/wav';
    if (buffer.subarray(4, 8).toString() === 'ftyp') return 'audio/mp4';
    return 'audio/webm';
}

async function downloadYoutubeAudioReliable(query) {
    const videos = await searchYoutubeModern(query);
    if (!videos.length) throw new Error('Aucun résultat YouTube trouvé.');
    let lastError;
    for (const video of videos) {
        try {
            const buffer = await downloadYoutubeAudioToBuffer(video.url);
            const mimetype = detectAudioMime(buffer);
            return { buffer, mimetype, title: video.title || query, author: video.author?.name || 'Inconnu', duration: video.timestamp || '?' };
        } catch (error) {
            lastError = error;
            console.error(`[DAUDIO] Échec ${video.url}:`, error.message);
        }
    }
    throw lastError || new Error('Aucun audio téléchargeable.');
}

module.exports = async (sock, m, { sessionId = 'super', sessionManager = null } = {}) => {
    const msg = m.messages[0];
    const from = msg?.key?.remoteJid;

    try {
        if (!msg?.message) return;

        const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';

        // ── Extraction robuste du texte ───────────────────────────────────
        // Fonction récursive pour trouver le texte dans n'importe quel wrapper
        function extractBody(m) {
            if (!m) return '';
            // Dépaqueter les wrappers courants
            if (m.ephemeralMessage) return extractBody(m.ephemeralMessage.message);
            if (m.viewOnceMessageV2) return extractBody(m.viewOnceMessageV2.message);
            if (m.documentWithCaptionMessage) return extractBody(m.documentWithCaptionMessage.message);

            if (m.conversation) return m.conversation;
            if (m.extendedTextMessage) return m.extendedTextMessage?.text || '';
            if (m.imageMessage) return m.imageMessage?.caption || '';
            if (m.videoMessage) return m.videoMessage?.caption || '';
            if (m.audioMessage) return '';
            if (m.buttonsResponseMessage) return m.buttonsResponseMessage?.selectedButtonId || '';
            if (m.listResponseMessage) return m.listResponseMessage?.singleSelectReply?.selectedRowId || '';
            return '';
        }

        const body = extractBody(msg.message);
        if (!body) return;

        // ── Interception des messages en mode IA Alive ────────────────────
        // Ce bloc doit être AVANT le filtre commandes
        if (!body.startsWith(currentPrefix) && groqAliveChats.has(from)) {
            let text = body.trim();
            const quotedMsg = msg.message && msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo && msg.message.extendedTextMessage.contextInfo.quotedMessage;
            if (quotedMsg) {
                const quotedText = quotedMsg.conversation || (quotedMsg.extendedTextMessage && quotedMsg.extendedTextMessage.text) || (quotedMsg.imageMessage && quotedMsg.imageMessage.caption) || (quotedMsg.videoMessage && quotedMsg.videoMessage.caption) || "";
                if (quotedText) {
                    text = 'Message cite :\n"' + quotedText + '"\n\nMa question : ' + text;
                }
            }
            const wordCount = body.trim().split(/\s+/).length;
            const isQuestion = (wordCount >= 2 && QUESTION_PATTERNS.some(p => p.test(body.trim()))) || (quotedMsg && wordCount >= 1);
            if (isQuestion) {
                if (!groqHistory.has(from)) groqHistory.set(from, []);
                const hist = groqHistory.get(from);
                hist.push({ role: 'user', content: text });
                const modelAlias = iaModelPerChat.get(from) || 'g8';
                const result = await askAIWithHistory(hist, modelAlias);
                if (result?.text) {
                    hist.push({ role: 'assistant', content: result.text });
                    if (hist.length > HISTORY_LIMIT) hist.splice(0, hist.length - HISTORY_LIMIT);
                    await sock.sendMessage(from, { text: `👻 ${result.text}` });
                }
            }
            return;
        }

        // Filtre : seules les commandes (débutant par le préfixe configuré) sont traitées après
        if (!body.startsWith(currentPrefix)) return;

        const parts = body.trim().split(/ +/);
        const command = parts.shift().slice(currentPrefix.length).toLowerCase();
        const query = parts.join(' ');

        console.log(`👻 [PHANTOM] ${currentPrefix}${command}${query ? ' | ' + query : ''}`);

        // ── Vérification des droits d'exécution ──────────────────────────────
        // myJid (propriétaire) = toujours autorisé
        // Autres : doivent être ajoutés via .auth
        const rawSender = msg.key.fromMe ? myJid : (msg.key.participant || from);
        const senderJid = normalizeJid(rawSender);
        const normMyJid = normalizeJid(myJid);
        console.log(`🔑 [AUTH] sender=${senderJid} | owner=${normMyJid} | list=${[...authorizedNumbers].join(',') || '(vide)'}`);
        if (senderJid !== normMyJid && !authorizedNumbers.has(senderJid)) {
            return sock.sendMessage(from, {
                text: '🚨 *Accès refusé !*\n_Tu n\'es pas autorisé à utiliser les commandes de Phantom Bot._'
            });
        }

        // Les commandes de sessions sont réservées au propriétaire de la super-session.
        const isSuperUser = Boolean(sessionManager?.isSuperSession(sessionId) && senderJid === normMyJid);
        if (['couple', 'info', 'uncouple'].includes(command) && !isSuperUser) {
            return sock.sendMessage(from, { text: '🚫 *Commande réservée à la super-session.*' });
        }

        if (command === 'couple') {
            const id = await sessionManager.createCoupledSession(from);
            return sock.sendMessage(from, {
                text: `⏳ *Préparation d'une nouvelle session (${id})...*\n_Le QR sera envoyé ici dès qu'il sera généré._`
            });
        }

        if (command === 'info') {
            const connected = sessionManager.listSessions();
            const lines = connected.map((entry, index) => {
                const role = entry.super ? '👑 Super-session' : '🔗 Session couplée';
                const number = entry.number ? `+${entry.number}` : 'Numéro en attente';
                return `${index + 1}. ${role}\n   ${number} — _${entry.status}_`;
            });
            return sock.sendMessage(from, {
                text: `📡 *Sessions Phantom (${connected.length})*\n\n${lines.join('\n\n') || '_Aucune session active._'}\n\n_Utilise ${currentPrefix}uncouple <numéro> pour déconnecter une session couplée._`
            });
        }

        if (command === 'uncouple') {
            if (!query) return sock.sendMessage(from, { text: `⚠️ *Numéro manquant.*\n_Usage : ${currentPrefix}uncouple <numéro>_` });
            const result = await sessionManager.disconnectByNumber(query);
            if (!result.ok) {
                const text = result.reason === 'super-protected'
                    ? '👑 *Action refusée.* La super-session ne peut pas être déconnectée avec cette commande.'
                    : result.reason === 'ambiguous'
                    ? '⚠️ Plusieurs sessions correspondent à ce numéro. Saisis le numéro complet avec son indicatif.'
                    : '⚠️ Aucune session couplée ne correspond à ce numéro. Utilise *.info* pour voir les numéros.';
                return sock.sendMessage(from, { text });
            }
            return sock.sendMessage(from, { text: `✅ *Session déconnectée.*\n_+${result.session.number} a été retiré du bot._` });
        }

        if (command === 'setprefix') {
            if (!query) return sock.sendMessage(from, { text: `⚠️ *Préfixe manquant !*\n_Exemple : ${currentPrefix}setprefix !_` });
            if (query.length > 3) return sock.sendMessage(from, { text: '⚠️ *Le préfixe est trop long !* (3 caractères max)' });
            
            currentPrefix = query.trim();
            return sock.sendMessage(from, { text: `✅ *Préfixe modifié avec succès !*\n_Le nouveau préfixe est :_ *${currentPrefix}*` });
        }

        if (command === 'off') {
            botActive = false;
            return sock.sendMessage(from, { text: `🌑 *Phantom s'eclipse dans le Ghost Zone...*\n_Tape ${currentPrefix}on pour le réveiller._` });
        }
        if (command === 'on') {
            botActive = true;
            try {
                const onAnimPath = path.join(__dirname, 'img', 'on_anim.mp4');
                if (fs.existsSync(onAnimPath)) {
                    return sock.sendMessage(from, {
                        video: fs.readFileSync(onAnimPath),
                        caption: '⚡ *I\'M GOING GHOST !* 👻\n_Phantom Bot surgit de l\'ombre !_',
                        gifPlayback: true
                    });
                }
            } catch (_) {}
            return sock.sendMessage(from, { text: '⚡ *I\'M GOING GHOST !* 👻\n_Phantom Bot surgit de l\'ombre !_' });
        }
        if (!botActive) return;

        switch (command) {


            case 'auth': {
                const sub = query.trim().toLowerCase();

                // .auth clear - vide toute la liste
                if (sub === 'clear') {
                    authorizedNumbers.clear();
                    return sock.sendMessage(from, { text: '🚨 *Mise à jour spectrale !*\n_Tous les accès ont été réinitialisés. Seul le propriétaire peut utiliser le bot._' });
                }

                // .auth list — affiche les JIDs autorisés (brut pour debug)
                if (sub === 'list') {
                    if (authorizedNumbers.size === 0) {
                        return sock.sendMessage(from, { text: '📋 _Aucun numéro autorisé pour le moment._' });
                    }
                    const list = [...authorizedNumbers].map((j, i) => `${i + 1}. ${j}`).join('\n');
                    return sock.sendMessage(from, { text: `🛡️ *Autorisés :*\n${list}` });
                }

                // .auth - autorise la personne (en privé ou en répondant à son message en groupe)
                if (sub === '') {
                    const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;
                    let target = null;

                    if (quotedParticipant) {
                        target = normalizeJid(quotedParticipant);
                    } else if (!from.endsWith('@g.us')) {
                        target = normalizeJid(from);
                    }

                    if (!target) return sock.sendMessage(from, {
                        text: '⚠️ *Cible introuvable !*\n_En groupe, vous devez répondre au message de la personne pour l\'autoriser._'
                    });

                    if (target === normalizeJid(myJid)) return sock.sendMessage(from, {
                        text: '⚠️ *Impossible !* C\'est le numéro du bot.'
                    });

                    authorizedNumbers.add(target);
                    console.log(`✅ [AUTH here] Ajout JID : ${target}`);
                    return sock.sendMessage(from, {
                        text: [
                            '✅ *Accès accordé !*',
                            `_ID autorisé : ${target}_`,
                            '',
                            '👻 _Ce contact peut maintenant utiliser les commandes Phantom._'
                        ].join('\n')
                    });
                }

                // Commande inconnue pour .auth
                return sock.sendMessage(from, {
                    text: [
                        '⚠️ *Usage :*',
                        '  *.auth* — Autorise ce contact (réponds à son message en groupe)',
                        '  *.auth list* — Voir les accès actifs',
                        '  *.auth clear* — Réinitialiser tous les accès'
                    ].join('\n')
                });
            }

            // ── RET ───────────────────────────────────────────────────────
            case 'ret': {
                const sub = query.trim().toLowerCase();

                // .ret - retire la personne (en privé ou en répondant à son message en groupe)
                if (sub === '') {
                    const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;
                    let target = null;

                    if (quotedParticipant) {
                        target = normalizeJid(quotedParticipant);
                    } else if (!from.endsWith('@g.us')) {
                        target = normalizeJid(from);
                    }

                    if (!target) return sock.sendMessage(from, {
                        text: '⚠️ *Cible introuvable !*\n_En groupe, vous devez répondre au message de la personne pour lui retirer ses droits._'
                    });

                    const existed = authorizedNumbers.delete(target);
                    const remaining = [...authorizedNumbers].join('\n') || '_Aucun_';
                    return sock.sendMessage(from, {
                        text: existed
                            ? `✅ *Accès retiré !*\n_Le JID ${target} n'est plus autorisé._\n\n📋 *Restants :*\n${remaining}`
                            : `ℹ️ _Ce contact (${target}) n'était pas dans la liste._`
                    });
                }

                // Commande inconnue pour .ret
                return sock.sendMessage(from, {
                    text: [
                        '⚠️ *Usage :*',
                        '  *.ret* — Retire ce contact (réponds à son message en groupe)'
                    ].join('\n')
                });
            }

            // ── HELP ─────────────────────────────────────────────────────
            case 'help': {
                const menu = [
                    ...(isSuperUser ? [
                        '👑 *SUPER-SESSION*',
                        ` • *${currentPrefix}couple* ➜ Connecter un compte`,
                        ` • *${currentPrefix}info* ➜ Voir les sessions`,
                        ` • *${currentPrefix}uncouple <numéro>* ➜ Déconnecter un compte`,
                        ''
                    ] : []),
                    '╭─ 👻 *PHANTOM BOT*',
                    '│ ⚡ _Gardien du Ghost Zone_ ⚡',
                    '╰────────────── ✧',
                    '',
                    ' 🔮 *PORTAIL DU FANTÔME*',
                    ` ├ ⋆ *${currentPrefix}help* ➜ Ouvre ce portail`,
                    ` ├ ⋆ *${currentPrefix}setprefix* ➜ Changer le préfixe`,
                    ` ├ ⋆ *${currentPrefix}on* ➜ 🟢 Activer Phantom`,
                    ` ╰ ⋆ *${currentPrefix}off* ➜ 🔴 Mode veille`,
                    '',
                    ' 🛡️ *CONTRÔLE D\'ACCÈS*',
                    ` ├ ⋆ *${currentPrefix}auth* ➜ Autorise un contact`,
                    ` ╰ ⋆ *${currentPrefix}ret* ➜ Retire les droits`,
                    '',
                    ' 🤖 *INTELLIGENCE SPECTRALE*',
                    ` ├ ⋆ *${currentPrefix}ia <question>* ➜ IA (modèle actif)`,
                    ` ├ ⋆ *${currentPrefix}ia <alias>* ➜ Changer le modèle`,
                    ` ├ ⋆ *${currentPrefix}ia alive* ➜ 🟢 Chat IA automatique`,
                    ` ├ ⋆ *${currentPrefix}ia dead* ➜ 🔴 Stop Chat IA`,
                    ` ╰ ⋆ *${currentPrefix}ia reset* ➜ Efface mémoire`,
                    '',
                    '',
                    ' 🎵 *FRÉQUENCES SPECTRALES*',
                    ` ├ ⋆ *${currentPrefix}play* _<titre>_ ➜ Aperçu`,
                    ` ├ ⋆ *${currentPrefix}daudio* _<titre>_ ➜ Audio`,
                    ` ╰ ⋆ *${currentPrefix}dvid* _<titre>_ ➜ Vidéo`,
                    '',
                    ' 🎤 *VOIX SPECTRALE*',
                    ` ├ ⋆ *${currentPrefix}tts* _<texte>_ ➜ Texte en audio`,
                    ` ╰ ⋆ *${currentPrefix}stt* ➜ Transcrit un audio`,
                    '',
                    ' 🎨 *CRÉATION SPECTRALE*',
                    ` ╰ ⋆ *${currentPrefix}img* _<description>_ ➜ Génère une image`,
                    '',
                    ' 💀 *ARTEFACTS FANTÔMES*',
                    ` ├ ⋆ *${currentPrefix}save* ➜ Vole vue unique`,
                    ` ├ ⋆ *${currentPrefix}stick* ➜ Crée un sticker`,
                    ` ╰ ⋆ *${currentPrefix}gif* ➜ Crée un GIF`,
                    '',
                    ` 💡 *ASTUCE : ${currentPrefix}save*`,
                    ' ▹ 1. _Ouvre la vue unique_',
                    ' ▹ 2. _Réponds au message_',
                    ` ▹ 3. _Tape *${currentPrefix}save*_`,
                    '',
                    `『 👁️ _Préfixe : ${currentPrefix} | By Danny_ 』`,
                ].join('\n');

                const media = loadDanyMedia();
                if (media) {
                    if (media.isVideo || media.isGif) {
                        await sock.sendMessage(from, { 
                            video: media.buffer, 
                            caption: menu,
                            gifPlayback: media.isGif // Si c'est un .gif, on l'affiche en boucle muette
                        });
                    } else {
                        await sock.sendMessage(from, { 
                            image: media.buffer, 
                            caption: menu 
                        });
                    }
                } else {
                    await sock.sendMessage(from, { text: menu });
                }
                break;
            }

            // ── IA ───────────────────────────────────────────────────────
            case 'ia': {
                const trimmedQuery = query.trim();
                const firstWord = trimmedQuery.split(/\s+/)[0]?.toLowerCase() || '';

                // ── .ia alive ─────────────────────────────────────────────
                if (firstWord === 'alive') {
                    groqAliveChats.add(from);
                    if (!groqHistory.has(from)) groqHistory.set(from, []);
                    
                    const alias = iaModelPerChat.get(from) || 'g8';
                    const activeModelObj = MODELS.find(m => m.alias === alias) || MODELS[0];

                    return sock.sendMessage(from, {
                        text: [
                            `⚡ *Mode IA Alive activé !* 👻`,
                            `🤖 _Modèle actif : *${activeModelObj.name}*_`,
                            '',
                            '_Je lis vos messages et réponds aux questions automatiquement._',
                            '_Si les tokens s\'épuisent, je bascule sur le modèle suivant tout seul !_',
                            '',
                            `🔴 Tape *${currentPrefix}ia dead* pour me faire taire.`
                        ].join('\n')
                    });
                }

                // ── .ia dead ──────────────────────────────────────────────
                if (firstWord === 'dead' || firstWord === 'off') {
                    groqAliveChats.delete(from);
                    groqHistory.delete(from);
                    return sock.sendMessage(from, {
                        text: '🔴 *Mode IA Alive désactivé.*\n_Je ne lis plus vos messages automatiquement._'
                    });
                }

                // ── .ia reset ─────────────────────────────────────────────
                if (firstWord === 'reset') {
                    groqHistory.delete(from);
                    return sock.sendMessage(from, {
                        text: '🧠 *Mémoire effacée !*\n_L\'IA repart de zéro pour cette conversation._'
                    });
                }

                // ── .ia <alias> → changer le modèle (query = exactement un alias)
                const targetModel = MODELS.find(m => m.alias === firstWord);
                if (targetModel && firstWord === trimmedQuery.toLowerCase()) {
                    iaModelPerChat.set(from, firstWord);
                    return sock.sendMessage(from, {
                        text: [
                            `✅ *Modèle IA changé !*`,
                            `🤖 _Actif : *${targetModel.name}*_`,
                            '',
                            `_Tape *${currentPrefix}ia <question>* pour poser une question._`,
                            `_Tape *${currentPrefix}ia alive* pour le mode conversation._`,
                            `_Si ce modèle est à court de tokens, je bascule automatiquement._`
                        ].join('\n')
                    });
                }

                // ── .ia sans argument → aide + modèle actuel
                if (!trimmedQuery) {
                    const activeAlias = iaModelPerChat.get(from) || 'g8';
                    const list = generateModelsList(activeAlias);
                    return sock.sendMessage(from, {
                        text: [
                            '🤖 *Intelligence Spectrale — Phantom Bot*',
                            '',
                            '🔹 *Modèles disponibles (tape l\'alias pour changer) :*',
                            list,
                            '',
                            `🔹 *Commandes :*`,
                            `  *${currentPrefix}ia <question>*  — Poser une question`,
                            `  *${currentPrefix}ia <alias>*     — Choisir le modèle (ex: .ia gp)`,
                            `  *${currentPrefix}ia alive*       — Chat auto (mode conversation)`,
                            `  *${currentPrefix}ia dead*        — Stop chat`,
                            `  *${currentPrefix}ia reset*       — Efface la mémoire IA`,
                            '',
                            '_Si le modèle actif est à court de tokens, je bascule sur le suivant automatiquement._'
                        ].join('\n')
                    });
                }

                // ── .ia <question> → réponse avec modèle actif + fallback auto
                await sock.sendMessage(from, { text: '🔮 _Phantom plonge dans les dimensions du savoir..._' });
                const activeAlias = iaModelPerChat.get(from) || 'g8';
                const activeModelObj = MODELS.find(m => m.alias === activeAlias) || MODELS[0];
                const result = await askAI(trimmedQuery, activeAlias);

                if (result?.text) {
                    const fell = result.modelName !== activeModelObj.name;
                    const tag = fell
                        ? ` [⚡ basculé sur ${result.modelName}]`
                        : ` [${result.modelName}]`;
                    await sock.sendMessage(from, {
                        text: [
                            `╔══ 👻 *PHANTOM RÉPOND*${tag}`,
                            `╠══ ❓ _${trimmedQuery}_`,
                            `╠══`,
                            `║ ${result.text.replace(/\n/g, '\n║ ')}`,
                            `╚══════════════════════`,
                            `⚡ _Réponse spectrale de Phantom Bot_`
                        ].join('\n')
                    });
                } else {
                    // Fallback DuckDuckGo si tous les providers IA ont échoué
                    const results = await duckSearch(trimmedQuery);
                    if (!results || !results.length) {
                        return sock.sendMessage(from, { text: '💀 _Aucune trace dans le Ghost Zone. Tous les modèles IA sont indisponibles._' });
                    }
                    let text = `╔══ 🌀 *SCAN SPECTRAL : "${trimmedQuery}"*\n`;
                    results.slice(0, 3).forEach((res, i) => {
                        const num = ['1️⃣', '2️⃣', '3️⃣'][i];
                        text += `╠══\n║ ${num} *${res.title}*\n`;
                        if (res.snippet) text += `║ 👁️ _${res.snippet.slice(0, 120)}_\n`;
                        text += `║ 🔗 ${res.link}\n`;
                    });
                    text += `╚══════════════════════`;
                    await sock.sendMessage(from, { text });
                }
                break;
            }


            // ── PLAY ─────────────────────────────────────────────────────
            case 'play': {
                if (!query) return sock.sendMessage(from, {
                    text: '🎵 *Fréquence manquante !*\nUsage : *.play <titre>*'
                });
                await sock.sendMessage(from, { text: '👻 _Phantom capte les ondes de YouTube..._' });

                const vid = await youtubeSearch(query);
                if (vid) {
                    await sock.sendMessage(from, {
                        image: { url: vid.thumbnail },
                        caption: [
                            `🎵 *${vid.title}*`,
                            `👤 *Artiste :* ${vid.author}`,
                            `⏱️ *Durée :*  ${vid.timestamp}`,
                            `🔗 *Lien :*   ${vid.url}`,
                            ``,
                            `_💡 Tape_ *.daudio ${query}* _pour télécharger l'audio_`,
                            `_💡 Tape_ *.dvid ${query}* _pour télécharger la vidéo_`
                        ].join('\n')
                    });
                } else {
                    await sock.sendMessage(from, { text: '💀 _Signal perdu. Aucune vidéo trouvée._' });
                }
                break;
            }

            // ── DAUDIO ───────────────────────────────────────────────────
            case 'daudio': {
                if (!query) return sock.sendMessage(from, {
                    text: [
                        '🎵 *Titre manquant !*',
                        'Usage : *.daudio <titre> <artiste>*',
                        '',
                        '_Exemples :_',
                        '➜ .daudio Bella GIMS',
                        '➜ .daudio Hakari Zoro l\'frero',
                        '➜ .daudio Calm Down Rema',
                    ].join('\n')
                });

                await sock.sendMessage(from, { text: '🎵 _Phantom vole l\'audio depuis YouTube..._' });

                try {
                    const result = await downloadYoutubeAudioReliable(query);
                    await sock.sendMessage(from, {
                        text: `🎵 _Envoi de :_ *${result.title}* par *${result.author}* _(${result.duration})_`
                    });
                    await sock.sendMessage(from, {
                        audio: result.buffer,
                        mimetype: result.mimetype, // mimetype dynamique selon le fichier réel
                        ptt: false
                    });
                } catch (dlErr) {
                    console.error('[DAUDIO ERROR]', dlErr.message);
                    await sock.sendMessage(from, {
                        text: [
                            '💀 _Téléchargement impossible._',
                            '',
                            '💡 *Essaie avec titre + artiste :*',
                            `➜ *.daudio ${query} official*`,
                            `➜ *.daudio ${query} lyrics*`,
                        ].join('\n')
                    });
                }
                break;
            }

            // ── DVID ─────────────────────────────────────────────────────
            case 'dvid': {
                if (!query) return sock.sendMessage(from, {
                    text: [
                        '🎬 *Titre manquant !*',
                        'Usage : *.dvid <titre> <artiste>*',
                        '',
                        '_Fonctionne avec YouTube, TikTok,_',
                        '_Instagram, Facebook et plus..._',
                        '',
                        '_Exemples :_',
                        '➜ .dvid Bella GIMS clip officiel',
                        '➜ .dvid Hakari Zoro l\'frero',
                        '➜ .dvid <lien direct TikTok/Insta>',
                    ].join('\n')
                });

                await sock.sendMessage(from, { text: '🎬 _Phantom capture la vidéo depuis le Ghost Zone..._' });

                try {
                    // Si c'est un lien direct (TikTok, Instagram, Facebook...)
                    const isDirectUrl = query.startsWith('http://') || query.startsWith('https://');
                    let result;

                    if (isDirectUrl) {
                        // Téléchargement direct depuis l'URL
                        const youtubedl = require('youtube-dl-exec');
                        const os = require('os');
                        const tmpBase = path.join(os.tmpdir(), `phantom_vid_${Date.now()}`);
                        const tmpFile = tmpBase + '.mp4';

                        await youtubedl(query, {
                            // Pas de fusion → pas de ffmpeg
                            format: 'best[ext=mp4][acodec!=none][vcodec!=none][height<=480]/best[acodec!=none][vcodec!=none][height<=480]',
                            output: tmpFile,
                            noPlaylist: true,
                            noCheckCertificates: true,
                            addHeader: ['user-agent:Mozilla/5.0'],
                        });

                        let finalFile = tmpFile;
                        if (!fs.existsSync(finalFile)) {
                            const found = fs.readdirSync(os.tmpdir()).find(f => f.includes(`phantom_vid_`));
                            if (found) finalFile = path.join(os.tmpdir(), found);
                            else throw new Error('Fichier introuvable');
                        }

                        const stats = fs.statSync(finalFile);
                        const sizeMB = stats.size / (1024 * 1024);
                        if (sizeMB > 95) {
                            fs.unlinkSync(finalFile);
                            throw new Error(`Fichier trop lourd (${Math.round(sizeMB)}MB)`);
                        }

                        const buffer = fs.readFileSync(finalFile);
                        try { fs.unlinkSync(finalFile); } catch (_) { }
                        result = { buffer, title: 'Vidéo', author: 'Lien direct', duration: '?', sizeMB: Math.round(sizeMB) };

                    } else {
                        // Recherche YouTube par titre
                        result = await downloadYoutubeVideoReliable(query);
                    }

                    await sock.sendMessage(from, {
                        text: `🎬 _Envoi de :_ *${result.title}* par *${result.author}* _(${result.duration} | ${result.sizeMB}MB)_`
                    });
                    await sock.sendMessage(from, {
                        video: result.buffer,
                        mimetype: 'video/mp4',
                        caption: `🎬 *${result.title}* - *${result.author}* — 👻 _Phantom Bot_`
                    });

                } catch (dlErr) {
                    console.error('[DVID ERROR]', dlErr);
                    await sock.sendMessage(from, {
                        text: [
                            '💀 _Téléchargement vidéo impossible._',
                            '',
                            `⚠️ _Raison : ${dlErr.message}_`,
                            '',
                            '💡 *Essaie :*',
                            `➜ *.dvid ${query} clip officiel*`,
                            '➜ Colle directement le lien YouTube/TikTok',
                            '➜ Vérifie que la vidéo est publique',
                        ].join('\n')
                    });
                }
                break;
            }

            // ── STICK ────────────────────────────────────────────────────
            case 'stick':
            case 's': {
                const quotedForStick = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                const imgMsg =
                    msg.message?.imageMessage ||
                    quotedForStick?.imageMessage;

                if (!imgMsg) {
                    return sock.sendMessage(from, {
                        text: [
                            '🖼️ *Aucune image trouvée !*',
                            '',
                            '💡 *Deux façons de créer un sticker :*',
                            '1️⃣ Envoie une photo avec *.stick* en légende',
                            '2️⃣ Réponds à une photo avec *.stick*',
                        ].join('\n')
                    });
                }

                await sock.sendMessage(from, { text: '👻 _Phantom forge un sticker spectral..._' });

                const imgBuffer = await downloadMedia(imgMsg, 'image');
                const sticker = new Sticker(imgBuffer, {
                    pack: '👻 Phantom Bot',
                    author: '⚡ Danny',
                    type: StickerTypes.FULL,
                    quality: 60
                });
                const stickerBuffer = await sticker.toBuffer();
                await sock.sendMessage(from, { sticker: stickerBuffer });
                break;
            }

            // ── GIF ──────────────────────────────────────────────────────
            case 'gif': {
                const quotedForGif = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                const vidMsg =
                    msg.message?.videoMessage ||
                    quotedForGif?.videoMessage;

                if (!vidMsg) {
                    return sock.sendMessage(from, {
                        text: [
                            '🎬 *Aucune vidéo trouvée !*',
                            '',
                            '💡 *Deux façons de créer un GIF :*',
                            '1️⃣ Envoie une courte vidéo avec *.gif* en légende',
                            '2️⃣ Réponds à une vidéo avec *.gif*',
                            '',
                            '_Idéal pour les vidéos de moins de 10 secondes._'
                        ].join('\n')
                    });
                }

                await sock.sendMessage(from, { text: '🌀 _Phantom transforme la vidéo en GIF spectral..._' });

                const videoBuffer = await downloadMedia(vidMsg, 'video');
                await sock.sendMessage(from, {
                    video: videoBuffer,
                    gifPlayback: true,
                    mimetype: 'video/mp4',
                    caption: '👻 _GIF spectral by Phantom Bot_ ⚡'
                });
                break;
            }

            // ── SAVE ─────────────────────────────────────────────────────
            case 'save': {
                const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
                const quoted = ctxInfo?.quotedMessage;

                if (!quoted) {
                    return sock.sendMessage(from, {
                        text: [
                            '👻 *Fantôme introuvable !*',
                            '',
                            '〔 💡 *Comment voler un média vue unique* 〕',
                            '1️⃣  Ouvre le message vue unique',
                            '2️⃣  Appuie sur ↩️ *Répondre*',
                            '3️⃣  Tape *.save*',
                        ].join('\n')
                    });
                }

                try {
                    const safeLog = JSON.parse(JSON.stringify(quoted, (k, v) =>
                        (v instanceof Buffer || v?.type === 'Buffer') ? '<Buffer>' : v
                    ));
                    console.log('👻 [SAVE] Clés quoted:', Object.keys(safeLog));
                } catch (_) { }

                const found = extractMedia(quoted);

                if (!found) {
                    return sock.sendMessage(from, {
                        text: [
                            '💀 *Artefact introuvable dans ce message.*',
                            '',
                            '〔 💡 *Rappel* 〕',
                            '1️⃣  Ouvre le message vue unique',
                            '2️⃣  Appuie sur ↩️ *Répondre*',
                            '3️⃣  Tape *.save*',
                        ].join('\n')
                    });
                }

                const buffer = await downloadMedia(found.mediaMessage, found.mediaType);
                await sock.sendMessage(myJid, {
                    [found.mediaType]: buffer,
                    caption: '👻 *Artefact spectral capturé — PHANTOM BOT* ⚡'
                });

                try {
                    const saveAnimPath = path.join(__dirname, 'img', 'save_anim.mp4');
                    if (fs.existsSync(saveAnimPath)) {
                        await sock.sendMessage(from, {
                            video: fs.readFileSync(saveAnimPath),
                            caption: '👀 *Cible acquise !*\n_L\'artefact a été sécurisé dans la Ghost Zone._ 👻',
                            gifPlayback: true
                        });
                    } else {
                        await sock.sendMessage(from, { text: '👀 *Cible acquise !*\n_L\'artefact a été sécurisé dans la Ghost Zone._ 👻' });
                    }
                } catch (_) {}

                break;
            }
            // -- TTS --
            case 'tts': {
                // Récupère le texte depuis la commande ou depuis le message cité.
                const quotedForTts = msg.message && msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo && msg.message.extendedTextMessage.contextInfo.quotedMessage;
                const getQuotedText = (quoted) => {
                    if (!quoted || typeof quoted !== 'object') return '';
                    if (quoted.ephemeralMessage) return getQuotedText(quoted.ephemeralMessage.message);
                    if (quoted.viewOnceMessageV2) return getQuotedText(quoted.viewOnceMessageV2.message);
                    return quoted.conversation
                        || quoted.extendedTextMessage?.text
                        || quoted.imageMessage?.caption
                        || quoted.videoMessage?.caption
                        || quoted.documentMessage?.caption
                        || '';
                };
                const ttsText = String(query || getQuotedText(quotedForTts)).trim();

                if (!ttsText) return sock.sendMessage(from, {
                    text: [
                        '🎙️ *Texte manquant !*',
                        'Usage : *.tts <texte>*',
                        '_Ou reponds a un message texte avec_ *.tts*'
                    ].join('\n')
                });
                await sock.sendMessage(from, { text: '🎙️ _Phantom synthétise la voix..._' });
                try {
                    // StreamElements renvoie désormais 401 sans authentification.
                    // Google Translate TTS ne demande pas de clé pour cette synthèse.
                    const ttsRes = await axios.get('https://translate.google.com/translate_tts', {
                        params: {
                            ie: 'UTF-8',
                            client: 'tw-ob',
                            tl: 'fr',
                            q: ttsText.slice(0, 200)
                        },
                        responseType: 'arraybuffer',
                        timeout: 30000,
                        headers: {
                            'User-Agent': 'Mozilla/5.0',
                            Referer: 'https://translate.google.com/'
                        }
                    });
                    if (!ttsRes.data || !ttsRes.data.byteLength) throw new Error('réponse audio vide');
                    await sock.sendMessage(from, { audio: Buffer.from(ttsRes.data), mimetype: 'audio/mpeg', ptt: false });
                } catch (ttsErr) {
                    console.error('[TTS ERROR]', ttsErr.message);
                    await sock.sendMessage(from, { text: '💀 _TTS impossible :_ ' + ttsErr.message });
                }
                break;
            }

            // -- STT --
            case 'stt': {
                const quotedForStt = msg.message && msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo && msg.message.extendedTextMessage.contextInfo.quotedMessage;
                const audioMsg = (msg.message && msg.message.audioMessage) || (quotedForStt && quotedForStt.audioMessage);
                if (!audioMsg) return sock.sendMessage(from, { text: '🎤 *Aucun vocal trouvé !*\n\n💡 Réponds à un message vocal avec *.stt*' });
                await sock.sendMessage(from, { text: '🎤 _Phantom transcrit le vocal..._' });
                try {
                    const apiContent = fs.readFileSync(path.join(__dirname, 'api.txt'), 'utf8');
                    const groqMatch = apiContent.match(/groq\s+api\s*:\s*(.+)/i);
                    if (!groqMatch) throw new Error('Clé Groq introuvable dans api.txt');
                    const groqKey = groqMatch[1].trim();
                    const audioBuffer = await downloadMedia(audioMsg, 'audio');
                    const os2 = require('os');
                    const tmpAudio = path.join(os2.tmpdir(), 'phantom_stt_' + Date.now() + '.ogg');
                    fs.writeFileSync(tmpAudio, audioBuffer);
                    const FormData = require('form-data');
                    const form = new FormData();
                    form.append('file', fs.createReadStream(tmpAudio), { filename: 'audio.ogg', contentType: 'audio/ogg' });
                    form.append('model', 'whisper-large-v3');
                    const sttHeaders = Object.assign({}, form.getHeaders(), { 'Authorization': 'Bearer ' + groqKey });
                    const sttRes = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, { headers: sttHeaders, timeout: 60000 });
                    try { fs.unlinkSync(tmpAudio); } catch (_) {}
                    const transcription = sttRes.data && sttRes.data.text && sttRes.data.text.trim();
                    if (!transcription) throw new Error('Transcription vide.');
                    await sock.sendMessage(from, { text: '🎤 *Transcription :*\n\n_' + transcription + '_\n\n👻 _Phantom Bot_ ⚡' });
                } catch (sttErr) {
                    console.error('[STT ERROR]', sttErr.message);
                    await sock.sendMessage(from, { text: '💀 _Transcription impossible :_ ' + sttErr.message });
                }
                break;
            }

            // ── IMG ──────────────────────────────────────────────────────
            case 'img': {
                if (!query) return sock.sendMessage(from, {
                    text: [
                        '🎨 *Prompt manquant !*',
                        'Usage : *.img <description>*',
                        '',
                        '_Exemples :_',
                        '➜ .img un chat astronaute dans l\'espace',
                        '➜ .img paysage cyberpunk au coucher du soleil',
                        '➜ .img portrait d\'un samouraï fantôme',
                    ].join('\n')
                });

                await sock.sendMessage(from, { text: '🎨 _Phantom invoque l\'image depuis le Ghost Zone..._' });

                try {
                    const apiContent = fs.readFileSync(path.join(__dirname, 'api.txt'), 'utf8');
                    const nvidiaMatch = apiContent.match(/^\s*nvidia\s+api\s*:\s*(.+)\s*$/im);
                    if (!nvidiaMatch) throw new Error('Clé NVIDIA introuvable dans api.txt');

                    let translatedPrompt = query;
                    try {
                        const groqMatch = apiContent.match(/^\s*groq\s+api\s*:\s*(.+)\s*$/im);
                        if (groqMatch) {
                            const enhancement = await axios.post(
                                'https://api.groq.com/openai/v1/chat/completions',
                                {
                                    model: 'llama3-8b-8192',
                                    temperature: 0.1,
                                    messages: [
                                        {
                                            role: 'system',
                                            content: 'Rewrite the user request as a detailed English image-generation prompt. Preserve every named person, object, action and requested visual style exactly. For public figures and fictional characters, add recognizable canonical facial features, hairstyle, outfit and identifying traits while keeping their names. Use the canonical art style of fictional characters unless another style is requested. Make the requested action visibly explicit and central. If it is a fight, show a dynamic action battle with both characters attacking or defending; never make them merely stand facing each other. Reply with only the English prompt.'
                                        },
                                        { role: 'user', content: query }
                                    ]
                                },
                                {
                                    timeout: 30000,
                                    headers: {
                                        Authorization: `Bearer ${groqMatch[1].trim()}`,
                                        'Content-Type': 'application/json'
                                    }
                                }
                            );
                            const translated = enhancement.data?.choices?.[0]?.message?.content?.trim();
                            if (translated) translatedPrompt = translated;
                        }
                    } catch (_) { }

                    const imagePrompt = [
                        `Create exactly this scene: ${translatedPrompt}.`,
                        'Clearly show the precise requested action and every named person.',
                        'Do not replace the requested action with an unrelated activity or a simple portrait.',
                        'Preserve any requested artistic style; otherwise use high-quality photorealistic editorial photography, coherent composition and natural lighting.'
                    ].join(' ');

                    let imgBuffer;
                    let usedFallback = false;
                    try {
                        const imgResponse = await axios.post(
                            'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev',
                            {
                                prompt: imagePrompt,
                                width: 1024,
                                height: 1024,
                                cfg_scale: 5,
                                mode: 'base',
                                samples: 1,
                                seed: Math.floor(Math.random() * 2147483647),
                                steps: 30
                            },
                            {
                                timeout: 120000,
                                headers: {
                                    Authorization: `Bearer ${nvidiaMatch[1].trim()}`,
                                    Accept: 'application/json',
                                    'Content-Type': 'application/json'
                                }
                            }
                        );

                        const artifact = imgResponse.data?.artifacts?.[0];
                        if (artifact?.finishReason === 'CONTENT_FILTERED') {
                            throw new Error('CONTENT_FILTERED');
                        }
                        const imageBase64 = artifact?.base64;
                        if (!imageBase64) throw new Error('réponse image NVIDIA invalide');
                        imgBuffer = Buffer.from(imageBase64, 'base64');
                    } catch (fallbackErr) {
                        console.log(`[IMG] NVIDIA a échoué (${fallbackErr.message}), basculement sur Pollinations...`);
                        usedFallback = true;
                        const pollRes = await axios.get(`https://image.pollinations.ai/prompt/${encodeURIComponent(imagePrompt)}?width=1024&height=1024&nologo=true`, { responseType: 'arraybuffer', timeout: 60000 });
                        imgBuffer = Buffer.from(pollRes.data);
                    }
                    await sock.sendMessage(from, {
                        image: imgBuffer,
                        mimetype: 'image/jpeg',
                        caption: `🎨 *${query}*\n👻 _Généré par Phantom Bot_ ⚡`
                    });
                } catch (imgErr) {
                    console.error('[IMG ERROR]', imgErr.message);
                    await sock.sendMessage(from, {
                        text: [
                            '💀 _Génération impossible._',
                            '',
                            `⚠️ _Raison : ${imgErr.message}_`,
                            '',
                            '💡 *Essaie avec un prompt plus simple.*'
                        ].join('\n')
                    });
                }
                break;
            }

            // ── DEFAULT ──────────────────────────────────────────────────

            default:
                await sock.sendMessage(from, {
                    text: `👻 *Commande inconnue :* _${currentPrefix}${command}_\n⚡ Tape *${currentPrefix}help* pour voir le portail.`
                });
        }

    } catch (e) {
        console.error('💀 [PHANTOM ERROR]', e);
        try {
            if (from) await sock.sendMessage(from, { text: '⚠️ _Erreur spectrale :_ ' + e.message });
        } catch (_) { }
    }
};

