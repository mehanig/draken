#!/usr/bin/env node
// Installer fixture, copied to a temporary npm-cli.js. Never used in production.
const fs=require('node:fs'),path=require('node:path');
const controlFile=path.join(__dirname,'control.json'),control=fs.existsSync(controlFile)?JSON.parse(fs.readFileSync(controlFile,'utf8')):{};
fs.appendFileSync(path.join(__dirname,'npm-calls.jsonl'),JSON.stringify({pid:process.pid,args:process.argv.slice(2),cwd:process.cwd(),home:process.env.HOME,agent:process.env.PI_CODING_AGENT_DIR,hasKey:Boolean(process.env.OPENAI_API_KEY),hasPreload:Boolean(process.env.NODE_OPTIONS)})+'\n');
if(control.fail)process.exit(3);
const install=()=>{
 const root=path.join(process.cwd(),'node_modules/@earendil-works/pi-coding-agent');fs.mkdirSync(path.join(root,'dist'),{recursive:true});
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:control.badVersion?'0.0.1':'1.4.0'}));
 fs.writeFileSync(path.join(root,'dist/cli.js'),`const fs=require('fs'),path=require('path');const args=process.argv.slice(2),agent=process.env.PI_CODING_AGENT_DIR||path.join(process.env.HOME,'.pi/agent');
 if(args[0]==='--version'){console.log('1.4.0');process.exit(0);}
 if(args[0]==='auth'){if(!args.includes('--no-refresh')||args.includes('--credentials'))process.exit(2);const ready=fs.existsSync(path.join(agent,'auth.json'));console.log(JSON.stringify({status:ready?'ready':'not_ready',provider:'synthetic',reason:ready?undefined:'credentials_not_configured'}));process.exit(ready?0:1);}
 if(args.includes('--print')){let input='';process.stdin.on('data',part=>input+=part);process.stdin.on('end',()=>{fs.writeFileSync(path.join(agent,'invocation.json'),JSON.stringify({args,input,agent,home:process.env.HOME,hasKey:!!process.env.OPENAI_API_KEY,hasParent:!!process.env.PI_SESSION_ID,hasPreload:!!process.env.NODE_OPTIONS,hasCodexHome:!!process.env.CODEX_HOME}));console.log('Synthetic private summary.');});}else{console.log('Synthetic interactive login');}
 `);
};
if(control.delay)setTimeout(install,control.delay);else install();
