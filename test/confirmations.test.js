const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'); const os=require('os'); const path=require('path');
const {createConfirmations,parseCorrection}=require('../confirmations');
test('confirmações sobrevivem a reinício e ficam isoladas por grupo e equipamento',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'confirm-')); const file=path.join(dir,'state.json');
 const a=createConfirmations(file); const payload=['g1','sessao1','Joe Griffin','MCP 1',{'Axial Horizontal':'-0.02 mm'},[{field:'Axial Vertical',caption:'-0.1 mm',visual:'-0.01 mm'}]];
 const sent=a.prepare(...payload); assert.match(sent.text, /-0.01 mm/); a.sent(sent.key,'msg1');
 assert.equal(a.prepare(...payload),null); const b=createConfirmations(file);
 assert.equal(b.lookup('g2','msg1'),null); assert.equal(b.lookup('g1','msg1')[1].sessionId,'sessao1');
 assert.ok(b.prepare('g1','sessao2','Joe Griffin','MCP 2',{},[]));
 b.done(sent.key,'resp1'); assert.equal(b.lookup('g1','msg1'),null);
 fs.rmSync(dir,{recursive:true,force:true});
});
test('correção exige campo explícito e preserva sinal e decimal',()=>{
 assert.deepEqual(parseCorrection('axial vertical: -0,01 mm'),[{key:'axial_vertical',value:'-0.01 mm'}]);
 assert.deepEqual(parseCorrection('sim, 0,01'),[]);
});
