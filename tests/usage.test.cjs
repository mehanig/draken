const {test}=require('node:test'),assert=require('node:assert/strict'),DB=require('better-sqlite3');
const {preparationUsage}=require('../dist/sync/usage');
const now=Date.parse('2026-01-15T12:30:00.000Z');
function fixture(){const d=new DB(':memory:');d.exec('CREATE TABLE sync_runs(id INTEGER PRIMARY KEY,sync_id INTEGER,question TEXT,status TEXT,started_at TEXT,completed_at TEXT,invocations INTEGER,metrics_json TEXT,total_entries INTEGER)');return d;}
function metric(at,cost,complete=true){return{started_at:at,status:'completed',accounting:{source:'pi-usage/catalog-pricing',cost_usd:cost,complete}};}
function run(d,id,sync,start,end,metrics,extra={}){const r={question:null,status:'completed',invocations:metrics.length,entries:64,...extra};d.prepare('INSERT INTO sync_runs VALUES (?,?,?,?,?,?,?,?,?)').run(id,sync,r.question,r.status,start,end,r.invocations,JSON.stringify(metrics),r.entries);}
test('usage bins count first successful snapshots once and include retry costs, unknown usage and legacy timing',()=>{
 const d=fixture();try{
 run(d,1,1,'2026-01-14T10:00:00.000Z','2026-01-14T13:10:00.000Z',[metric('2026-01-14T12:29:59.999Z',100),metric('2026-01-14T13:00:00.000Z',.25)]);
 const legacy=metric(undefined,.5,false);run(d,2,2,'2026-01-14T13:30:00.000Z','2026-01-14T13:31:00.000Z',[legacy],{invocations:2});
 run(d,3,1,'2026-01-14T14:00:00.000Z','2026-01-14T14:05:00.000Z',[metric('2026-01-14T14:00:00.000Z',.1)],{status:'failed'});
 run(d,4,1,'2026-01-14T15:00:00.000Z','2026-01-14T15:02:00.000Z',[metric('2026-01-14T15:00:00.000Z',.2)]);
 run(d,5,5,'2026-01-14T16:00:00.000Z','2026-01-14T16:02:00.000Z',[metric('2026-01-14T16:00:00.000Z',1000)],{question:'Excluded chat'});
 run(d,6,6,'2026-01-15T12:00:00.000Z',null,[{started_at:'2026-01-15T12:01:00.000Z',status:'running'}],{status:'running'});
 run(d,7,7,'2026-01-14T12:30:00.000Z','2026-01-14T12:31:00.000Z',[metric('2026-01-14T12:30:00.000Z',.05)]);
 run(d,8,8,'2026-01-15T12:30:00.000Z','2026-01-15T12:30:00.000Z',[metric('2026-01-15T12:30:00.000Z',1000)]);
 const before=d.prepare('SELECT total_changes() n').get().n;const data=preparationUsage(d,{range:'1d',bucket:'1h'},now);
 assert.equal(data.totals.completed_batches,3);assert.equal(data.totals.entries,192);assert.equal(data.totals.requests,7);assert.ok(Math.abs(data.totals.cost.usd-1.1)<1e-10);assert.equal(data.totals.cost.complete,false);assert.equal(data.totals.incomplete_pricing,3);assert.equal(data.totals.approximate_timing,2);assert.equal(data.totals.failed_attempts,1);assert.equal(data.active_attempts,1);
 assert.equal(data.buckets.length,25);assert.equal(data.buckets[0].from,data.from);assert.equal(data.buckets.at(-1).to,data.to);assert.equal(data.buckets.at(-1).cost.usd,null,'In-flight usage is not free');assert.equal(data.buckets.reduce((n,b)=>n+b.requests,0),7);assert.equal(d.prepare('SELECT total_changes() n').get().n,before);
 }finally{d.close();}
});
test('all range/bucket combinations are bounded, UTC-aligned, contiguous and include partial edge buckets',()=>{const d=fixture();try{for(const range of ['6h','1d','7d','14d'])for(const bucket of ['1h','6h','24h']){const v=preparationUsage(d,{range,bucket},now);assert.ok(v.buckets.length>=1&&v.buckets.length<=337);assert.deepEqual(v.totals.cost,{usd:0,complete:true});assert.equal(v.buckets[0].from,v.from);assert.equal(v.buckets.at(-1).to,v.to);for(let i=1;i<v.buckets.length;i++)assert.equal(v.buckets[i-1].to,v.buckets[i].from);}}finally{d.close();}});
test('missing historical accounting is unavailable, not recomputed from today’s prices; invalid queries and metadata fail visibly',()=>{const d=fixture();try{run(d,1,1,'2026-01-15T10:00:00.000Z','2026-01-15T10:10:00.000Z',[],{invocations:3});assert.deepEqual(preparationUsage(d,{},now).totals.cost,{usd:null,complete:false});for(const query of [{range:'30d'},{bucket:'2h'},{range:['7d','1d']},{bucket:'__proto__'},{extra:'x'}])assert.throws(()=>preparationUsage(d,query,now),/Choose a range/);d.prepare("UPDATE sync_runs SET metrics_json='{}'").run();assert.throws(()=>preparationUsage(d,{},now),/metadata could not be read/);}finally{d.close();}});
test('a cached zero-request preparation counts once and a later rebuild does not recount it in another window',()=>{const d=fixture();try{run(d,1,1,'2026-01-01T10:00:00.000Z','2026-01-01T10:01:00.000Z',[]);run(d,2,1,'2026-01-15T10:00:00.000Z','2026-01-15T10:01:00.000Z',[metric('2026-01-15T10:00:00.000Z',.2)]);const data=preparationUsage(d,{range:'1d'},now);assert.equal(data.totals.completed_batches,0);assert.equal(data.totals.cost.usd,.2);assert.equal(preparationUsage(d,{range:'14d'},now).totals.completed_batches,0);}finally{d.close();}});
