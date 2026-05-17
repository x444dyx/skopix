import fs from 'fs-extra';
import path from 'path';

export class ReportGenerator {
  constructor(outputDir, sessionId) {
    this.outputDir = outputDir;
    this.sessionId = sessionId;
  }

  async generate({ sessionId, url, goal, steps, issues, goalAchieved, stuck, videoPath, duration, provider, model }) {
    const reportPath = path.join(this.outputDir, 'report.html');
    const jsonPath = path.join(this.outputDir, 'report.json');

    // Save raw JSON
    await fs.writeJson(jsonPath, {
      sessionId, url, goal, steps, issues, goalAchieved, stuck,
      duration, provider, model, generatedAt: new Date().toISOString(),
    }, { spaces: 2 });

    // Build HTML report
    const html = this._buildHTML({ sessionId, url, goal, steps, issues, goalAchieved, stuck, videoPath, duration, provider, model });
    await fs.writeFile(reportPath, html);

    return reportPath;
  }

  _buildHTML({ sessionId, url, goal, steps, issues, goalAchieved, stuck, videoPath, duration, provider, model }) {
    const status = goalAchieved ? 'PASSED' : stuck ? 'STUCK' : 'FAILED';
    const statusClass = goalAchieved ? 'passed' : stuck ? 'stuck' : 'failed';
    const durationStr = this._formatDuration(duration);
    const videoFilename = videoPath ? path.basename(videoPath) : null;

    const stepsHtml = steps.map((s, i) => this._stepHtml(s, i)).join('');
    const issuesHtml = issues.length > 0
      ? issues.map((iss) => this._issueHtml(iss)).join('')
      : '<p class="no-issues">No issues detected in this session.</p>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Skopix Report — ${sessionId}</title>
<style>
  :root {
    --bg: #0a0a0f;
    --surface: #111118;
    --border: #1e1e2e;
    --accent: #00d4ff;
    --accent2: #7c3aed;
    --text: #e2e8f0;
    --muted: #64748b;
    --passed: #10b981;
    --failed: #ef4444;
    --stuck: #f59e0b;
    --critical: #ef4444;
    --high: #f97316;
    --medium: #f59e0b;
    --low: #3b82f6;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'SF Mono', 'Fira Code', monospace; font-size: 14px; line-height: 1.6; }
  .container { max-width: 1100px; margin: 0 auto; padding: 40px 24px; }

  header { border-bottom: 1px solid var(--border); padding-bottom: 32px; margin-bottom: 32px; }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
  .brand-name { font-size: 22px; font-weight: 700; color: var(--accent); letter-spacing: 0.05em; }
  .brand-sub { color: var(--muted); font-size: 12px; }

  .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }
  .meta-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .meta-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; }
  .meta-value { color: var(--text); font-size: 14px; word-break: break-all; }
  .meta-value.accent { color: var(--accent); }

  .status-badge { display: inline-flex; align-items: center; gap: 8px; padding: 8px 20px; border-radius: 100px; font-weight: 700; font-size: 13px; letter-spacing: 0.05em; }
  .status-badge.passed { background: rgba(16,185,129,0.15); color: var(--passed); border: 1px solid rgba(16,185,129,0.3); }
  .status-badge.failed { background: rgba(239,68,68,0.15); color: var(--failed); border: 1px solid rgba(239,68,68,0.3); }
  .status-badge.stuck { background: rgba(245,158,11,0.15); color: var(--stuck); border: 1px solid rgba(245,158,11,0.3); }

  section { margin-bottom: 40px; }
  .section-title { font-size: 16px; font-weight: 600; color: var(--accent); margin-bottom: 20px; padding-bottom: 8px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; }
  .badge { background: var(--accent2); color: white; font-size: 11px; padding: 2px 8px; border-radius: 100px; }

  .issue-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin-bottom: 12px; border-left: 3px solid; }
  .issue-card.critical { border-left-color: var(--critical); }
  .issue-card.high { border-left-color: var(--high); }
  .issue-card.medium { border-left-color: var(--medium); }
  .issue-card.low { border-left-color: var(--low); }
  .issue-header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .severity-tag { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; padding: 2px 8px; border-radius: 4px; }
  .severity-tag.critical { background: rgba(239,68,68,0.2); color: var(--critical); }
  .severity-tag.high { background: rgba(249,115,22,0.2); color: var(--high); }
  .severity-tag.medium { background: rgba(245,158,11,0.2); color: var(--stuck); }
  .severity-tag.low { background: rgba(59,130,246,0.2); color: var(--low); }
  .issue-title { font-weight: 600; color: var(--text); }
  .issue-desc { color: var(--muted); font-size: 13px; margin-bottom: 8px; }
  .issue-meta { font-size: 12px; color: var(--muted); }

  .step-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 8px; overflow: hidden; }
  .step-header { display: flex; align-items: center; gap: 12px; padding: 14px 16px; cursor: pointer; }
  .step-header:hover { background: rgba(255,255,255,0.02); }
  .step-num { color: var(--muted); font-size: 12px; min-width: 40px; }
  .step-action { color: var(--accent); font-weight: 600; font-size: 12px; min-width: 80px; }
  .step-target { color: var(--text); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .step-status { font-size: 16px; }
  .conf-bar { display: flex; gap: 2px; }
  .conf-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--border); }
  .conf-dot.filled { background: var(--accent); }
  .step-body { padding: 0 16px 16px; border-top: 1px solid var(--border); display: none; }
  .step-body.open { display: block; }
  .step-field { margin-top: 12px; }
  .step-field-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
  .step-field-value { color: var(--text); font-size: 13px; }
  .step-screenshot { width: 100%; border-radius: 6px; margin-top: 12px; border: 1px solid var(--border); cursor: pointer; }

  .video-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 20px; }
  video { width: 100%; border-radius: 6px; }

  .no-issues { color: var(--muted); font-style: italic; padding: 16px 0; }

  footer { border-top: 1px solid var(--border); padding-top: 24px; margin-top: 40px; display: flex; justify-content: space-between; align-items: center; color: var(--muted); font-size: 12px; }

  .lightbox { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.9); z-index: 9999; align-items: center; justify-content: center; }
  .lightbox.open { display: flex; }
  .lightbox img { max-width: 95vw; max-height: 95vh; border-radius: 8px; }
  .lightbox-close { position: absolute; top: 20px; right: 20px; color: white; font-size: 24px; cursor: pointer; background: none; border: none; }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="brand">
      <div>
        <div class="brand-name">SKOPIX</div>
        <div class="brand-sub">AI QA Agent Report</div>
      </div>
      <div style="margin-left: auto;">
        <span class="status-badge ${statusClass}">${status === 'PASSED' ? '✓' : status === 'STUCK' ? '⚠' : '✗'} ${status}</span>
      </div>
    </div>
    <div class="meta-grid">
      <div class="meta-card">
        <div class="meta-label">Session ID</div>
        <div class="meta-value accent">${sessionId}</div>
      </div>
      <div class="meta-card">
        <div class="meta-label">Target URL</div>
        <div class="meta-value"><a href="${url}" style="color: var(--accent)" target="_blank">${url}</a></div>
      </div>
      <div class="meta-card">
        <div class="meta-label">Goal</div>
        <div class="meta-value">${escapeHtml(goal)}</div>
      </div>
      <div class="meta-card">
        <div class="meta-label">Steps / Issues</div>
        <div class="meta-value">${steps.length} steps · ${issues.length} issues</div>
      </div>
      <div class="meta-card">
        <div class="meta-label">Duration</div>
        <div class="meta-value">${durationStr}</div>
      </div>
      <div class="meta-card">
        <div class="meta-label">AI Model</div>
        <div class="meta-value">${provider} / ${model}</div>
      </div>
    </div>
  </header>

  ${issues.length > 0 ? `
  <section>
    <div class="section-title">Issues Detected <span class="badge">${issues.length}</span></div>
    ${issuesHtml}
  </section>
  ` : ''}

  <section>
    <div class="section-title">Test Steps <span class="badge">${steps.length}</span></div>
    ${stepsHtml}
  </section>

  ${videoFilename ? `
  <section>
    <div class="section-title">Session Recording</div>
    <div class="video-wrap">
      <video controls src="${videoFilename}"></video>
    </div>
  </section>
  ` : ''}

  <footer>
    <span>Generated by Skopix · ${new Date().toUTCString()}</span>
    <span>skopix.dev</span>
  </footer>
</div>

<div class="lightbox" id="lightbox" onclick="closeLightbox()">
  <button class="lightbox-close" onclick="closeLightbox()">✕</button>
  <img id="lightbox-img" src="" alt="screenshot">
</div>

<script>
function toggleStep(el) {
  const body = el.nextElementSibling;
  body.classList.toggle('open');
}
function openLightbox(src) {
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox').classList.add('open');
}
function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
}
</script>
</body>
</html>`;
  }

  _stepHtml(step, i) {
    const statusIcon = step.success ? '✓' : '✗';
    const confDots = Array.from({ length: 5 }, (_, j) =>
      `<div class="conf-dot ${j < Math.round(step.confidence / 2) ? 'filled' : ''}"></div>`
    ).join('');

    const issuesInStep = step.issues && step.issues.length > 0
      ? `<div class="step-field"><div class="step-field-label">Issues</div>${step.issues.map(iss =>
        `<div><span class="severity-tag ${iss.severity}">${iss.severity}</span> ${escapeHtml(iss.title)}</div>`
      ).join('')}</div>`
      : '';

    const screenshotHtml = step.screenshot
      ? `<img class="step-screenshot" src="${step.screenshot}" alt="Step ${i + 1}" onclick="openLightbox('${step.screenshot}')" loading="lazy">`
      : '';

    return `
<div class="step-card">
  <div class="step-header" onclick="toggleStep(this)">
    <span class="step-num">#${i + 1}</span>
    <span class="step-action">${step.action}</span>
    <span class="step-target">${escapeHtml(step.target || step.value || '—')}</span>
    <div class="conf-bar">${confDots}</div>
    <span class="step-status">${step.success ? '✓' : '✗'}</span>
  </div>
  <div class="step-body">
    ${step.reasoning ? `<div class="step-field"><div class="step-field-label">Reasoning</div><div class="step-field-value">${escapeHtml(step.reasoning)}</div></div>` : ''}
    ${step.observation ? `<div class="step-field"><div class="step-field-label">Observation</div><div class="step-field-value">${escapeHtml(step.observation)}</div></div>` : ''}
    ${step.error ? `<div class="step-field"><div class="step-field-label">Error</div><div class="step-field-value" style="color:var(--failed)">${escapeHtml(step.error)}</div></div>` : ''}
    ${issuesInStep}
    ${screenshotHtml}
  </div>
</div>`;
  }

  _issueHtml(issue) {
    const sev = (issue.severity || 'low').toLowerCase();
    return `
<div class="issue-card ${sev}">
  <div class="issue-header">
    <span class="severity-tag ${sev}">${sev}</span>
    <span class="issue-title">${escapeHtml(issue.title)}</span>
  </div>
  <div class="issue-desc">${escapeHtml(issue.description)}</div>
  <div class="issue-meta">Step ${issue.step} · ${escapeHtml(issue.url)}${issue.type ? ` · ${issue.type}` : ''}</div>
</div>`;
  }

  _formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
