import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, invoke } from '../src/mcp.mjs';
test('defaults and bounds',async()=>{
 let input;await invoke({start:async x=>(input=x,{})},'start',{requestId:'q',cwd:'x',prompt:'  p  '});
 assert.equal(input.prompt,'  p  ');assert.equal(input.timeoutSeconds,1800);assert.equal(input.permission,'read-only');
 await assert.rejects(invoke({},'wait',{runIds:[]}));await assert.rejects(invoke({},'list',{limit:101}));
});
test('MCP protocol and sanitized errors',async()=>{
 const server=createServer({doctor:async()=>({ready:true}),cancel:async()=>{throw Error('Session is busy; sk-abcdefghijklmnop Bearer topsecret');}});
 const client=new Client({name:'fixture',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);
 try {assert.equal((await client.listTools()).tools.length,13);
 const r=await client.callTool({name:'dsh_doctor',arguments:{}});assert.deepEqual(r.structuredContent,{ready:true});assert.deepEqual(JSON.parse(r.content[0].text),{ready:true});
 const e=await client.callTool({name:'dsh_cancel',arguments:{runId:'r'}});assert.equal(e.isError,true);assert.ok(!JSON.stringify(e).includes('topsecret'));assert.ok(!JSON.stringify(e).includes('sk-abcdefghijklmnop'));assert.ok(JSON.stringify(e).includes('Session is busy'));
 }finally{await client.close();await server.close();}
});
