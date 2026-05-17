import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import fs from 'fs-extra';
import { v4 as uuidv4 } from 'uuid';
import { BrowserAgent } from '../../core/browser.js';
import { LLMRouter } from '../../core/llm.js';
import { ReportGenerator } from '../../core/reporter.js';
import { IssueTracker } from '../../core/tracker.js';
import { loadCredentials } from '../../core/credentials.js';
import { formatStep, formatIssue, printSummary } from '../ui.js';

export async function runCommand(options) {
  const sessionId = uuidv4().slice(0, 8);
  const startTime = Date.now();

  console.log(chalk.cyan('━'.repeat(60)));
  console.log(chalk.white.bold(`  Session: `) + chalk.yellow(sessionId));
  console.log(chalk.white.bold(`  Target:  `) + chalk.green(options.url));
  console.log(chalk.white.bold(`  Goal:    `) + chalk.white(options.goal));
  console.log(chalk.white.bold(`  Provider:`) + chalk.magenta(options.provider));
  console.log(chalk.cyan('━'.repeat(60)));
  console.log();

  // Load credentials if provided
  let credentials = {};
  if (options.credentials) {
    const spinner = ora('Loading credentials...').start();
    try {
      credentials = await loadCredentials(options.credentials);
      spinner.succeed(chalk.green(`Credentials loaded (${Object.keys(credentials).length} entries)`));
    } catch (err) {
      spinner.fail(chalk.red(`Failed to load credentials: ${err.message}`));
      process.exit(1);
    }
  }

  // Set up output directory
  const outputDir = path.resolve(options.output, sessionId);
  await fs.ensureDir(outputDir);

  // Initialise LLM
  const spinner = ora('Initialising AI agent...').start();
  let llm;
  try {
    llm = new LLMRouter(options.provider, options.model);
    await llm.verify();
    spinner.succeed(chalk.green(`AI agent ready (${llm.modelName})`));
  } catch (err) {
    spinner.fail(chalk.red(`LLM init failed: ${err.message}`));
    console.log(chalk.yellow('\n  Hint: Run `skopix init` to configure your API keys.\n'));
    process.exit(1);
  }

  // Launch browser
  const browserSpinner = ora('Launching browser...').start();
  const agent = new BrowserAgent({
    headless: options.headless,
    videoDir: options.video !== false ? outputDir : null,
    sessionId,
  });

  try {
    await agent.launch();
    browserSpinner.succeed(chalk.green('Browser launched'));
  } catch (err) {
    browserSpinner.fail(chalk.red(`Browser failed: ${err.message}`));
    process.exit(1);
  }

  // Navigate to URL
  const navSpinner = ora(`Navigating to ${options.url}...`).start();
  try {
    await agent.goto(options.url);
    navSpinner.succeed(chalk.green(`Loaded: ${options.url}`));
  } catch (err) {
    navSpinner.fail(chalk.red(`Navigation failed: ${err.message}`));
    await agent.close();
    process.exit(1);
  }

  console.log();
  console.log(chalk.cyan.bold('  ◆ Agent loop starting\n'));

  const steps = [];
  const issues = [];
  const maxSteps = parseInt(options.maxSteps);
  let goalAchieved = false;
  let stuck = false;
  let previousDOMHash = null;
  let stuckCount = 0;

  // ─── MAIN AGENT LOOP ────────────────────────────────────────────────────────
  for (let step = 1; step <= maxSteps; step++) {
    const stepSpinner = ora({
      text: chalk.dim(`Step ${step}/${maxSteps} — extracting page state...`),
      color: 'cyan',
    }).start();

    let domSnapshot, screenshot;
    try {
      domSnapshot = await agent.extractDOM();
      screenshot = await agent.screenshot(path.join(outputDir, `step-${step}.png`));
    } catch (err) {
      stepSpinner.fail(chalk.red(`DOM extraction failed: ${err.message}`));
      break;
    }

    // Detect if we're stuck - allow 5 unchanged DOM snapshots before giving up
    // Skip stuck detection if last action was OBSERVE (no DOM change expected)
    const lastAction = steps.length > 0 ? steps[steps.length - 1].action : null;
    const currentHash = simpleHash(domSnapshot.text);
    if (currentHash === previousDOMHash && lastAction !== 'OBSERVE') {
      stuckCount++;
      if (stuckCount >= 5) {
        stepSpinner.warn(chalk.yellow('Agent appears stuck — no DOM changes detected after 5 attempts'));
        stuck = true;
        break;
      }
    } else {
      stuckCount = 0;
    }
    previousDOMHash = currentHash;

    // Ask LLM what to do next
    stepSpinner.text = chalk.dim(`Step ${step}/${maxSteps} — reasoning...`);

    let decision;
    try {
      decision = await llm.decide({
        goal: options.goal,
        url: options.url,
        currentUrl: await agent.currentUrl(),
        domSnapshot: domSnapshot.text,
        stepNumber: step,
        previousSteps: steps.slice(-5), // Last 5 for context
        credentials,
      });
    } catch (err) {
      stepSpinner.fail(chalk.red(`LLM reasoning failed: ${err.message}`));
      break;
    }

    // Execute the action
    stepSpinner.text = chalk.dim(`Step ${step}/${maxSteps} — executing: ${decision.action}...`);

    let actionResult = { success: false, error: null };
    try {
      actionResult = await agent.executeAction(decision);
    } catch (err) {
      actionResult = { success: false, error: err.message };
    }

    // Record the step
    const stepRecord = {
      step,
      url: await agent.currentUrl(),
      action: decision.action,
      target: decision.target,
      value: decision.value ? '***' : undefined,
      reasoning: decision.reasoning,
      observation: decision.observation,
      confidence: decision.confidence,
      issues: decision.issues || [],
      success: actionResult.success,
      error: actionResult.error,
      screenshot: `step-${step}.png`,
      batchResults: actionResult.batchResults || null,
      batchSize: decision.actions ? decision.actions.length : null,
      actions: decision.actions || null,
      timestamp: new Date().toISOString(),
    };

    steps.push(stepRecord);

    // Collect issues - aggressively deduplicate similar ones across steps
    if (decision.issues && decision.issues.length > 0) {
      for (const issue of decision.issues) {
        // Build a stricter fingerprint that catches semantic duplicates
        // - Strip common variation words ("with", "during", filler), normalise whitespace
        // - Use first 5 meaningful words rather than first 30 chars
        const normaliseTitle = (t) => {
          return (t || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\b(the|a|an|with|of|on|in|for|to|and|or|when|during|at|that)\b/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .split(' ')
            .filter(Boolean)
            .slice(0, 5)
            .join(' ');
        };
        const fingerprint = normaliseTitle(issue.title) + '|' + (issue.type || '');
        const isDuplicate = issues.some(existing => {
          const existingFp = normaliseTitle(existing.title) + '|' + (existing.type || '');
          // Either fingerprints match OR one title is a substring of the other
          if (existingFp === fingerprint) return true;
          const a = (existing.title || '').toLowerCase();
          const b = (issue.title || '').toLowerCase();
          // Detect cases like "Login failed with invalid credentials" vs "Login failed with incorrect credentials"
          // by checking if they share most meaningful words
          const aWords = new Set(normaliseTitle(a).split(' '));
          const bWords = new Set(normaliseTitle(b).split(' '));
          if (aWords.size === 0 || bWords.size === 0) return false;
          const overlap = [...aWords].filter(w => bWords.has(w)).length;
          const minSize = Math.min(aWords.size, bWords.size);
          // 60%+ word overlap = same issue
          return minSize > 0 && (overlap / minSize) >= 0.6;
        });
        if (!isDuplicate) {
          issues.push({
            ...issue,
            step,
            url: stepRecord.url,
            screenshot: `step-${step}.png`,
          });
        }
      }
    }

    // Print step output
    stepSpinner.stop();
    formatStep(stepRecord, step, maxSteps);

    // Check if goal is complete
    if (decision.goalAchieved) {
      console.log();
      console.log(chalk.green.bold('  ✓ Goal achieved!'));
      goalAchieved = true;
      break;
    }

    // Auto-detect goal completion based on URL/page changes for common goals
    // Heuristic auto-detection of login success/failure was removed.
    // It would force goalAchieved=true on simple login-goal keyword matches,
    // causing multi-step goals like "log in AND open Dates category" to false-pass
    // after just typing into the form. The LLM is now responsible for setting
    // goalAchieved based on the full goal, with explicit prompt guidance on
    // reading the goal literally and only marking achieved when the actual
    // required outcome was observed.

    if (decision.action === 'STOP') {
      console.log();
      console.log(chalk.yellow('  ⚠ Agent decided to stop: ') + chalk.white(decision.reasoning));
      break;
    }

    // Small delay between steps
    await sleep(150);
  }

  console.log();
  console.log(chalk.cyan('━'.repeat(60)));

  // Stop recording
  const closeSpinner = ora('Finalising session...').start();
  let videoPath = null;
  try {
    videoPath = await agent.close();
    closeSpinner.succeed(chalk.green('Browser closed'));
  } catch (err) {
    closeSpinner.warn(chalk.yellow(`Browser close warning: ${err.message}`));
  }

  // Test pass/fail is based purely on whether the goal was achieved.
  // Issues found during the test are reported separately - they're observations the agent
  // noticed but they do not influence the pass/fail status unless directly related to the goal.
  const actuallyPassed = goalAchieved;
  const failReason = null;

  // Generate report
  const reportSpinner = ora('Generating report...').start();
  const reporter = new ReportGenerator(outputDir, sessionId);
  let reportPath;
  try {
    reportPath = await reporter.generate({
      sessionId,
      url: options.url,
      goal: options.goal,
      steps,
      issues,
      goalAchieved: actuallyPassed,
      goalActuallyAchieved: goalAchieved,
      failReason,
      stuck,
      videoPath,
      duration: Date.now() - startTime,
      provider: options.provider,
      model: llm.modelName,
    });
    reportSpinner.succeed(chalk.green(`Report saved → ${reportPath}`));
  } catch (err) {
    reportSpinner.fail(chalk.red(`Report generation failed: ${err.message}`));
  }

  // Push to issue tracker if requested
  if ((options.jira || options.linear || options.github) && issues.length > 0) {
    const trackerSpinner = ora('Pushing issues to tracker...').start();
    try {
      const tracker = new IssueTracker({ jira: options.jira, linear: options.linear, github: options.github });
      const created = await tracker.pushIssues(issues, { url: options.url, goal: options.goal, sessionId });
      const newCount = created.filter(c => c.action === 'created').length;
      const commentedCount = created.filter(c => c.action === 'commented').length;
      const semanticCount = created.filter(c => c.action === 'commented' && c.matchedBy === 'semantic').length;
      let summary;
      if (newCount > 0 && commentedCount > 0) {
        summary = `${newCount} new issue(s), ${commentedCount} existing issue(s) updated`;
        if (semanticCount > 0) summary += ` (${semanticCount} matched semantically)`;
      } else if (commentedCount > 0) {
        summary = `${commentedCount} existing issue(s) updated (already known)`;
        if (semanticCount > 0) summary += ` — ${semanticCount} matched semantically`;
      } else {
        summary = `${newCount} issue(s) created in tracker`;
      }
      trackerSpinner.succeed(chalk.green(summary));
    } catch (err) {
      trackerSpinner.fail(chalk.red(`Tracker error: ${err.message}`));
    }
  }

  // Print summary
  printSummary({
    sessionId,
    steps: steps.length,
    issues: issues.length,
    goalAchieved: actuallyPassed,
    stuck,
    duration: Date.now() - startTime,
    reportPath,
    videoPath,
    failReason,
  });

  process.exit(actuallyPassed ? 0 : 1);
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < Math.min(str.length, 1000); i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
