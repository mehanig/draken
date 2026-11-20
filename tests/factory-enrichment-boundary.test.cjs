const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
test('enrichment has only internal imports and works outside Draken with injected hosts',()=>{
 const root=path.resolve(__dirname,'..'),source=path.join(root,'src/factory-enrichment');
 for(const file of fs.readdirSync(source)){
  const text=fs.readFileSync(path.join(source,file),'utf8');
  for(const match of text.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g))assert.match(match[1],/^\.\/(?:contracts|enrich|runner|session)$/,`${file}: ${match[1]}`);
 }
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'factory-enrichment-proof-'));
 try{
  fs.mkdirSync(path.join(temp,'src'),{recursive:true});fs.cpSync(source,path.join(temp,'src/factory-enrichment'),{recursive:true});
  fs.mkdirSync(path.join(temp,'tests/fixtures'),{recursive:true});fs.mkdirSync(path.join(temp,'types'));
  fs.copyFileSync(path.join(root,'tests/fixtures/factory-enrichment-contract.ts'),path.join(temp,'tests/fixtures/contract.ts'));
  execFileSync(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'--strict','--target','ES2022','--module','commonjs','--lib','ES2022,DOM','--typeRoots',path.join(temp,'types'),'--outDir',path.join(temp,'out'),path.join(temp,'tests/fixtures/contract.ts')],{cwd:temp});
  assert.match(execFileSync(process.execPath,[path.join(temp,'out/tests/fixtures/contract.js')],{cwd:temp,encoding:'utf8'}),/Standalone enrichment and execution proof passed/);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
