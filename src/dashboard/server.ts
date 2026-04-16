import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getQueueStats,
  getDailyCost,
  getTotalCost,
  getDailyTokens,
  getTotalTokens,
  listTasks,
} from "../core/task-queue.js";
import type { Orchestrator, OrchestratorState } from "../core/orchestrator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface DashboardConfig {
  port: number;
  orchestrator: Orchestrator;
  projectRoot: string;
}

/**
 * Simple HTTP server for the burn-harness monitoring dashboard.
 *
 * Routes:
 *   GET /          - Serves dashboard.html
 *   GET /api/status - JSON: current status, active task, queue depth, costs
 *   GET /api/tasks  - JSON: all tasks with status
 *   GET /api/log    - SSE stream: live log lines
 *   POST /api/pause - Toggle pause/resume
 */
export function startDashboard(config: DashboardConfig): http.Server {
  const { port, orchestrator, projectRoot } = config;
  let paused = false;

  // SSE clients
  const sseClients: http.ServerResponse[] = [];

  // Watch log file for changes
  const logPath = path.join(projectRoot, ".burn", "logs", "burn.log");
  let lastLogSize = 0;

  try {
    if (fs.existsSync(logPath)) {
      lastLogSize = fs.statSync(logPath).size;
    }
  } catch { /* ignore */ }

  const logWatcher = setInterval(() => {
    try {
      if (!fs.existsSync(logPath)) return;
      const stat = fs.statSync(logPath);
      if (stat.size > lastLogSize) {
        const fd = fs.openSync(logPath, "r");
        const buf = Buffer.alloc(Math.min(stat.size - lastLogSize, 10000));
        fs.readSync(fd, buf, 0, buf.length, lastLogSize);
        fs.closeSync(fd);
        const newLines = buf.toString("utf-8");
        lastLogSize = stat.size;

        for (const client of sseClients) {
          try {
            client.write(`data: ${JSON.stringify({ type: "log", data: newLines })}\n\n`);
          } catch {
            // client disconnected
          }
        }
      }
    } catch { /* ignore */ }
  }, 1000);

  // Also push status updates via SSE every 5 seconds
  const statusPusher = setInterval(() => {
    const statusData = getStatusData(orchestrator);
    for (const client of sseClients) {
      try {
        client.write(`data: ${JSON.stringify({ type: "status", data: statusData })}\n\n`);
      } catch { /* ignore */ }
    }
  }, 5000);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST");

    if (url.pathname === "/" || url.pathname === "/index.html") {
      // Serve dashboard HTML
      const htmlPath = path.join(__dirname, "dashboard.html");
      if (fs.existsSync(htmlPath)) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(fs.readFileSync(htmlPath, "utf-8"));
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(getEmbeddedDashboardHTML());
      }
      return;
    }

    if (url.pathname === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getStatusData(orchestrator)));
      return;
    }

    if (url.pathname === "/api/tasks") {
      res.writeHead(200, { "Content-Type": "application/json" });
      const tasks = listTasks();
      res.end(JSON.stringify(tasks));
      return;
    }

    if (url.pathname === "/api/log") {
      // SSE stream
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // Send last 50 log lines
      try {
        if (fs.existsSync(logPath)) {
          const content = fs.readFileSync(logPath, "utf-8");
          const lines = content.split("\n").filter(Boolean).slice(-50);
          res.write(
            `data: ${JSON.stringify({ type: "log-history", data: lines.join("\n") })}\n\n`
          );
        }
      } catch { /* ignore */ }

      sseClients.push(res);

      req.on("close", () => {
        const idx = sseClients.indexOf(res);
        if (idx >= 0) sseClients.splice(idx, 1);
      });
      return;
    }

    if (url.pathname === "/api/pause" && req.method === "POST") {
      paused = !paused;
      if (paused) {
        orchestrator.stop();
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ paused }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(port, () => {
    // Startup message handled by caller
  });

  server.on("close", () => {
    clearInterval(logWatcher);
    clearInterval(statusPusher);
    for (const client of sseClients) {
      try {
        client.end();
      } catch { /* ignore */ }
    }
  });

  return server;
}

function getStatusData(orchestrator: Orchestrator) {
  const state = orchestrator.getState();
  const stats = getQueueStats();
  return {
    running: state.running,
    workers: state.workers,
    queue: stats,
    dailyCost: getDailyCost(),
    totalCost: getTotalCost(),
    dailyTokens: getDailyTokens(),
    totalTokens: getTotalTokens(),
    successRate: stats.total > 0
      ? Math.round((stats.done / (stats.done + stats.failed || 1)) * 100)
      : 0,
  };
}

function getEmbeddedDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>burn-harness dashboard</title>
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --border: #30363d;
    --text: #c9d1d9;
    --text-dim: #8b949e;
    --accent: #ff6b35;
    --green: #3fb950;
    --red: #f85149;
    --yellow: #d29922;
    --blue: #58a6ff;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace;
    font-size: 14px;
    padding: 20px;
  }
  h1 {
    color: var(--accent);
    font-size: 20px;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  h1 .status-dot {
    width: 10px; height: 10px; border-radius: 50%;
    display: inline-block;
  }
  h1 .status-dot.running { background: var(--green); }
  h1 .status-dot.stopped { background: var(--red); }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 12px;
    margin-bottom: 20px;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
  }
  .card .label { color: var(--text-dim); font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  .card .value { font-size: 24px; font-weight: bold; margin-top: 4px; }
  .card .value.green { color: var(--green); }
  .card .value.red { color: var(--red); }
  .card .value.yellow { color: var(--yellow); }
  .card .value.blue { color: var(--blue); }
  table {
    width: 100%;
    border-collapse: collapse;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    margin-bottom: 20px;
  }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
  th { color: var(--text-dim); font-size: 12px; text-transform: uppercase; background: rgba(0,0,0,0.2); }
  tr:last-child td { border-bottom: none; }
  .status-pending { color: var(--yellow); }
  .status-executing, .status-planning { color: var(--blue); }
  .status-done, .status-reviewing { color: var(--green); }
  .status-failed { color: var(--red); }
  .status-cancelled { color: var(--text-dim); }
  #log-container {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    max-height: 400px;
    overflow-y: auto;
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-all;
  }
  #log-container .line-error { color: var(--red); }
  #log-container .line-success { color: var(--green); }
  #log-container .line-info { color: var(--text-dim); }
  .controls {
    display: flex; gap: 12px; margin-bottom: 20px;
  }
  button {
    background: var(--accent);
    color: white;
    border: none;
    padding: 8px 20px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 600;
  }
  button:hover { opacity: 0.9; }
  button.secondary { background: var(--border); }
  h2 { font-size: 16px; margin-bottom: 12px; color: var(--text); }
  .section { margin-bottom: 20px; }
  .worker-bar {
    display: flex; gap: 8px; margin-bottom: 8px;
  }
  .worker-chip {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 12px;
  }
  .worker-chip.working { border-color: var(--blue); color: var(--blue); }
  .worker-chip.idle { border-color: var(--text-dim); color: var(--text-dim); }
  .worker-chip.rate-limited { border-color: var(--yellow); color: var(--yellow); }
  .worker-chip.stopped { border-color: var(--red); color: var(--red); }
</style>
</head>
<body>

<h1>
  <span id="status-dot" class="status-dot stopped"></span>
  burn-harness
  <span style="flex:1"></span>
  <span id="clock" style="font-size:12px;color:var(--text-dim)"></span>
</h1>

<div class="controls">
  <button id="pause-btn" onclick="togglePause()">Pause</button>
</div>

<div class="grid">
  <div class="card">
    <div class="label">Pending</div>
    <div class="value yellow" id="stat-pending">0</div>
  </div>
  <div class="card">
    <div class="label">Running</div>
    <div class="value blue" id="stat-running">0</div>
  </div>
  <div class="card">
    <div class="label">Done</div>
    <div class="value green" id="stat-done">0</div>
  </div>
  <div class="card">
    <div class="label">Failed</div>
    <div class="value red" id="stat-failed">0</div>
  </div>
  <div class="card">
    <div class="label">Cost Today</div>
    <div class="value" id="stat-cost">$0.00</div>
  </div>
  <div class="card">
    <div class="label">Cost Total</div>
    <div class="value" id="stat-total-cost">$0.00</div>
  </div>
  <div class="card">
    <div class="label">Success Rate</div>
    <div class="value green" id="stat-success">0%</div>
  </div>
  <div class="card">
    <div class="label">Tokens Today</div>
    <div class="value" id="stat-tokens">0</div>
  </div>
</div>

<div class="section">
  <h2>Workers</h2>
  <div id="workers" class="worker-bar"></div>
</div>

<div class="section">
  <h2>Task Queue</h2>
  <table id="task-table">
    <thead>
      <tr><th>ID</th><th>Status</th><th>Type</th><th>P</th><th>Title</th><th>Cost</th></tr>
    </thead>
    <tbody id="task-body"></tbody>
  </table>
</div>

<div class="section">
  <h2>Log</h2>
  <div id="log-container"></div>
</div>

<script>
  let isPaused = false;

  // SSE connection
  const evtSource = new EventSource('/api/log');
  const logEl = document.getElementById('log-container');
  const maxLogLines = 50;

  evtSource.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'log' || msg.type === 'log-history') {
      appendLog(msg.data);
    }
    if (msg.type === 'status') {
      updateStatus(msg.data);
    }
  };

  function appendLog(text) {
    const lines = text.split('\\n').filter(Boolean);
    for (const line of lines) {
      const el = document.createElement('div');
      el.textContent = line;
      if (line.includes('error') || line.includes('Error') || line.includes('failed')) {
        el.className = 'line-error';
      } else if (line.includes('done') || line.includes('success') || line.includes('PR created')) {
        el.className = 'line-success';
      } else {
        el.className = 'line-info';
      }
      logEl.appendChild(el);
    }
    // Trim
    while (logEl.children.length > maxLogLines) {
      logEl.removeChild(logEl.firstChild);
    }
    logEl.scrollTop = logEl.scrollHeight;
  }

  function updateStatus(data) {
    document.getElementById('stat-pending').textContent = data.queue.pending;
    document.getElementById('stat-running').textContent = data.queue.executing;
    document.getElementById('stat-done').textContent = data.queue.done;
    document.getElementById('stat-failed').textContent = data.queue.failed;
    document.getElementById('stat-cost').textContent = '$' + data.dailyCost.toFixed(2);
    document.getElementById('stat-total-cost').textContent = '$' + data.totalCost.toFixed(2);
    document.getElementById('stat-success').textContent = data.successRate + '%';
    document.getElementById('stat-tokens').textContent = data.dailyTokens.toLocaleString();

    const dot = document.getElementById('status-dot');
    dot.className = 'status-dot ' + (data.running ? 'running' : 'stopped');

    // Workers
    const workersEl = document.getElementById('workers');
    workersEl.innerHTML = data.workers.map(w => {
      const task = w.currentTask ? ' \\u2192 ' + w.currentTask.title.slice(0, 30) : '';
      return '<div class="worker-chip ' + w.status + '">' + w.id + ': ' + w.status + task + '</div>';
    }).join('');
  }

  // Fetch tasks periodically
  async function fetchTasks() {
    try {
      const res = await fetch('/api/tasks');
      const tasks = await res.json();
      const tbody = document.getElementById('task-body');
      const active = tasks.filter(t => !['done','cancelled'].includes(t.status)).slice(0, 30);
      const recent = tasks.filter(t => t.status === 'done').slice(-5).reverse();
      const all = [...active, ...recent];

      tbody.innerHTML = all.map(t => {
        const cls = 'status-' + t.status;
        return '<tr>'
          + '<td style="font-family:monospace;font-size:12px">' + t.id.slice(-6) + '</td>'
          + '<td class="' + cls + '">' + t.status + '</td>'
          + '<td>' + t.type + '</td>'
          + '<td>P' + t.priority + '</td>'
          + '<td>' + t.title.slice(0, 50) + '</td>'
          + '<td>' + (t.estimated_cost_usd > 0 ? '$' + t.estimated_cost_usd.toFixed(2) : '') + '</td>'
          + '</tr>';
      }).join('');
    } catch { /* ignore */ }
  }

  // Initial load
  fetch('/api/status').then(r => r.json()).then(updateStatus).catch(() => {});
  fetchTasks();
  setInterval(fetchTasks, 10000);

  // Clock
  setInterval(() => {
    document.getElementById('clock').textContent = new Date().toLocaleTimeString();
  }, 1000);

  async function togglePause() {
    const res = await fetch('/api/pause', { method: 'POST' });
    const data = await res.json();
    isPaused = data.paused;
    document.getElementById('pause-btn').textContent = isPaused ? 'Resume' : 'Pause';
  }
</script>
</body>
</html>`;
}
