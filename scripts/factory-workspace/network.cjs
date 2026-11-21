// This command runs inside the worker. Importing its descriptor performs no network work.
const networkAccess={
 scope:'Public HTTPS GET/HEAD and npm installation/audit. Private/LAN/metadata destinations, credentials, arbitrary write methods and CONNECT tunnels are denied.',
 web:'Use bash: node /factory/network.cjs HTTPS_URL [OUTPUT_FILE]. It fetches through the approved broker, follows at most five public HTTPS redirects, writes the body to stdout or the file, and reports status/final URL on stderr. Non-2xx exits nonzero. This is the authorized network interface, not a workaround or an additional Pi tool.',
 npm:'npm is preconfigured with npm_config_registry=http://egress:8080/npm/. Use ordinary npm view, install and audit commands through bash; do not replace the registry or seek host credentials. Use a temporary directory for published-package checks.',
 examples:[
  'npm view draken@0.10.0 version --json',
  'node /factory/network.cjs "https://api.github.com/repos/OWNER/REPO/actions/runs?per_page=5" /tmp/actions.json',
  'node /factory/network.cjs https://SITE/ /tmp/website.html',
 ],
 limitations:'IPv6-only destinations are not supported. Public access does not grant GitHub authentication, push, merge, publication or deployment rights. Report private-resource failures and API rate limits accurately; do not retry automatically. Outbound URLs can transmit data, so do not put secrets or repository contents into request URLs.',
};
async function main(){
 const [url,file,...extra]=process.argv.slice(2);
 if(!url||extra.length)throw Error('Usage: node /factory/network.cjs HTTPS_URL [OUTPUT_FILE]');
 const target=new URL(url);if(target.protocol!=='https:'||target.username||target.password)throw Error('A public HTTPS URL without credentials is required');
 const response=await fetch('http://egress:8080/fetch?url='+encodeURIComponent(target.href),{redirect:'error',signal:AbortSignal.timeout(65000)});
 const body=Buffer.from(await response.arrayBuffer());
 if(file)require('node:fs').writeFileSync(file,body);else process.stdout.write(body);
 console.error(`HTTP ${response.status} ${response.headers.get('x-draken-url')||target.href}`);
 if(!response.ok)process.exitCode=1;
}
module.exports={networkAccess};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
