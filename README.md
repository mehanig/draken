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

## \n\n\n AI Generated Readme below.

A web-based dashboard for running [Claude Code](https://github.com/anthropics/claude-code) tasks across multiple projects in isolated Docker containers.

## Features

- **Multi-project management** — Add and manage multiple code projects from a single dashboard
- **Isolated execution** — Each task runs in its own Docker container with the project mounted
- **Real-time streaming** — Watch Claude Code output live via Server-Sent Events
- **Session continuity** — Follow-up on previous tasks to continue conversations
- **Git integration** — View git status and file diffs directly in the dashboard
- **Authentication** — JWT-based auth for secure deployment

## Prerequisites

- **Node.js** 18+
- **Docker** installed and running
- **Claude CLI** authenticated (`claude login`) or an Anthropic API key

## Quick Start

```bash
# Clone the repository
git clone https://github.com/yourusername/draken.git
cd draken

# Install dependencies
npm install
cd client && npm install && cd ..

# Build the project
npm run build
cd client && npm run build && cd ..

# Run with auth disabled for local development
DRAKEN_NO_AUTH=true npm start
```

Open http://localhost:40333 in your browser.

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

### Claude Authentication

Choose one method:

1. **OAuth (Recommended):** Run `claude login` before starting Draken. Your credentials in `~/.claude` will be mounted into containers.

2. **API Key:** Set `ANTHROPIC_API_KEY` in your `.env` file.

### Web Authentication

For local development, disable auth:
```bash
DRAKEN_NO_AUTH=true npm start
```

For deployment, set these in `.env`:
```
DRAKEN_USERNAME=admin
DRAKEN_PASSWORD=your-secure-password
DRAKEN_JWT_SECRET=random-string-at-least-32-characters
```

## Usage

1. **Add a project** — Click "Add Project" and browse to select a folder
2. **Generate Dockerfile** — Click "Generate" to create a Draken Dockerfile for the project
3. **Run a task** — Enter a prompt and click "Run Task"
4. **View logs** — Click on a task to see real-time output
5. **Follow up** — Use the input at the bottom of the logs modal to continue the conversation

## Project Structure

```
draken/
├── src/                  # Backend (Express + TypeScript)
│   ├── server.ts         # Main server
│   ├── auth/             # JWT authentication
│   ├── db/               # SQLite database
│   ├── docker/           # Container management
│   ├── git/              # Git status integration
│   └── routes/           # API endpoints
├── client/               # Frontend (React + TypeScript)
│   └── src/
│       ├── pages/        # Page components
│       └── components/   # UI components
└── public/               # Built frontend assets
```

## Security Notes

- Containers run with `--dangerously-skip-permissions` to enable non-interactive execution
- Projects are mounted read-write into containers
- For production deployment:
  - Always enable authentication
  - Run behind an HTTPS reverse proxy
  - Consider network isolation for containers

## Development

```bash
# Run backend in watch mode
npm run dev

# Run frontend dev server (in separate terminal)
cd client && npm run dev
```

The frontend dev server proxies API requests to the backend on port 40333.

## License

MIT
