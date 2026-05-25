import chalk from 'chalk';
import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import crypto from 'crypto';
import readline from 'readline';

// ── SKOPIX AGENT ──────────────────────────────────────────────────────────────
// Runs on a teammate's machine. Connects to the shared Skopix server and
// executes recording/replay jobs locally (opening a real browser window).
// The server dispatches jobs to the right person based on their login.
//
// Usage:
//   skopix agent --server http://192.168.1.45:9000 --key "yourteamsecretkey"
//   skopix agent --server https://skopix.yourportix.com --key "yourteamsecretkey"

// ── PROMPT HELPER ─────────────────────────────────────────────────────────────
function prompt(question, hidden = false) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      process.stdout.write(question);
      process.stdin.setRawMode(true);
      let input = '';
      process.stdin.on('data', function handler(ch) {
        ch = ch.toString();
        if (ch === '\n' || ch === '\r' || ch === '\u0004') {
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', handler);
          process.stdout.write('\n');
          rl.close();
          resolve(input);
        } else if (ch === '\u0003') {
          process.exit();
        } else if (ch === '\u007f') {
          input = input.slice(0, -1);
        } else {
          input += ch;
          process.stdout.write('*');
        }
      });
      process.stdin.resume();
    } else {
      rl.question(question, (answer) => { rl.close(); resolve(answer); });
    }
  });
}

// ── AUTH: identify this agent with your Skopix login ─────────────────────────
async function promptAndAuth(serverUrl, secretKey) {
  // First check if server is in team mode
  try {
    const checkRes = await fetch(serverUrl + '/api/agent/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-skopix-key': secretKey },
      body: JSON.stringify({ email: '', password: '' }),
    });
    // 400 = team mode (bad request), 200 with userId null = solo mode
    if (checkRes.status === 404) return { userId: null, name: 'local' }; // solo mode, endpoint doesn't exist
  } catch {}

  console.log(chalk.cyan('  Enter your Skopix dashboard login to identify this agent:'));
  const email = await prompt('  Email: ');
  const password = await prompt('  Password: ', true);

  const res = await fetch(serverUrl + '/api/agent/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-skopix-key': secretKey },
    body: JSON.stringify({ email: email.trim(), password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Auth failed');
  return data;
}

export async function agentCommand(options) {
  const serverUrl = (options.server || process.env.SKOPIX_SERVER_URL || '').replace(/\/$/, '');
  const secretKey = options.key || process.env.SKOPIX_SECRET_KEY;
  const agentName = options.name || os.hostname();
  const machine = os.hostname() + ' (' + os.platform() + ')';
  const agentId = crypto.randomUUID();

  if (!serverUrl) {
    console.error(chalk.red('✖ --server is required. Example: skopix agent --server http://192.168.1.45:9000 --key "secret"'));
    process.exit(1);
  }
  if (!secretKey) {
    console.error(chalk.red('✖ --key is required (same SKOPIX_SECRET_KEY as the server)'));
    process.exit(1);
  }

  console.log('');
  console.log(chalk.cyan('  ┌─────────────────────────────────────────────┐'));
  console.log(chalk.cyan('  │') + '  SKOPIX AGENT                               ' + chalk.cyan('│'));
  console.log(chalk.cyan('  └─────────────────────────────────────────────┘'));
  console.log('');
  console.log('  Machine : ' + chalk.white(machine));
  console.log('  Server  : ' + chalk.white(serverUrl));
  console.log('');

  // Authenticate to identify this agent with the correct user
  let userId = null;
  let userName = agentName;

  try {
    const authData = await promptAndAuth(serverUrl, secretKey);
    userId = authData.userId;
    userName = authData.name || agentName;
    if (userId) {
      console.log(chalk.green('  ✔ Authenticated as ') + chalk.white(userName));
    } else {
      console.log(chalk.cyan('  ◆ Solo mode — no user auth needed'));
    }
  } catch (err) {
    console.log(chalk.yellow('  ⚠ Could not authenticate: ' + err.message));
    console.log(chalk.yellow('  ⚠ Connecting anonymously — replays may dispatch to any available agent'));
  }

  console.log('');

  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/agent';
  let reconnectDelay = 2000;
  let running = true;
  let ws = null;

  process.on('SIGINT', () => {
    running = false;
    if (ws) try { ws.close(); } catch {}
    console.log('\n' + chalk.yellow('  Agent stopped.'));
    process.exit(0);
  });

  async function connect() {
    console.log(chalk.cyan('  Connecting to server...'));

    ws = new WebSocket(wsUrl, { headers: { 'x-skopix-key': secretKey } });

    ws.addEventListener('open', () => {
      reconnectDelay = 2000;
      ws.send(JSON.stringify({ type: 'register', agentId, name: userName, machine, userId }));
      console.log(chalk.green('  ✔ Connected — waiting for jobs\n'));
    });

    ws.addEventListener('message', async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'registered') return;
      if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
      if (msg.type === 'record') { await handleRecord(msg); return; }
      if (msg.type === 'replay') { await handleReplay(msg); return; }
    });

    ws.addEventListener('close', () => {
      if (!running) return;
      console.log(chalk.yellow('  ⚠ Disconnected. Reconnecting in ' + (reconnectDelay / 1000) + 's...'));
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    });

    ws.addEventListener('error', (err) => {
      console.error(chalk.red('  ✖ ' + (err.message || 'Connection error')));
    });
  }

  // ── RECORD JOB ─────────────────────────────────────────────────────────────
  async function handleRecord(msg) {
    const { recordingId, url } = msg;
    console.log(chalk.cyan('  ⏺ Recording: ') + chalk.white(url));

    const send = (data) => {
      try { ws.send(JSON.stringify({ type: 'recordingUpdate', recordingId, data })); } catch {}
    };

    const screenshotDir = path.join(os.homedir(), '.skopix', 'recordings', recordingId);
    await fs.ensureDir(screenshotDir);

    const recorderPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'core', 'recorder.js');
    const { spawn } = await import('child_process');
    const child = spawn('node', [recorderPath, url, recordingId, screenshotDir], { stdio: ['pipe', 'pipe', 'pipe'] });

    child.stdout.on('data', (chunk) => {
      chunk.toString().split('\n').filter(Boolean).forEach(line => {
        try {
          const parsed = JSON.parse(line);
          send(parsed);
          if (parsed.type === 'step') process.stdout.write(chalk.cyan('    ⏺ ') + (parsed.step?.action || '') + '\n');
          if (parsed.type === 'done') console.log(chalk.green('  ✔ Recording done — ') + (parsed.steps?.length || 0) + ' steps');
        } catch {}
      });
    });

    child.stderr.on('data', (chunk) => {
      send({ type: 'error', message: chunk.toString().trim().slice(0, 200) });
    });

    child.on('close', () => { send({ type: 'stopped' }); });

    // Listen for stop signal from server
    const stopHandler = (event) => {
      let m; try { m = JSON.parse(event.data); } catch { return; }
      if (m.type === 'stopRecord' && m.recordingId === recordingId) {
        try { child.stdin.write('stop\n'); } catch {}
        ws.removeEventListener('message', stopHandler);
      }
    };
    ws.addEventListener('message', stopHandler);
  }

  // ── REPLAY JOB ─────────────────────────────────────────────────────────────
  async function handleReplay(msg) {
    const { runId, test, setupTest, env } = msg;
    console.log(chalk.cyan('  ▶ Replay: ') + chalk.white(test.name));

    const send = (data) => {
      try { ws.send(JSON.stringify({ type: 'jobUpdate', runId, data })); } catch {}
    };

    if (env) Object.assign(process.env, env);

    try {
      const { chromium } = await import('playwright');
      const sessionDir = path.join(os.homedir(), '.skopix', 'sessions', runId);
      await fs.ensureDir(sessionDir);

      send({ type: 'stdout', text: '' });
      send({ type: 'stdout', text: '  Agent: ' + machine });
      send({ type: 'sessionId', sessionId: runId });

      const browser = await chromium.launch({ headless: test.headless || false, args: ['--no-sandbox'] });
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: sessionDir, size: { width: 1280, height: 800 } } });
      const page = await ctx.newPage();

      const allSteps = [...(setupTest ? (setupTest.steps || []) : []), ...(test.steps || [])];
      let stepNum = 0, passed = true, failReason = '';

      if (test.url) {
        await page.goto(test.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(800);
      }

      send({ type: 'stdout', text: '◆ Replaying ' + allSteps.length + ' steps on ' + os.hostname() });

      for (const step of allSteps) {
        stepNum++;
        const sel = sanitiseSelector(step.stableSelector || step.selector);
        const isSetup = setupTest && stepNum <= (setupTest.steps || []).length;
        const desc = step.description || (step.action + ' ' + (sel || ''));
        send({ type: 'stdout', text: '  [' + stepNum + '/' + allSteps.length + '] ' + step.action.toUpperCase() + (isSetup ? ' [SETUP]' : '') + ' — ' + desc });

        try {
          await executeStep(step, sel, page, test);
          send({ type: 'stdout', text: '    ✓ Done' });
          const screenshotPath = path.join(sessionDir, 'step-' + String(stepNum).padStart(3, '0') + '.png');
          await page.screenshot({ path: screenshotPath }).catch(() => {});
        } catch (err) {
          send({ type: 'stdout', text: '    ✖ FAILED: ' + err.message });
          failReason = err.message;
          passed = false;
          break;
        }
      }

      try {
        const videoPath = await page.video()?.path();
        await ctx.close();
        if (videoPath) await fs.move(videoPath, path.join(sessionDir, 'replay.webm'), { overwrite: true }).catch(() => {});
      } catch { try { await ctx.close(); } catch {} }
      await browser.close();

      await fs.writeJson(path.join(sessionDir, 'report.json'), {
        sessionId: runId, goalAchieved: passed, url: test.url || '',
        goal: test.name + ' (recorded replay)', steps: allSteps.slice(0, stepNum),
        duration: 0, type: 'replay', provider: 'replay',
      }, { spaces: 2 }).catch(() => {});

      send({ type: 'stdout', text: '' });
      send({ type: 'stdout', text: '━'.repeat(60) });
      send({ type: 'stdout', text: '  Status: ' + (passed ? 'PASSED ✓' : 'FAILED ✗') });
      if (!passed) send({ type: 'stdout', text: '  Reason: ' + failReason });
      send({ type: 'done', exitCode: passed ? 0 : 1, status: passed ? 'passed' : 'failed' });

      console.log((passed ? chalk.green('  ✔ PASSED') : chalk.red('  ✖ FAILED')) + ' — ' + test.name);
      console.log(chalk.cyan('  ◆ Waiting for jobs\n'));
    } catch (err) {
      console.error(chalk.red('  ✖ Replay error: ' + err.message));
      send({ type: 'stdout', text: '✖ Agent error: ' + err.message });
      send({ type: 'done', exitCode: 1, status: 'failed' });
    }
  }

  // ── HELPERS ────────────────────────────────────────────────────────────────
  function sanitiseSelector(sel) {
    if (!sel) return sel;
    return sel.replace(/\[([a-zA-Z_-]+)="([^"]+\.\d{5,})"\]/g, (_, attr, val) => '[' + attr + '*="' + val.replace(/\.\d{5,}$/, '') + '"]');
  }

  async function executeStep(step, sel, page, test) {
    if (step.action === 'navigate') {
      let navUrl = step.url || step.value;
      if (test.url && navUrl) {
        try { const ro = new URL(navUrl).origin; const to = new URL(test.url).origin; if (ro !== to) navUrl = navUrl.replace(ro, to); } catch {}
      }
      await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(800);

    } else if (step.action === 'click') {
      await page.waitForTimeout(200);
      let clicked = false;
      const selectors = [step.stableSelector, step.selector].filter(Boolean).map(sanitiseSelector);
      if (!clicked && (step.elementX || step.clickX)) {
        const tx = step.elementX || step.clickX, ty = step.elementY || step.clickY;
        for (const s of selectors) {
          if (clicked) break;
          try {
            const count = await page.locator(s).count();
            if (count > 1) {
              let bi = 0, bd = Infinity;
              for (let i = 0; i < count; i++) { try { const box = await page.locator(s).nth(i).boundingBox({ timeout: 2000 }); if (!box) continue; const d = Math.sqrt(Math.pow(box.x + box.width / 2 - tx, 2) + Math.pow(box.y + box.height / 2 - ty, 2)); if (d < bd) { bd = d; bi = i; } } catch {} }
              await page.locator(s).nth(bi).click({ timeout: 5000 }); clicked = true;
            } else if (count === 1) { await page.locator(s).first().click({ timeout: 5000 }); clicked = true; }
          } catch {}
        }
      }
      if (!clicked) { for (const s of selectors) { if (clicked) break; try { await page.locator(s).first().click({ timeout: 5000 }); clicked = true; } catch {} } }
      if (!clicked) { for (const s of selectors) { if (clicked) break; try { await page.locator(s).first().click({ force: true, timeout: 5000 }); clicked = true; } catch {} } }
      if (!clicked) throw new Error('Could not click: ' + selectors.join(', '));
      await page.waitForTimeout(400);

    } else if (step.action === 'type') {
      await page.locator(sel).first().click({ timeout: 5000 });
      await page.locator(sel).first().fill('');
      await page.locator(sel).first().pressSequentially(step.value || '', { delay: 50 });
      await page.locator(sel).first().evaluate(el => {
        el.dispatchEvent(new Event('blur', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('focusout', { bubbles: true }));
      });
      await page.waitForTimeout(300);

    } else if (step.action === 'check') {
      // Use click() rather than check() — Playwright's check() sets the property
      // but doesn't always dispatch the real click event Angular needs.
      // First verify if it's already in the desired state to avoid double-toggling.
      let alreadyCorrect = false;
      try {
        const isCurrentlyChecked = await page.locator(sel).first().isChecked({ timeout: 2000 });
        if (isCurrentlyChecked === step.checked) alreadyCorrect = true;
      } catch {}
      if (!alreadyCorrect) {
        await page.locator(sel).first().click({ timeout: 10000 });
        await page.waitForTimeout(400);
      }

    } else if (step.action === 'select') {
      await page.locator(sel).first().selectOption(step.value || '', { timeout: 10000 });

    } else if (step.action === 'scroll') {
      if (step.isWindow || step.selector === 'window') await page.evaluate(({ x, y }) => window.scrollTo({ left: x, top: y, behavior: 'smooth' }), { x: step.scrollX || 0, y: step.scrollY || 0 });
      else await page.evaluate(({ s, x, y }) => { const el = document.querySelector(s); if (el) el.scrollTo({ left: x, top: y, behavior: 'smooth' }); }, { s: sel, x: step.scrollX || 0, y: step.scrollY || 0 });
      await page.waitForTimeout(500);

    } else if (step.action === 'assert') {
      const assertSel = sanitiseSelector(step.stableSelector || step.selector);
      switch (step.assertType) {
        case 'visible': await page.locator(assertSel).first().waitFor({ state: 'visible', timeout: 10000 }); break;
        case 'text_contains': { const txt = await page.locator(assertSel).first().textContent({ timeout: 10000 }); if (!txt || !txt.includes(step.value || '')) throw new Error('Expected to contain "' + step.value + '"'); break; }
        case 'text_equals': { const txt = await page.locator(assertSel).first().textContent({ timeout: 10000 }); if ((txt || '').trim() !== (step.value || '').trim()) throw new Error('Expected "' + step.value + '"'); break; }
        case 'url_contains': if (!page.url().includes(step.value || '')) throw new Error('URL does not contain "' + step.value + '"'); break;
        case 'element_count': { const count = await page.locator(assertSel).count(); if (count !== parseInt(step.value || '0', 10)) throw new Error('Expected ' + step.value + ' elements, got ' + count); break; }
        case 'attribute_contains': { const attrName = step.attribute || 'title'; const attrVal = await page.locator(assertSel).first().getAttribute(attrName, { timeout: 10000 }); if (!attrVal || !attrVal.includes(step.value || '')) throw new Error(attrName + ' does not contain "' + step.value + '"'); break; }
      }
    }
  }

  // Start connecting
  await connect();
}
