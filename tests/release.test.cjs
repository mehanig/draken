const {test}=require('node:test'),assert=require('node:assert/strict');
const {releaseVersion}=require('../scripts/release-version.cjs');
test('the actual committed package and lock agree on the release version',()=>{
 const pkg=require('../package.json'),lock=require('../package-lock.json');
 assert.equal(releaseVersion({event:'push',ref:`refs/tags/v${pkg.version}`,version:pkg.version,lockVersion:lock.version,lockRootVersion:lock.packages[''].version}),pkg.version);
});
test('release versions are literal, committed, stable, and from the intended ref',()=>{
 const base={event:'workflow_dispatch',ref:'refs/heads/master',input:'0.2.0',version:'0.2.0',lockVersion:'0.2.0',lockRootVersion:'0.2.0'};
 assert.equal(releaseVersion(base),'0.2.0');
 assert.equal(releaseVersion({...base,event:'push',ref:'refs/tags/v0.2.0'}),'0.2.0');
 for(const input of ['0.2.0; echo injected','$(echo injected)','0.2.0\nOTHER=value','0.2.0\n','01.2.0','v0.2.0','latest','0.2.0-beta.1',' 0.2.0','0.2.0 ','999999999999999.0.0'])assert.throws(()=>releaseVersion({...base,input}));
 for(const changed of [{version:'0.1.6'},{lockVersion:'0.1.6'},{lockRootVersion:'0.1.6'},{ref:'refs/heads/feature'},{event:'pull_request'},{event:'push',ref:'refs/tags/v0.3.0'}])assert.throws(()=>releaseVersion({...base,...changed}));
});
