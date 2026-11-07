// Static public files only: no application server, database or agent histories.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('@playwright/test');
const root=path.join(__dirname,'../site');
const files=new Set(['/index.html','/site.css','/site.js','/img/logo.png','/img/dragon.webp']);
const types={'.html':'text/html','.css':'text/css','.js':'text/javascript','.png':'image/png','.webp':'image/webp'};
let server,browser,base;
before(async()=>{
 server=http.createServer((req,res)=>{
  const name=req.url==='/'?'/index.html':req.url;
  if(req.method!=='GET'||!files.has(name)){res.writeHead(404).end();return;}
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'");
  res.setHeader('Permissions-Policy','microphone=(), camera=()');
  res.setHeader('Content-Type',types[path.extname(name)]+'; charset=utf-8');
  res.end(fs.readFileSync(path.join(root,name)));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true});
});
after(async()=>{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}});
for(const width of [320,390,768,1440])test(`public page at ${width}px: readable layout, honest release notice, no external requests or capture`,async()=>{
 const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'}),external=[],errors=[],failed=[];
 try{
  page.on('request',request=>{if(new URL(request.url()).origin!==base)external.push(request.url());});
  page.on('pageerror',error=>errors.push(error.message));page.on('response',response=>{if(response.status()>=400)failed.push(response.url());});
  await page.addInitScript(()=>{window.__captures=0;navigator.mediaDevices.getUserMedia=async()=>{window.__captures++;throw Error('No capture allowed');};});
  await page.goto(base);await page.getByRole('heading',{level:1}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.match(await page.locator('#get-started').innerText(),/not published yet/);
  assert.match(await page.locator('.release-note').innerText(),/0\.1\.6.*old task dashboard/);
  await page.getByRole('button',{name:'Inspect source E03',exact:true}).click();
  assert.match(await page.locator('#source-quote').innerText(),/Deployment has not been checked/);
  assert.equal(await page.getByRole('button',{name:'Inspect source E03',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Inspect source E01',exact:true}).focus();await page.keyboard.press('Enter');
  assert.match(await page.locator('#source-quote').innerText(),/bounded retry/);
  await page.getByText('Do I have to use voice?',{exact:false}).click();
  assert.match(await page.locator('.faq details[open]').innerText(),/without a microphone/);
  assert.equal(await page.evaluate(()=>window.__captures),0);
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);
 }finally{await page.close();}
});
