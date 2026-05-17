import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs-extra';

dotenv.config({ path: path.resolve(process.cwd(), '.skopix.env') });
dotenv.config();

// Local issue store - shared across all tests in the project
const ISSUES_STORE_PATH = path.join(process.cwd(), 'skopix-reports', '.issues', 'issues.json');

async function loadIssueStore() {
  try {
    if (!await fs.pathExists(ISSUES_STORE_PATH)) return { issues: [] };
    return await fs.readJson(ISSUES_STORE_PATH);
  } catch {
    return { issues: [] };
  }
}

async function saveIssueStore(store) {
  await fs.ensureDir(path.dirname(ISSUES_STORE_PATH));
  await fs.writeJson(ISSUES_STORE_PATH, store, { spaces: 2 });
}

async function findIssueInStore(fingerprint, tracker) {
  const store = await loadIssueStore();
  return store.issues.find(i => i.fingerprint === fingerprint && i.tracker === tracker);
}

async function recordIssueInStore(record) {
  const store = await loadIssueStore();
  // Upsert by fingerprint + tracker
  const idx = store.issues.findIndex(i => i.fingerprint === record.fingerprint && i.tracker === record.tracker);
  if (idx >= 0) {
    store.issues[idx] = { ...store.issues[idx], ...record };
  } else {
    store.issues.push(record);
  }
  await saveIssueStore(store);
}

async function updateIssueInStore(fingerprint, tracker, updates) {
  const store = await loadIssueStore();
  const idx = store.issues.findIndex(i => i.fingerprint === fingerprint && i.tracker === tracker);
  if (idx >= 0) {
    store.issues[idx] = { ...store.issues[idx], ...updates };
    await saveIssueStore(store);
  }
}

export { loadIssueStore, saveIssueStore };

export class IssueTracker {
  constructor({ jira, linear, github }) {
    this.useJira = jira;
    this.useLinear = linear;
    this.useGithub = github;
  }

  async pushIssues(issues, context) {
    const created = [];
    const { url, goal } = context;

    for (const issue of issues) {
      const safe = this._sanitise(issue, { url, goal });
      const fingerprint = this._fingerprint(safe, context);
      const body = this._formatBody(safe, context, fingerprint);
      const title = this._formatTitle(safe, context);

      if (this.useJira) {
        try {
          const result = await this._createOrUpdateJiraIssue(safe, title, body, fingerprint, context);
          created.push({ tracker: 'jira', ...result });
        } catch (err) {
          console.error(`Jira error: ${err.message}`);
        }
      }

      if (this.useLinear) {
        try {
          const result = await this._createOrUpdateLinearIssue(safe, title, body, fingerprint, context);
          created.push({ tracker: 'linear', ...result });
        } catch (err) {
          console.error(`Linear error: ${err.message}`);
        }
      }

      if (this.useGithub) {
        try {
          const result = await this._createOrUpdateGithubIssue(safe, title, body, fingerprint, context);
          created.push({ tracker: 'github', ...result });
        } catch (err) {
          console.error(`GitHub error: ${err.message}`);
        }
      }
    }

    return created;
  }

  _sanitise(issue, { url, goal }) {
    let title = issue.title && issue.title !== 'undefined' ? issue.title : null;
    if (!title && issue.description && issue.description !== 'undefined') {
      title = String(issue.description).split(/[.\n]/)[0].slice(0, 80).trim();
    }
    if (!title) {
      const urlPath = url ? new URL(url).pathname : 'page';
      title = `Issue detected on ${urlPath}`;
    }

    const description = issue.description && issue.description !== 'undefined'
      ? issue.description
      : 'An issue was detected during automated testing. See session details for full context.';

    return {
      title: title.replace(/^undefined\s*/i, '').trim() || 'Issue detected',
      description,
      severity: (issue.severity && issue.severity !== 'undefined') ? issue.severity : 'medium',
      type: issue.type || 'bug',
      step: issue.step || '?',
      url: issue.url || url,
    };
  }

  _fingerprint(issue, { testName, suiteName, url }) {
    // Normalise the title - strip variable bits, lowercase, collapse whitespace
    let normalisedTitle = (issue.title || '')
      .toLowerCase()
      // Strip session IDs, hashes, numbers in brackets
      .replace(/[a-f0-9]{8,}/g, '')
      .replace(/\[[\w\-:]+\]/g, '')
      .replace(/\d+/g, 'N')
      // Collapse whitespace and special chars
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Strip common filler words and pluralisation to reduce minor variations
    const fillerWords = new Set(['the', 'a', 'an', 'with', 'of', 'on', 'in', 'for', 'to', 'and', 'or', 'when', 'during', 'at', 'that', 'is', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'this', 'these', 'those', 'it']);
    normalisedTitle = normalisedTitle
      .split(' ')
      .filter(w => w && !fillerWords.has(w))
      // Crude singularisation - strip trailing s/es to handle plural variations
      .map(w => {
        // Crude singularisation - strip trailing s to handle plural variations
        // Don't double-strip: "resources" → "resource" (strip s only), not "resourc"
        if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y'; // "categories" → "category"
        if (w.length > 4 && w.endsWith('xes')) return w.slice(0, -2); // "boxes" → "box"
        if (w.length > 4 && w.endsWith('ses') && !w.endsWith('sses')) return w.slice(0, -2); // "buses" → "bus"
        if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1); // "resources" → "resource", "errors" → "error"
        return w;
      })
      .slice(0, 8) // first 8 meaningful words only
      .sort() // sort so word order doesn't affect hash
      .join(' ');

    // Use URL pathname only (ignore query strings, fragments)
    let urlKey = '';
    try {
      const u = new URL(issue.url || url);
      urlKey = u.hostname + u.pathname;
    } catch {
      urlKey = issue.url || url || '';
    }

    const parts = [
      suiteName || '',
      testName || '',
      urlKey,
      issue.type || 'bug',
      normalisedTitle,
    ];

    return crypto.createHash('sha256').update(parts.join('::')).digest('hex').slice(0, 16);
  }

  // Filter issues to those that could plausibly be the "same" issue:
  // - Same tracker
  // - Same status (open)
  // - Same URL hostname AND pathname (so /login on site A != /login on site B, and /login != /admin on same site)
  _filterCandidates(allIssues, newIssue, tracker, contextUrl) {
    const targetUrl = newIssue.url || contextUrl;
    let targetHost = '';
    let targetPath = '';
    try {
      const u = new URL(targetUrl);
      targetHost = u.hostname.toLowerCase();
      targetPath = u.pathname.toLowerCase().replace(/\/+$/, '') || '/';
    } catch {
      targetHost = (targetUrl || '').toLowerCase();
    }

    return allIssues.filter(stored => {
      if (stored.tracker !== tracker) return false;
      if (stored.status !== 'open') return false;
      // URL match - same host AND same path
      if (!stored.url) return false;
      try {
        const s = new URL(stored.url);
        if (s.hostname.toLowerCase() !== targetHost) return false;
        const sPath = s.pathname.toLowerCase().replace(/\/+$/, '') || '/';
        if (sPath !== targetPath) return false;
      } catch {
        return false;
      }
      // Same issue type (bug != performance != accessibility)
      if (stored.type && newIssue.type && stored.type !== newIssue.type) return false;
      return true;
    });
  }

  // Use the LLM to decide: is this new issue semantically the same as any of the candidates?
  // Returns the matched stored issue, or null if it's genuinely new.
  async _findSemanticMatch(newIssue, candidates) {
    if (candidates.length === 0) return null;

    // Fast path: if we have an exact fingerprint match in candidates, use it directly.
    // Saves the LLM call when phrasing is identical.
    // (Caller already passes through fingerprint-stored issues, but check anyway.)
    const exactFp = this._fingerprintCore(newIssue.title || '');
    for (const c of candidates) {
      if (this._fingerprintCore(c.title || '') === exactFp) return c;
    }

    // Slow path: ask the LLM via direct Gemini API call (no extra deps)
    try {
      const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
      if (!apiKey) return null; // No LLM available - safer to fail open (create new)

      const list = candidates.map((c, i) => `${i + 1}. "${c.title}" (description: "${(c.description || '').slice(0, 100)}", severity: ${c.severity}, type: ${c.type})`).join('\n');
      const prompt = `You are deduplicating bug reports detected by an automated QA tool. A test detected this NEW issue on a website:

NEW ISSUE:
Title: "${newIssue.title}"
Description: "${(newIssue.description || '').slice(0, 200)}"
Severity: ${newIssue.severity}
Type: ${newIssue.type}
URL: ${newIssue.url}

Below are existing OPEN issues already raised for the SAME page. Decide if the NEW issue is reporting the SAME underlying bug as any of them.

EXISTING ISSUES (all on the same page):
${list}

Rules:
- Two issues are the SAME if they describe the same root cause, even with different wording. Examples of same: "Broken images" vs "Images failed to load" vs "404 errors on image resources". "Login failed" vs "Login Failed with Invalid Credentials" vs "Authentication failure".
- Two issues are DIFFERENT if they describe distinct technical problems. Examples of different: "Login button missing" vs "Slow page load". "Broken image" vs "Console error about Stripe widget".
- Be conservative: if unsure, say NEW. False merges hide bugs; false splits just create extra tickets.

Respond with ONLY one of these formats - nothing else:
- A single integer (1, 2, 3, etc.) referring to the matching existing issue number above.
- The literal word: NEW

Your answer:`;

      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 10 },
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
      );

      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const trimmed = text.trim().toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g, '');

      if (trimmed === 'new') return null;
      const num = parseInt(trimmed, 10);
      if (Number.isInteger(num) && num >= 1 && num <= candidates.length) {
        return candidates[num - 1];
      }
      return null;
    } catch (err) {
      // LLM call failed - fail open (create new ticket). Better an extra ticket than a false merge.
      return null;
    }
  }

  _fingerprintCore(title) {
    let s = (title || '')
      .toLowerCase()
      .replace(/[a-f0-9]{8,}/g, '')
      .replace(/\d+/g, 'N')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const fillers = new Set(['the', 'a', 'an', 'with', 'of', 'on', 'in', 'for', 'to', 'and', 'or', 'when', 'during', 'at', 'that', 'is', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'this', 'these', 'those', 'it']);
    s = s.split(' ').filter(w => w && !fillers.has(w))
      .map(w => {
        if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
        if (w.length > 4 && w.endsWith('xes')) return w.slice(0, -2);
        if (w.length > 4 && w.endsWith('ses') && !w.endsWith('sses')) return w.slice(0, -2);
        if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1);
        return w;
      })
      .slice(0, 8).sort().join(' ');
    return s;
  }

  // Find any existing issue (in local store) that matches the new one.
  // Strategy:
  //   1. Exact fingerprint match → use it (fastest, deterministic)
  //   2. URL-scoped semantic comparison via LLM → use it (handles phrasing variation)
  //   3. No match → return null (caller creates new)
  async _findExistingMatch(issue, fingerprint, tracker, context) {
    const store = await loadIssueStore();
    const allIssues = store.issues || [];

    // Step 1: exact fingerprint match wins fast
    const exact = allIssues.find(i => i.fingerprint === fingerprint && i.tracker === tracker);
    if (exact) {
      exact._matchReason = 'fingerprint';
      return exact;
    }

    // Step 2: filter to plausible candidates (same URL host+path, same tracker, status open)
    const candidates = this._filterCandidates(allIssues, issue, tracker, context.url);
    if (candidates.length === 0) return null;

    // Step 3: ask the LLM if any candidate is the same bug
    const semantic = await this._findSemanticMatch(issue, candidates);
    if (semantic) {
      semantic._matchReason = 'semantic';
      return semantic;
    }

    return null;
  }

  _formatTitle(issue, { testName, suiteName }) {
    let prefix = '[Skopix]';
    if (suiteName) prefix = `[Skopix · ${suiteName}]`;
    else if (testName) prefix = `[Skopix · ${testName}]`;
    return `${prefix} ${issue.title}`;
  }

  _formatBody(issue, { url, goal, sessionId, testName, suiteName, reportPath, dashboardUrl }, fingerprint) {
    const lines = [];

    lines.push(`<!-- skopix-fingerprint: ${fingerprint} -->`);
    lines.push('');
    lines.push(`## ${issue.title}`);
    lines.push('');
    lines.push(`**Severity:** ${issue.severity}`);
    lines.push(`**Type:** ${issue.type}`);
    lines.push(`**Detected at:** Step ${issue.step}`);
    lines.push(`**URL:** ${issue.url}`);
    lines.push('');

    lines.push('### Description');
    lines.push(issue.description);
    lines.push('');

    lines.push('### Test context');
    if (suiteName) lines.push(`- **Suite:** ${suiteName}`);
    if (testName) lines.push(`- **Test:** ${testName}`);
    lines.push(`- **Goal:** "${goal}"`);
    lines.push(`- **Target URL:** ${url}`);
    lines.push(`- **Session ID:** \`${sessionId}\``);
    if (reportPath) lines.push(`- **Local report:** \`${reportPath}\``);
    if (dashboardUrl) lines.push(`- **Dashboard:** [Open in Skopix](${dashboardUrl})`);
    lines.push('');

    lines.push('---');
    lines.push('*Detected automatically by [Skopix](https://skopix.dev) — AI-powered QA agent*');

    return lines.join('\n');
  }

  _formatRecurrenceComment({ sessionId, testName, suiteName, reportPath }) {
    const when = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const lines = [`**Detected again** at ${when} UTC`];
    if (suiteName) lines.push(`- Suite: ${suiteName}`);
    if (testName) lines.push(`- Test: ${testName}`);
    lines.push(`- Session: \`${sessionId}\``);
    if (reportPath) lines.push(`- Report: \`${reportPath}\``);
    return lines.join('\n');
  }

  // ─── GITHUB ────────────────────────────────────────────────────────────────
  async _findGithubIssueByFingerprint(fingerprint) {
    const { GITHUB_TOKEN, GITHUB_REPO } = process.env;
    try {
      // GitHub search API - look for the fingerprint in open issues
      const response = await axios.get(
        `https://api.github.com/search/issues`,
        {
          params: {
            q: `repo:${GITHUB_REPO} is:issue is:open "skopix-fingerprint: ${fingerprint}"`,
          },
          headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
          },
        }
      );
      const items = response.data.items || [];
      return items.length > 0 ? items[0] : null;
    } catch (err) {
      // Search API can have eventual consistency, fail gracefully
      return null;
    }
  }

  async _commentOnGithubIssue(issueNumber, comment) {
    const { GITHUB_TOKEN, GITHUB_REPO } = process.env;
    await axios.post(
      `https://api.github.com/repos/${GITHUB_REPO}/issues/${issueNumber}/comments`,
      { body: comment },
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );
  }

  async _createOrUpdateGithubIssue(issue, title, body, fingerprint, context) {
    const { GITHUB_TOKEN, GITHUB_REPO } = process.env;
    if (!GITHUB_TOKEN || !GITHUB_REPO) {
      throw new Error('Missing GitHub env vars. Run `skopix init`.');
    }

    // Find a matching existing issue using URL-scoped semantic comparison
    const match = await this._findExistingMatch(issue, fingerprint, 'github', context);

    if (match) {
      // Verify it's still actually open on the tracker (auto-sync)
      try {
        const liveStatus = await this._getGithubIssueStatus(match.trackerRef);
        if (liveStatus === 'closed') {
          await updateIssueInStore(match.fingerprint, 'github', { status: 'resolved' });
          // Fall through to create-new path
        } else {
          // Still open - comment, increment counter
          const comment = this._formatRecurrenceComment(context);
          await this._commentOnGithubIssue(match.trackerRef, comment);
          await updateIssueInStore(match.fingerprint, 'github', {
            lastSeen: new Date().toISOString(),
            occurrences: (match.occurrences || 1) + 1,
            sessions: [...(match.sessions || []), context.sessionId].slice(-20),
          });
          return {
            action: 'commented',
            number: match.trackerRef,
            html_url: match.trackerUrl,
            matchedBy: match._matchReason || 'fingerprint',
          };
        }
      } catch {
        // Status check failed - safer to create new
      }
    }

    // Create new (either no existing record OR previous one was resolved)
    const labelMap = {
      critical: ['bug', 'priority: critical'],
      high: ['bug', 'priority: high'],
      medium: ['bug'],
      low: ['enhancement'],
    };

    const response = await axios.post(
      `https://api.github.com/repos/${GITHUB_REPO}/issues`,
      {
        title,
        body,
        labels: labelMap[issue.severity] || ['bug'],
      },
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    // Save to local store
    await recordIssueInStore({
      fingerprint,
      tracker: 'github',
      trackerRef: String(response.data.number),
      trackerUrl: response.data.html_url,
      title: issue.title,
      severity: issue.severity,
      type: issue.type,
      status: 'open',
      testName: context.testName || null,
      suiteName: context.suiteName || null,
      url: issue.url,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      occurrences: 1,
      sessions: [context.sessionId],
    });

    return {
      action: 'created',
      number: response.data.number,
      html_url: response.data.html_url,
    };
  }

  async _getGithubIssueStatus(issueNumber) {
    const { GITHUB_TOKEN, GITHUB_REPO } = process.env;
    const response = await axios.get(
      `https://api.github.com/repos/${GITHUB_REPO}/issues/${issueNumber}`,
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );
    return response.data.state; // 'open' or 'closed'
  }

  // ─── JIRA ──────────────────────────────────────────────────────────────────
  async _findJiraIssueByFingerprint(fingerprint) {
    const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY } = process.env;
    try {
      const jql = `project = "${JIRA_PROJECT_KEY}" AND statusCategory != Done AND text ~ "skopix-fingerprint ${fingerprint}"`;
      const response = await axios.get(
        `${JIRA_BASE_URL}/rest/api/3/search`,
        {
          params: { jql, fields: 'summary,status', maxResults: 1 },
          auth: { username: JIRA_EMAIL, password: JIRA_API_TOKEN },
        }
      );
      const issues = response.data.issues || [];
      return issues.length > 0 ? issues[0] : null;
    } catch (err) {
      return null;
    }
  }

  async _commentOnJiraIssue(issueKey, comment) {
    const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
    await axios.post(
      `${JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/comment`,
      {
        body: {
          type: 'doc', version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: comment }] }],
        },
      },
      {
        auth: { username: JIRA_EMAIL, password: JIRA_API_TOKEN },
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  async _createOrUpdateJiraIssue(issue, title, body, fingerprint, context) {
    const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY } = process.env;
    if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN || !JIRA_PROJECT_KEY) {
      throw new Error('Missing Jira env vars. Run `skopix init`.');
    }

    const match = await this._findExistingMatch(issue, fingerprint, 'jira', context);
    if (match) {
      try {
        const liveStatus = await this._getJiraIssueStatus(match.trackerRef);
        if (liveStatus === 'closed') {
          await updateIssueInStore(match.fingerprint, 'jira', { status: 'resolved' });
        } else {
          const comment = this._formatRecurrenceComment(context);
          await this._commentOnJiraIssue(match.trackerRef, comment);
          await updateIssueInStore(match.fingerprint, 'jira', {
            lastSeen: new Date().toISOString(),
            occurrences: (match.occurrences || 1) + 1,
            sessions: [...(match.sessions || []), context.sessionId].slice(-20),
          });
          return {
            action: 'commented',
            key: match.trackerRef,
            url: match.trackerUrl,
            matchedBy: match._matchReason || 'fingerprint',
          };
        }
      } catch {}
    }

    const priorityMap = { critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low' };

    const response = await axios.post(
      `${JIRA_BASE_URL}/rest/api/3/issue`,
      {
        fields: {
          project: { key: JIRA_PROJECT_KEY },
          summary: title,
          description: {
            type: 'doc', version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }],
          },
          issuetype: { name: 'Bug' },
          priority: { name: priorityMap[issue.severity] || 'Medium' },
        },
      },
      {
        auth: { username: JIRA_EMAIL, password: JIRA_API_TOKEN },
        headers: { 'Content-Type': 'application/json' },
      }
    );

    await recordIssueInStore({
      fingerprint, tracker: 'jira',
      trackerRef: response.data.key,
      trackerUrl: `${JIRA_BASE_URL}/browse/${response.data.key}`,
      title: issue.title, severity: issue.severity, type: issue.type,
      status: 'open',
      testName: context.testName || null, suiteName: context.suiteName || null,
      url: issue.url,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      occurrences: 1, sessions: [context.sessionId],
    });

    return {
      action: 'created',
      key: response.data.key,
      url: `${JIRA_BASE_URL}/browse/${response.data.key}`,
    };
  }

  async _getJiraIssueStatus(issueKey) {
    const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
    const response = await axios.get(
      `${JIRA_BASE_URL}/rest/api/3/issue/${issueKey}?fields=status`,
      { auth: { username: JIRA_EMAIL, password: JIRA_API_TOKEN } }
    );
    const cat = response.data.fields?.status?.statusCategory?.key;
    return cat === 'done' ? 'closed' : 'open';
  }

  // ─── LINEAR ────────────────────────────────────────────────────────────────
  async _findLinearIssueByFingerprint(fingerprint) {
    const { LINEAR_API_KEY, LINEAR_TEAM_ID } = process.env;
    try {
      const query = `
        query SearchIssues($filter: IssueFilter!) {
          issues(filter: $filter, first: 5) {
            nodes { id identifier url description state { type } }
          }
        }
      `;
      const response = await axios.post(
        'https://api.linear.app/graphql',
        {
          query,
          variables: {
            filter: {
              team: { id: { eq: LINEAR_TEAM_ID } },
              state: { type: { neq: 'completed' } },
              description: { contains: `skopix-fingerprint: ${fingerprint}` },
            },
          },
        },
        { headers: { Authorization: LINEAR_API_KEY } }
      );
      const nodes = response.data.data?.issues?.nodes || [];
      return nodes.length > 0 ? nodes[0] : null;
    } catch {
      return null;
    }
  }

  async _commentOnLinearIssue(issueId, comment) {
    const { LINEAR_API_KEY } = process.env;
    const query = `
      mutation CreateComment($input: CommentCreateInput!) {
        commentCreate(input: $input) { success }
      }
    `;
    await axios.post(
      'https://api.linear.app/graphql',
      { query, variables: { input: { issueId, body: comment } } },
      { headers: { Authorization: LINEAR_API_KEY } }
    );
  }

  async _createOrUpdateLinearIssue(issue, title, body, fingerprint, context) {
    const { LINEAR_API_KEY, LINEAR_TEAM_ID } = process.env;
    if (!LINEAR_API_KEY || !LINEAR_TEAM_ID) {
      throw new Error('Missing Linear env vars. Run `skopix init`.');
    }

    const match = await this._findExistingMatch(issue, fingerprint, 'linear', context);
    if (match) {
      try {
        const liveStatus = await this._getLinearIssueStatus(match.trackerRef);
        if (liveStatus === 'closed') {
          await updateIssueInStore(match.fingerprint, 'linear', { status: 'resolved' });
        } else {
          const comment = this._formatRecurrenceComment(context);
          await this._commentOnLinearIssue(match.trackerRef, comment);
          await updateIssueInStore(match.fingerprint, 'linear', {
            lastSeen: new Date().toISOString(),
            occurrences: (match.occurrences || 1) + 1,
            sessions: [...(match.sessions || []), context.sessionId].slice(-20),
          });
          return {
            action: 'commented',
            id: match.trackerRef,
            url: match.trackerUrl,
            matchedBy: match._matchReason || 'fingerprint',
          };
        }
      } catch {}
    }

    const priorityMap = { critical: 1, high: 2, medium: 3, low: 4 };
    const query = `
      mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success issue { id url }
        }
      }
    `;
    const response = await axios.post(
      'https://api.linear.app/graphql',
      {
        query,
        variables: {
          input: {
            title, description: body,
            teamId: LINEAR_TEAM_ID,
            priority: priorityMap[issue.severity] || 3,
          },
        },
      },
      { headers: { Authorization: LINEAR_API_KEY } }
    );

    const created = response.data.data?.issueCreate?.issue;
    if (created) {
      await recordIssueInStore({
        fingerprint, tracker: 'linear',
        trackerRef: created.id,
        trackerUrl: created.url,
        title: issue.title, severity: issue.severity, type: issue.type,
        status: 'open',
        testName: context.testName || null, suiteName: context.suiteName || null,
        url: issue.url,
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        occurrences: 1, sessions: [context.sessionId],
      });
    }
    return { action: 'created', id: created?.id, url: created?.url };
  }

  async _getLinearIssueStatus(issueId) {
    const { LINEAR_API_KEY } = process.env;
    const query = `query GetIssue($id: String!) { issue(id: $id) { state { type } } }`;
    const response = await axios.post(
      'https://api.linear.app/graphql',
      { query, variables: { id: issueId } },
      { headers: { Authorization: LINEAR_API_KEY } }
    );
    const stateType = response.data.data?.issue?.state?.type;
    return stateType === 'completed' || stateType === 'canceled' ? 'closed' : 'open';
  }
}
