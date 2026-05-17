#!/usr/bin/env node
const endpoint = process.env.OPENAGENT_E2E_CDP_URL || 'http://127.0.0.1:9223';
const waitMs = Number(process.env.OPENAGENT_E2E_WAIT_MS || 30000);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
  const page = targets.find((target) => target.title === 'OpenAgent Desktop' || target.url?.includes('127.0.0.1:5173'));
  assert(page?.webSocketDebuggerUrl, `OpenAgent Desktop target not found at ${endpoint}`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  const cdp = (method, params = {}) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const evalPage = async (expression) => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 30000 });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };

  await cdp('Runtime.enable');
  const report = await evalPage(`(async () => {
    const events = [];
    const off = window.desktopApi.onUiEvent((event) => {
      events.push(event);
      if (event.type === 'approval.required' && String(event.payload?.actionType || '').startsWith('skill.script')) {
        window.desktopApi.resolveApproval({ approvalId: event.payload.approvalId, decision: 'approved', scope: 'always' }).catch(() => {});
      }
    });
    const result = await window.desktopApi.sendPrompt({
      prompt: '使用当前选中的 markdown-report skill。必须调用它声明的 scripts/word_count.mjs 脚本，对文本 "hello OpenAgent skill system" 做 word count，然后用简短 Markdown 汇总脚本结果。不要委托 pi_coding_agent。',
      skillId: 'system:markdown-report',
      awaitCompletion: false
    });
    await new Promise((resolve) => setTimeout(resolve, ${JSON.stringify(waitMs)}));
    off?.();
    const snapshot = await window.desktopApi.getStateSnapshot();
    return {
      submitResult: result,
      eventTypes: events.map((event) => event.type),
      approvalRequired: events.find((event) => event.type === 'approval.required')?.payload ?? null,
      approvalResolved: events.find((event) => event.type === 'approval.resolved')?.payload ?? null,
      skillScriptStarted: events.find((event) => event.type === 'skill.script.started')?.payload ?? null,
      skillScriptCompleted: events.find((event) => event.type === 'skill.script.completed')?.payload ?? null,
      piCodingFailed: events.find((event) => event.type === 'tool.failed' && event.payload?.name === 'pi_coding_agent')?.payload ?? null,
      runCompleted: events.find((event) => event.type === 'run.completed')?.payload ?? null,
      runFailed: events.find((event) => event.type === 'run.failed')?.payload ?? null,
      latestRun: snapshot.latestRun
    };
  })()`);
  ws.close();

  const fail = (message) => {
    console.error(JSON.stringify({ ok: false, message, report }, null, 2));
    throw new Error(message);
  };

  if (!report.submitResult?.ok) fail(`prompt submit failed: ${JSON.stringify(report.submitResult)}`);
  if (report.approvalRequired?.actionType !== 'skill.script') fail('skill_script approval was not requested');
  assert(report.approvalRequired?.risk === 'low', `expected low skill_script risk, got ${report.approvalRequired?.risk}`);
  assert(report.approvalResolved?.scope === 'once', `skill_script approval must be forced to once, got ${report.approvalResolved?.scope}`);
  assert(report.skillScriptStarted?.scriptPath === 'scripts/word_count.mjs', 'skill.script.started was not emitted for word_count.mjs');
  assert(report.skillScriptCompleted?.exitCode === 0, `skill_script did not complete successfully: ${JSON.stringify(report.skillScriptCompleted)}`);
  assert(report.skillScriptCompleted?.network === false && report.skillScriptCompleted?.writes === false, 'script metadata was not preserved');
  assert(!report.piCodingFailed, 'pi_coding_agent should not be used for selected skill script path');
  assert(report.runCompleted, `run did not complete: ${JSON.stringify(report.runFailed || report.latestRun)}`);
  assert(!String(report.runCompleted.summary || '').includes('<|channel>'), 'provider channel marker leaked into final summary');

  console.log(JSON.stringify({
    ok: true,
    runId: report.runCompleted.runId,
    approvalScope: report.approvalResolved.scope,
    skillName: report.skillScriptCompleted.skillName,
    scriptPath: report.skillScriptCompleted.scriptPath,
    stdoutPreview: report.skillScriptCompleted.stdoutPreview,
    summaryPreview: String(report.runCompleted.summary || '').slice(0, 240)
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
