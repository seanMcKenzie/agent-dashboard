const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
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

  for (const entry of entries) {
    if (!entry) continue;

    // Track model
    if (entry.type === 'model_change' && entry.modelId) {
      model = entry.modelId;
    }

    // Track timestamps
    if (entry.timestamp) {
      const t = new Date(entry.timestamp).getTime();
      if (!lastActivity || t > lastActivity) lastActivity = t;
    }

    // Parse messages
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

        // Count tool calls
        if (Array.isArray(msg.content)) {
          toolCalls += msg.content.filter(c => c.type === 'toolCall').length;
        }
      }

      // Collect recent assistant messages (last 5)
      if (role === 'assistant') {
        const preview = Array.isArray(msg.content)
          ? msg.content.find(c => c.type === 'text')?.text || ''
          : typeof msg.content === 'string' ? msg.content : '';

        if (preview.trim()) {
          recentMessages.push({
            timestamp: entry.timestamp,
            preview: preview.slice(0, 120).trim() + (preview.length > 120 ? '…' : ''),
          });
        }
      }
    }
  }

  // Keep only the last 5 messages
  recentMessages = recentMessages.slice(-5).reverse();

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
    let lastActivity = null;
    let model = 'unknown';
    let activeSessionId = null;
    let recentMessages = [];
    let sessionCount = 0;

    for (const [sessionKey, sessionMeta] of Object.entries(sessions)) {
      sessionCount++;
      const sessionId = sessionMeta.sessionId;
      if (!activeSessionId) activeSessionId = sessionId;

      const jsonlPath = path.join(sessionsDir, `${sessionId}.jsonl`);
      if (fs.existsSync(jsonlPath)) {
        const parsed = parseSession(jsonlPath, sessionId);
        totalTokens += parsed.totalTokens;
        totalMessages += parsed.messageCount;
        totalToolCalls += parsed.toolCalls;
        model = parsed.model !== 'unknown' ? parsed.model : model;
        if (!lastActivity || (parsed.lastActivity && parsed.lastActivity > lastActivity)) {
          lastActivity = parsed.lastActivity;
          recentMessages = parsed.recentMessages;
        }
      }
    }

    // Determine status
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
      lastActivity,
      minutesSinceActive: Math.floor(minutesSinceActive),
      recentMessages,
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
    admin: 'Admin',
  };
  return names[name] || name.charAt(0).toUpperCase() + name.slice(1);
}

function getSystemStats(agents) {
  const totalTokens = agents.reduce((s, a) => s + a.totalTokens, 0);
  const totalMessages = agents.reduce((s, a) => s + a.totalMessages, 0);
  const totalToolCalls = agents.reduce((s, a) => s + a.totalToolCalls, 0);
  const activeAgents = agents.filter(a => a.status === 'active').length;

  // Rough cost estimate: claude-sonnet-4 pricing
  // Input: $3/M tokens, Output: $15/M tokens (estimate 30% output)
  const estimatedOutputTokens = Math.floor(totalTokens * 0.3);
  const estimatedInputTokens = totalTokens - estimatedOutputTokens;
  const estimatedCost = ((estimatedInputTokens / 1_000_000) * 3) + ((estimatedOutputTokens / 1_000_000) * 15);

  return {
    totalTokens,
    totalMessages,
    totalToolCalls,
    activeAgents,
    totalAgents: agents.length,
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

    // Extract emoji from metadata line
    const emojiMatch = frontmatter.match(/"emoji":\s*"([^"]+)"/);
    const emoji = emojiMatch ? emojiMatch[1] : null;

    // Extract requires
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
    res.json({
      timestamp: new Date().toISOString(),
      system,
      agents,
    });
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

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🤖 Agent Dashboard running at http://localhost:${PORT}\n`);
});
