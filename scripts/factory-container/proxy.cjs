// HTTPS request broker, NOT a CONNECT tunnel. Workers have only an internal Docker network.
// The broker fixes DNS/IP, TLS server name and Host together, preventing domain-fronting bypasses.
const http=require('node:http'),https=require('node:https'),tls=require('node:tls'),net=require('node:net'),dns=require('node:dns').promises;
const allowed=new Set((process.env.ALLOWED_HOSTS||'').split(',').filter(Boolean));
function publicIPv4(ip){
 if(net.isIP(ip)!==4)return false;const [a,b]=ip.split('.').map(Number);
 return !([0,10,127].includes(a)||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0))||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19)));
}
function createProxy(hosts,lookup=dns.lookup){
 const server=http.createServer(async(request,response)=>{
  try{
   const local=new URL(request.url,'http://egress:8080'),npm=local.pathname.startsWith('/npm/');
   const target=npm?new URL(local.pathname.slice(5)+local.search,'https://registry.npmjs.org/'):local.pathname==='/fetch'?new URL(local.searchParams.get('url')):null;
   if(!target||(npm&&target.hostname!=='registry.npmjs.org')||target.protocol!=='https:'||target.username||target.password||(target.port&&target.port!=='443')||!hosts.has(target.hostname))throw Error('Target denied');
   const audit=npm&&request.method==='POST'&&['/-/npm/v1/security/advisories/bulk','/-/npm/v1/security/audits/quick'].includes(target.pathname);
   if(!['GET','HEAD'].includes(request.method)&&!audit)throw Error('Method denied');
   const resolved=await lookup(target.hostname,{family:4,all:true});if(!resolved.length||resolved.some(value=>!publicIPv4(value.address)))throw Error('Private address denied');
   let size=0;const chunks=[];for await(const chunk of request){size+=chunk.length;if(size>2_000_000)throw Error('Request too large');chunks.push(chunk);}const body=Buffer.concat(chunks);
   const headers={Host:target.hostname,'User-Agent':'Draken-Factory','Accept':npm?(request.headers.accept||'application/json'):'*/*','Accept-Encoding':'identity'};
   if(body.length){headers['Content-Length']=String(body.length);headers['Content-Type']='application/json';}
   if(request.headers['content-encoding']){if(!audit||request.headers['content-encoding']!=='gzip')throw Error('Content encoding denied');headers['Content-Encoding']='gzip';}
   const upstream=https.request({hostname:resolved[0].address,port:443,path:target.pathname+target.search,method:request.method,
    servername:target.hostname,checkServerIdentity:(_,certificate)=>tls.checkServerIdentity(target.hostname,certificate),headers,timeout:30000},incoming=>{
    if(incoming.statusCode>=300&&incoming.statusCode<400){incoming.destroy();response.writeHead(502).end('Redirect denied');return;}
    let count=0;const parts=[],rewrite=npm&&request.method!=='HEAD'&&(incoming.headers['content-type']||'').includes('json');
    if(!rewrite)response.writeHead(incoming.statusCode,{'Content-Type':incoming.headers['content-type']||'application/octet-stream'});
    incoming.on('data',chunk=>{count+=chunk.length;if(count>(rewrite?16_000_000:128_000_000)){incoming.destroy();response.destroy();return;}if(rewrite)parts.push(chunk);else if(!response.write(chunk)){incoming.pause();response.once('drain',()=>incoming.resume());}});
    incoming.on('end',()=>{try{
     if(rewrite){const value=JSON.parse(Buffer.concat(parts).toString('utf8'));const encoded=JSON.stringify(value,(key,value)=>{
      if(key==='tarball'&&typeof value==='string'){const url=new URL(value);if(url.protocol!=='https:'||url.hostname!=='registry.npmjs.org'||url.username||url.password||url.port)throw Error('External package tarball denied');return 'http://egress:8080/npm'+url.pathname+url.search;}return value;
     });response.writeHead(incoming.statusCode,{'Content-Type':'application/json'});response.end(encoded);
     }else response.end();
    }catch{if(!response.headersSent)response.writeHead(502);response.end('Invalid upstream response');}});
    incoming.on('error',()=>response.destroy());
   });
   upstream.on('timeout',()=>upstream.destroy());upstream.on('error',()=>{if(!response.headersSent)response.writeHead(502);response.end('Upstream request failed');});response.on('close',()=>upstream.destroy());upstream.end(body);
  }catch{if(!response.headersSent)response.writeHead(403);response.end('Request denied');}
 });
 server.on('connect',(_,socket)=>socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'));
 return server;
}
module.exports={publicIPv4,createProxy};
if(require.main===module)createProxy(allowed).listen(8080,'0.0.0.0',()=>console.log('proxy-ready'));
