// Synthetic-only instrumentation at the real worker boundary. No production
// environment switch, injected planner, or fake count/result path.
const threads = require('node:worker_threads');
const path = require('node:path');
exports.install = (options = {}) => {
  const Original = threads.Worker, workers = [], events = [];
  const gate = new SharedArrayBuffer(4);
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  threads.Worker = class extends Original {
    constructor(file, config) {
      if (!String(file).endsWith('/preview-worker.js')) { super(file, config); return; }
      super(`require(${JSON.stringify(__filename)}); require(${JSON.stringify(String(file))});`, {
        ...config, eval: true, workerData: { gate, hold: options.hold, action: options.action },
      });
      this.previewDirectory = config.env.DRAKEN_DATA_DIR;
      workers.push(this);
    }
    emit(name, ...args) {
      if (name === 'message' && args[0]?.previewTest) {
        events.push(args[0]);
        if (args[0].previewTest === 'held') enter(this);
        return true;
      }
      if (name === 'message' && args[0]?.counts) options.onResult?.(args[0], this);
      return super.emit(name, ...args);
    }
    async terminate() {
      const code = await super.terminate();
      await options.retirement;
      return code;
    }
  };
  return { workers, events, entered,
    release() { Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0); },
    restore() { threads.Worker = Original; },
  };
};
function inside() {
  const { parentPort, workerData } = threads;
  const send = previewTest => parentPort.postMessage({ previewTest });
  const tree = require('../../dist/sync/tree').SummaryTree;
  const forbidden = () => { send('provider'); throw Error('Synthetic forbidden provider'); };
  tree.prototype.call = forbidden;
  require('../../dist/sync/pi').invokePi = forbidden;
  for (const name of ['prepareHistory', 'searchHistory', 'searchPreparedHistory', 'readHistory']) require('../../dist/memory/service')[name] = forbidden;
  require('../../dist/sync/collector').scanSessions = forbidden;
  require('../../dist/sync/summary-preparation').warmSummaryCache = forbidden;
  const store = require('../../dist/sync/store'), input = store.previewSummaryInput;
  store.previewSummaryInput = () => { send('input'); return input(); };
  const fs = require('node:fs'), open = fs.openSync, close = fs.closeSync, handles = new Set();
  fs.openSync = function(file, ...args) {
    const fd = open.call(this, file, ...args);
    if (String(file).startsWith(process.env.DRAKEN_PI_SESSIONS_DIR + '/')) handles.add(fd);
    return fd;
  };
  fs.closeSync = function(fd) { handles.delete(fd); return close.call(this, fd); };
  const hold = phase => {
    if (workerData.hold !== phase) return;
    send('held');
    Atomics.wait(new Int32Array(workerData.gate), 0, 0);
  };
  if (workerData.action === 'freezeError') require('../../dist/db/evidence').EvidenceReader.prototype.freeze = () => { throw Error('Synthetic freeze failure'); };
  if (workerData.action === 'noReplay') require('../../dist/sync/reusable-leaves').HistoricalLeafReplay.prototype.replay = () => { throw Error('Recovered receipts must avoid archive replay'); };
  const counts = tree.prototype.previewCounts;
  tree.prototype.previewCounts = async function(...args) {
    hold('before');
    if (workerData.action === 'crash') process.exit(9);
    if (workerData.action === 'error') throw Error('Synthetic worker error: private sentinel');
    if (workerData.action === 'write') require('../../dist/db/schema').getDb().prepare("UPDATE sync_settings SET value='forbidden'").run();
    try { return await counts.apply(this, args); }
    finally { send(handles.size ? 'leaked-handles' : 'closed-handles'); hold('after'); }
  };
  const final = tree.prototype.verifyFinal;
  tree.prototype.verifyFinal = function() { final.call(this); send(handles.size ? 'leaked-handles' : 'closed-handles'); };
}
if (!threads.isMainThread) inside();
