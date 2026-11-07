const fs=require('node:fs');
const {runTrayWorker}=require('../../dist/tray/worker');
void runTrayWorker((state,action)=>{
 let done;const exited=new Promise(resolve=>done=resolve);
 const timer=setInterval(()=>{
  if(fs.existsSync(process.env.DRAKEN_TRAY_TEST_ACTION)){const value=fs.readFileSync(process.env.DRAKEN_TRAY_TEST_ACTION,'utf8');fs.unlinkSync(process.env.DRAKEN_TRAY_TEST_ACTION);if(value==='crash'){clearInterval(timer);done();}else action(value);}
  try{if(JSON.parse(fs.readFileSync(state,'utf8')).quit){clearInterval(timer);done();}}catch{}
 },30);
 return {ready:Promise.resolve(),exited,async close(){clearInterval(timer);done();}};
},()=>{}).catch(error=>{console.error(error);process.exitCode=1});
