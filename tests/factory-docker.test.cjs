const {test}=require('node:test'),assert=require('node:assert/strict');
const {assertDockerHost,dockerIsolation}=require('../dist/factory/docker');
test('ordinary bridge networking retains filesystem isolation and resource limits',()=>{
 const info={SecurityOptions:['name=rootless','name=seccomp,profile=builtin'],MemoryLimit:true,PidsLimit:true,CpuCfsQuota:true},image='sha256:'+'a'.repeat(64);
 assertDockerHost(info,'unix:///test.sock',image);for(const flag of ['MemoryLimit','PidsLimit','CpuCfsQuota'])assert.throws(()=>assertDockerHost({...info,[flag]:false},'unix:///test.sock',image),/enforcement/);
 assert.throws(()=>assertDockerHost({...info,SecurityOptions:[]},'unix:///test.sock',image),/Rootless/);assert.throws(()=>assertDockerHost(info,'tcp://remote',image),/local/);assert.throws(()=>assertDockerHost(info,'unix:///test.sock','node:latest'),/pinned/);
 const args=dockerIsolation('owned','bridge','run');for(const flag of ['--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--init','--memory=4096m'])assert.ok(args.includes(flag));
 assert.equal(args[args.indexOf('--user')+1],'65532:65532');assert.equal(args[args.indexOf('--network')+1],'bridge');assert.ok(!args.join().includes('type=bind'));assert.ok(!args.includes('--privileged'));
});
