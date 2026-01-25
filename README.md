# Draken

### What is this???

One more Agent orchestrator that I build for myself.

It might be buggy and it might be weird.

But it fit my needs.

### WHY?

I often work on multiple projects simualtaniously and quite asynchrounously, and quite often I just want to submit a task for Claude in Private repo and return to it later.
I can use github integration with Claude, or Tmux sessions, but first one is lacking full machine access to run whatever it wants to achieve a task.
And tmux require ssh/machine access, so it doesn't really work when I commute or visiting at event.

The vision for Draken is that's asyncronous by nature and every interation with it is a single container run which completes and exits, the only artifact it produces is visible via `git diff`.
Context is preserved via sessions and threads in UI, so you can have few async sessions and interact with them.

---

## Install

### Quick Start (npx)

```bash
# Install prerequisites
npm install -g @anthropic-ai/claude-code
claude login  # Authenticate with Anthropic

# Run Draken (local dev, no auth)
DRAKEN_NO_AUTH=true npx draken
```

Open http://localhost:40333

### VPS Deployment

```bash
# 1. Install Node.js 18+ and Docker
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# 2. Install and authenticate Claude CLI
npm install -g @anthropic-ai/claude-code
claude login

# 3. Set credentials and run
export DRAKEN_USERNAME=admin
export DRAKEN_PASSWORD=your-secure-password
export DRAKEN_JWT_SECRET=$(openssl rand -hex 32)

npx draken
```

For HTTPS, put behind a reverse proxy:
```bash
# Caddy (automatic HTTPS)
sudo caddy reverse-proxy --from draken.yourdomain.com --to localhost:40333
```

### From Source

```bash
git clone https://github.com/mehanig/draken.git
cd draken

npm install && cd client && npm install && cd ..
npm run build && cd client && npm run build && cd ..

DRAKEN_NO_AUTH=true npm start
```

---

## Features

- **Multi-project** — Manage multiple codebases from one dashboard
- **Docker isolation** — Each task runs in its own container
- **Real-time logs** — Stream Claude's output via SSE
- **Session continuity** — Follow up on previous tasks
- **Git integration** — View status and diffs in the UI
- **Auth** — JWT-based for secure deployment

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `DRAKEN_USERNAME` | For deployment | Web UI username |
| `DRAKEN_PASSWORD` | For deployment | Web UI password |
| `DRAKEN_JWT_SECRET` | For deployment | JWT signing secret (32+ chars) |
| `DRAKEN_NO_AUTH` | No | Set `true` to disable auth |
| `ANTHROPIC_API_KEY` | If no OAuth | Alternative to `claude login` |

## Usage

1. **Add a project** — Browse and select a folder
2. **Generate Dockerfile** — One-time setup per project
3. **Run a task** — Enter a prompt, Claude works in container
4. **View logs** — Real-time output streaming
5. **Follow up** — Continue the conversation
6. **Check git diff** — Review changes before committing

## License

MIT
