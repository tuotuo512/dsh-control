import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setupPlan,initialize,setupArgs} from '../src/setup.mjs';
import {fakeInstallation} from './fixtures/installation.mjs';

function fixture(){
  const parent=fs.realpathSync.native(os.tmpdir()),base=fs.mkdtempSync(path.join(parent,'dsh-setup-'));
  const app=fakeInstallation(base),home=path.join(base,'state'),dshHome=path.join(base,'dsh'),profile=path.join(dshHome,'profiles','desktop');
  fs.mkdirSync(profile,{recursive:true});fs.writeFileSync(path.join(profile,'package.json'),JSON.stringify({dsh:{profile:{patchReload:'live'}}}));
  fs.writeFileSync(path.join(profile,'cordis.patch.yml'),'- id: agent-default-model\n  config:\n    provider: fixture-provider\n    model: fixture-model\n    reasoningEffort: max\n');
  const options={home,dshHome,executable:app.executable};
  const dependencies={platform:'win32',userDir:base,env:{},matrix:{artifacts:[{platform:'win32',version:app.version,buildCommit:app.buildCommit,archiveSha256:app.archiveSha256,protocolPackageVersion:app.version}]}};
  return {base,home,dshHome,profile,app,options,dependencies,close(){assert.equal(path.dirname(base),parent);assert.ok(path.basename(base).startsWith('dsh-setup-'));fs.rmSync(base,{recursive:true,force:true});}};
}
test('first-run plan is read-only; write records only selected runtime/profile settings and cannot overwrite',()=>{
  const f=fixture();try{
    const before=fs.readFileSync(path.join(f.profile,'cordis.patch.yml'),'utf8');
    const plan=setupPlan(f.options,f.dependencies);assert.equal(plan.mode,'plan');assert.ok(!fs.existsSync(f.home));assert.equal(plan.config.defaultBackend,'desktop');
    const written=initialize(f.options,f.dependencies);assert.equal(written.mode,'written');assert.equal(written.config.provider,'fixture-provider');assert.equal(written.config.dshHome,f.dshHome);
    assert.equal(fs.readFileSync(path.join(f.profile,'cordis.patch.yml'),'utf8'),before);
    const config=fs.readFileSync(written.configPath,'utf8');assert.ok(!config.includes('apiKey'));assert.ok(!config.includes('password'));
    assert.throws(()=>initialize({...f.options,model:'different'},f.dependencies),/already exists/);assert.equal(fs.readFileSync(written.configPath,'utf8'),config);
  }finally{f.close();}
});
test('same version with unknown bytes, unsupported OS and inactive profile fail before writing',()=>{
  const f=fixture();try{
    assert.throws(()=>setupPlan(f.options,{...f.dependencies,matrix:{artifacts:[]}}),/Unsupported/);
    assert.throws(()=>setupPlan(f.options,{...f.dependencies,platform:'linux'}),/Windows only/);
    fs.writeFileSync(path.join(f.profile,'package.json'),'{}');assert.throws(()=>initialize(f.options,f.dependencies),/live patch reload/);assert.ok(!fs.existsSync(f.home));
  }finally{f.close();}
});
test('explicit model and custom paths work without guessing, missing profile/model requires setup in DSH',()=>{
  const f=fixture();try{
    fs.writeFileSync(path.join(f.profile,'cordis.patch.yml'),'[]\n');assert.throws(()=>setupPlan(f.options,f.dependencies),/provider\/model/);
    assert.equal(setupPlan({...f.options,provider:'p',model:'m'},f.dependencies).config.model,'m');
    assert.throws(()=>setupPlan({...f.options,profile:'../outside'},f.dependencies),/Invalid profile/);
    assert.throws(()=>setupPlan({...f.options,home:f.base},f.dependencies),/dedicated/);
  }finally{f.close();}
});
test('CLI defaults to a plan and rejects ambiguous modes, unknown flags and missing values',()=>{
  assert.deepEqual(setupArgs([]),{mode:'plan',options:{}});
  assert.equal(setupArgs(['--write','--max-parallel','3']).options.maxParallel,'3');
  assert.equal(setupArgs(['--home=C:/work/a=b']).options.home,'C:/work/a=b');
  assert.throws(()=>setupArgs(['--write','--plan']),/either/);assert.throws(()=>setupArgs(['--unknown']),/Unknown/);assert.throws(()=>setupArgs(['--home','--write']),/Missing/);
});
