import dotenv from 'dotenv';
import path from 'path';
import axios from 'axios';

const envPath = path.resolve(process.cwd(), '.skopix.env');
dotenv.config({ path: envPath });
dotenv.config();

export class LLMRouter {
  constructor(provider, modelOverride) {
    this.provider = provider || process.env.SKOPIX_PROVIDER || 'gemini';
    this.modelOverride = modelOverride;
    this.modelName = null;
  }

  async verify() {
    switch (this.provider) {
      case 'gemini':
        if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set. Run skopix init.');
        this.modelName = this.modelOverride || 'gemini-2.5-flash';
        break;
      case 'ollama':
        this.modelName = this.modelOverride || process.env.OLLAMA_MODEL || 'llama3.1';
        await this._verifyOllama();
        break;
      case 'openai':
        if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set. Run skopix init.');
        this.modelName = this.modelOverride || 'gpt-4o-mini';
        break;
      default:
        throw new Error('Unknown provider: ' + this.provider);
    }
  }

  async _verifyOllama() {
    const base = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    try {
      await axios.get(base + '/api/tags', { timeout: 5000 });
    } catch {
      throw new Error('Cannot connect to Ollama at ' + base);
    }
  }

  async decide({ goal, url, currentUrl, domSnapshot, stepNumber, previousSteps, credentials }) {
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt({ goal, url, currentUrl, domSnapshot, stepNumber, previousSteps, credentials });

    let rawResponse;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        switch (this.provider) {
          case 'gemini':
            rawResponse = await this._callGemini(systemPrompt, userPrompt);
            break;
          case 'ollama':
            rawResponse = await this._callOllama(systemPrompt, userPrompt);
            break;
          case 'openai':
            rawResponse = await this._callOpenAI(systemPrompt, userPrompt);
            break;
        }
        break;
      } catch (err) {
        const status = err && err.response && err.response.status;
        const isRetryable = status === 429 || status === 503 || (err.message && (err.message.includes('429') || err.message.includes('503')));
        if (isRetryable && attempt < maxRetries) {
          await new Promise(r => setTimeout(r, attempt * 8000));
          continue;
        }
        throw err;
      }
    }

    // Try to parse. On failure, retry ONCE with a tighter prompt asking for a shorter response.
    // This recovers from genuinely-truncated JSON outputs (token limit hit, etc).
    try {
      return parseDecision(rawResponse);
    } catch (parseErr) {
      const shorterPrompt = userPrompt + '\n\nIMPORTANT: Your last response was truncated or malformed JSON. Respond with a CONCISE decision: keep reasoning under 100 chars, flag at most 1 issue this step, no markdown. Just valid compact JSON.';
      try {
        let retryResponse;
        switch (this.provider) {
          case 'gemini':
            retryResponse = await this._callGemini(systemPrompt, shorterPrompt);
            break;
          case 'ollama':
            retryResponse = await this._callOllama(systemPrompt, shorterPrompt);
            break;
          case 'openai':
            retryResponse = await this._callOpenAI(systemPrompt, shorterPrompt);
            break;
        }
        return parseDecision(retryResponse);
      } catch {
        // Both attempts failed - rethrow original parse error
        throw parseErr;
      }
    }
  }

  async _callGemini(systemPrompt, userPrompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    const model = this.modelName;
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey;

    const body = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userPrompt }], role: 'user' }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingBudget: 0 },
      },
    };

    const response = await axios.post(url, body, { timeout: 60000 });
    const candidates = response.data.candidates;
    if (candidates && candidates[0] && candidates[0].content && candidates[0].content.parts && candidates[0].content.parts[0]) {
      return candidates[0].content.parts[0].text || '';
    }
    return '';
  }

  async _callOllama(systemPrompt, userPrompt) {
    const base = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    const response = await axios.post(
      base + '/api/generate',
      { model: this.modelName, system: systemPrompt, prompt: userPrompt, stream: false, options: { temperature: 0.2 } },
      { timeout: 60000 }
    );
    return response.data.response || '';
  }

  async _callOpenAI(systemPrompt, userPrompt) {
    const apiKey = process.env.OPENAI_API_KEY;
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: this.modelName,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        temperature: 0.2,
        max_tokens: 2048,
      },
      { headers: { Authorization: 'Bearer ' + apiKey }, timeout: 60000 }
    );
    const choices = response.data.choices;
    if (choices && choices[0] && choices[0].message) return choices[0].message.content || '';
    return '';
  }
}

function buildSystemPrompt() {
  const parts = [
    'You are Skopix, an expert QA agent that tests web applications like a skilled human tester would.',
    '',
    'Your job: analyse the DOM snapshot, decide the best next action(s), evaluate UI quality, flag bugs.',
    'Respond ONLY with valid JSON. No markdown. Just JSON.',
    '',
    'SINGLE ACTION FORMAT:',
    '{ "action": "...", "target": "...", "value": "...", "reasoning": "...", "observation": "...", "confidence": 8, "goalAchieved": false, "issues": [] }',
    '',
    'BATCH FORMAT - PREFERRED for filling multiple form fields in one turn:',
    '{ "action": "BATCH", "actions": [ {"action":"TYPE","target":"#fullname","value":"John Smith"}, {"action":"TYPE","target":"#email","value":"john@example.com"}, {"action":"SELECT","target":"#country","value":"United States"} ], "reasoning":"...", "observation":"...", "confidence": 9, "goalAchieved": false, "issues": [] }',
    '',
    'WHEN TO USE BATCH (it makes tests much faster):',
    '- 2+ form fields are visible and you know what to fill in each',
    '- You can chain straightforward inputs without observing the result of each one',
    '- BATCH max 8 actions per turn',
    '- Do NOT batch CLICK actions that submit forms or navigate - keep those single',
    '- Ideal use: filling out a form with name, email, address, etc all at once',
    '',
    'BATCH COMPLETENESS - CRITICAL (most common cause of test failures):',
    '- Look at the FORM FIELDS section of the DOM. COUNT the required-looking input fields (username, email, password, name, etc).',
    '- Your BATCH actions array MUST contain ONE TYPE action for EACH of those fields. Never skip one.',
    '- If FORM FIELDS shows id="username" AND id="password", your BATCH MUST have 2 TYPE actions - one for #username AND one for #password. Never just one.',
    '- BEFORE submitting your JSON: re-read your actions array. Count the TYPE actions. Does that count match the number of required fields? If not, ADD the missing ones before responding.',
    '- This is the #1 source of test failures. Take an extra second to double-check completeness.',
    '- Example: form has username + password. WRONG: BATCH with only [TYPE password]. CORRECT: BATCH with [TYPE #username, TYPE #password].',
    '',
    'Actions: CLICK, TYPE, SELECT, PRESS, SCROLL, NAVIGATE, WAIT, HOVER, CLICK_AT, OBSERVE, STOP, BATCH',
    '',
    'CLICK: target = JUST the visible text or label e.g. "Login" or "Submit". Do NOT use "button:Login" or similar prefixed format - just the text itself.',
    'CLICK_AT: target = x,y coords from pos:(x,y) in DOM. Use when CLICK fails.',
    'TYPE: target = id selector from FORM FIELDS section. value = text',
    'SELECT: target = selector. value = option text',
    'PRESS: value = key e.g. Enter, Tab',
    'SCROLL: value = down or up',
    'NAVIGATE: value = full URL',
    'WAIT: value = ms max 5000',
    'HOVER: hover over element to reveal tooltip',
    'OBSERVE: read and record page content, error messages, modal text',
    'STOP: goal complete or stuck',
    '',
    'Critical rules:',
    '- DOM shows TARGET: "#fieldid" for inputs - use those EXACT selectors for TYPE/SELECT',
    '- DOM marks WARNING-STYLED elements - target those for error icons',
    '- Every element shows pos:(x,y) - use CLICK_AT with coords if CLICK fails',
    '- After clicking icons always OBSERVE next to read tooltips/modals',
    '- When verifying error text, OBSERVE and quote EXACT text in observation',
    '- Always use credentials when login forms appear',
    '- Set goalAchieved true only when fully complete',
    '- USE BATCH for forms - it is dramatically faster than one-at-a-time',
    '',
    'FLAGGING ISSUES VS GOAL ACHIEVEMENT (very important - read carefully):',
    '- The GOAL is what the user asked you to test. Set goalAchieved=true ONLY if the specific goal succeeded as described.',
    '- ISSUES are problems you NOTICE while pursuing the goal - they are recorded as observations even if unrelated to the goal.',
    '',
    'How to decide goalAchieved (READ CAREFULLY):',
    '- Read the goal LITERALLY. If the goal says "verify successful login" and login fails → goalAchieved=FALSE. Do not assume the user wanted the opposite.',
    '- Goal "log in and verify dashboard loads" → did login succeed and a dashboard appear? Yes → goalAchieved=true. Unrelated bugs on dashboard do NOT fail the goal.',
    '- Goal "verify successful login with username X password Y" → did the user actually log in successfully? If you see an error message or stay on the login page, login FAILED → goalAchieved=FALSE.',
    '- Goal "verify all images load successfully" → are the images actually loading? No → goalAchieved=false.',
    '- Goal "verify error appears for invalid credentials" → did the error appear? Yes → goalAchieved=true (the goal was to see the error).',
    '- Rule: only the SPECIFIC THING the goal asks about determines goalAchieved. The actual outcome must match what the goal REQUIRES.',
    '- DO NOT mark goalAchieved=true just because you completed your investigation. Mark it true only when the GOAL\'s required outcome was actually observed.',
    '',
    'When to flag issues:',
    '- Flag any problem you notice during testing: broken images, 404s, console errors, JS errors, broken links, layout problems, slow loads, error messages, accessibility issues, etc.',
    '- Each issue: { "title": "Short clear title", "description": "What is wrong and where", "severity": "low" | "medium" | "high" | "critical", "type": "bug" | "ux" | "performance" | "accessibility", "step": <current step number>, "url": "current page URL" }',
    '- Severity: "critical" for blocking core functionality (login broken, data loss, security). "high" for major bugs affecting key flows. "medium" for broken images, 404 resources, console errors. "low" for minor styling/polish.',
    '- CRITICAL: Flag each unique issue ONCE total across all steps - in the step where you first noticed it. Do not re-flag the same issue in subsequent steps.',
    '- "The same issue" means the same root cause - "Login failed with invalid credentials" and "Login failed with incorrect credentials" are the SAME issue, only flag once.',
    '- Look at issues already flagged in previous steps in this conversation. If the issue is already in the previous step\'s issues array, do NOT flag it again.',
    '- Do NOT flag normal app behaviour as issues (e.g. cookie warnings, expected validation errors during a form test).',
    '',
    'Examples:',
    '- Goal "verify images load" + images are broken → goalAchieved=false (the goal target failed) + flag issue.',
    '- Goal "log in" + login works but dashboard has SQL error → goalAchieved=true (login worked) + flag the SQL error as a separate issue.',
    '- Goal "log in" + login fails → goalAchieved=false + flag issue describing the login failure.',
    '- Goal "checkout flow" + checkout completes but image broken on receipt page → goalAchieved=true + flag the image issue.',
    '',
    '',
    'CRITICAL - GOAL DETECTION:',
    '- After EVERY action, check the page for goal completion signals BEFORE deciding to act again',
    '- The CURRENT URL is your strongest signal - if URL has changed from the login/start page, you have likely progressed',
    '- For LOGIN goals: the goal is achieved as soon as you are NO LONGER on the login screen - check if dashboard, sidebar, navigation, or any post-login content is visible',
    '- If you see success messages like "Order placed", "Welcome", "Successfully", "Thank you", "Confirmed", "Dashboard" - the goal is likely DONE',
    '- If you see Order ID, confirmation number, success badges - the goal is likely DONE',
    '- If the original form has been replaced by a success state - the goal is likely DONE',
    '- When goal is done: respond with action OBSERVE, set goalAchieved: true, do NOT try more actions',
    '- Do NOT keep batching after success - check the observation field of previous steps for completion',
    '',
    'IMPORTANT - IGNORE BACKGROUND NOISE:',
    '- Cookie warnings, third-party storage notices, GDPR popups, and similar messages are NOT failure signals',
    '- These messages can appear ALONGSIDE successful login - look for ACTUAL form/dashboard state changes',
    '- If you see new content like a sidebar, dashboard panels, navigation menu, or different page structure than the start - login likely succeeded',
    '- Compare CURRENT URL to ORIGINAL URL - if path has changed (even just adding /dashboard or similar), action succeeded',
    '',
    'NAVIGATION DISCOVERY - finding hidden menu items, categories, tree nodes:',
    '- Sidebars, menus and category lists are often COLLAPSED by default. If you are looking for an item (e.g. "Dates", "Reports", "Settings") and you do not see it in the current snapshot, it may be hidden behind a parent that needs expanding.',
    '- Signs of an expandable parent: a chevron icon (▸ ▶ ▼), an arrow class (caret/chevron/arrow/toggle/expand/collapse), aria-expanded="false", or a parent label that looks like a category header.',
    '- The DOM snapshot marks these with hints like [expandable] or [collapsed] in the NAV section when present.',
    '- Strategy: CLICK the parent first to expand it, then OBSERVE to see the new children, then CLICK the item you actually want.',
    '- Example: Goal "open the Dates category" + you see a "Dashboard" item with a ▸ arrow but no "Dates" → first CLICK "Dashboard" (or the arrow) to expand, THEN you will see "Dates" appear, THEN CLICK it.',
    '- Do NOT give up just because the item is not visible. Always try expanding plausible parent categories first.',
    '- IMPORTANT: When a nav item shows selector:"..." in the snapshot, prefer that EXACT selector as your CLICK target instead of the text. Selectors are more reliable than text matching for custom widgets. e.g. CLICK target = "[pi-test-identifier=\"Dashboard.organisationList.organisation.1\"]".',
    '',
    'STUCK DETECTION - what to do when an action is not progressing:',
    '- If your last 2 steps tried the same action or the page state has not changed, you are stuck.',
    '- Things to try when stuck: SCROLL down to see more content, CLICK any expandable parents to reveal hidden options, HOVER over icons to reveal tooltips, or OBSERVE to re-read the page.',
    '- If the goal references a specific element that does not appear in the DOM, try expanding sidebars, scrolling, or clicking category headers BEFORE assuming the test cannot be completed.',
  ];
  return parts.join('\n');
}

function buildUserPrompt({ goal, url, currentUrl, domSnapshot, stepNumber, previousSteps, credentials }) {
  const credentialSection = buildCredentialSection(credentials);
  const historySection = buildHistorySection(previousSteps);
  const stuckHint = detectStuck(previousSteps);
  return 'TESTING GOAL: ' + goal + '\nORIGINAL URL: ' + url + '\nCURRENT URL: ' + currentUrl + '\nSTEP: ' + stepNumber + '\n' + credentialSection + '\n' + historySection + stuckHint + '\n\nCURRENT PAGE STATE:\n' + domSnapshot + '\n\nDecide the next action. Respond ONLY with valid JSON. Use BATCH if multiple form fields can be filled.';
}

// Change 6: detect when the agent is repeating the same unproductive action.
// Surfaces a hint to break the loop (expand sidebars, scroll, click expandable parents).
function detectStuck(previousSteps) {
  if (!previousSteps || previousSteps.length < 2) return '';
  const last = previousSteps[previousSteps.length - 1];
  const prev = previousSteps[previousSteps.length - 2];

  // Repeated same action+target
  if (last && prev && last.action === prev.action && (last.target || '') === (prev.target || '')) {
    return '\n\n⚠ STUCK SIGNAL: your last 2 actions were identical (' + last.action + ' on ' + (last.target || '?') + '). Try a different approach: expand a sidebar item, SCROLL down, HOVER over icons, or look for a different selector.';
  }
  // Multiple recent failures
  const last3 = previousSteps.slice(-3);
  const failures = last3.filter(s => s.success === false).length;
  if (failures >= 2) {
    return '\n\n⚠ STUCK SIGNAL: your last actions have been failing. Re-read the DOM snapshot carefully. If you are looking for an element that does not appear, try expanding parent categories (look for [expandable, COLLAPSED] in NAVIGATION) or scrolling.';
  }
  return '';
}

function buildCredentialSection(credentials) {
  if (!credentials || Object.keys(credentials).length === 0) return '';
  const lines = ['\nAVAILABLE CREDENTIALS:'];
  for (const [label, fields] of Object.entries(credentials)) {
    lines.push('  [' + label + ']');
    for (const [key, value] of Object.entries(fields)) {
      lines.push('    ' + key + ': ' + value);
    }
  }
  return lines.join('\n');
}

function buildHistorySection(previousSteps) {
  if (!previousSteps || previousSteps.length === 0) return '';
  const lines = ['\nPREVIOUS STEPS:'];
  previousSteps.forEach((s) => {
    const status = s.success ? 'OK' : 'FAIL';
    lines.push('  ' + status + ' Step ' + s.step + ': ' + s.action + ' -> ' + (s.target || s.value || '-'));
    if (s.observation) lines.push('    obs: ' + s.observation);
  });
  return lines.join('\n');
}

// Attempts to repair truncated/malformed JSON from LLMs.
// Common patterns: missing closing ] for arrays, missing closing }, unterminated strings,
// trailing commas. Returns parsed object on success, null on failure.
function tryRepairJSON(jsonStr) {
  if (!jsonStr || typeof jsonStr !== 'string') return null;
  let s = jsonStr;

  // Helper: strip trailing whitespace and commas
  const trimRight = () => {
    while (s.length > 0) {
      const c = s[s.length - 1];
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === ',') {
        s = s.slice(0, -1);
        continue;
      }
      break;
    }
  };

  // Helper: count bracket depth at each position
  const countDepths = (str) => {
    let curly = 0, square = 0;
    let inStr = false, esc = false;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') curly++;
      else if (c === '}') curly--;
      else if (c === '[') square++;
      else if (c === ']') square--;
    }
    return { curly, square };
  };

  // Helper: are we currently inside an unterminated string?
  const inUnterminatedString = (str) => {
    let inStr = false, esc = false;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = !inStr;
    }
    return inStr;
  };

  // Attempt 1: Simple repair (close unterminated string, balance brackets)
  trimRight();
  if (inUnterminatedString(s)) s += '"';
  trimRight();
  let attempt = s;
  let d = countDepths(attempt);
  while (d.square > 0) { attempt += ']'; d.square--; }
  while (d.curly > 0) { attempt += '}'; d.curly--; }
  try { return JSON.parse(attempt); } catch {}

  // Attempt 2: Strip incomplete trailing object inside array.
  // Walk back from end, find the last position where we're at a 'safe' depth
  // (i.e., between array elements with no unterminated string).
  // Then close from there.
  s = jsonStr;
  for (let pos = s.length; pos > 0; pos--) {
    const slice = s.slice(0, pos);
    if (inUnterminatedString(slice)) continue;
    // Look back past whitespace and commas
    let trimmed = slice;
    while (trimmed.length > 0) {
      const c = trimmed[trimmed.length - 1];
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === ',') {
        trimmed = trimmed.slice(0, -1);
        continue;
      }
      break;
    }
    if (trimmed.length === 0) continue;
    const last = trimmed[trimmed.length - 1];
    // Safe positions to truncate at: after } (end of object), ] (end of array),
    // a digit or a quote (end of value)
    if (last !== '}' && last !== ']' && last !== '"' && !/[0-9truefalsn]/.test(last)) continue;
    let candidate = trimmed;
    const dd = countDepths(candidate);
    while (dd.square > 0) { candidate += ']'; dd.square--; }
    while (dd.curly > 0) { candidate += '}'; dd.curly--; }
    try { return JSON.parse(candidate); } catch { continue; }
  }

  return null;
}

function parseDecision(rawText) {
  if (!rawText) throw new Error('Empty response from LLM');

  let cleaned = rawText.trim();
  cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  const start = cleaned.indexOf('{');
  if (start === -1) throw new Error('LLM response is not JSON: ' + cleaned.slice(0, 200));

  const end = cleaned.lastIndexOf('}');
  // Take everything from { onwards. If there's a closing }, use that. If not, work with what we have.
  let jsonStr = end === -1 ? cleaned.slice(start) : cleaned.slice(start, end + 1);

  let parsed = null;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    // Auto-repair common LLM truncation patterns:
    // 1) Truncated mid-array: close unclosed [
    // 2) Truncated mid-string: close unterminated "
    // 3) Truncated mid-object: close unclosed {
    // 4) Trailing comma before close
    parsed = tryRepairJSON(jsonStr);
    if (!parsed) {
      throw new Error('Failed to parse JSON: ' + err.message);
    }
  }

  const validActions = ['CLICK', 'TYPE', 'SELECT', 'PRESS', 'SCROLL', 'NAVIGATE', 'WAIT', 'HOVER', 'CLICK_AT', 'STOP', 'OBSERVE', 'BATCH'];
  let action = (parsed.action || 'OBSERVE').toUpperCase();

  if (!validActions.includes(action)) {
    const actionMap = {
      'INSPECT': 'OBSERVE', 'READ': 'OBSERVE', 'VERIFY': 'OBSERVE', 'CHECK': 'OBSERVE',
      'ASSERT': 'OBSERVE', 'VALIDATE': 'OBSERVE', 'FIND': 'OBSERVE',
      'TAP': 'CLICK', 'PRESS_BUTTON': 'CLICK', 'SUBMIT': 'CLICK',
      'ENTER': 'TYPE', 'INPUT': 'TYPE', 'FILL': 'TYPE',
    };
    const prefix = Object.keys(actionMap).find(k => action.startsWith(k));
    action = prefix ? actionMap[prefix] : 'OBSERVE';
  }

  const result = {
    action,
    target: parsed.target || null,
    value: parsed.value || null,
    reasoning: parsed.reasoning || '',
    observation: parsed.observation || '',
    confidence: Math.min(10, Math.max(0, parseInt(parsed.confidence) || 5)),
    goalAchieved: Boolean(parsed.goalAchieved),
    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
  };

  // For BATCH, validate the actions array
  if (action === 'BATCH') {
    if (!Array.isArray(parsed.actions) || parsed.actions.length === 0) {
      // Fall back to OBSERVE if BATCH has no actions
      result.action = 'OBSERVE';
    } else {
      result.actions = parsed.actions.slice(0, 8).map(a => ({
        action: (a.action || '').toUpperCase(),
        target: a.target || null,
        value: a.value || null,
      }));
    }
  }

  return result;
}
