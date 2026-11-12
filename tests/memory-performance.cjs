// Optional real-WASM benchmark: same pinned model/inputs/cache fingerprint.
// Synthetic data only, existing weights, no application DB/download/provider.
const assert=require('node:assert/strict'),path=require('node:path'),{execFileSync}=require('node:child_process');
const modelDir=process.argv.find(arg=>arg.startsWith('--model-dir='))?.slice(12);
if(!modelDir)throw Error('Pass --model-dir=<existing pinned test model directory>');
const {modelFilesPresent}=require('../dist/memory/model-assets');
const {MODEL_ID}=require('../dist/memory/model-files');
if(!modelFilesPresent(path.resolve(modelDir)))throw Error('Model absent. Pass --model-dir=<existing pinned test model directory>; this benchmark never downloads weights.');
if(process.argv.includes('--child')){
 const baseline=process.argv.includes('--baseline');
 const Model=baseline?require('../dist/memory/model').LocalEmbedder:require('../dist/memory/embedding-pool').EmbeddingPool;
 const threads=Math.min(4,require('node:os').availableParallelism());
 const model=new Model(path.resolve(modelDir),...(baseline?[threads]:[]));
 const samples=Array.from({length:48},(_,i)=>[
  'Deployment remains a proposal, not a verified release. Preserve the SQLite snapshots and inspect the authenticated health endpoint. Synthetic tests passed but production was NOT checked. ',
  `export async function collectRecords(db,source){const rows=db.prepare("SELECT id,hash FROM passages WHERE embedded=0 ORDER BY id").all();for(const row of rows){await index(row);}} // synthetic revision ${i} `,
  `2026-01-02T12:34:56.789Z INFO build_step=compile status=pending request_id=synthetic_${i} module=/demo/src/release.ts\nHTTP/1.1 403 Forbidden\nassert.strictEqual(actual,expected); expected=200 received=403\n`,
  'Проверка развертывания не выполнялась. Изменения предложены, но решение не принято. 変更は提案だけで、デプロイは未確認です。 '
 ][i%4].repeat(10).slice(0,800));
 const embed=async texts=>{if(model.embedMany)return model.embedMany(texts);const out=[];for(const text of texts)out.push(await model.embed(text,false));return out;};
 (async()=>{try{
  global.fetch=()=>{throw Error('Unexpected network');};
  await embed(samples.slice(0,8));const start=performance.now(),vectors=[];
  for(let i=0;i<samples.length;i+=8)vectors.push(...await embed(samples.slice(i,i+8)));
  const ms=performance.now()-start;
  // Long multilingual input crosses token windows; query prefix stays distinct.
  vectors.push(await model.embed('日'.repeat(1100)+' Deployment NOT checked.',false));
  vectors.push(await model.embed('Was the deployment checked?',true));
  console.log(JSON.stringify({ms,parallelism:baseline?{workers:1,threads}:model.parallelism,rss:process.memoryUsage().rss,fingerprint:baseline?MODEL_ID:model.fingerprint,vectors:Buffer.concat(vectors.map(v=>Buffer.from(v.buffer,v.byteOffset,v.byteLength))).toString('base64')}));
 }finally{await model.close?.();}})().catch(e=>{console.error(e);process.exitCode=1;});
}else{
 const run=baseline=>JSON.parse(execFileSync(process.execPath,[__filename,'--child',...(baseline?['--baseline']:[]),'--model-dir='+path.resolve(modelDir)],{encoding:'utf8',timeout:180000,maxBuffer:1000000}));
 const baseline=run(true),parallel=run(false);assert.equal(baseline.fingerprint,parallel.fingerprint);
 const vector=r=>new Float32Array(Uint8Array.from(Buffer.from(r.vectors,'base64')).buffer),a=vector(baseline),b=vector(parallel);assert.equal(a.length,b.length);
 let cosine=1;for(let start=0;start<a.length;start+=384){let dot=0,aa=0,bb=0;for(let i=start;i<start+384;i++){dot+=a[i]*b[i];aa+=a[i]**2;bb+=b[i]**2;}cosine=Math.min(cosine,dot/Math.sqrt(aa*bb));}
 assert.ok(cosine>0.99999,'Existing embeddings must remain compatible');assert.ok(parallel.parallelism.workers<=2&&parallel.parallelism.threads<=6);
 console.log(JSON.stringify({syntheticPassages:48,charactersPerPassage:800,additionalLongAndQueryChecks:2,baselineMs:Math.round(baseline.ms),parallelMs:Math.round(parallel.ms),parallelism:parallel.parallelism,speedup:+(baseline.ms/parallel.ms).toFixed(2),minimumCosine:cosine,byteIdentical:baseline.vectors===parallel.vectors,rssBytes:parallel.rss,existingCacheCompatible:true,productionDataUsed:false,qualification:'Warm embedding throughput on this host, not a promise about total sync time or retrieval correctness.'},null,2));
}
