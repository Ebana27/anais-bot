require('dotenv').config();

const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
const http = require('node:http');
const crypto = require('node:crypto');
const { personality } = require('../personality');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error('Ajoute GEMINI_API_KEY dans le fichier .env');

const GROUP_ALLOWLIST = (process.env.WHATSAPP_GROUPS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const OWNER_NUMBER = (process.env.ANAIS_OWNER_NUMBER || '').replace(/\D/g, '');
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const MIN_DELAY = Math.max(0, Math.min(300, Number(process.env.MIN_REPLY_DELAY_MS || 300)));
const MAX_DELAY = Math.max(MIN_DELAY, Math.min(700, Number(process.env.MAX_REPLY_DELAY_MS || 700)));
const BATCH_WINDOW = Math.max(1800, Number(process.env.MESSAGE_BATCH_WINDOW_MS || 1800));
const MAX_BATCH_WAIT = 5000;
const AMBIENT_REPLY_CHANCE = Math.max(0.70, Math.min(1, Number(process.env.AMBIENT_REPLY_CHANCE || 0.70)));
const MIN_AMBIENT_GAP = Math.min(15000, Math.max(0, Number(process.env.MIN_AMBIENT_GAP_MS || 15000)));
const MAX_HISTORY = 8;
const histories = new Map();
const recentMessages = new Map();
const lastReplies = new Map();
const lastAmbient = new Map();
const activeGroupUntil = new Map();
const seen = new Set();
const pendingGroups = new Map();
const batchTimers = new Map();
const batchStartedAt = new Map();
const busyGroups = new Set();
let downloadMediaMessage;
let whatsappConnected = false;
let latestQrSvg = null;
const qrViewPassword = process.env.QR_VIEW_PASSWORD || '';

function makeQrSvg(value) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(value);
  qr.make();
  const quietZone = 4;
  const size = qr.getModuleCount();
  const path = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (qr.modules[row][col]) path.push(`M${col + quietZone},${row + quietZone}h1v1h-1z`);
    }
  }
  const viewSize = size + quietZone * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path.join('')}" fill="#000"/></svg>`;
}

function hasQrAccess(req) {
  if (!qrViewPassword) return false;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  let supplied;
  try { supplied = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const expected = Buffer.from(`anais:${qrViewPassword}`);
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const healthServer = http.createServer((req, res) => {
  if (req.url === '/qr') {
    if (!qrViewPassword) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Configure QR_VIEW_PASSWORD dans les variables du service.');
      return;
    }
    if (!hasQrAccess(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Anais WhatsApp QR", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Authentification requise.');
      return;
    }
    const qrMarkup = latestQrSvg || '<p>WhatsApp est déjà connecté ou aucun QR n’est en attente. Recharge cette page après un redémarrage.</p>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:;" });
    res.end(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QR WhatsApp Anaïs</title><style>body{font:16px system-ui,sans-serif;max-width:520px;margin:30px auto;padding:0 16px;text-align:center;color:#222}svg{width:min(88vw,430px);height:auto;border:12px solid white;box-shadow:0 1px 8px #999}p{line-height:1.5}</style><h1>Connexion WhatsApp</h1>${qrMarkup}<p>Scanne ce code depuis WhatsApp → Appareils connectés → Connecter un appareil. Ne partage pas cette page ni le QR.</p><p>Si le code expire, recharge la page.</p></html>`);
    return;
  }
  if (req.url !== '/health') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ service: 'anais-bot', whatsapp: whatsappConnected ? 'connected' : 'connecting' }));
});
healthServer.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => {
  console.log(`Serveur de santé actif sur le port ${process.env.PORT || 3000}.`);
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const sentGreetingSlots = new Set();
const sentPrivateDates = new Set();
let greetingScheduler = null;

function brazzavilleClock() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Brazzaville', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function scheduledGreeting(hour) {
  const greetings = hour === 9
    ? ['Salut mes bestioles, vous êtes déjà réveillés ou je repasse après le café ?', 'Bonjour la team, qui est opérationnel ce matin ?', 'Coucou les bestioles, racontez-moi un peu votre programme.']
    : ['Pause de midi, vous mangez quoi ?', 'Salut mes bestioles, vous avez survécu à la matinée ?', 'Midi est là… qui a déjà faim ?'];
  return greetings[rand(0, greetings.length - 1)];
}

async function sendScheduledMessages(sock) {
  if (!whatsappConnected) return;
  const clock = brazzavilleClock();
  const hour = Number(clock.hour);
  const minute = Number(clock.minute);
  const date = clock.year + '-' + clock.month + '-' + clock.day;
  const dueHours = [9, 12].filter((target) => hour === target && minute <= 4 && !sentGreetingSlots.has(date + '-' + target));
  const privateDue = hour === 12 && minute <= 4 && !sentPrivateDates.has(date);
  if (!dueHours.length && !privateDue) return;

  let groups;
  try { groups = await sock.groupFetchAllParticipating(); }
  catch (error) { console.error('Envois programmés ignorés : impossible de lire les groupes.', error.message); return; }
  const groupIds = Object.keys(groups || {}).filter((id) => !GROUP_ALLOWLIST.length || GROUP_ALLOWLIST.includes(id));

  for (const target of dueHours) {
    sentGreetingSlots.add(date + '-' + target);
    const greeting = scheduledGreeting(target);
    for (const groupId of groupIds) {
      try {
        await sock.sendMessage(groupId, { text: greeting });
        console.log('Salutation programmée envoyée dans un groupe à ' + target + ' h (heure de Brazzaville).');
        await wait(500);
      } catch (error) { console.error('Salutation programmée non envoyée :', error.message); }
    }
  }

  if (privateDue) {
    const ownIds = new Set([sock.user?.id, sock.user?.lid].filter(Boolean).map((id) => id.split(':')[0]));
    const recipients = new Set();
    for (const groupId of groupIds) {
      for (const participant of groups[groupId]?.participants || []) {
        const jid = participant.id || participant.phoneNumber || participant.lid;
        if (jid && !ownIds.has(jid.split(':')[0])) recipients.add(jid);
      }
    }
    const privateGreetings = [
      'Salut, j’espère que ta journée se passe bien. Tu racontes quoi ?',
      'Coucou, petite pause pour te demander comment tu vas 🙂',
      'Hey, tu tiens le coup aujourd’hui ?',
    ];
    let sentCount = 0;
    for (const jid of recipients) {
      try {
        await sock.sendMessage(jid, { text: privateGreetings[rand(0, privateGreetings.length - 1)] });
        sentCount += 1;
        await wait(900);
      } catch (error) { console.error('Message privé programmé non envoyé :', error.message); }
    }
    sentPrivateDates.add(date);
    console.log('Messages privés programmés envoyés : ' + sentCount + ' membre(s), au plus une fois aujourd’hui.');
  }
}

function startGreetingScheduler(sock) {
  if (greetingScheduler) clearInterval(greetingScheduler);
  greetingScheduler = setInterval(() => {
    sendScheduledMessages(sock).catch((error) => console.error('Erreur du planificateur :', error.message));
  }, 30000);
  sendScheduledMessages(sock).catch((error) => console.error('Erreur du planificateur :', error.message));
}

function messageText(message) {
  const m = message?.ephemeralMessage?.message || message?.viewOnceMessage?.message || message;
  return m?.conversation || m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption || m?.videoMessage?.caption || '';
}

async function generateImage(prompt) {
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    throw new Error('La génération d’image n’est pas configurée.');
  }
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt: prompt.slice(0, 1800), steps: 4 }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.success || !result.result?.image) {
    throw new Error(result.errors?.[0]?.message || `Cloudflare AI ${response.status}`);
  }
  return Buffer.from(result.result.image, 'base64');
}

function imagePromptOf(text) {
  const match = text.match(/^\/image\s+([\s\S]{3,1800})$/i);
  return match?.[1]?.trim() || null;
}

async function mediaPart(sock, msg) {
  const message = msg.message?.ephemeralMessage?.message || msg.message?.viewOnceMessage?.message || msg.message;
  const media = message?.imageMessage || message?.audioMessage;
  if (!media) return null;
  const mimeType = media.mimetype || (message.imageMessage ? 'image/jpeg' : 'audio/ogg');
  if (!mimeType.startsWith('image/') && !mimeType.startsWith('audio/')) return null;
  const downloadable = { ...msg, message };
  const buffer = await downloadMediaMessage(downloadable, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
  if (buffer.length > 10 * 1024 * 1024) throw new Error('Média ignoré : fichier trop volumineux (limite 10 Mo).');
  return { inline_data: { mime_type: mimeType, data: Buffer.from(buffer).toString('base64') } };
}

function wasAddressed(sock, msg, text) {
  const myIds = new Set([sock.user?.id, sock.user?.lid].filter(Boolean).map((id) => id.split(':')[0]));
  const content = msg.message?.ephemeralMessage?.message || msg.message?.viewOnceMessage?.message || msg.message;
  const context = content?.extendedTextMessage?.contextInfo || content?.imageMessage?.contextInfo || content?.audioMessage?.contextInfo;
  const mentioned = context?.mentionedJid || [];
  const quoted = context?.participant;
  const normalizedText = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const nameTokens = normalizedText.match(/[a-z]+/g) || [];
  const fuzzyName = nameTokens.some((token) => ['anais', 'anaiss', 'anai', 'anis', 'anais'].includes(token));
  return mentioned.some((id) => myIds.has(id.split(':')[0])) || myIds.has(quoted?.split(':')[0]) ||
    fuzzyName || /(^|[^a-z0-9])@(all|tous|toutlemonde)\b/.test(normalizedText);
}

function getHistory(chatId) {
  if (!histories.has(chatId)) histories.set(chatId, []);
  return histories.get(chatId);
}

async function answer(text, speaker, chatId, quotedText, media, chatType, isOwner = false) {
  const history = getHistory(chatId);
  const recent = recentMessages.get(chatId) || [];
  const channel = chatType === 'private' ? 'conversation privée entre toi et une seule personne' : 'groupe WhatsApp avec plusieurs participants';
  const context = 'Contexte du canal (' + channel + '). Voici les ' + recent.length + ' messages récents, du plus ancien au plus récent. Les heures aident à repérer les rafales et les pauses. Regroupe les messages rapprochés comme une seule pensée, distingue les participants, réponds au dernier point important et évite de répondre séparément à chaque ligne. Appuie-toi aussi sur l’historique pour garder le fil.\n' + (recent.map((m) => '[' + (m.time || '--:--') + '] ' + m.name + ': ' + m.text).join('\n') || '(aucun)');
  const assistantGuidance = isOwner && chatType === 'private'
    ? '\n\nQuand neocodex te demande de l’aide en privé, sois aussi son assistante : il étudie le Génie informatique, aide-le pour la programmation, ses projets et ses études, ainsi que pour l’organisation, la rédaction et les explications. Ta propre spécialité d’études reste la GRH. Réponds clairement et de façon utile, tout en gardant ton ton naturel. Si une information manque, pose une seule question précise. Ne prétends pas avoir effectué une action extérieure à WhatsApp et ne promets pas de rappels que le bot ne sait pas programmer.'
    : '';
  const contents = [
    ...history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      { role: 'user', parts: [{ text: `${context}\n\nTu réponds à ${speaker}${quotedText ? ` qui répond à : « ${quotedText} »` : ''}. Message : ${text || 'Regarde ou écoute le média envoyé.'}` }, ...(media ? [media] : [])] },
  ];
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: personality + assistantGuidance }] },
      contents,
      generationConfig: { temperature: 0.9, maxOutputTokens: 120 },
    }),
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    const message = details.error?.message || response.statusText;
    throw new Error(`Gemini API ${response.status}: ${message}`);
  }
  const result = await response.json();
  const reply = result.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim();
  if (!reply) return null;
  history.push({ role: 'user', content: `${speaker} : ${text}` }, { role: 'assistant', content: reply });
  if (history.length > MAX_HISTORY * 2) history.splice(0, history.length - MAX_HISTORY * 2);
  return reply;
}

function quotedTextOf(msg) {
  const content = msg.message?.ephemeralMessage?.message || msg.message?.viewOnceMessage?.message || msg.message;
  const context = content?.extendedTextMessage?.contextInfo || content?.imageMessage?.contextInfo || content?.audioMessage?.contextInfo;
  return messageText(context?.quotedMessage);
}

function importance(item) {
  let score = item.addressed ? 100 : 0;
  const text = item.text.trim();
  if (text.length >= 8) score += 1;
  if (text.length >= 25) score += 2;
  if (text.includes('?') || text.includes('？')) score += 5;
  if (/\b(aide|urgent|important|besoin|probl[eè]me|svp|s'il te plaît|qui peut|comment|pourquoi)\b/i.test(text)) score += 3;
  if (item.media) score += 2;
  return score;
}

async function processBatch(sock, chatId) {
  batchTimers.delete(chatId);
  const batch = pendingGroups.get(chatId) || [];
  pendingGroups.delete(chatId);
  batchStartedAt.delete(chatId);
  if (!batch.length) return;
  console.log(`Lot fermé : ${batch.length} message(s), ${batch.filter((item) => item.addressed).length} interpellation(s).`);
  if (busyGroups.has(chatId)) {
    pendingGroups.set(chatId, batch.concat(pendingGroups.get(chatId) || []));
    if (!batchStartedAt.has(chatId)) batchStartedAt.set(chatId, Date.now() - MAX_BATCH_WAIT);
    batchTimers.set(chatId, setTimeout(() => processBatch(sock, chatId).catch(console.error), 300));
    return;
  }

  const directed = batch.filter((item) => item.addressed);
  let chosen;
  let spontaneous = false;
  if (directed.length) {
    chosen = directed.reduce((best, item) => importance(item) >= importance(best) ? item : best);
    activeGroupUntil.set(chatId, Date.now() + 5 * 60 * 1000);
    console.log('Anaïs reste attentive à ce groupe pendant les prochaines minutes.');
  } else {
    const substantive = batch.filter((item) => importance(item) >= 1);
    if (!substantive.length) {
      console.log('Aucune réponse : aucun message assez pertinent dans ce lot.');
      return;
    }
    if (Date.now() - (lastAmbient.get(chatId) || 0) < MIN_AMBIENT_GAP) {
      console.log('Aucune réponse spontanée : délai minimal entre interventions pas encore écoulé.');
      return;
    }
    const followUp = Date.now() < (activeGroupUntil.get(chatId) || 0);
    if (!followUp && Math.random() > AMBIENT_REPLY_CHANCE) {
      console.log('Aucune réponse spontanée choisie pour ce lot.');
      return;
    }
    chosen = substantive.reduce((best, item) => importance(item) >= importance(best) ? item : best);
    spontaneous = true;
  }

  const delay = rand(MIN_DELAY, MAX_DELAY);
  console.log(`Anaïs prépare une réponse ${spontaneous ? 'spontanée' : 'à une interpellation'} (${delay} ms).`);
  busyGroups.add(chatId);
  try {
    const media = await mediaPart(sock, chosen.msg);
    const isOwner = Boolean(OWNER_NUMBER && chosen.senderNumber.endsWith(OWNER_NUMBER));
    const isPrivateChat = chatId.endsWith('@s.whatsapp.net') || chatId.endsWith('@lid');
    const imagePrompt = isOwner && isPrivateChat ? imagePromptOf(chosen.text) : null;
    const speaker = isOwner ? 'Mon chéri' : chosen.name;
    await wait(delay);
    if (imagePrompt) {
      console.log('Anaïs prépare une image avec Cloudflare AI…');
      const image = await generateImage(imagePrompt);
      await sock.sendMessage(chatId, { image, caption: 'Voilà 😊' }, { quoted: chosen.msg });
      console.log('Image générée et envoyée.');
      return;
    }
    const promptText = spontaneous
      ? `Rebondis naturellement sur ce message, comme si tu lançais la conversation. Tu peux demander à ${chosen.name} comment ça va ou poser une petite question. Message : ${chosen.text || '[média partagé]'}`
      : chosen.text;
    const chatType = chatId.endsWith('@g.us') ? 'group' : 'private';
    const reply = await answer(promptText, speaker, chatId, chosen.quotedText, media, chatType, isOwner);
    if (!reply) {
      console.log('Gemini n’a fourni aucune réponse ; Anaïs reste silencieuse.');
      return;
    }
    console.log('Réponse générée ; envoi à WhatsApp…');
    const mentionJid = spontaneous && chosen.mentionJid;
    const outgoingText = mentionJid ? `@${mentionJid.split('@')[0]} ${reply}` : reply;
    await sock.sendMessage(chatId, { text: outgoingText, ...(mentionJid ? { mentions: [mentionJid] } : {}) }, { quoted: chosen.msg });
    if (chatId.endsWith('@g.us')) lastAmbient.set(chatId, Date.now());
    console.log(`Réponse envoyée au groupe (${batch.length} message(s) regroupé(s)).`);
  } catch (error) {
    console.error('Erreur pendant la réponse ; Anaïs reste silencieuse :', error.message);
  } finally {
    busyGroups.delete(chatId);
    if (pendingGroups.get(chatId)?.length && !batchTimers.has(chatId)) {
      if (!batchStartedAt.has(chatId)) batchStartedAt.set(chatId, Date.now());
      const elapsed = Date.now() - batchStartedAt.get(chatId);
      const waitForQuiet = Math.max(0, Math.min(BATCH_WINDOW, MAX_BATCH_WAIT - elapsed));
      batchTimers.set(chatId, setTimeout(() => processBatch(sock, chatId).catch(console.error), waitForQuiet));
    }
  }
}

async function start() {
  const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage: downloader } = await import('baileys');
  downloadMediaMessage = downloader;
  const { state, saveCreds } = await useMultiFileAuthState(process.env.AUTH_DIR || './auth_info');
  const sock = makeWASocket({ auth: state, printQRInTerminal: false, markOnlineOnConnect: false });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      latestQrSvg = makeQrSvg(qr);
      console.log('Nouveau QR WhatsApp prêt sur la page protégée /qr.');
    }
    if (connection === 'open') {
      latestQrSvg = null;
      whatsappConnected = true;
      console.log('Anaïs est connectée à WhatsApp.');
      startGreetingScheduler(sock);
    }
    if (connection === 'close') {
      whatsappConnected = false;
      if (greetingScheduler) clearInterval(greetingScheduler);
      greetingScheduler = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) start().catch(console.error);
      else console.log('Session déconnectée. Supprime auth_info puis relance le bot pour scanner un nouveau QR.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`WhatsApp: ${messages.length} message(s) reçu(s), type=${type}`);
    if (type !== 'notify') return;
    for (const msg of messages) {
      const chatId = msg.key.remoteJid;
      const isGroup = chatId?.endsWith('@g.us');
      const isPrivate = chatId?.endsWith('@s.whatsapp.net') || chatId?.endsWith('@lid');
      if (!isGroup && !isPrivate) {
        console.log('WhatsApp: message ignoré (statut ou conversation non prise en charge).');
        continue;
      }
      if (msg.key.fromMe) {
        console.log('WhatsApp: message ignoré (envoyé depuis le compte d’Anaïs).');
        continue;
      }
      if (isGroup && GROUP_ALLOWLIST.length && !GROUP_ALLOWLIST.includes(chatId)) {
        console.log('WhatsApp: message ignoré (groupe absent de WHATSAPP_GROUPS).');
        continue;
      }
      const id = msg.key.id;
      if (seen.has(id)) continue;
      seen.add(id);
      if (seen.size > 500) seen.clear();

      const text = messageText(msg.message);
      const senderId = msg.key.participantAlt || msg.key.participant || msg.key.remoteJidAlt || chatId || '';
      const content = msg.message?.ephemeralMessage?.message || msg.message?.viewOnceMessage?.message || msg.message;
      const hasMedia = Boolean(content?.imageMessage || content?.audioMessage);
      if (!text.trim() && !hasMedia) continue;
      const recent = recentMessages.get(chatId) || [];
      const name = msg.pushName || senderId.split('@')[0] || 'Membre';
      const recentText = text || (content?.imageMessage ? '[photo envoyée]' : '[audio envoyé]');
      const messageSeconds = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);
      const time = new Date(messageSeconds * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Brazzaville' });
      recent.push({ name, text: recentText.slice(0, 500), time });
      if (recent.length > 20) recent.shift();
      recentMessages.set(chatId, recent);
      const addressed = isPrivate || wasAddressed(sock, msg, text);
      console.log(`Message de groupe détecté ; interpellation=${addressed} ; mise en lot.`);
      const senderNumber = senderId.split('@')[0].replace(/\D/g, '');
      const item = { msg, text, name, senderNumber, senderId, mentionJid: msg.key.participant || senderId, addressed, media: hasMedia, quotedText: quotedTextOf(msg) };
      if (!pendingGroups.has(chatId)) pendingGroups.set(chatId, []);
      if (!batchStartedAt.has(chatId)) batchStartedAt.set(chatId, Date.now());
      pendingGroups.get(chatId).push(item);
      if (batchTimers.has(chatId)) clearTimeout(batchTimers.get(chatId));
      const elapsed = Date.now() - batchStartedAt.get(chatId);
      const waitForQuiet = Math.max(0, Math.min(BATCH_WINDOW, MAX_BATCH_WAIT - elapsed));
      batchTimers.set(chatId, setTimeout(() => processBatch(sock, chatId).catch(console.error), waitForQuiet));
    }
  });
}

start().catch((error) => { console.error(error); process.exitCode = 1; });
