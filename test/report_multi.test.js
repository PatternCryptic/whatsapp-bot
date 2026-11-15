const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const extraction = require('../gemini_conversation');

test('relatório com quatro geradores gera quatro linhas e preserva ausências', async () => {
  let onExtract;
  const writes = [];
  const mocks = {
    '@whiskeysockets/baileys': {}, 'qrcode-terminal': {}, pino: () => ({}),
    googleapis: { google: { options() {}, auth: { GoogleAuth: class {} }, sheets: () => ({}) } },
    fs: { readFileSync() { throw new Error('sem estado'); }, appendFileSync() {}, chmodSync() {} },
    './gemini_conversation': {
      ...extraction, createTracker: () => ({}),
      fileStore: () => ({ load() {}, save() {} }),
      makeGeminiFunctions: args => { onExtract = args.onExtract; return {}; }
    },
    './alignment_config': { loadAlignmentConfig: async () => ({}) },
    './alignment_history': { recordHistory: async (_sheets, _id, data, sessionId) => {
      writes.push({ data, sessionId }); return { status:'appended' };
    } }
  };
  const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');
  const start = source.indexOf("process.on('SIGINT'");
  vm.runInNewContext(source.slice(0, start), {
    require: name => mocks[name] || require(name), __dirname:'/tmp', Buffer,
    process: {env:{SPREADSHEET_ID:'test', CONFIG_SPREADSHEET_ID:'test', GEMINI_API_KEY:'test', GEMINI_CONVERSATION_ENABLED:'true'}},
    console, fetch, setInterval:() => ({unref() {}}), setTimeout, Date
  });

  const text = '[Grupo: BRAM Breeze]\nEquipamento: Diesel Generator #1\nEquipamento: Diesel Generator #2\nEquipamento: Diesel Generator #3\nCoupling GAP: 31,00 mm\nEquipamento: Diesel Generator #4';
  const item = value => ({value, message:1, quote:text});
  const records = [1,2,3,4].map(n => ({status:'incomplete', vessel:item('BRAM Breeze'),
    equipment:item(`Diesel Generator #${n}`), fields:n === 3 ? {coupling_gap:item('31,00 mm')} : {}}));
  const session = {group:'group@g.us', startedAt:'2026-11-14T23:29:36Z', messages:[{text}]};
  const outcome = await onExtract(session, 'sincronização periódica', {records}, [{text}]);

  assert.deepEqual(outcome, {written:4, pending:0});
  assert.equal(writes.length, 4);
  assert.equal(new Set(writes.map(row => row.sessionId)).size, 4);
  assert.deepEqual(writes.map(row => row.data.equipment),
    ['Diesel Generator #1', 'Diesel Generator #2', 'Diesel Generator #3', 'Diesel Generator #4']);
  assert.equal(writes[2].data.coupling_gap, '31,00 mm');
  assert.equal(writes[0].data.coupling_gap, undefined);

  await onExtract(session, 'sincronização periódica', {records}, [{text}]);
  assert.deepEqual(writes.slice(4).map(row => row.sessionId), writes.slice(0,4).map(row => row.sessionId));
});
