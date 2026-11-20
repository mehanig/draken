const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {workflowLocation}=require('../dist/factory/location');
let root;
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-location-'));});
afterEach(()=>fs.rmSync(root,{recursive:true,force:true}));
function repo(name){const dir=path.join(root,name);execFileSync('git',['init','-q',dir]);return dir;}
test('subfolders share their repository; nested repositories remain separate',()=>{
 const a=repo('a');fs.mkdirSync(path.join(a,'src'));const nested=path.join(a,'nested');execFileSync('git',['init','-q',nested]);
 assert.deepEqual(workflowLocation(path.join(a,'src')),workflowLocation(a));assert.equal(workflowLocation(a).kind,'repository');
 assert.notEqual(workflowLocation(nested).key,workflowLocation(a).key);
});
test('separate clones are not merged by repository name or remote URL',()=>{
 const a=repo('one/project'),b=repo('two/project');for(const p of [a,b])execFileSync('git',['-C',p,'remote','add','origin','https://example.invalid/team/project']);
 assert.notEqual(workflowLocation(a).key,workflowLocation(b).key);
});
test('linked Git worktrees share the common repository identity',()=>{
 const a=repo('main');execFileSync('git',['-C',a,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','Fixture']);
 const worktree=path.join(root,'worktree');execFileSync('git',['-C',a,'worktree','add','--detach','-q',worktree]);
 assert.deepEqual(workflowLocation(a),workflowLocation(worktree));
});
test('replacing a repository at the same path changes its identity',()=>{
 const a=repo('a'),before=workflowLocation(a);fs.renameSync(path.join(a,'.git'),path.join(root,'retired-git'));
 execFileSync('git',['init','-q',a]);assert.notEqual(workflowLocation(a).key,before.key);
});
test('non-Git directories have distinct folder identities',()=>{
 const a=path.join(root,'a'),b=path.join(a,'b');fs.mkdirSync(b,{recursive:true});
 assert.equal(workflowLocation(a).kind,'folder');assert.equal(workflowLocation(a).path,a);assert.notEqual(workflowLocation(a).key,workflowLocation(b).key);
});
test('missing directories and broken Git markers are unavailable, not claimed as non-Git',()=>{
 assert.equal(workflowLocation(path.join(root,'missing')).kind,'unavailable');
 fs.writeFileSync(path.join(root,'.git'),'gitdir: /nonexistent-workflow-fixture');assert.equal(workflowLocation(root).kind,'unavailable');
});
