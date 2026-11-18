const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const confirmationLib=require('../confirmations');

function harness(entry) {
  const writes=[]; const completed=[]; const replies=[];
  const mocks={
    '@whiskeysockets/baileys':{}, 'qrcode-terminal':{}, pino:()=>({}),
    googleapis:{google:{options(){},auth:{GoogleAuth:class{}},sheets:()=>({})}},
    fs:{readFileSync(){throw new Error('sem estado')},writeFileSync(){},appendFileSync(){},chmodSync(){}},
    './gemini_conversation':{
      createTracker:()=>({process:async()=> 'aberta',snapshot:()=>({})}),
      fileStore:()=>({load(){},save(){}}),makeGeminiFunctions:()=>({})
    },
    './confirmations':{...confirmationLib,createConfirmations:()=>({
      lookup:()=>['proposal-key',entry],done:(key,id,status)=>completed.push({key,id,status})
    })},
    './alignment_config':{loadAlignmentConfig:async()=>({})},
    './alignment_history':{
      getRecordSchema:async()=>[],
      recordHistory:async(_sheets,_id,data,sessionId)=>{writes.push({data,sessionId});return {status:'appended',row:3};}
    }
  };
  const source=fs.readFileSync(require.resolve('../index.js'),'utf8');
  const end=source.indexOf("process.on('SIGINT'");
  const context={require:name=>mocks[name]||require(name),__dirname:'/tmp',Buffer,
    process:{env:{SPREADSHEET_ID:'test',CONFIG_SPREADSHEET_ID:'test',GEMINI_API_KEY:'test',GEMINI_CONVERSATION_ENABLED:'true'}},
    console,fetch,setInterval:()=>({unref(){}}),setTimeout,Date};
  vm.runInNewContext(source.slice(0,end)+'\nthis.handle=handleMessage;',context);
  return {handle:context.handle,writes,completed,replies,sock:{sendMessage:async(_group,message)=>{replies.push(message);return {key:{id:'bot-reply'}};}}};
}

const proposal=()=>({status:'sent',startedAt:'2026-11-18T10:00:00.000Z',data:{
  vessel:'BRAM Atlas',equipment:'MCP 1',axial_vertical:'usuário passou informação divergente'
},conflicts:[{field:'Axial Vertical',caption:'-0.015 mm',visual:'-0.01 mm'}]});
const reply=text=>({key:{remoteJid:'grupo@g.us',id:'response'},message:{extendedTextMessage:{text,contextInfo:{stanzaId:'proposal'}}}});

test('só grava após a resposta e marca a célula de divergência confirmada',async()=>{
  const h=harness(proposal());
  await h.handle(h.sock,reply('confirmo'));
  assert.equal(h.writes.length,1);
  assert.equal(h.writes[0].data.axial_vertical,'usuário passou informação divergente');
  assert.equal(h.completed[0].status,'answered');
  assert.equal(h.replies.length,1);
});

test('correção citada substitui a célula divergente antes de gravar',async()=>{
  const h=harness(proposal());
  await h.handle(h.sock,reply('Axial Vertical: -0,01 mm'));
  assert.equal(h.writes.length,1);
  assert.equal(h.writes[0].data.axial_vertical,'-0.01 mm');
  assert.equal(h.writes[0].data.observations,'');
});
