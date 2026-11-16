import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {DesktopHostController, listenDesktop, PLUGIN_VERSION} from './desktop-host.mjs';
import {readJson,writeJson,redact} from './store.mjs';
import {PROTOCOL_VERSION, CAPABILITIES} from './protocol.mjs';

const diagnostic=(home,phase,error)=>writeJson(path.join(home,'desktop-plugin-diagnostic.json'),{phase,pid:process.pid,at:new Date().toISOString(),...(error?{error:redact(error?.message||String(error)),stack:redact(String(error?.stack||'')).slice(0,5000)}:{} )});

export const name='dsh-control-desktop-bridge';
export const inject=['sessionController','workspaceRegistry','permissionPresets','connection','typertGateway','agents','sessions','sessionPersistence','sessionProjections','llm'];

/** One independently hot-loadable official Cordis plugin; no installation modifications. */
export async function apply(ctx,options={}) {
  const home=options.home||path.join(os.homedir(),'.codex','dsh-control-state');
  if(!path.isAbsolute(home))throw new Error('DSH control home must be absolute');
  diagnostic(home,'activating');
  await ctx.effect(async()=>{
    try {
    const cfg=readJson(path.join(home,'config.json'));
    const expected=fs.realpathSync.native(cfg.executable).toLowerCase();
    if(fs.realpathSync.native(process.execPath).toLowerCase()!==expected)throw new Error('Desktop bridge must run inside the pinned installed application');
    // Electron's patched fs treats an ASAR root as a virtual directory. Hash the physical archive.
    const physicalFs=createRequire(import.meta.url)('original-fs');
    const bytes=physicalFs.readFileSync(cfg.archive);const digest=crypto.createHash('sha256').update(bytes).digest('hex');
    if(digest!==cfg.verifiedArchiveSha256)throw new Error('Installed Desktop changed; revalidate native contract first');
    const instanceId=crypto.randomUUID();
    const sourceFiles=['desktop-plugin.mjs','desktop-host.mjs','store.mjs','protocol.mjs'].map(n=>path.join(path.dirname(fileURLToPath(import.meta.url)),n));
    const sourceDigest=crypto.createHash('sha256').update(Buffer.concat(sourceFiles.map(f=>fs.readFileSync(f)))).digest('hex');
    const runtime={pid:process.pid,hostPid:process.pid,instanceId,archiveSha256:digest,sourceDigest,hostEntrypoint:process.argv[1]};
    diagnostic(home,'connecting-events');
    const lifetime=new AbortController();
    // Documented in-process Peer. This is not a copied Desktop cookie or authentication token.
    const peer=ctx.connection.createPeer({principal:{kind:'owner'},interactions:'answer'});
    const api=ctx.connection.createSharedFetchHandler('/api');
    let clientId;let controller;let listener;let stopped=false;
    const ready=Promise.withResolvers();
    const empty={async *[Symbol.asyncIterator](){}};
    const stream=await ctx.typertGateway.wireStream.open('$events',{args:{}},empty,peer,lifetime.signal);
    const eventTask=(async()=>{try{
      for await(const frame of stream){
        if(frame.type==='ready'){clientId=frame.clientId;ready.resolve();}
        else controller?.remoteFrame(frame);
      }
      if(!stopped)throw new Error('Native forwarded event stream ended');
    }catch(e){ready.reject(e);if(!stopped){ctx.logger.error('dsh-control: native event stream unavailable');await controller?.close();}}})();
    try{
      await Promise.race([ready.promise,new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('Native event readiness timed out')),10000);t.unref?.();})]);
      controller=new DesktopHostController(ctx,{home,runtime,maxParallel:cfg.maxParallel,answerNative:async(eventId,value)=>{
        const rpcId=crypto.randomUUID();
        const response=await api.fetch(new Request('http://127.0.0.1/api/$events/result',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({type:'client-request',rpcId,method:'$events/result',payload:{args:{clientId,eventId,outcome:{kind:'result',value}}}})}),peer);
        if(!response.ok)throw new Error(`Native answer rejected (${response.status})`);
        const result=await response.json();
        if(result.type!=='server-response'||result.rpcId!==rpcId||result.result?.ok!==true)throw new Error('Native answer RPC rejected');
      }});
      listener=await listenDesktop(controller);
      const descriptor=path.join(home,'desktop-connection.json');
      writeJson(descriptor,{schemaVersion:1,protocolVersion:PROTOCOL_VERSION,capabilities:[...CAPABILITIES],url:listener.url,token:listener.token,...runtime,pluginVersion:PLUGIN_VERSION});
      diagnostic(home,'ready');
      return async()=>{
        stopped=true;await controller.close();lifetime.abort();peer.dispose();await eventTask;await listener.close();
        if(fs.existsSync(descriptor)&&readJson(descriptor).instanceId===instanceId)fs.unlinkSync(descriptor);
      };
    }catch(e){stopped=true;lifetime.abort();peer.dispose();await eventTask;await controller?.close();await listener?.close();throw e;}
    }catch(e){diagnostic(home,'failed',e);throw e;}
  },'dsh-control: native supervisor bridge');
}
