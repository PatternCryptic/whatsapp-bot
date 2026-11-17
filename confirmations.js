const fs = require('fs');
const crypto = require('crypto');
const FIELDS = {'axial vertical':'axial_vertical','axial horizontal':'axial_horizontal','radial vertical':'radial_vertical','radial horizontal':'radial_horizontal'};
function createConfirmations(file) {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  function save() { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state), {mode:0o600}); fs.renameSync(tmp,file); }
  return {
    prepare(group, sessionId, vessel, equipment, fields, conflicts) {
      const key = crypto.createHash('sha256').update(JSON.stringify([group,sessionId,fields,conflicts])).digest('hex');
      if (state[key]) return null;
      const lines = [`Registrei o alinhamento: ${vessel} — ${equipment}. Confira os dados:`];
      for (const [name, value] of Object.entries(fields)) if (value && value !== 'não informado') lines.push(`${name}: ${value}`);
      for (const c of conflicts) lines.push(`${c.field}: legenda ${c.caption}; imagem ${c.visual || 'não legível'}. Qual é o valor correto?`);
      lines.push('Responda diretamente a esta mensagem. Para corrigir, informe o campo e o valor, por exemplo: axial vertical: -0,01 mm.');
      // Persist before sending to prevent duplicate messages after a crash. A failed send requires review.
      state[key] = {group, sessionId, vessel, equipment, fields, conflicts, status:'prepared'}; save();
      return {key, text:lines.join('\n')};
    },
    sent(key, messageId) { state[key].messageId=messageId; state[key].status='sent'; save(); },
    lookup(group, quotedId) { return Object.entries(state).find(([,v]) => v.group===group && v.messageId===quotedId && v.status==='sent') || null; },
    done(key, responseId) { state[key].status='answered'; state[key].responseId=responseId; save(); }
  };
}
function parseCorrection(text) {
 const matches=[...String(text).matchAll(/\b(axial|radial)\s+(vertical|horizontal)\s*[:=]?\s*([+-]?\d+(?:[.,]\d+)?)\s*(mm)?\b/gi)];
 return matches.map(m=>({key:FIELDS[(m[1]+' '+m[2]).toLowerCase()], value:m[3].replace(',','.')+' mm'}));
}
module.exports={createConfirmations,parseCorrection};
