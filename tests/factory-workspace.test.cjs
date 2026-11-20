const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {snapshot}=require('../scripts/factory-workspace.cjs');
const {validate}=require('../scripts/factory-workspace/environment.cjs');
const image='node@sha256:'+'a'.repeat(64);
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'factory-workspace-'));const git=(...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['pipe','pipe','pipe']});git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@localhost');const commit=()=>{git('add','-A');git('commit','-qm','Fixture');return git('rev-parse','HEAD').trim();};return {dir,git,commit,clean:()=>fs.rmSync(dir,{recursive:true,force:true})};}
test('environment cannot grant itself an image, host mount, network permission or escaping cwd',()=>{
 const env={schema:1,image,setup:[],checks:[{name:'Test',argv:['node','--version']}]};assert.deepEqual(validate(env,[image]),env);
 assert.throws(()=>validate({...env,image:'node:latest'},[image]),/not approved/);
 assert.throws(()=>validate(env,[]),/not approved/);
 for(const field of ['network','mounts','privileged','secrets'])assert.throws(()=>validate({...env,[field]:true},[image]),/Unsupported/);
 assert.throws(()=>validate({...env,checks:[{name:'Bad',argv:['node'],cwd:'./../outside'}]},[image]),/inside/);
 assert.throws(()=>validate({...env,checks:[]},[image]),/checks/);
});
test('snapshot includes all committed files, excludes dirty/untracked changes, local Git config and earlier history',async()=>{
 const f=fixture();try{
  fs.writeFileSync(path.join(f.dir,'old-secret'),'old historical data');const old=f.commit();f.git('rm','-q','old-secret');
  fs.writeFileSync(path.join(f.dir,'tracked'),'committed');fs.writeFileSync(path.join(f.dir,'hidden-by-archive'),'still part of checkout');fs.writeFileSync(path.join(f.dir,'.gitattributes'),'hidden-by-archive export-ignore\n');fs.writeFileSync(path.join(f.dir,'.env.example'),'not a credential');const commit=f.commit();
  fs.writeFileSync(path.join(f.dir,'tracked'),'dirty');fs.writeFileSync(path.join(f.dir,'untracked'),'private');f.git('config','remote.origin.url','https://user:credential@example.invalid/private');
  const result=await snapshot(f.dir,'HEAD',new AbortController().signal);assert.equal(result.commit,commit);assert.equal(result.fileCount,4);
  const unpack=fs.mkdtempSync(path.join(os.tmpdir(),'factory-unpack-'));try{
   execFileSync('git',['init','--bare','-q',unpack]);execFileSync('git',['-C',unpack,'index-pack','--stdin'],{input:result.pack});
   const show=p=>execFileSync('git',['-C',unpack,'show',commit+':'+p],{encoding:'utf8',stdio:['pipe','pipe','pipe']});
   assert.equal(show('tracked'),'committed');assert.equal(show('hidden-by-archive'),'still part of checkout');assert.throws(()=>show('untracked'));
   assert.throws(()=>execFileSync('git',['-C',unpack,'cat-file','-e',old],{stdio:'pipe'}));assert.equal(fs.readFileSync(path.join(unpack,'config'),'utf8').includes('credential'),false);
  }finally{fs.rmSync(unpack,{recursive:true,force:true});}
 }finally{f.clean();}
});
test('workspace API reads saved results without executing commands and refuses duplicate or invalid requests',async()=>{
 const {readWorkspaces,startWorkspace,cancelWorkspace}=require('../dist/factory/workspace');const {workflowLocation}=require('../dist/factory/location');const f=fixture(),prior={...process.env};
 try{
  Object.assign(process.env,{DRAKEN_DATA_DIR:path.join(f.dir,'data'),DRAKEN_WORKSPACE_REPO:f.dir,DRAKEN_WORKSPACE_ALLOWED_IMAGES:JSON.stringify([image]),DRAKEN_DOCKER_BIN:'/not-executed',DRAKEN_DOCKER_HOST:'unix:///not-executed'});
  assert.deepEqual(readWorkspaces().runs,[]);const id='12345678-1234-4234-8234-123456789abc',dir=path.join(f.dir,'data/factory-workspaces',id);fs.mkdirSync(path.join(dir,'work'),{recursive:true});
  fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({id,ref:'HEAD',propose:false,location:workflowLocation(f.dir).key,createdAt:new Date().toISOString()}));
  fs.writeFileSync(path.join(dir,'work/result.json'),JSON.stringify({status:'completed',modelCalls:0}));
  assert.equal(readWorkspaces().runs[0].status,'completed');assert.equal((await startWorkspace({requestId:id,ref:'HEAD',propose:false})).id,id);
  await assert.rejects(startWorkspace({requestId:id,ref:'other',propose:false}),/already used/);
  await assert.rejects(startWorkspace({requestId:'../../escape',ref:'HEAD',propose:false}),/request ID/);assert.throws(()=>cancelWorkspace('../../escape'),/Invalid/);
  delete process.env.DRAKEN_WORKSPACE_REPO;assert.equal(readWorkspaces().available,false);assert.deepEqual(readWorkspaces().runs,[]);
 }finally{for(const key of Object.keys(process.env))if(!(key in prior))delete process.env[key];Object.assign(process.env,prior);f.clean();}
});
test('snapshot rejects tracked credential paths, submodules and LFS rather than silently omitting source',async()=>{
 for(const kind of ['secret','submodule','lfs']){const f=fixture();try{
  fs.writeFileSync(path.join(f.dir,'tracked'),'data');const commit=f.commit();
  if(kind==='secret')fs.writeFileSync(path.join(f.dir,'.env'),'TOKEN=private');
  if(kind==='lfs')fs.writeFileSync(path.join(f.dir,'.gitattributes'),'*.bin filter=lfs\n');
  if(kind==='submodule')f.git('update-index','--add','--cacheinfo','160000,'+commit+',dependency');
  if(kind==='submodule')f.git('commit','-qm','submodule');else f.commit();
  await assert.rejects(snapshot(f.dir,'HEAD',new AbortController().signal),/credential|Submodules|LFS/);
 }finally{f.clean();}}
});
