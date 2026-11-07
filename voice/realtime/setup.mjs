import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CODEX_VERSION, realtimeRoot, defaultBinary, defaultHome, helperEnvironment, nativeStatus } from './native.mjs';

process.umask(0o077);
const flags = process.argv.slice(2);
if (flags.length !== 1 || !['--install', '--login', '--check'].includes(flags[0])) {
  console.error('Usage: node voice/realtime/setup.mjs --install | --login | --check'); process.exitCode = 2;
} else {
  const run = (binary, args, env) => new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: 'inherit', shell: false, env });
    child.once('error', () => reject(new Error('Cannot start the requested helper.')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('The requested helper did not complete.')));
  });
  try {
    if (flags[0] === '--install') {
      fs.mkdirSync(realtimeRoot, { recursive: true, mode: 0o700 });
      await run('npm', ['install', '--prefix', path.join(realtimeRoot, 'runtime'), '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `@openai/codex@${CODEX_VERSION}`], helperEnvironment(defaultHome));
    }
    if (flags[0] === '--login') {
      if (!(await nativeStatus()).installed) throw new Error('Run npm run voice:realtime:setup first.');
      fs.mkdirSync(defaultHome, { recursive: true, mode: 0o700 });
      if (fs.existsSync(path.join(defaultHome, 'config.toml'))) throw new Error('The dedicated voice account directory must not contain a custom config.toml.');
      // An explicit operator command, not an automatic browser popup or token conversion.
      // This is native ChatGPT sign-in, not API-key login and not pi's direct-token registration.
      await run(defaultBinary, ['-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"', 'login', '--device-auth'], helperEnvironment(defaultHome));
    }
    console.log(JSON.stringify(await nativeStatus(), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
