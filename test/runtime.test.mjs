import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {SdkConnection} from '../src/runtime.mjs';
const fixture = String.raw`
const readline=require('node:readline');
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
const held=[];
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(!m.method){send({method:'answered',params:m.result});return;}
 if(m.method==='echo'){held.push(m);if(held.length===2)for(const x of held.reverse())send({id:x.id,result:x.params});}
 if(m.method==='notify'){send({method:'progress',params:{step:1}});send({id:m.id,result:true});}
 if(m.method==='ask'){send({id:'host-1',method:'user-question/ask',params:{question:'fixture'}});send({id:m.id,result:true});}
 if(m.method==='unicode'){const b=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{text:'中文'}})+'\n');const cut=b.indexOf(Buffer.from('中'))+1;process.stdout.write(b.subarray(0,cut));setTimeout(()=>process.stdout.write(b.subarray(cut)),15);}
 if(m.method==='crash')process.exit(7);
 if(m.method==='shutdown'){send({id:m.id,result:{}});process.exitCode=0;process.stdin.destroy();}
});
`;
const open=()=>new SdkConnection(spawn(process.execPath,['-e',fixture],{windowsHide:true,stdio:['pipe','pipe','pipe']}));
test('actual stdio subprocess routes out-of-order replies, notifications and host answers, then stops gracefully',{timeout:10000},async()=>{
 const runtime=open();
 try {
  assert.deepEqual(await Promise.all([runtime.rpc('echo',{n:1}),runtime.rpc('echo',{n:2})]),[{n:1},{n:2}]);
  const notification=once(runtime,'notification');await runtime.rpc('notify');assert.equal((await notification)[0].method,'progress');
  const request=once(runtime,'request');await runtime.rpc('ask');const [message]=await request;assert.equal(message.id,'host-1');
  const answered=once(runtime,'notification');runtime.answer(message.id,{cancelled:true});assert.deepEqual((await answered)[0].params,{cancelled:true});
  assert.deepEqual(await runtime.rpc('unicode'),{text:'中文'});
  assert.equal((await runtime.stop()).code,0);assert.ok(!runtime.forcedTermination);
 }finally{if(!runtime.exited)runtime.child.kill();}
});
test('actual process failure rejects pending and future RPCs',{timeout:10000},async()=>{
 const runtime=open();
 try {
  const pending=runtime.rpc('never');const crash=runtime.rpc('crash');
  const results=await Promise.allSettled([pending,crash]);assert.ok(results.every(x=>x.status==='rejected'));
  assert.equal((await runtime.exit).code,7);await assert.rejects(runtime.rpc('later'),/exited/i);
 }finally{if(!runtime.exited)runtime.child.kill();}
});
