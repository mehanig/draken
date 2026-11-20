const crypto=require('node:crypto');
const pinned=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(value);
function validate(value,approvedImages){
 if(!value||value.schema!==1||Object.keys(value).some(key=>!['schema','image','setup','checks'].includes(key)))throw Error('Unsupported environment definition');
 if(!pinned(value.image)||!approvedImages.includes(value.image))throw Error('Environment image is not approved by the host');
 for(const key of ['setup','checks']){
  if(!Array.isArray(value[key])||value[key].length>12||(key==='checks'&&!value[key].length))throw Error('Environment requires one to twelve checks and at most twelve setup commands');
  for(const command of value[key]){
   if(!command||Object.keys(command).some(k=>!['name','argv','cwd'].includes(k))||typeof command.name!=='string'||!command.name.trim()||command.name.length>160
    ||!Array.isArray(command.argv)||!command.argv.length||command.argv.length>64||command.argv.some(a=>typeof a!=='string'||a.length>8000||a.includes('\0')))throw Error('Invalid environment command');
   if(command.cwd!==undefined&&(typeof command.cwd!=='string'||!/^\.(?:\/[a-zA-Z0-9_.-]+)*$/.test(command.cwd)||command.cwd.split('/').includes('..')))throw Error('Command directory must stay inside the checkout');
  }
 }
 return structuredClone(value);
}
const fingerprint=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
module.exports={validate,pinned,fingerprint};
