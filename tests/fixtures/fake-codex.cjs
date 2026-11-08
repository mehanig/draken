#!/usr/bin/env node
// Synthetic protocol fixture. Never contacts a provider or runs tools.
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
if (process.argv.includes('--version')) { console.log('codex-cli 0.166.0'); process.exit(0); }
const home = process.env.CODEX_HOME;
const scenario = fs.readFileSync(path.join(home, 'scenario.txt'), 'utf8').trim();
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
let failedLookup = false;
fs.writeFileSync(path.join(home, 'pid'), String(process.pid));
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'PI_SESSION_ID', 'HTTPS_PROXY']) if (process.env[key]) process.exit(7);
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line); fs.appendFileSync(path.join(home, 'requests.jsonl'), JSON.stringify({ method: request.method, params: request.params }) + '\n');
  const result = value => emit({ id: request.id, result: value });
  if (request.method === 'initialize') result({});
  else if (request.method === 'initialized') return;
  else if (request.method === 'account/read') result({ account: { type: scenario === 'api-key' ? 'apiKey' : 'chatgpt' } });
  else if (request.method === 'thread/start') result({ thread: { id: 'synthetic-thread' }, modelProvider: scenario === 'provider-drift' ? 'openai' : 'draken_readonly' });
  else if (request.method === 'thread/realtime/start') {
    if (scenario === 'reject') { emit({ id: request.id, error: { message: 'do-not-leak-this-synthetic-secret' } }); return; }
    if (scenario === 'handoff') { emit({ method: 'turn/started', params: { threadId: 'synthetic-thread' } }); return; }
    const finish = () => { emit({ method: 'thread/realtime/sdp', params: { threadId: 'synthetic-thread', sdp: 'v=0\r\nm=audio 9 test' } }); result({}); };
    if (scenario === 'slow') setTimeout(finish, 1000); else finish();
    if (scenario === 'spoken-recall') setTimeout(() => emit({ method: 'thread/realtime/transcript/done', params: { threadId: 'synthetic-thread', role: 'user', text: 'Recall our previous discussion. What did we decide?' } }), 50);
    if (scenario === 'spoken-stop') setTimeout(() => emit({ method: 'thread/realtime/transcript/done', params: { threadId: 'synthetic-thread', role: 'user', text: 'Stop speaking.' } }), 50);
    if (scenario === 'spoken-ack') setTimeout(() => {
      emit({ method: 'thread/realtime/transcript/done', params: { threadId: 'synthetic-thread', role: 'user', text: 'Can you check the export tests?' } });
      emit({ method: 'thread/realtime/transcript/done', params: { threadId: 'synthetic-thread', role: 'assistant', text: 'I’ll check what’s recorded.' } });
    }, 50);
  } else if (request.method === 'thread/realtime/appendText') {
    result({});
    if (request.params.role === 'developer') failedLookup = request.params.text.includes('Archive lookup failed');
    if (request.params.role !== 'developer' && request.params.text.startsWith('Stop speaking.')) {
      emit({ method: 'thread/realtime/transcript/delta', params: { threadId: 'synthetic-thread', role: 'user', delta: request.params.text } });
      emit({ method: 'thread/realtime/transcript/done', params: { threadId: 'synthetic-thread', role: 'user', text: request.params.text } });
    }
    if (request.params.role === 'user' && scenario === 'refinement') void (async()=>{
      const prefix='model_providers.draken_readonly.base_url=',arg=process.argv.find(value=>value.startsWith(prefix)),url=JSON.parse(arg.slice(prefix.length));
      if(!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(url))throw Error('Fixture permits loopback only');
      const token=JSON.parse(fs.readFileSync(path.join(home,'auth.json'),'utf8')).tokens.access_token;
      emit({method:'thread/realtime/transcript/done',params:{threadId:'synthetic-thread',role:'user',text:request.params.text}});
      for(const detail of [0,0,1,2]){
        const response=await fetch(url+'/responses',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({input:[{role:'system',content:'SYSTEM_INPUT_MUST_NOT_BECOME_A_QUERY'},{role:'user',content:`Find GPS points and recording events, detail ${detail}.`}]})});
        if(!response.ok)throw Error('Synthetic refinement failed');await response.text();
      }
      emit({method:'thread/realtime/transcript/done',params:{threadId:'synthetic-thread',role:'assistant',text:'Synthetic evidence supplied for this question.'}});
    })().catch(()=>process.exit(8));
    if (request.params.role !== 'developer' && ['conversation', 'partial', 'typed-ack', 'spoken-ack'].includes(scenario) && !request.params.text.startsWith('Stop speaking.')) {
      const event = (kind, role, text) => emit({ method: `thread/realtime/transcript/${kind}`, params: { threadId: 'synthetic-thread', role, [kind === 'done' ? 'text' : 'delta']: text } });
      event('delta', 'user', request.params.text); event('done', 'user', request.params.text);
      if (scenario === 'typed-ack') event('done', 'assistant', 'I will check the records.');
      else {
        event('delta', 'assistant', 'The targeted '); event('delta', 'assistant', 'export tests passed. ');
        if (scenario !== 'partial') event('done', 'assistant', 'The targeted export tests passed. Deployment remains unverified.');
      }
    }
  } else if (request.method === 'thread/realtime/appendSpeech') {
    result({});
    emit({ method: 'thread/realtime/transcript/done', params: { threadId: 'synthetic-thread', role: 'assistant', text: failedLookup ? 'Earlier history could not be checked. Deployment remains unverified.' : 'The targeted export tests passed. Deployment remains unverified.' } });
  } else if (request.method === 'thread/realtime/stop') result({});
  else emit({ id: request.id, error: { message: 'Unexpected test method' } });
});
