// Static public files only: no application server, database or agent histories.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('@playwright/test');
const root=path.join(__dirname,'../site');
const version=require('../package.json').version,anchor=version.replaceAll('.','');
test('public release copy and documentation match the npm version',()=>{
 const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
 assert.ok(html.includes(`Version ${version} / Available on npm`));
 assert.ok(html.includes(`CHANGELOG.md#${anchor}`));
 assert.ok(fs.readFileSync(path.join(__dirname,'../README.md'),'utf8').includes(`**Draken ${version}**`));
 assert.ok(fs.readFileSync(path.join(__dirname,'../SETUP.md'),'utf8').includes(`**Draken ${version}**`));
 assert.ok(fs.readFileSync(path.join(__dirname,'../CHANGELOG.md'),'utf8').startsWith(`# Changelog\n\n## ${version}\n`));
});
const files=new Set(['/index.html','/site.css','/site.js','/img/logo.png','/img/dragon.webp']);
const types={'.html':'text/html','.css':'text/css','.js':'text/javascript','.png':'image/png','.webp':'image/webp'};
const unwantedGlyphs=/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u20E3\u2190-\u21FF\u2713\u2261\u25A1]/u;
test('public assets use text and CSS instead of emoji and decorative text icons',()=>{
 for(const file of ['index.html','site.css','site.js'])assert.doesNotMatch(fs.readFileSync(path.join(root,file),'utf8'),unwantedGlyphs,file);
});
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
  assert.doesNotMatch(await page.locator('body').innerText(),unwantedGlyphs);
  assert.ok((await page.locator('#get-started').innerText()).toLowerCase().includes(`version ${version} / available on npm`));
  assert.doesNotMatch(await page.locator('#get-started').innerText(),/not published|not been published|upcoming release/i);
  assert.equal(await page.locator('.install-command').innerText(),'npm install -g draken\ndraken');
  assert.match(await page.locator('.release-note').innerText(),/0\.1\.6.*Back up.*old task dashboard/s);
  assert.equal(await page.getByRole('link',{name:'Release notes',exact:true}).getAttribute('href'),'#release-notes');
  const notes=await page.locator('#release-notes').innerText();
  assert.ok(notes.includes(version));assert.doesNotMatch(notes,/upcoming|not published|unreleased|current npm release/i);
  assert.match(notes,/New installations enable indexing, summaries and briefings by default/);assert.match(notes,/without a saved preference stays off/);assert.match(notes,/No new tables, columns or dependencies/);
  assert.match(notes,/64-record threshold/);assert.match(notes,/quota or API billing/);
  const preparation=await page.locator('#preparation').innerText();
  assert.match(preparation,/Automatic preparation and compaction/);assert.match(preparation,/does not edit or delete original agent logs/);
  assert.match(preparation,/on by default for new installations/);assert.match(preparation,/does not silently authorize model usage/);
  assert.match(preparation,/not invoices, total spending or account quota/);assert.match(preparation,/Chat, voice, standalone post-conversation recaps and local machine\/network costs are excluded/);
  assert.equal(await page.getByRole('link',{name:`Full ${version} notes`,exact:true}).getAttribute('href'),`https://github.com/mehanig/draken/blob/master/CHANGELOG.md#${anchor}`);
  assert.doesNotMatch(await page.locator('.release-note').innerText(),/draken@/i,'avoid Cloudflare treating the package version as an email address');
  assert.match(await page.locator('.findings').innerText(),/Export uploads now retry when they fail/);
  await page.getByRole('button',{name:'Inspect source E03',exact:true}).click();
  assert.match(await page.locator('#source-quote').innerText(),/I haven’t checked the live site yet/);
  assert.equal(await page.getByRole('button',{name:'Inspect source E03',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Inspect source E01',exact:true}).focus();await page.keyboard.press('Enter');
  assert.match(await page.locator('#source-quote').innerText(),/retries for failed export uploads/);
  assert.match(await page.locator('#source-qualification').innerText(),/hasn’t checked the code itself/);
  await page.getByText('Do I have to use voice?',{exact:false}).click();
  assert.match(await page.locator('.faq details[open]').innerText(),/without a microphone/);
  await page.locator('.faq details[open] summary').press('Enter');
  assert.equal(await page.locator('.faq details[open]').count(),0);
  assert.equal(await page.evaluate(()=>window.__captures),0);
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);
 }finally{await page.close();}
});
