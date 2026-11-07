const {test,afterEach}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const threads=require('node:worker_threads'),os=require('node:os');
const original={Worker:threads.Worker,cpus:os.availableParallelism,memory:process.availableMemory};
let pool;
afterEach(async()=>{await pool?.close();pool=undefined;threads.Worker=original.Worker;os.availableParallelism=original.cpus;process.availableMemory=original.memory;});
function mock(options={}){
 let alive=0,active=0,max=0,created=0;const workers=[];
 os.availableParallelism=()=>options.cpus??12;process.availableMemory=()=>options.memory??8*1024**3;
 threads.Worker=class extends EventEmitter{
  stdout={resume(){}};stderr={resume(){}};dead=false;
  constructor(file,config){super();created++;alive++;this.config=config;workers.push(this);assert.match(file,/embedding-worker\.js$/);assert.deepEqual(config.execArgv,[]);assert.ok(!('DRAKEN_PASSWORD'in config.env));}
  postMessage(m){active++;max=Math.max(max,active);setTimeout(()=>{active--;if(this.dead)return;if(options.fail){this.emit('error',Error('private source text'));return;}const vector=new Float32Array(384);vector[0]=Number(m.text);this.emit('message',{id:options.wrongId?m.id+1:m.id,vector:vector.buffer});},options.delay??Number(m.text)%3+1);}
  async terminate(){if(this.dead)return 0;this.dead=true;await new Promise(r=>setTimeout(r,5));alive--;this.emit('exit',0);return 0;}
 };
 pool=new(require('../dist/memory/embedding-pool').EmbeddingPool)('/synthetic/model');
 return{workers,get max(){return max},get alive(){return alive},get created(){return created}};
}
test('lazy bounded lanes preserve batch order and never add unbounded queues',async()=>{
 const state=mock();assert.equal(state.created,0);assert.deepEqual(pool.parallelism,{workers:2,threads:6});
 const values=await pool.embedMany(['1','2','3','4','5','6','7','8']);assert.deepEqual(values.map(v=>v[0]),[1,2,3,4,5,6,7,8]);assert.equal(state.max,2);assert.equal(state.created,2);
 assert.ok(state.workers.every(w=>w.config.workerData.threads===3));
 const work=pool.embedMany(['1','2']);await assert.rejects(pool.embed('3',true),/overlapping/);await work;
 await assert.rejects(pool.embedMany(Array(9).fill('1')),/Invalid/);await pool.close();assert.equal(state.alive,0);
});
test('small or memory-constrained machines keep one lane, and a query starts only one model',async()=>{
 const state=mock({cpus:8});assert.deepEqual(pool.parallelism,{workers:1,threads:4});await pool.embedMany(['1','2','3']);assert.equal(state.max,1);await pool.close();
 const limited=mock({memory:1024**3});assert.equal(pool.parallelism.workers,1);await pool.close();
 const ample=mock();await pool.embed('1',true);await pool.embedMany(['1','2','3'],false);assert.equal(ample.created,1);assert.equal(limited.created,0);
});
test('failure terminates all lanes before an explicit retry; no fallback or private error text',async()=>{
 const options={fail:true},state=mock(options);await assert.rejects(pool.embedMany(['1','2','3','4','5','6','7','8']),e=>/worker failed/.test(e.message)&&!e.message.includes('private source'));assert.equal(state.alive,0);
 options.fail=false;assert.equal((await pool.embed('3',true))[0],3);assert.equal(state.alive,1);
});
test('stale worker responses fail closed and explicit cancellation retires every thread',async()=>{
 const options={wrongId:true},state=mock(options);await assert.rejects(pool.embedMany(['1','2']),/worker failed/);assert.equal(state.alive,0);
 options.wrongId=false;options.delay=100;const work=pool.embedMany(['1','2']);const rejected=assert.rejects(work,/worker failed/);await new Promise(r=>setImmediate(r));assert.equal(state.alive,2);await pool.close();await rejected;assert.equal(state.alive,0);
});
