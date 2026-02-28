const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = 3131;
const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');
const AGENTS_DIR = path.join(OPENCLAW_DIR, 'agents');
const SKILLS_DIR = path.join(os.homedir(), '.nvm/versions/node/v22.22.0/lib/node_modules/openclaw/skills');

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length / 4);
}

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => {
      if (typeof c === 'string') return c;
      if (c.type === 'text') return c.text || '';
      if (c.type === 'thinking') return c.thinking || '';
      if (c.type === 'toolCall') return JSON.stringify(c.arguments || {});
      if (c.type === 'toolResult') return JSON.stringify(c.content || {});
      return '';
    }).join(' ');
  }
  return JSON.stringify(content);
}

function readJsonl(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.trim().split('\n').map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function parseSession(jsonlPath, sessionId) {
  const entries = readJsonl(jsonlPath);
  let inputTokens = 0;
  let outputTokens = 0;
  let messageCount = 0;
  let toolCalls = 0;
  let lastActivity = null;
  let model = 'unknown';
  let recentMessages = [];
  let activityLog = [];

  for (const entry of entries) {
    if (!entry) continue;

    if (entry.type === 'model_change' && entry.modelId) {
      model = entry.modelId;
    }

    if (entry.timestamp) {
      const t = new Date(entry.timestamp).getTime();
      if (!lastActivity || t > lastActivity) lastActivity = t;
    }

    if (entry.type === 'message' && entry.message) {
      const msg = entry.message;
      const role = msg.role;
      const text = extractText(msg.content);
      const tokens = estimateTokens(text);

      if (role === 'user' || role === 'toolResult') {
        inputTokens += tokens;
      } else if (role === 'assistant') {
        outputTokens += tokens;
        messageCount++;

        if (Array.isArray(msg.content)) {
          const toolCallEntries = msg.content.filter(c => c.type === 'toolCall');
          toolCalls += toolCallEntries.length;

          // Log tool calls
          for (const tc of toolCallEntries) {
            activityLog.push({
              type: 'tool_call',
              timestamp: entry.timestamp,
              tool: tc.name || tc.toolName || 'unknown',
              args: JSON.stringify(tc.arguments || {}).slice(0, 200),
              tokens,
            });
          }
        }
      }

      // Log messages
      if (role === 'assistant') {
        const fullText = Array.isArray(msg.content)
          ? msg.content.find(c => c.type === 'text')?.text || ''
          : typeof msg.content === 'string' ? msg.content : '';

        if (fullText.trim()) {
          const isTruncated = fullText.length > 200;
          recentMessages.push({
            timestamp: entry.timestamp,
            preview: fullText.slice(0, 200).trim() + (isTruncated ? '…' : ''),
            full: fullText.trim(),
          });

          activityLog.push({
            type: 'message',
            timestamp: entry.timestamp,
            preview: fullText.slice(0, 200).trim() + (isTruncated ? '…' : ''),
            full: fullText.trim(),
            tokens,
          });
        }
      }

      if (role === 'user') {
        const fullText = typeof msg.content === 'string' ? msg.content : extractText(msg.content);
        if (fullText.trim()) {
          const isTruncated = fullText.length > 200;
          activityLog.push({
            type: 'user_message',
            timestamp: entry.timestamp,
            preview: fullText.slice(0, 200).trim() + (isTruncated ? '…' : ''),
            full: fullText.trim(),
            tokens,
          });
        }
      }
    }
  }

  recentMessages = recentMessages.slice(-10).reverse();
  activityLog = activityLog.slice(-50).reverse();

  return {
    sessionId,
    model,
    messageCount,
    toolCalls,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    lastActivity,
    recentMessages,
    activityLog,
  };
}

function getAgents() {
  const agents = [];

  if (!fs.existsSync(AGENTS_DIR)) return agents;

  const agentDirs = fs.readdirSync(AGENTS_DIR).filter(name => {
    return fs.statSync(path.join(AGENTS_DIR, name)).isDirectory();
  });

  for (const agentName of agentDirs) {
    const sessionsDir = path.join(AGENTS_DIR, agentName, 'sessions');
    const sessionsJsonPath = path.join(sessionsDir, 'sessions.json');

    let sessions = {};
    try {
      sessions = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf8'));
    } catch {
      // No sessions yet
    }

    let totalTokens = 0;
    let totalMessages = 0;
    let totalToolCalls = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let lastActivity = null;
    let model = 'unknown';
    let activeSessionId = null;
    let recentMessages = [];
    let activityLog = [];
    let sessionCount = 0;

    for (const [sessionKey, sessionMeta] of Object.entries(sessions)) {
      sessionCount++;
      const sessionId = sessionMeta.sessionId;
      if (!activeSessionId) activeSessionId = sessionId;

      const jsonlPath = path.join(sessionsDir, `${sessionId}.jsonl`);
      if (fs.existsSync(jsonlPath)) {
        const parsed = parseSession(jsonlPath, sessionId);
        totalTokens += parsed.totalTokens;
        totalInputTokens += parsed.inputTokens;
        totalOutputTokens += parsed.outputTokens;
        totalMessages += parsed.messageCount;
        totalToolCalls += parsed.toolCalls;
        model = parsed.model !== 'unknown' ? parsed.model : model;
        if (!lastActivity || (parsed.lastActivity && parsed.lastActivity > lastActivity)) {
          lastActivity = parsed.lastActivity;
          recentMessages = parsed.recentMessages;
          activityLog = parsed.activityLog;
        }
      }
    }

    const now = Date.now();
    const minutesSinceActive = lastActivity ? (now - lastActivity) / 60000 : Infinity;
    let status = 'idle';
    if (minutesSinceActive < 2) status = 'active';
    else if (minutesSinceActive < 30) status = 'recent';
    else if (!lastActivity) status = 'never';

    agents.push({
      name: agentName,
      displayName: formatAgentName(agentName),
      status,
      model,
      sessionCount,
      activeSessionId,
      totalMessages,
      totalToolCalls,
      totalTokens,
      totalInputTokens,
      totalOutputTokens,
      lastActivity,
      minutesSinceActive: Math.floor(minutesSinceActive),
      recentMessages,
      activityLog,
    });
  }

  return agents.sort((a, b) => {
    const order = { active: 0, recent: 1, idle: 2, never: 3 };
    return (order[a.status] ?? 9) - (order[b.status] ?? 9);
  });
}

function formatAgentName(name) {
  const names = {
    main: 'K2S0',
    k2so: 'K2S0 (legacy)',
    developer: 'Charlie',
    pm: 'Dennis',
    qa: 'Mac',
    devops: 'Frank',
    research: 'Sweet Dee',
    admin: 'Admin',
  };
  return names[name] || name.charAt(0).toUpperCase() + name.slice(1);
}

function getSystemStats(agents) {
  const totalTokens = agents.reduce((s, a) => s + a.totalTokens, 0);
  const totalMessages = agents.reduce((s, a) => s + a.totalMessages, 0);
  const totalToolCalls = agents.reduce((s, a) => s + a.totalToolCalls, 0);
  const activeAgents = agents.filter(a => a.status === 'active').length;
  const totalInputTokens = agents.reduce((s, a) => s + (a.totalInputTokens || 0), 0);
  const totalOutputTokens = agents.reduce((s, a) => s + (a.totalOutputTokens || 0), 0);

  const estimatedCost = ((totalInputTokens / 1_000_000) * 3) + ((totalOutputTokens / 1_000_000) * 15);

  return {
    totalTokens,
    totalMessages,
    totalToolCalls,
    activeAgents,
    totalAgents: agents.length,
    totalInputTokens,
    totalOutputTokens,
    estimatedCostUSD: estimatedCost.toFixed(4),
  };
}

// ─── Skills ──────────────────────────────────────────────────────────────────

function parseSkillMd(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.startsWith('---')) return null;
    const end = raw.indexOf('---', 3);
    if (end === -1) return null;
    const frontmatter = raw.slice(3, end).trim();

    const get = (key) => {
      const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
      return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
    };

    const name = get('name');
    const description = get('description');
    const homepage = get('homepage');

    const emojiMatch = frontmatter.match(/"emoji":\s*"([^"]+)"/);
    const emoji = emojiMatch ? emojiMatch[1] : null;

    const binsMatch = frontmatter.match(/"bins":\s*\[([^\]]+)\]/);
    const anyBinsMatch = frontmatter.match(/"anyBins":\s*\[([^\]]+)\]/);
    const configMatch = frontmatter.match(/"config":\s*\[([^\]]+)\]/);

    const parseList = (m) => m ? m[1].replace(/"/g, '').split(',').map(s => s.trim()).filter(Boolean) : [];

    return {
      name,
      description,
      homepage,
      emoji,
      requires: {
        bins: parseList(binsMatch),
        anyBins: parseList(anyBinsMatch),
        config: parseList(configMatch),
      },
    };
  } catch {
    return null;
  }
}

function getSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs.readdirSync(SKILLS_DIR)
    .map(name => {
      const skillPath = path.join(SKILLS_DIR, name, 'SKILL.md');
      if (!fs.existsSync(skillPath)) return null;
      return parseSkillMd(skillPath);
    })
    .filter(Boolean)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/api/data', (req, res) => {
  try {
    const agents = getAgents();
    const system = getSystemStats(agents);
    res.json({ timestamp: new Date().toISOString(), system, agents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/skills', (req, res) => {
  try {
    res.json(getSkills());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ─── WebSocket ───────────────────────────────────────────────────────────────

let connectedClients = 0;

io.on('connection', (socket) => {
  connectedClients++;
  console.log(`📡 Client connected (${connectedClients} total)`);

  // Send initial data immediately
  try {
    const agents = getAgents();
    const system = getSystemStats(agents);
    socket.emit('dashboard-update', { timestamp: new Date().toISOString(), system, agents });
  } catch (err) {
    console.error('Error sending initial data:', err.message);
  }

  socket.on('disconnect', () => {
    connectedClients--;
    console.log(`📡 Client disconnected (${connectedClients} total)`);
  });
});

// Broadcast updates every 5 seconds
setInterval(() => {
  if (connectedClients === 0) return;
  try {
    const agents = getAgents();
    const system = getSystemStats(agents);
    io.emit('dashboard-update', { timestamp: new Date().toISOString(), system, agents });
  } catch (err) {
    console.error('Error broadcasting update:', err.message);
  }
}, 5000);

// ─── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n🤖 Agent Dashboard running at http://localhost:${PORT}`);
  console.log(`📡 WebSocket live updates enabled\n`);
});
