const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { google } = require('googleapis');
google.options({ fetchImplementation: fetch });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('pino');

const spreadsheetId = process.env.SPREADSHEET_ID;
const geminiEnabled = process.env.GEMINI_CONVERSATION_ENABLED === 'true';

if (!spreadsheetId) {
  throw new Error('Configure SPREADSHEET_ID no ambiente antes de iniciar.');
}
if (geminiEnabled && !process.env.GEMINI_API_KEY) {
  throw new Error('GEMINI_CONVERSATION_ENABLED requer GEMINI_API_KEY.');
}
if (geminiEnabled && !process.env.CONFIG_SPREADSHEET_ID) {
  throw new Error('GEMINI_CONVERSATION_ENABLED requer CONFIG_SPREADSHEET_ID.');
}
if (geminiEnabled) {
  console.log('Gemini ativo em todos os grupos dos quais o bot participa; sessões isoladas por grupo.');
}

// ADC uses the VM's attached service account on Compute Engine.
// No downloaded service-account private key is needed.
const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });

const seenFile = path.join(__dirname, 'processed-message-ids.json');
const sessionsFile = path.join(__dirname, 'alignment-sessions.json');
const pendingFile = path.join(__dirname, 'pending-alignment.jsonl');
const failedAttachmentsDir = path.join(__dirname, 'failed-attachments');
let seenIds = new Set();
try {
  seenIds = new Set(JSON.parse(fs.readFileSync(seenFile, 'utf8')));
} catch {
  // Primeira execução: ainda não há IDs processados.
}

function saveSeenIds() {
  fs.writeFileSync(seenFile, JSON.stringify([...seenIds].slice(-10000), null, 2));
}

function appendPending(entry) {
  fs.appendFileSync(pendingFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
  fs.chmodSync(pendingFile, 0o600);
}

function archiveFailedAttachment(groupJid, messageId, mimeType, data) {
  if (!Buffer.isBuffer(data) || !data.length) return null;
  const key = crypto.createHash('sha256').update(`${groupJid}|${messageId || Date.now()}`).digest('hex').slice(0, 24);
  const extension = mimeType === 'application/pdf' ? '.pdf' : mimeType === 'image/png' ? '.png' :
    mimeType === 'image/webp' ? '.webp' : '.jpg';
  fs.mkdirSync(failedAttachmentsDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(failedAttachmentsDir, 0o700);
  const file = path.join(failedAttachmentsDir, key + extension);
  fs.writeFileSync(file, data, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return path.relative(__dirname, file);
}

function unwrapMessage(message) {
  let current = message;
  while (current?.ephemeralMessage?.message || current?.viewOnceMessage?.message ||
         current?.viewOnceMessageV2?.message || current?.documentWithCaptionMessage?.message) {
    current = current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.documentWithCaptionMessage?.message;
  }
  return current || {};
}

function getMessageText(message) {
  const content = unwrapMessage(message);
  return content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    '';
}

let alignmentTracker = null;
let gemini = null;
let activeSock = null;
let alignmentConfigPromise = null;
const groupTitleCache = new Map();
const {createConfirmations, parseCorrection} = require('./confirmations');
const confirmations = createConfirmations(path.join(__dirname, 'alignment-confirmations.json'));
if (geminiEnabled) {
  const { createTracker, fileStore, makeGeminiFunctions, verifyExtractions } = require('./gemini_conversation');
  const { loadAlignmentConfig } = require('./alignment_config');
  const history = require('./alignment_history');
  const store = fileStore(sessionsFile);
  // Suppress retroactive notices for sessions present before this process started.
  const startupSessions = store.load() || {};
  const baselineCounts = new Map(Object.entries(startupSessions).map(([group, session]) => [group + '|' + session.startedAt, (session.messages || []).length]));
  alignmentConfigPromise = loadAlignmentConfig(sheets, process.env.CONFIG_SPREADSHEET_ID);
  gemini = makeGeminiFunctions({
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
    config: alignmentConfigPromise,
    getRecordSchema: () => history.getRecordSchema(sheets, spreadsheetId),
    onExtract: async (session, reason, extraction, transcript) => {
      const checkedRecords = verifyExtractions(extraction, transcript);
      const recorded = new Set();
      let written = 0;
      let pending = 0;
      for (const checked of checkedRecords) {
        if (!checked.ok) {
          pending += 1;
          appendPending({ groupJid: session.group, startedAt: session.startedAt,
            closedAt: new Date().toISOString(), reason: checked.reason, messages: session.messages });
          console.log('Alinhamento mantido para revisão:', checked.reason);
          continue;
        }
        const equipmentKey = String(checked.equipment).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .toLowerCase().replace(/\b(?:diesel generator|diesel gerador|gerador diesel|grupo gerador|genset)\s*#?\s*(\d+)\b/g, 'dg$1')
          .replace(/\bdg\s*#?\s*(\d+)\b/g, 'dg$1').replace(/[^a-z0-9]/g, '');
        if (recorded.has(equipmentKey)) {
          pending += 1;
          appendPending({ groupJid: session.group, startedAt: session.startedAt,
            reason: `equipamento duplicado na extração: ${checked.equipment}`, messages: session.messages });
          continue;
        }
        recorded.add(equipmentKey);
        const sessionId = crypto.createHash('sha256')
          .update(`${session.group}|${session.startedAt}|${equipmentKey}`).digest('hex').slice(0, 24);
        const fields = checked.fields || {};
        const result = await history.recordHistory(sheets, spreadsheetId, {
          vessel: checked.vessel, equipment: checked.equipment,
          class: fields['Equipment Class'], maker: fields.Maker, model: fields.Model,
          stationary_class: fields['Stationary Equipment Class'], stationary_maker: fields['Stationary Maker'],
          stationary_model: fields['Stationary Model'], document: fields.Document,
          date: fields.Data, motivation: fields.Motivacao, executor: fields.Executor, method: fields.Metodo,
          axial_vertical: fields['Axial vertical'], axial_horizontal: fields['Axial horizontal'],
          radial_vertical: fields['Radial vertical'], radial_horizontal: fields['Radial horizontal'],
          coupling_gap: fields['Coupling gap'], standard: fields['Padrão'],
          axial_tolerance: fields['Axial tolerance'], radial_tolerance: fields['Radial tolerance'],
          gap_tolerance: fields['Coupling gap tolerance'],
          observations: Object.entries(fields).filter(([key]) => /antes do ajuste|unidade das medições/i.test(key))
            .map(([key, value]) => `${key}: ${value}`).join('; ')
        }, sessionId);
        if (['appended', 'updated', 'duplicate', 'conflict', 'unchanged'].includes(result.status)) written += 1;
        const identityNeedsClarification = checked.vessel === 'não informado' || checked.equipment === 'não informado';
        if (!['appended', 'updated', 'duplicate', 'unchanged'].includes(result.status) || identityNeedsClarification) {
          appendPending({ groupJid: session.group, startedAt: session.startedAt,
            closedAt: new Date().toISOString(), equipment: checked.equipment,
            reason: identityNeedsClarification
              ? { message: 'Embarcação ou equipamento não puderam ser associados com segurança; linha registrada com não informado.', result }
              : result, messages: session.messages });
        }
        if (activeSock && !identityNeedsClarification && session.messages.length > (baselineCounts.get(session.group + '|' + session.startedAt) || 0) && ['appended','updated','conflict'].includes(result.status)) {
          try {
            const current = await history.findSession(sheets, spreadsheetId, sessionId);
            const shown = {};
            for (const [key,col] of Object.entries(current.cols)) {
              if (key === 'comments' || key.startsWith('stationary_')) continue;
              const value = current.row[col];
              if (value && String(value).toLowerCase() !== 'não informado') shown[current.headers[col]] = String(value);
            }
            const conflicts = [];
            if (checkedRecords.length === 1) for (const msg of session.messages) {
              for (const line of String(msg.text || '').split('\n')) if (line.startsWith('DIVERGENCIA_MEDICAO: ')) {
                try { conflicts.push(JSON.parse(line.slice('DIVERGENCIA_MEDICAO: '.length))); } catch {}
              }
            }
            const prompt = confirmations.prepare(session.group, sessionId, checked.vessel, checked.equipment, shown, conflicts);
            if (prompt) {
              const sent = await activeSock.sendMessage(session.group, {text:prompt.text});
              if (!sent?.key?.id) throw new Error('Mensagem sem identificador');
              confirmations.sent(prompt.key, sent.key.id);
            }
          } catch (error) { appendPending({groupJid:session.group, sessionId, reason:'confirmação não enviada ou pendente de revisão: '+error.message}); }
        }
        console.log('Registro de alinhamento:', checked.equipment, result.status);
      }
      return {written, pending};
    }
  });

  alignmentTracker = createTracker({
    detect: async (msg, context) => {
      try { return await gemini.detect(msg, context); }
      catch { console.error('Falha ao identificar atividade com Gemini.'); return false; }
    },
    classify: async (previous, current) => {
      try {
        return await gemini.classify(previous, current);
      } catch (error) {
    console.error('Falha de classificação Gemini; mantendo mensagem pendente.');
        return 'uncertain';
      }
    },
    // Monitoramento silencioso; dados são sincronizados periodicamente.
    onMessage: async () => {},
    onTick: async (session) => {
      try { await gemini.finish(session, 'sincronização periódica'); return true; }
      catch (error) { console.error('Falha ao sincronizar dados de alinhamento:', error.message); return false; }
    },
    finish: async (session, reason) => {
      try {
        await gemini.finish(session, reason);
      } catch (error) {
        appendPending({
          groupJid: session.group,
          startedAt: session.startedAt,
          closedAt: new Date().toISOString(),
          reason: 'falha ao finalizar com Gemini',
          messages: session.messages
        });
        console.error('Sessão salva para revisão após falha do Gemini.');
      }
    },
    save: (state) => store.save(state),
    load: () => store.load(),
    timeoutMs: Number.MAX_SAFE_INTEGER,
    maxMessages: 5000
  });

  setInterval(() => {
    alignmentTracker.tick().catch((error) => {
      console.error('Falha ao sincronizar sessões de alinhamento:', error.message);
    });
  }, 5 * 60 * 1000).unref();
}

async function handleMessage(sock, msg) {
  const groupJid = msg.key.remoteJid || '';
  if (!groupJid.endsWith('@g.us') || msg.key.fromMe) return;

  let text = getMessageText(msg.message).trim();
  const content = unwrapMessage(msg.message);
  const image = content.imageMessage;
  const document = content.documentMessage;
  const attachment = image || document;
  if (!text && !attachment) return;

  const messageId = msg.key.id;
  if (messageId && seenIds.has(messageId)) return;

  if (!attachment && /\b(?:relat[oó]rio|report)\b/i.test(text)) {
    console.log('Mensagem sobre relatório sem anexo reconhecido:', groupJid, messageId);
  }

  if (geminiEnabled) {
    const contextInfo = content.extendedTextMessage?.contextInfo || content.imageMessage?.contextInfo || content.documentMessage?.contextInfo;
    const confirmation = contextInfo?.stanzaId && confirmations.lookup(groupJid, contextInfo.stanzaId);
    if (confirmation) {
      const [key, entry] = confirmation;
      let corrections = parseCorrection(text);
      const numericReply = text.trim().match(/^([+-]?\d+(?:[.,]\d+)?)\s*(?:mm)?[.!]?$/i);
      if (!corrections.length && numericReply && entry.conflicts.length === 1) {
        const key = entry.conflicts[0].field.toLowerCase().replace(/\s+/g, '_');
        if (['axial_vertical','axial_horizontal','radial_vertical','radial_horizontal'].includes(key)) corrections = [{key, value:numericReply[1].replace(',', '.') + ' mm'}];
      }
      if (corrections.length) {
        const required = entry.conflicts.map(c => c.field.toLowerCase().replace(/\s+/g, '_'));
        if (required.some(field => !corrections.some(c => c.key === field))) { appendPending({groupJid, messageId, reason:'resposta não resolveu todas as divergências'}); return; }
        if (new Set(corrections.map(x=>x.key)).size !== corrections.length) {
          appendPending({groupJid, messageId, reason:'resposta com medições duplicadas'}); return;
        }
        await require('./alignment_history').correctSession(sheets, spreadsheetId, entry.sessionId, corrections);
        confirmations.done(key, messageId);
        if (messageId) { seenIds.add(messageId); saveSeenIds(); }
      } else if (/^(?:sim|correto|corretos|confirmo|confirmado|ok|certo)[.!\s]*$/i.test(text)) {
        if (entry.conflicts.length) { appendPending({groupJid, messageId, reason:'confirmação genérica com divergência pendente'}); return; }
        confirmations.done(key, messageId);
        if (messageId) { seenIds.add(messageId); saveSeenIds(); }
      } else appendPending({groupJid, messageId, reason:'resposta de confirmação não reconhecida'});
      return;
    }
    let groupName = groupTitleCache.get(groupJid)?.name || '';
    if (!groupName || Date.now() - groupTitleCache.get(groupJid).time > 60 * 60 * 1000) {
      try {
        groupName = (await sock.groupMetadata(groupJid)).subject || '';
        groupTitleCache.set(groupJid, { name: groupName, time: Date.now() });
      } catch { /* nome do grupo pode não estar disponível temporariamente */ }
    }
    if (attachment) {
      const mimeType = image?.mimetype || document?.mimetype || '';
      const fileName = document?.fileName || '';
      console.log('Anexo recebido:', groupJid, messageId, mimeType, fileName);
      if (!/^image\/(jpeg|png|webp)$|^application\/pdf$/i.test(mimeType)) {
        appendPending({ messageId, groupJid, groupName, fileName, mimeType, reason: 'formato de anexo não suportado' });
        text += `\n[Anexo ${fileName || mimeType || 'não identificado'}: formato não suportado para leitura]`;
      } else {
        let data;
        try {
          data = await downloadMediaMessage(msg, 'buffer', {}, { logger: P({ level: 'silent' }) });
          if (data.length > 20 * 1024 * 1024) throw new Error('Anexo excede 20 MB');
          const summary = await gemini.inspectAttachment({ caption: text, groupName, fileName, mimeType, data });
          if (image && /\b(?:axial|radial)\s+(?:vertical|horizontal)\s*:\s*[+-]?\d/i.test(text)) {
            const originalCaption = text;
            const labels = [...originalCaption.matchAll(/\b(axial|radial)\s+(vertical|horizontal)\s*:\s*([+-]?\d+(?:[.,]\d+)?)/gi)];
            const safeSummary = String(summary || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
            for (const item of labels) {
              const field = (item[1] + ' ' + item[2]).toLowerCase();
              const value = item[3];
              if (!safeSummary.includes(field + ': ' + value.toLowerCase() + ' mm')) {
                appendPending({ messageId, groupJid, groupName, reason: 'medição da legenda sem confirmação visual', field, value });
              }
            }
            text = text.replace(/\b(axial|radial)\s+(vertical|horizontal)\s*:\s*[+-]?\d+(?:[.,]\d+)?(?:\s*mm)?/gi,
              '$1 $2: verificação visual no resumo do anexo');
          }
          if (!summary) {
            const savedAs = archiveFailedAttachment(groupJid, messageId, mimeType, data);
            appendPending({ messageId, groupJid, groupName, fileName, mimeType, savedAs,
              reason: 'Gemini retornou resumo vazio para o anexo' });
            console.error('Anexo sem dados extraídos:', groupJid, messageId, mimeType);
            if (!text) return;
          } else {
            console.log('Anexo interpretado:', groupJid, messageId, summary.length);
            text = [text, `Conteúdo lido do anexo: ${summary}`].filter(Boolean).join('\n');
          }
        } catch (error) {
          let savedAs = null;
          try { if (data?.length <= 20 * 1024 * 1024) savedAs = archiveFailedAttachment(groupJid, messageId, mimeType, data); }
          catch (archiveError) { console.error('Falha ao preservar anexo:', archiveError.message); }
          appendPending({ messageId, groupJid, groupName, fileName, mimeType, savedAs,
            reason: `não foi possível ler o anexo: ${error.message}` });
          console.error('Não foi possível ler um anexo da conversa:', error.message);
          return;
        }
      }
    }
    if (!text.trim()) return;
    const timestamp = msg.messageTimestamp
      ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
      : new Date().toISOString();
    const outcome = await alignmentTracker.process({
      group: groupJid,
      id: messageId || '',
      timestamp,
      sender: msg.pushName || '',
      groupName,
      text: groupName ? `[Grupo: ${groupName}]\n${text}` : text
    });
    if (outcome !== 'ignorada' && messageId) {
      seenIds.add(messageId);
      saveSeenIds();
    }
    if (outcome !== 'ignorada') console.log('Coleta de alinhamento:', outcome, groupJid);
    return;
  }

  if (/\b(?:alinhamento|alignment)\b/i.test(text)) {
    appendPending({ messageId, groupJid, text, reason: 'modo Gemini desativado; coleta conversacional indisponível' });
    console.log('Mensagem de alinhamento colocada para revisão; Gemini está desativado.');
  }
}

async function startBot() {
  if (geminiEnabled) await alignmentConfigPromise;
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    browser: ['Alignment Collector', 'Chrome', '1.0.0'],
    syncFullHistory: false
  });
  activeSock = sock;

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('Escaneie o QR Code com o WhatsApp que ficará conectado ao grupo:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') console.log(geminiEnabled
      ? 'Coletor conectado em modo silencioso.'
      : 'Coletor conectado em modo silencioso.');
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) setTimeout(startBot, 3000);
      else console.error('Sessão desconectada. Reinicie e escaneie um novo QR Code.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message) continue;
      try {
        await handleMessage(sock, msg);
      } catch (error) {
        console.error('Falha ao registrar mensagem:', error.message);
      }
    }
  });
}

async function recoverAttachment(savedAs) {
  if (!geminiEnabled) throw new Error('Recuperação requer Gemini ativo.');
  const resolved = path.resolve(__dirname, String(savedAs || ''));
  if (!resolved.startsWith(path.resolve(failedAttachmentsDir) + path.sep)) {
    throw new Error('Arquivo de recuperação deve estar em failed-attachments/.');
  }
  const entries = fs.readFileSync(pendingFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const entry = entries.find(item => item.savedAs === path.relative(__dirname, resolved) && item.groupJid && item.mimeType);
  if (!entry) throw new Error('Anexo não encontrado no registro de pendências.');
  const data = fs.readFileSync(resolved);
  await alignmentConfigPromise;
  const summary = await gemini.inspectAttachment({
    caption:'', groupName:entry.groupName, fileName:entry.fileName, mimeType:entry.mimeType, data
  });
  if (!summary) throw new Error('Gemini ainda retornou extração vazia; arquivo mantido para revisão.');
  const store = require('./gemini_conversation').fileStore(sessionsFile);
  const sessions = store.load();
  const timestamp = fs.statSync(resolved).mtime.toISOString();
  const session = sessions[entry.groupJid] || {
    group:entry.groupJid, startedAt:timestamp, lastRelated:Date.now(), messages:[]
  };
  const messageText = `[Grupo: ${entry.groupName || ''}]\nConteúdo lido do anexo: ${summary}`;
  const existingMessage = session.messages.find(message => message.id === entry.messageId);
  if (existingMessage) existingMessage.text = messageText;
  else session.messages.push({group:entry.groupJid, id:entry.messageId, timestamp,
    sender:'', groupName:entry.groupName, text:messageText});
  const outcome = await gemini.finish(session, 'recuperação de anexo');
  const expected = (summary.match(/^Equipamento:/gm) || []).length;
  if (!outcome || outcome.written < expected || outcome.pending) {
    throw new Error(`Extração parcial: ${outcome?.written || 0}/${expected} linhas; arquivo mantido para revisão.`);
  }
  session.lastAnalyzedMessageCount = session.messages.length;
  sessions[entry.groupJid] = session;
  store.save(sessions);
  if (entry.messageId) { seenIds.add(entry.messageId); saveSeenIds(); }
  appendPending({messageId:entry.messageId, savedAs:entry.savedAs,
    recoveredAt:new Date().toISOString(), reason:'anexo recuperado e sincronizado'});
  console.log('Anexo recuperado e sincronizado:', entry.savedAs);
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

console.log('Iniciando coletor silencioso de mensagens de alinhamento...');
const operation = process.argv[2] === '--recover-attachment'
  ? recoverAttachment(process.argv[3]) : startBot();
operation.catch((error) => {
  console.error('Não foi possível iniciar o coletor:', error.message);
  process.exit(1);
});


