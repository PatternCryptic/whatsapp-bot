const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTracker } = require('../gemini_conversation');

test('isola grupos e reconhece início em inglês', async () => {
  const closed = [];
  let clock = 0;
  const tracker = createTracker({ classify: async () => 'related', finish: async s => closed.push(s),
    save: async () => {}, now: () => clock, timeoutMs: 900000 });
  await tracker.process({ group: 'a', text: 'alignment', id: '1' });
  await tracker.process({ group: 'b', text: 'alinhamento', id: '2' });
  await tracker.process({ group: 'a', text: 'resultado', id: '3' });
  clock = 900000;
  await tracker.tick();
  assert.deepEqual(closed.map(s => [s.group, s.messages.map(m => m.id)]), [['a', ['1', '3']], ['b', ['2']]]);
});

test('usa mensagens anteriores do mesmo grupo para reconhecer uma conversa contextual', async () => {
  const tracker = createTracker({
    detect: async (message, context) => context.some(item => /eixo da bomba/i.test(item.text)) && /valor final/i.test(message.text),
    classify: async () => 'related', finish: async () => {}, save: async () => {}
  });
  assert.equal(await tracker.process({group:'grupo-a', text:'Vamos verificar o eixo da bomba', id:'1'}), 'ignorada');
  assert.equal(await tracker.process({group:'grupo-a', text:'O valor final foi 0,02 mm', id:'2'}), 'aberta');
  assert.equal(tracker.snapshot()['grupo-a'].messages.length, 2);
});

test('sincroniza novamente quando chegam dados novos e retenta falhas transitórias', async () => {
  let calls = 0;
  const tracker = createTracker({ detect: async () => true, classify: async () => 'related',
    finish: async () => {}, save: async () => {}, onTick: async () => { calls += 1; return calls === 1 ? false : true; }
  });
  await tracker.process({group:'g', id:'1', text:'DG1 em alinhamento'});
  await tracker.tick();
  await tracker.tick();
  await tracker.tick();
  assert.equal(calls, 2);
  await tracker.process({group:'g', id:'2', text:'resultado 0,02 mm'});
  await tracker.tick();
  assert.equal(calls, 3);
});


