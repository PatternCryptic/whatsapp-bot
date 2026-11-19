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
  console.log('Gemini aguardará menção explícita antes de processar uma conversa do grupo.');
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
const {createConfirmations, parseCorrection, isApproval} = require('./confirmations');
const history = require('./alignment_history');
const confirmations = createConfirmations(path.join(__dirname, 'alignment-confirmations.json'));
let confirmationQueue = Promise.resolve();

function serializeConfirmations(operation) {
  const result = confirmationQueue.then(operation);
  confirmationQueue = result.catch(() => {});
  return result;
}
const preMentionMessages = new Map();
const armedGroups = new Map();
const GROUP_ARM_WINDOW_MS = 2 * 60 * 60 * 1000;

function messageContextInfo(content) {
  return content.extendedTextMessage?.contextInfo || content.imageMessage?.contextInfo ||
    content.documentMessage?.contextInfo || content.videoMessage?.contextInfo || {};
}

function jidDigits(value) {
  return String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

function explicitlyMentionsBot(sock, content) {
  const botIds = new Set([sock.user?.id, sock.user?.lid].map(jidDigits).filter(Boolean));
  const mentions = messageContextInfo(content).mentionedJid || [];
  return mentions.some(jid => botIds.has(jidDigits(jid)));
}

function cacheBeforeMention(group, msg) {
  const now = Date.now();
  const messages = (preMentionMessages.get(group) || []).filter(item => now - item.time < GROUP_ARM_WINDOW_MS);
  messages.push({time:now, msg});
  preMentionMessages.set(group, messages.slice(-60));
}

async function publishReview(sock, group, sessionId, proposal) {
  const { data, conflicts } = proposal;
  const { target: resolved, status, schema } = await history.resolveRecordTarget(sheets, spreadsheetId, data, sessionId);
  const lostExistingRow = proposal.requireExisting && !resolved?.row;
  const target = lostExistingRow ? null : resolved;
  const displayLines = schema.filter(column => column.mappedAs?.length).flatMap(column =>
    column.mappedAs.map(key => {
      const repeated = schema.filter(item => item.title === column.title && item.mappedAs?.length).length > 1;
      const title = repeated ? `${column.title} (${column.group})` : column.title;
      const value = key === 'comments'
        ? [history.userComments(target?.current.comments), data.observations].filter(Boolean).join(' | ')
        : data[key];
      const previous = target?.current[key];
      const shown = history.isKnown(value) ? value : history.isKnown(previous) ? `${previous} (mantido)` : 'não informado';
      return `${title}: ${shown}`;
    })
  );
  if (data.observations && !schema.some(column => column.mappedAs?.includes('comments'))) {
    displayLines.push(`Observações: ${data.observations}`);
  }
  const destination = target?.row ? `Destino: linha ${target.row} já existente.`
    : target ? 'Destino: nova linha para este equipamento.'
    : lostExistingRow ? 'A linha existente deixou de ser identificável. Confira a embarcação, o equipamento e a data antes de prosseguir.'
    : status === 'too_recent' ? 'A última gravação de equipamento nesta embarcação foi há menos de duas horas. Depois desse intervalo, marque o bot para uma nova conferência.'
    : status === 'identity_missing' ? 'Informe a embarcação e o equipamento para identificar a linha.'
    : 'A linha ainda não foi identificada com segurança. Confira a embarcação, o equipamento e a data completa.';
  const text = [
    'Confira todos os dados do alinhamento antes de gravar na planilha:',
    destination,
    ...displayLines,
    ...conflicts.map(conflict => `Divergência ${conflict.field}: legenda ${conflict.caption || 'não informada'}; imagem ${conflict.visual || 'não legível'}.`),
    conflicts.length ? 'Ao confirmar, os campos com divergência ainda marcada serão registrados como “usuário passou informação divergente”.' : '',
    target ? 'Responda diretamente com “confirmo” para validar todos os dados acima.' : '',
    'Para corrigir ou completar algum dado, responda no formato “Campo: valor”. O bot enviará todos os dados para nova confirmação.'
  ].filter(Boolean).join('\n');
  const prompt = confirmations.prepare(group, sessionId, { ...proposal, target: target ?? null, text });
  if (!prompt) return true;
  if (!sock) return false;
  try {
    const sent = await sock.sendMessage(group, { text: prompt.text });
    if (!sent?.key?.id) throw new Error('Mensagem sem identificador');
    confirmations.sent(prompt.key, sent.key.id);
    return true;
  } catch {
    appendPending({groupJid:group, sessionId, reason:'proposta pendente: confirmação não enviada'});
    return false;
  }
}

if (geminiEnabled) {
  const { createTracker, fileStore, makeGeminiFunctions, verifyExtractions } = require('./gemini_conversation');
  const { loadAlignmentConfig } = require('./alignment_config');
  const store = fileStore(sessionsFile);
  alignmentConfigPromise = loadAlignmentConfig(sheets, process.env.CONFIG_SPREADSHEET_ID);
  gemini = makeGeminiFunctions({
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
    config: alignmentConfigPromise,
    getRecordSchema: () => history.getRecordSchema(sheets, spreadsheetId),
    onExtract: (session, reason, extraction, transcript) => serializeConfirmations(async () => {
      const checkedRecords = verifyExtractions(extraction, transcript);
      const proposed = new Set();
      let pending = 0;
      let deliveryFailed = false;
      const sourceVersion = crypto.createHash('sha256')
        .update(JSON.stringify(session.messages.map(({id, text}) => [id, text]))).digest('hex');
      const fieldKeys = {
        'Equipment Class':'class', Maker:'maker', Model:'model',
        'Stationary Equipment Class':'stationary_class', 'Stationary Maker':'stationary_maker',
        'Stationary Model':'stationary_model', Document:'document', Data:'date',
        Motivacao:'motivation', Motivation:'motivation', Executor:'executor', Metodo:'method', Method:'method',
        'Axial vertical':'axial_vertical', 'Axial horizontal':'axial_horizontal',
        'Radial vertical':'radial_vertical', 'Radial horizontal':'radial_horizontal',
        'Coupling gap':'coupling_gap', 'Padrão':'standard', 'Axial tolerance':'axial_tolerance',
        'Radial tolerance':'radial_tolerance', 'Coupling gap tolerance':'gap_tolerance'
      };
      for (const checked of checkedRecords) {
        if (!checked.ok) {
          pending += 1;
          appendPending({ groupJid: session.group, startedAt: session.startedAt,
            closedAt: new Date().toISOString(), reason: checked.reason, messages: session.messages });
          console.log('Alinhamento mantido para revisão:', checked.reason);
          continue;
        }
        const equipmentKey = history.equipmentIdentity(checked.equipment);
        if (proposed.has(equipmentKey)) {
          pending += 1;
          appendPending({ groupJid: session.group, startedAt: session.startedAt,
            reason: `equipamento duplicado na extração: ${checked.equipment}`, messages: session.messages });
          continue;
        }
        proposed.add(equipmentKey);
        const sessionId = crypto.createHash('sha256')
          .update(`${session.group}|${session.startedAt}|${equipmentKey}`).digest('hex').slice(0, 24);
        const extracted = checked.fields || {};
        const data = {
          vessel: checked.vessel, equipment: checked.equipment,
          class: extracted['Equipment Class'], maker: extracted.Maker, model: extracted.Model,
          stationary_class: extracted['Stationary Equipment Class'], stationary_maker: extracted['Stationary Maker'],
          stationary_model: extracted['Stationary Model'], document: extracted.Document,
          date: extracted.Data, motivation: extracted.Motivacao || extracted.Motivation,
          executor: extracted.Executor, method: extracted.Metodo || extracted.Method,
          axial_vertical: extracted['Axial vertical'], axial_horizontal: extracted['Axial horizontal'],
          radial_vertical: extracted['Radial vertical'], radial_horizontal: extracted['Radial horizontal'],
          coupling_gap: extracted['Coupling gap'], standard: extracted['Padrão'],
          axial_tolerance: extracted['Axial tolerance'], radial_tolerance: extracted['Radial tolerance'],
          gap_tolerance: extracted['Coupling gap tolerance'],
          observations: Object.entries(extracted).filter(([key]) => /antes do ajuste|unidade das medições/i.test(key))
            .map(([key, value]) => `${key}: ${value}`).join('; ')
        };
        const conflicts = [];
        let currentEquipment = '';
        for (const msg of session.messages) for (const line of String(msg.text || '').split('\n')) {
          const equipmentMatch = line.match(/^Equipamento:\s*(.+)$/i);
          if (equipmentMatch) currentEquipment = equipmentMatch[1].trim();
          if (!line.startsWith('DIVERGENCIA_MEDICAO: ')) continue;
          try {
            const conflict = JSON.parse(line.slice('DIVERGENCIA_MEDICAO: '.length));
            if ((history.equipmentIdentity(currentEquipment) === equipmentKey || checkedRecords.length === 1) &&
                !conflicts.some(item => item.field === conflict.field)) conflicts.push(conflict);
          } catch {}
        }
        for (const conflict of conflicts) {
          const key = fieldKeys[conflict.field] || fieldKeys[conflict.field[0]?.toUpperCase() + conflict.field.slice(1)];
          if (key) data[key] = 'usuário passou informação divergente';
        }
        const sent = await publishReview(activeSock, session.group, sessionId, {
          data, conflicts, sourceVersion, startedAt:session.startedAt
        });
        if (!sent) deliveryFailed = true;
      }
      return {proposed:proposed.size, pending, deliveryFailed};
    })
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
    // Analisa a cada cinco minutos e só propõe a gravação depois de uma menção explícita.
    onMessage: async () => {},
    onTick: async (session) => {
      if (!session.activatedByMention) return true;
      try {
        const result = await gemini.finish(session, 'sincronização periódica');
        return result?.deliveryFailed ? false : true;
      }
      catch (error) { console.error('Falha ao sincronizar dados de alinhamento:', error.message); return false; }
    },
    finish: async (session, reason) => {
      if (!session.activatedByMention) return;
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
    timeoutMs: 2 * 60 * 60 * 1000,
    maxMessages: 5000
  });

  setInterval(() => {
    alignmentTracker.tick().catch((error) => {
      console.error('Falha ao sincronizar sessões de alinhamento:', error.message);
    });
  }, 5 * 60 * 1000).unref();
}


async function handleConfirmation(sock, msg, text, quotedId) {
  const groupJid = msg.key.remoteJid;
  const messageId = msg.key.id;
  const confirmation = confirmations.lookup(groupJid, quotedId);
  if (!confirmation) return false;

  const [key, entry] = confirmation;
  const reply = async text => {
    try { await sock.sendMessage(groupJid, { text, quoted: msg }); } catch {}
  };
  if (entry.status === 'superseded') {
    await reply('Responda à última mensagem de conferência do bot. Esta versão foi substituída.');
    return true;
  }

  const corrections = parseCorrection(text, entry.conflicts || []);
  const approved = isApproval(text);
  if (entry.status === 'answered' && !corrections.length) return true;
  if (!corrections.length && !approved) {
    await reply('Responda “confirmo” para validar todos os dados ou indique as correções no formato “Campo: valor”.');
    return true;
  }

  const data = { ...entry.data };
  const sessionId = entry.sessionId;
  const makeReview = (conflicts = entry.conflicts || []) => publishReview(sock, groupJid, sessionId, {
    data, conflicts, sourceVersion: entry.sourceVersion, startedAt: entry.startedAt, parentKey: key,
    requireExisting: Boolean(entry.target?.row || entry.requireExisting) && history.sameEquipment(data, entry.data)
  });
  if (!sessionId) {
    await reply('Esta proposta antiga não pode ser validada. Marque o bot para gerar uma nova conferência.');
    return true;
  }

  try {
    if (corrections.length) {
      const schema = await history.getRecordSchema(sheets, spreadsheetId);
      const allowed = new Set(schema.flatMap(column => column.mappedAs || []));
      if (corrections.some(({ key }) => !allowed.has(key === 'observations' ? 'comments' : key))) {
        await reply('Uma das correções aponta para um campo sem coluna reconhecida. Confira os nomes apresentados na proposta.');
        return true;
      }
      for (const { key, value } of corrections) data[key] = value;
      const conflicts = (entry.conflicts || []).filter(conflict =>
        !corrections.some(change => change.key === parseCorrection(`${conflict.field}: 0 mm`)[0]?.key)
      );
      if (await makeReview(conflicts)) {
        if (messageId) { seenIds.add(messageId); saveSeenIds(); }
      } else {
        await reply('Não consegui enviar a proposta corrigida. Responda novamente com as correções para tentar de novo.');
      }
      return true;
    }

    if (!entry.target) {
      if (entry.target === null) {
        await reply('Ainda preciso identificar o destino. Confira os dados solicitados na mensagem de conferência.');
      } else {
        await makeReview();
      }
      return true;
    }

    const conflictNotes = (entry.conflicts || []).map(item =>
      `${item.field}: legenda ${item.caption || 'não informada'}; imagem ${item.visual || 'não legível'}`
    ).join('; ');
    const result = await history.recordHistory(sheets, spreadsheetId, {
      ...data,
      observations: [data.observations, conflictNotes].filter(Boolean).join('; '),
      groupJid
    }, sessionId, { target: entry.target, confirmationId: key });
    if (!['appended', 'updated', 'unchanged'].includes(result.status)) {
      appendPending({ groupJid, messageId, sessionId, reason: result.status });
      await reply('A planilha mudou ou o destino ficou indefinido. Confira os dados na nova proposta para liberar a gravação.');
      if (!await makeReview()) await reply('Não consegui enviar a nova conferência. Tente confirmar novamente.');
      return true;
    }
    confirmations.done(key, messageId);
    if (messageId) { seenIds.add(messageId); saveSeenIds(); }
    await reply(result.row ? `Dados validados e gravados na linha ${result.row} da planilha.`
      : 'Dados validados e gravados na planilha.');
  } catch (error) {
    console.error('Falha ao processar confirmação de alinhamento.', error.code || error.status || '');
    appendPending({ groupJid, messageId, sessionId, reason: 'falha ao processar confirmação' });
    await reply('Não consegui concluir a confirmação com o Google Sheets. Responda novamente à mensagem de conferência para tentar de novo.');
  }
  return true;
}

async function handleMessage(sock, msg, options = {}) {
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

  if (geminiEnabled) {
    const contextInfo = messageContextInfo(content);

    if (contextInfo.stanzaId && await serializeConfirmations(() =>
      handleConfirmation(sock, msg, text, contextInfo.stanzaId))) return;

    const mentioned = explicitlyMentionsBot(sock, content);
    const activeSession = alignmentTracker?.snapshot?.()[groupJid];
    const active = armedGroups.get(groupJid) > Date.now() || activeSession?.activatedByMention === true;
    if (!options.replay && !mentioned && !active) {
      cacheBeforeMention(groupJid, msg);
      return;
    }
    if (mentioned && !options.replay) {
      const buffered = (preMentionMessages.get(groupJid) || []).filter(item => Date.now() - item.time < GROUP_ARM_WINDOW_MS);
      preMentionMessages.delete(groupJid);
      armedGroups.set(groupJid, Date.now() + GROUP_ARM_WINDOW_MS);
      if (activeSession && !activeSession.activatedByMention) await alignmentTracker.clearGroup?.(groupJid);
      for (const item of buffered) await handleMessage(sock, item.msg, {replay:true, activated:true});
      return handleMessage(sock, msg, {replay:true, activated:true});
    }
    if (active || options.activated) armedGroups.set(groupJid, Date.now() + GROUP_ARM_WINDOW_MS);

    if (!attachment && /\b(?:relat[oó]rio|report)\b/i.test(text)) {
      console.log('Mensagem sobre relatório sem anexo reconhecido:', groupJid, messageId);
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
      activatedByMention: options.activated === true || active,
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
      ? 'Coletor conectado; aguardando menção explícita em um grupo.'
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
  session.lastRelated = Date.now();
  session.activatedByMention = true;
  delete session.lastAnalyzedMessageCount;
  sessions[entry.groupJid] = session;
  store.save(sessions);
  if (entry.messageId) { seenIds.add(entry.messageId); saveSeenIds(); }
  appendPending({messageId:entry.messageId, savedAs:entry.savedAs,
    recoveredAt:new Date().toISOString(), reason:'anexo recuperado para conferência no WhatsApp'});
  console.log('Anexo recuperado. A instância do bot deve carregar a sessão para enviar a conferência.');
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


