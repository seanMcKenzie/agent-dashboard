# Agent Dashboard

A local monitoring dashboard for your OpenClaw AI agent team. Shows session activity, token usage estimates, tool calls, and recent messages — all in real time.

## What It Shows

- **Agent status** — active, recent, idle, or never-used
- **Token usage** — estimated from message content (≈4 chars/token)
- **Tool calls** — how many actions each agent has executed
- **Cost estimate** — rough USD estimate based on Claude Sonnet pricing
- **Recent activity** — last messages from each agent's session
- **Auto-refreshes** every 10 seconds

## Setup

```bash
# Install dependencies
npm install

# Start the server
npm start
```

Then open **http://localhost:3131** in your browser.

## Notes

- Reads directly from `~/.openclaw/agents/*/sessions/`
- Token counts are **estimates** — OpenClaw does not expose raw API usage counts in transcripts
- Cost estimate assumes ~30% output tokens, Claude Sonnet 4 pricing ($3/M input, $15/M output)
- No data leaves your machine — fully local

## Stack

- **Backend:** Node.js + Express
- **Frontend:** Pure HTML/CSS/JS (no frameworks)
- **Data source:** OpenClaw JSONL session transcripts
