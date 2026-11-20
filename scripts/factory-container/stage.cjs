// Trusted stage implementation. The model chooses capability IDs, never commands or Docker flags.
const fs=require('node:fs'),path=require('node:path'),{execFile}=require('node:child_process');
const {setTimeout:pause}=require('node:timers/promises');
const read=id=>JSON.parse(fs.readFileSync(`/inputs/${id}/report.json`,'utf8'));
const ok=(detail,evidence=['container check'])=>({ok:true,detail,evidence});
const check=(value,detail,evidence)=>({ok:!!value,detail,evidence});
const remote=(url,options)=>fetch('http://egress:8080/fetch?url='+encodeURIComponent(url),options);
async function json(url){const r=await remote(url,{redirect:'error',signal:AbortSignal.timeout(30000),headers:{'User-Agent':'Draken-Factory','Accept':'application/json'}});if(!r.ok)throw Error(`HTTP ${r.status} from ${new URL(url).host}`);return r.json();}
function command(binary,args,allowed=[0]){return new Promise((resolve,reject)=>execFile(binary,args,{cwd:'/tmp',timeout:120000,maxBuffer:4_000_000},(error,stdout,stderr)=>{
 if(error&&!allowed.includes(error.code))return reject(Error(`Command failed: ${path.basename(binary)} (${error.code})`));resolve({code:error?.code||0,stdout,stderr});
}));}
async function execute({capability:id,invocation}){
 const {version,package:pkg,githubRepository}=invocation.task.inputs;
 if(pkg!=='draken'||githubRepository!=='mehanig/draken'||!/^\d+\.\d+\.\d+$/.test(version))throw Error('Task is outside the configured repository/package policy');
 fs.mkdirSync('/tmp/home',{recursive:true});
 const verified={
  'check-registry':()=>{const r=read('registry');return r.exact.version===version&&r.latest.version===version&&/^sha512-/.test(r.exact.dist.integrity)&&!!r.exact.dist.attestations?.provenance;},
  'check-install':()=>{const root='/inputs/install/install',r=read('install'),manifest=JSON.parse(fs.readFileSync(`${root}/node_modules/draken/package.json`)),lock=JSON.parse(fs.readFileSync(`${root}/package-lock.json`));
   return manifest.version===version&&r.cli.code===0&&r.cli.stdout.trim()===`draken ${version}`&&lock.packages['node_modules/draken'].integrity===read('registry').exact.dist.integrity&&['dist/factory/learning.js','public/index.html'].every(file=>fs.existsSync(`${root}/node_modules/draken/${file}`));},
  'check-audit':()=>{const r=read('audit');return r.code===0&&r.report.metadata?.vulnerabilities?.total===0;},
  'check-release':()=>{const r=read('release'),success=runs=>runs.some(run=>run.head_sha===r.commit&&run.status==='completed'&&run.conclusion==='success');return r.release.tag_name===`v${version}`&&!r.release.draft&&!r.release.prerelease&&!!r.release.published_at&&success(r.runs)&&success(r.website)&&r.site.status===200&&typeof r.site.body==='string'&&r.site.body.includes(`Version ${version} / Available on npm`);}
 };
 if(id==='input')return {outcome:ok('Task applicability checked',[`draken@${version}; mehanig/draken`])};
 if(verified[id])return {outcome:check(verified[id](),`${id}: independent read-only artifact check`,['prior-stage artifacts mounted read-only'])};
 if(id==='complete')return {outcome:check(Object.values(verified).every(fn=>fn()),'All release endpoint checks independently repeated',['registry, installed files, production audit, publication and website'])};
 let receipt;
 if(id==='prepare')receipt={isolated:true,uid:process.getuid(),lifecycleScripts:false};
 else if(id==='registry')receipt={exact:await json(`https://registry.npmjs.org/draken/${version}`),latest:await json('https://registry.npmjs.org/draken/latest')};
 else if(id==='install'){
  await command('npm',['install','--prefix','/out/install',`draken@${version}`,'--omit=dev','--ignore-scripts','--no-audit','--no-fund']);
  receipt={cli:await command(process.execPath,['/out/install/node_modules/draken/dist/cli.js','--version'])};
 }else if(id==='audit'){
  const r=await command('npm',['audit','--prefix','/inputs/install/install','--omit=dev','--json'],[0,1]);receipt={code:r.code,report:JSON.parse(r.stdout)};
 }else if(id==='release'){
  const base='https://api.github.com/repos/mehanig/draken',release=await json(`${base}/releases/tags/v${version}`),tag=await json(`${base}/git/ref/tags/v${version}`);
  const commit=tag.object.type==='tag'?(await json(`${base}/git/tags/${tag.object.sha}`)).object.sha:tag.object.sha;
  let runs,website;const success=values=>values.some(run=>run.head_sha===commit&&run.status==='completed'&&run.conclusion==='success');
  const trim=values=>values.map(({id,html_url,head_sha,status,conclusion})=>({id,html_url,head_sha,status,conclusion}));
  for(let i=0;i<20;i++){
   runs=trim((await json(`${base}/actions/workflows/release.yml/runs?branch=v${version}&event=push&per_page=100`)).workflow_runs);
   website=trim((await json(`${base}/actions/workflows/web-deploy.yml/runs?branch=master&per_page=100`)).workflow_runs);
   if((success(runs)&&success(website))||![...runs,...website].some(run=>run.head_sha===commit&&run.status!=='completed'))break;await pause(3000);
  }
  const site=await remote('https://draken.mehanig.com',{redirect:'error',signal:AbortSignal.timeout(30000)});
  receipt={release:{tag_name:release.tag_name,published_at:release.published_at,draft:release.draft,prerelease:release.prerelease,html_url:release.html_url},commit,runs,website,site:{status:site.status,body:await site.text()}};
 }else throw Error('Unknown registered stage');
 fs.writeFileSync('/out/report.json',JSON.stringify(receipt));
 return {outcome:ok(`${id}: action completed`,['/out/report.json']),receipt};
}
if(require.main===module){let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>{input+=part;if(input.length>64000)process.exit(2);});process.stdin.on('end',()=>execute(JSON.parse(input)).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;}));}
