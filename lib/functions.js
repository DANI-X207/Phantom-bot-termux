const axios = require('axios');
const yts = require('yt-search');
const fs = require('fs');
const path = require('path');

// ── Lecture des clés API depuis api.txt (à la racine du projet) ───────────────
// Format attendu dans api.txt :
//   groq api: <clé>
//   gemini api: <clé>
//   nvidia api: <clé>
function loadApiKeys() {
    try {
        const apiPath = path.join(__dirname, '..', 'api.txt');
        const content = fs.readFileSync(apiPath, 'utf8');
        const keys = {};
        for (const line of content.split(/\r?\n/)) {
            const match = line.match(/^(\w+)\s+api\s*:\s*(.+)$/i);
            if (match) keys[match[1].toLowerCase()] = match[2].trim();
        }
        return keys;
    } catch (e) {
        console.error('[API] Impossible de lire api.txt :', e.message);
        return {};
    }
}

// Recharge les clés à chaque appel (si la clé change, pas besoin de redémarrer)
function getKey(provider) {
    const keys = loadApiKeys();
    return keys[provider] || process.env[`${provider.toUpperCase()}_API_KEY`] || null;
}

// ── Prompt système commun ─────────────────────────────────────────────────────
const SYSTEM_PROMPT = [
    'Tu es Phantom Bot, un assistant WhatsApp au style Danny Phantom.',
    'Réponds TOUJOURS en français, de façon COURTE et DIRECTE.',
    'Si c\'est une traduction : donne juste le mot + un exemple d\'utilisation.',
    'Si c\'est du code : donne un exemple court et fonctionnel.',
    'Si c\'est une définition ou un concept : explique en 2-3 phrases max.',
    'Pour les faits simples : une seule phrase suffit.',
    'N\'utilise pas de ** ni de ## ni de markdown complexe.',
    'Maximum 10 lignes de réponse.'
].join(' ');

// ── Configuration des modèles IA disponibles ─────────────────────────────────
const MODELS = [
    // Groq (7 modèles performants)
    { alias: 'g70',   provider: 'groq',   id: 'openai/gpt-oss-120b',             name: 'GPT-OSS 120B' },
    { alias: 'g8',    provider: 'groq',   id: 'openai/gpt-oss-20b',              name: 'GPT-OSS 20B' },
    { alias: 'g3_70', provider: 'groq',   id: 'qwen/qwen3.6-27b',                name: 'Qwen 3.6 27B' },
    { alias: 'g3_8',  provider: 'groq',   id: 'groq/compound-mini',              name: 'Groq Compound Mini' },
    { alias: 'gmix',  provider: 'groq',   id: 'groq/compound',                   name: 'Groq Compound' },

    // Gemini (4 modèles performants)
    { alias: 'gp',    provider: 'gemini', id: 'gemini-3.1-pro-preview',          name: 'Gemini 3.1 Pro Preview' },
    { alias: 'gf',    provider: 'gemini', id: 'gemini-3.6-flash',                name: 'Gemini 3.6 Flash' },
    { alias: 'gf8b',  provider: 'gemini', id: 'gemini-3.5-flash-lite',           name: 'Gemini 3.5 Flash-Lite' },
    { alias: 'g1p',   provider: 'gemini', id: 'gemini-flash-latest',             name: 'Gemini Flash Latest' },

    // Nvidia NIM (10 modèles performants)
    { alias: 'nv405', provider: 'nvidia', id: 'nvidia/nemotron-3-super-120b-a12b', name: 'Nemotron 3 Super 120B' },
    { alias: 'nv70',  provider: 'nvidia', id: 'nvidia/nemotron-3.5-lightning-30b-a3b', name: 'Nemotron 3.5 Lightning' }
];

// Détecte si une erreur est due à un quota / rate-limit épuisé
function isQuotaError(e) {
    const status = e.response?.status;
    const body = JSON.stringify(e.response?.data || '').toLowerCase();
    return (
        status === 429 || status === 413 ||
        body.includes('quota') ||
        body.includes('rate_limit') ||
        body.includes('rate limit') ||
        body.includes('resource_exhausted') ||
        body.includes('exceeded') ||
        body.includes('too_many_requests')
    );
}

// ── GROQ ─────────────────────────────────────────────────────────────────────
async function askGroq(messages, modelId = 'openai/gpt-oss-20b') {
    const key = getKey('groq');
    if (!key) throw new Error('NO_KEY');
    const { data } = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model: modelId, max_tokens: 500, messages },
        {
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            timeout: 15000
        }
    );
    return data?.choices?.[0]?.message?.content?.trim() || null;
}

// ── GEMINI ───────────────────────────────────────────────────────────────────
async function askGemini(messages, modelId = 'gemini-3.6-flash') {
    const key = getKey('gemini');
    if (!key) throw new Error('NO_KEY');
    const contents = messages
        .filter(m => m.role !== 'system')
        .map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
        }));
    // Injecte le system prompt dans le premier message user
    const systemMsg = messages.find(m => m.role === 'system');
    if (systemMsg && contents.length > 0 && contents[0].role === 'user') {
        contents[0].parts[0].text = systemMsg.content + '\n\n' + contents[0].parts[0].text;
    }
    const { data } = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${key}`,
        { contents },
        { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}

// ── NVIDIA NIM ───────────────────────────────────────────────────────────────
async function askNvidia(messages, modelId = 'nvidia/nemotron-3-super-120b-a12b') {
    const key = getKey('nvidia');
    if (!key) throw new Error('NO_KEY');
    const request = {
        model: modelId,
        max_tokens: 180,
        temperature: 0.2,
        stream: false,
        messages
    };
    if (modelId.startsWith('deepseek-ai/')) {
        request.reasoning_effort = 'none';
    } else {
        request.chat_template_kwargs = { enable_thinking: false };
    }
    const headers = {
        'Authorization': `Bearer ${key}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    };
    let response = await axios.post(
        'https://integrate.api.nvidia.com/v1/chat/completions',
        request,
        {
            headers,
            timeout: 60000,
            validateStatus: status => status === 200 || status === 202
        }
    );

    // Les modèles NVIDIA serverless peuvent répondre 202 avec un requestId.
    // Dans ce cas, l'API impose un polling de /v1/status/{requestId}.
    const requestId = response.data?.requestId || response.data?.request_id ||
        response.headers['nvcf-request-id'] || response.headers['nvcf-reqid'];
    for (let attempt = 0; response.status === 202 && requestId && attempt < 12; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        response = await axios.get(`https://integrate.api.nvidia.com/v1/status/${requestId}`, {
            headers,
            timeout: 20000,
            validateStatus: status => status === 200 || status === 202
        });
    }

    if (response.status === 202) throw new Error('NVIDIA n’a pas terminé la génération dans le délai imparti.');
    return response.data?.choices?.[0]?.message?.content?.trim() || null;
}

// ── Routeur IA avec fallback automatique ─────────────────────────────────────
// Retourne { text: string, modelName: string } ou null si tous ont échoué.
async function callModel(modelDef, messages) {
    switch (modelDef.provider) {
        case 'gemini': return await askGemini(messages, modelDef.id);
        case 'nvidia': return await askNvidia(messages, modelDef.id);
        default:       return await askGroq(messages, modelDef.id);
    }
}

async function askWithFallback(messages, startAlias = 'g8') {
    // Trouve l'index de départ
    const idx = MODELS.findIndex(m => m.alias === startAlias);
    let order = idx >= 0
        ? [...MODELS.slice(idx), ...MODELS.slice(0, idx)]
        : MODELS;

    // Un service NVIDIA indisponible ne doit pas bloquer le bot sur plusieurs
    // délais consécutifs : après le modèle demandé, Groq/Gemini prennent le relais.
    if (idx >= 0 && MODELS[idx].provider === 'nvidia') {
        order = [MODELS[idx]];
    }

    for (const model of order) {
        try {
            const text = await callModel(model, messages);
            if (text) return { text, modelName: model.name };
        } catch (e) {
            if (isQuotaError(e)) {
                console.warn(`[IA] Quota épuisé sur ${model.name}, bascule sur le suivant...`);
                continue;
            }
            console.error(`[IA] Erreur ${model.name} :`, e.response?.data || e.message);
            // Si erreur d'auth on essaie le prochain provider, mais simplifions : on continue le fallback sur erreur
            continue;
        }
    }
    return null; // tous les providers/modèles ont échoué
}

/**
 * Pose une question à l'IA avec fallback automatique.
 * @param {string} question
 * @param {string} [startAlias] alias préféré (ex: 'g8', 'gf')
 * @returns {Promise<{text: string, modelName: string}|null>}
 */
const askAI = async (question, startAlias = 'g8') => {
    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: question }
    ];
    return await askWithFallback(messages, startAlias);
};

/**
 * Envoie un historique de conversation à l'IA avec fallback automatique.
 * @param {Array<{role, content}>} history
 * @param {string} [startAlias]
 * @returns {Promise<{text: string, modelName: string}|null>}
 */
const askAIWithHistory = async (history, startAlias = 'g8') => {
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history];
    return await askWithFallback(messages, startAlias);
};

/**
 * Fallback DuckDuckGo si l'IA échoue.
 */
const duckSearch = async (query) => {
    try {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
        const { data } = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PhantomBot/2.0)' },
            timeout: 8000
        });

        const results = [];

        if (data.AbstractText && data.AbstractURL) {
            results.push({
                title: data.Heading || query,
                link: data.AbstractURL,
                snippet: data.AbstractText
            });
        }

        for (const topic of (data.RelatedTopics || [])) {
            if (results.length >= 3) break;
            if (topic.Text && topic.FirstURL) {
                results.push({ title: topic.Text.slice(0, 60), link: topic.FirstURL, snippet: topic.Text });
            }
            for (const sub of (topic.Topics || [])) {
                if (results.length >= 3) break;
                if (sub.Text && sub.FirstURL) {
                    results.push({ title: sub.Text.slice(0, 60), link: sub.FirstURL, snippet: sub.Text });
                }
            }
        }

        if (results.length === 0) {
            results.push({
                title: `Recherche : "${query}"`,
                link: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
                snippet: 'Voir les résultats complets en ligne.'
            });
        }

        return results;
    } catch (e) {
        console.error('[duckSearch] Erreur :', e.message);
        return null;
    }
};

/**
 * Recherche YouTube — retourne la première vidéo trouvée.
 */
const youtubeSearch = async (query) => {
    try {
        const result = await yts(query);
        const videos = result.videos;
        if (!videos?.length) return null;
        const v = videos[0];
        return {
            title: v.title,
            url: v.url,
            thumbnail: v.thumbnail,
            timestamp: v.timestamp,
            author: v.author?.name || 'Inconnu'
        };
    } catch (e) {
        console.error('[youtubeSearch] Erreur :', e.message);
        return null;
    }
};

module.exports = { askAI, askAIWithHistory, duckSearch, youtubeSearch, MODELS };
