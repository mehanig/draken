// Public HTTPS reads, not a CONNECT tunnel. Workers remain on an internal Docker network.
// Every redirect gets a fresh public-IP check; connection IP, TLS name and Host are fixed together.
const http=require('node:http'),https=require('node:https'),tls=require('node:tls'),net=require('node:net'),dns=require('node:dns').promises;
function publicIPv4(ip){
 if(net.isIP(ip)!==4)return false;const [a,b,c]=ip.split('.').map(Number);
 return !([0,10,127].includes(a)||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||(b===0&&(c===0||c===2))||(b===88&&c===99)))||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19||(b===51&&c===100)))||(a===203&&b===0&&c===113));
}
function createProxy({lookup=dns.lookup,requestHTTPS=https.request}={}){
 const server=http.createServer(async(request,response)=>{
  let upstream,closed=false;
  const fail=(code,message)=>{if(response.destroyed)return;if(!response.headersSent)response.writeHead(code);response.end(message);};
  const deadline=setTimeout(()=>{upstream?.destroy();response.destroy();},60000);
  response.on('close',()=>{closed=true;clearTimeout(deadline);upstream?.destroy();});
  try{
   const local=new URL(request.url,'http://egress:8080'),npm=local.pathname.startsWith('/npm/');
   const target=npm?new URL(local.pathname.slice(5)+local.search,'https://registry.npmjs.org/'):local.pathname==='/fetch'?new URL(local.searchParams.get('url')):null;
   const audit=npm&&request.method==='POST'&&['/-/npm/v1/security/advisories/bulk','/-/npm/v1/security/audits/quick'].includes(target?.pathname);
   if(!['GET','HEAD'].includes(request.method)&&!audit)throw Error('Method denied');
   let size=0;const chunks=[];for await(const chunk of request){size+=chunk.length;if(size>2_000_000)throw Error('Request too large');chunks.push(chunk);}const body=Buffer.concat(chunks);
   if(body.length&&!audit)throw Error('Read requests cannot carry bodies');
   if(request.headers['content-encoding']&&(!audit||request.headers['content-encoding']!=='gzip'))throw Error('Content encoding denied');
   async function follow(url,hops){
    if(!url||url.hostname.startsWith('[')||(npm&&url.hostname!=='registry.npmjs.org')||url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))throw Error('Target denied');
    const resolved=await lookup(url.hostname,{family:4,all:true});
    if(!resolved.length||resolved.some(value=>!publicIPv4(value.address)))throw Error('Private address denied');
    if(closed)return;
    // Do not forward caller credentials, cookies, Host, proxy headers or arbitrary headers.
    const headers={Host:url.hostname,'User-Agent':'Draken-Factory','Accept':npm?'application/json':'*/*','Accept-Encoding':'identity'};
    if(body.length){headers['Content-Length']=String(body.length);headers['Content-Type']='application/json';}
    if(request.headers['content-encoding'])headers['Content-Encoding']='gzip';
    const incoming=await new Promise((resolve,reject)=>{
     upstream=requestHTTPS({hostname:resolved[0].address,port:443,path:url.pathname+url.search,method:request.method,
      servername:url.hostname,checkServerIdentity:(_,certificate)=>tls.checkServerIdentity(url.hostname,certificate),headers,timeout:30000},resolve);
     upstream.on('timeout',()=>upstream.destroy(Error('Upstream timeout')));upstream.on('error',reject);upstream.end(body);
    });
    if(incoming.statusCode>=300&&incoming.statusCode<400&&incoming.headers.location){
     incoming.destroy();if(audit||hops>=5){fail(502,'Redirect limit or method denied');return;}
     return follow(new URL(incoming.headers.location,url),hops+1);
    }
    const rewrite=npm&&request.method!=='HEAD'&&(incoming.headers['content-type']||'').includes('json');
    const outputHeaders={'Content-Type':incoming.headers['content-type']||'application/octet-stream','X-Draken-URL':url.href};
    if(!rewrite)response.writeHead(incoming.statusCode,outputHeaders);
    let count=0;const parts=[];
    incoming.on('data',chunk=>{
     count+=chunk.length;if(count>(rewrite?16_000_000:128_000_000)){incoming.destroy();response.destroy();return;}
     if(rewrite)parts.push(chunk);else if(!response.write(chunk)){incoming.pause();response.once('drain',()=>incoming.resume());}
    });
    incoming.on('end',()=>{try{
     if(rewrite){const value=JSON.parse(Buffer.concat(parts).toString('utf8'));const encoded=JSON.stringify(value,(key,value)=>{
      if(key==='tarball'&&typeof value==='string'){const tarball=new URL(value);if(tarball.protocol!=='https:'||tarball.hostname!=='registry.npmjs.org'||tarball.username||tarball.password||tarball.port)throw Error('External package tarball denied');return 'http://egress:8080/npm'+tarball.pathname+tarball.search;}return value;
     });response.writeHead(incoming.statusCode,outputHeaders);response.end(encoded);
     }else response.end();
    }catch{fail(502,'Invalid upstream response');}});
    incoming.on('error',()=>response.destroy());
   }
   await follow(target,0);
  }catch{fail(403,'Request denied or upstream unavailable');}
 });
 server.on('connect',(_,socket)=>socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'));
 return server;
}
module.exports={publicIPv4,createProxy};
if(require.main===module)createProxy().listen(8080,'0.0.0.0',()=>console.log('proxy-ready'));
