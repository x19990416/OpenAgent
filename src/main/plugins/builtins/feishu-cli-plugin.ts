import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { OpenAgentPlugin, OpenAgentPluginContext } from '../plugin-types.js';

export const feishuCliPlugin: OpenAgentPlugin = {
  id: 'openagent-plugin-feishu-cli',
  name: 'Feishu CLI',
  register(ctx: OpenAgentPluginContext) {
    ctx.registerSkill({ name: 'feishu-workspace', description: 'Use Feishu calendar and IM tools safely through OpenAgent policy.' });
    ctx.registerPolicy({
      tools: [
        { toolName: 'feishu_agent', risk: 'read', requiresApproval: false, description: 'Delegate Feishu/Lark tasks to the plugin-provided Feishu subagent.' },
        { toolName: 'feishu.test_connection', risk: 'read', requiresApproval: false, description: 'Test Feishu CLI availability and plugin configuration.' },
        { toolName: 'feishu.calendar_list', risk: 'read', requiresApproval: false, description: 'List Feishu/Lark calendars visible to the authorized user.' },
        { toolName: 'feishu.calendar_agenda', risk: 'read', requiresApproval: false, description: 'View Feishu/Lark calendar agenda for a date range.' },
        { toolName: 'feishu.send_text_message', risk: 'external_send', requiresApproval: true, description: 'Send a text message to an allowed Feishu chat or user.' },
        { toolName: 'feishu.reply_to_current_chat', risk: 'external_send', requiresApproval: true, description: 'Reply to current Feishu chat.' }
      ]
    });

    ctx.registerTool({
      name: 'feishu_agent',
      label: 'Feishu Agent',
      description: [
        'Plugin-provided Feishu/Lark subagent. Use this for ALL Feishu CLI tasks instead of inspecting .env, environment variables, or workspace config.',
        'It handles known operations directly and can run controlled lark-cli commands through the OpenAgent policy layer.',
        'Read operations are allowed; external send/write/destructive operations require approval based on expectedRisk.'
      ].join(' '),
      pluginId: ctx.pluginId,
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Natural-language Feishu task intent.' },
          operation: {
            type: 'string',
            enum: ['test_connection', 'calendar_list', 'calendar_agenda', 'send_text_message', 'reply_to_current_chat', 'cli'],
            description: 'Use calendar_agenda for schedules, send_text_message for IM sends, cli for other lark-cli domains.'
          },
          expectedRisk: { type: 'string', enum: ['read', 'external_send', 'external_write', 'destructive'], default: 'read' },
          start: { type: 'string', description: 'Calendar start time, ISO 8601.' },
          end: { type: 'string', description: 'Calendar end time, ISO 8601.' },
          calendarId: { type: 'string', description: 'Optional calendar ID. When omitted, calendar_agenda reads all visible calendars for the authorized user.' },
          identity: { type: 'string', enum: ['user', 'bot'], default: 'user' },
          receiveIdType: { type: 'string', enum: ['chat_id', 'open_id', 'user_id', 'email'] },
          receiveId: { type: 'string' },
          chatId: { type: 'string' },
          text: { type: 'string', maxLength: 4000 },
          cliArgs: { type: 'array', items: { type: 'string' }, description: 'Controlled lark-cli args without --profile; e.g. ["docs", "..."].' }
        },
        required: ['operation'],
        additionalProperties: false
      },
      execute: async ({ input, signal }) => {
        throwIfAborted(signal);
        const args = asRecord(input);
        const operation = String(args.operation || '');
        const cliPath = String((await ctx.config.get('cliPath')) || getPrivateLarkCliPath(ctx.pluginId));
        if (operation === 'test_connection') {
          const result = await checkExecutable(cliPath);
          if (!result.ok) return { ok: false, content: result.message, data: result };
          const configured = await ensureCliConfigured(ctx, cliPath, signal);
          return { ok: configured.ok, content: configured.ok ? `${result.message}\n${configured.content}` : configured.content, data: { result, configured } };
        }

        const configured = await ensureCliConfigured(ctx, cliPath, signal);
        if (!configured.ok) return configured;

        if (operation === 'calendar_list') {
          const cli = await listCalendars(cliPath, String(args.identity || 'user'), signal);
          ctx.logger.info('feishu_agent calendar_list completed', { exitCode: cli.exitCode });
          return { ok: cli.exitCode === 0, content: formatCliResult(cli), data: { operation, exitCode: cli.exitCode } };
        }

        if (operation === 'calendar_agenda') {
          const result = await readCalendarAgenda(cliPath, {
            calendarId: optionalString(args.calendarId),
            identity: String(args.identity || 'user'),
            start: optionalString(args.start),
            end: optionalString(args.end)
          }, signal);
          ctx.logger.info('feishu_agent calendar_agenda completed', { ok: result.ok, calendarCount: result.calendarCount });
          return result.response;
        }

        if (operation === 'send_text_message') {
          const receiveId = String(args.receiveId || '');
          const text = String(args.text || '');
          if (!receiveId || !text) return { ok: false, content: 'receiveId and text are required' };
          const cli = await runCli(cliPath, buildSendTextArgs(String(args.receiveIdType || 'chat_id'), receiveId, text), signal);
          ctx.logger.info('feishu_agent send_text_message completed', { exitCode: cli.exitCode, receiveId });
          return { ok: cli.exitCode === 0, content: formatCliResult(cli), data: { operation, receiveId, exitCode: cli.exitCode } };
        }

        if (operation === 'reply_to_current_chat') {
          const chatId = String(args.chatId || '');
          if (!chatId) return { ok: false, content: 'chatId is required until Feishu channel metadata is implemented' };
          const cli = await runCli(cliPath, buildSendTextArgs('chat_id', chatId, String(args.text || '')), signal);
          return { ok: cli.exitCode === 0, content: formatCliResult(cli), data: { operation, chatId, exitCode: cli.exitCode } };
        }

        if (operation === 'cli') {
          const cliArgs = Array.isArray(args.cliArgs) ? args.cliArgs.map(String).map((item) => item.trim()).filter(Boolean) : [];
          const validation = validateGenericCliArgs(cliArgs, String(args.expectedRisk || 'read'));
          if (!validation.ok) return validation;
          const cli = await runCli(cliPath, withProfile(cliArgs), signal);
          ctx.logger.info('feishu_agent cli completed', { exitCode: cli.exitCode, command: cliArgs.slice(0, 3).join(' ') });
          return { ok: cli.exitCode === 0, content: formatCliResult(cli), data: { operation, cliArgs, exitCode: cli.exitCode } };
        }

        return { ok: false, content: `Unsupported feishu_agent operation: ${operation}` };
      }
    });

    ctx.registerTool({
      name: 'feishu.test_connection',
      label: 'Feishu Test Connection',
      description: 'Test Feishu CLI plugin configuration and local CLI availability.',
      risk: 'read',
      pluginId: ctx.pluginId,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async ({ signal }) => {
        throwIfAborted(signal);
        const cliPath = String((await ctx.config.get('cliPath')) || getPrivateLarkCliPath(ctx.pluginId));
        const result = await checkExecutable(cliPath);
        if (!result.ok) return { ok: false, content: result.message, data: result };
        const configured = await ensureCliConfigured(ctx, cliPath, signal);
        return {
          ok: configured.ok,
          content: configured.ok ? `${result.message}\nCLI 配置已写入 profile: ${FEISHU_PROFILE}` : configured.content,
          data: { ...result, configured }
        };
      }
    });

    ctx.registerTool({
      name: 'feishu.calendar_list',
      label: 'Feishu Calendar List',
      description: 'List Feishu/Lark calendars visible to the authorized user, including shared/subscribed calendars when the user token has access.',
      risk: 'read',
      pluginId: ctx.pluginId,
      parameters: {
        type: 'object',
        properties: {
          identity: { type: 'string', enum: ['user', 'bot'], default: 'user' }
        },
        additionalProperties: false
      },
      execute: async ({ input, signal }) => {
        throwIfAborted(signal);
        const args = asRecord(input);
        const cliPath = String((await ctx.config.get('cliPath')) || getPrivateLarkCliPath(ctx.pluginId));
        const configured = await ensureCliConfigured(ctx, cliPath, signal);
        if (!configured.ok) return configured;
        const cli = await listCalendars(cliPath, String(args.identity || 'user'), signal);
        ctx.logger.info('calendar_list completed', { exitCode: cli.exitCode });
        return { ok: cli.exitCode === 0, content: formatCliResult(cli), data: { exitCode: cli.exitCode } };
      }
    });

    ctx.registerTool({
      name: 'feishu.calendar_agenda',
      label: 'Feishu Calendar Agenda',
      description: 'View Feishu/Lark calendar agenda. Defaults to today when start/end are omitted. When calendarId is omitted, reads all calendars visible to the authorized user, including shared/subscribed calendars.',
      risk: 'read',
      pluginId: ctx.pluginId,
      parameters: {
        type: 'object',
        properties: {
          start: { type: 'string', description: 'ISO 8601 start time, for example 2026-05-14T00:00:00+08:00' },
          end: { type: 'string', description: 'ISO 8601 end time, for example 2026-05-14T23:59:59+08:00' },
          calendarId: { type: 'string', description: 'Optional calendar ID. When omitted, all visible calendars are queried.' },
          identity: { type: 'string', enum: ['user', 'bot'], default: 'user' }
        },
        additionalProperties: false
      },
      execute: async ({ input, signal }) => {
        throwIfAborted(signal);
        const args = asRecord(input);
        const cliPath = String((await ctx.config.get('cliPath')) || getPrivateLarkCliPath(ctx.pluginId));
        const configured = await ensureCliConfigured(ctx, cliPath, signal);
        if (!configured.ok) return configured;
        const result = await readCalendarAgenda(cliPath, {
          calendarId: optionalString(args.calendarId),
          identity: String(args.identity || 'user'),
          start: optionalString(args.start),
          end: optionalString(args.end)
        }, signal);
        ctx.logger.info('calendar_agenda completed', { ok: result.ok, calendarCount: result.calendarCount });
        return result.response;
      }
    });

    ctx.registerTool({
      name: 'feishu.send_text_message',
      label: 'Feishu Send Text Message',
      description: 'Send text to Feishu through the configured CLI. External send is governed by OpenAgent approval and allowlist policy.',
      risk: 'external_send',
      pluginId: ctx.pluginId,
      parameters: {
        type: 'object',
        properties: {
          receiveIdType: { type: 'string', enum: ['chat_id', 'open_id', 'user_id', 'email'] },
          receiveId: { type: 'string' },
          text: { type: 'string', maxLength: 4000 }
        },
        required: ['receiveIdType', 'receiveId', 'text'],
        additionalProperties: false
      },
      execute: async ({ input, signal }) => {
        throwIfAborted(signal);
        const args = asRecord(input);
        const cliPath = String((await ctx.config.get('cliPath')) || getPrivateLarkCliPath(ctx.pluginId));
        const receiveId = String(args.receiveId || '');
        const text = String(args.text || '');
        if (!receiveId || !text) return { ok: false, content: 'receiveId and text are required' };
        const allowedChatIds = await ctx.config.get<string[]>('allowedChatIds');
        if (Array.isArray(allowedChatIds) && allowedChatIds.length > 0 && !allowedChatIds.map(String).includes(receiveId)) {
          return { ok: false, content: `receiveId is not in allowedChatIds: ${receiveId}` };
        }
        const configured = await ensureCliConfigured(ctx, cliPath, signal);
        if (!configured.ok) return configured;
        const cli = await runCli(cliPath, buildSendTextArgs(String(args.receiveIdType || 'chat_id'), receiveId, text), signal);
        ctx.logger.info('send_text_message completed', { exitCode: cli.exitCode, receiveId });
        return { ok: cli.exitCode === 0, content: formatCliResult(cli), data: { receiveId, exitCode: cli.exitCode } };
      }
    });

    ctx.registerTool({
      name: 'feishu.reply_to_current_chat',
      label: 'Feishu Reply Current Chat',
      description: 'Reply to the current Feishu channel chat when channel metadata contains a chat id.',
      risk: 'external_send',
      pluginId: ctx.pluginId,
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', maxLength: 4000 }, chatId: { type: 'string' } },
        required: ['text'],
        additionalProperties: false
      },
      execute: async ({ input, signal }) => {
        const args = asRecord(input);
        const chatId = String(args.chatId || '');
        if (!chatId) return { ok: false, content: 'chatId is required until Feishu channel metadata is implemented' };
        const cliPath = String((await ctx.config.get('cliPath')) || getPrivateLarkCliPath(ctx.pluginId));
        const configured = await ensureCliConfigured(ctx, cliPath, signal);
        if (!configured.ok) return configured;
        const cli = await runCli(cliPath, buildSendTextArgs('chat_id', chatId, String(args.text || '')), signal);
        return { ok: cli.exitCode === 0, content: formatCliResult(cli), data: { chatId, exitCode: cli.exitCode } };
      }
    });
  }
};

const FEISHU_PROFILE = 'openagent';

async function checkExecutable(command: string) {
  if (path.isAbsolute(command)) {
    const ok = await access(command, constants.X_OK).then(() => true, () => false);
    return { ok, message: ok ? `CLI 可执行：${command}` : `CLI 不存在或不可执行：${command}` };
  }
  const result = await runCli(command, ['--version'], undefined, 4000).catch((error) => ({ exitCode: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error), durationMs: 0 }));
  return { ok: result.exitCode === 0, message: result.exitCode === 0 ? `CLI 可用：${command} ${result.stdout || result.stderr}`.trim() : `CLI 不可用：${command} ${result.stderr || result.stdout}`.trim() };
}

async function ensureCliConfigured(ctx: OpenAgentPluginContext, cliPath: string, signal?: AbortSignal) {
  const appId = await ctx.secrets.get('appId');
  const appSecret = await ctx.secrets.get('appSecret');
  if (!appId || !appSecret) {
    return { ok: false, content: '飞书插件缺少 App ID 或 App Secret，请先在插件详情的“密钥 / 授权”里保存。' };
  }
  const cli = await runCli(
    cliPath,
    ['config', 'init', '--name', FEISHU_PROFILE, '--app-id', appId, '--app-secret-stdin', '--brand', 'feishu'],
    signal,
    30000,
    `${appSecret}\n`
  );
  if (cli.exitCode !== 0) {
    return { ok: false, content: `飞书 CLI 配置失败：\n${formatCliResult(cli)}` };
  }
  return { ok: true, content: '飞书 CLI 配置完成。' };
}

function withProfile(args: string[]) {
  return ['--profile', FEISHU_PROFILE, ...args];
}

function buildCalendarAgendaArgs(input: { calendarId: string; identity: string; start?: string; end?: string }) {
  const cliArgs = withProfile(['calendar', '+agenda', '--format', 'json', '--calendar-id', input.calendarId, '--as', input.identity]);
  if (input.start) cliArgs.push('--start', input.start);
  if (input.end) cliArgs.push('--end', input.end);
  return cliArgs;
}

async function listCalendars(cliPath: string, identity: string, signal?: AbortSignal) {
  return runCli(cliPath, withProfile(['calendar', 'calendars', 'list', '--format', 'json', '--as', identity, '--page-all']), signal);
}

async function readCalendarAgenda(
  cliPath: string,
  input: { calendarId?: string; identity: string; start?: string; end?: string },
  signal?: AbortSignal
) {
  if (input.calendarId) {
    const cli = await runCli(cliPath, buildCalendarAgendaArgs({ ...input, calendarId: input.calendarId }), signal);
    return {
      ok: cli.exitCode === 0,
      calendarCount: 1,
      response: { ok: cli.exitCode === 0, content: formatCliResult(cli), data: { exitCode: cli.exitCode, calendarId: input.calendarId } }
    };
  }

  const calendarList = await listCalendars(cliPath, input.identity, signal);
  if (calendarList.exitCode !== 0) {
    return {
      ok: false,
      calendarCount: 0,
      response: {
        ok: false,
        content: `列出飞书日历失败，无法聚合订阅日历：\n${formatCliResult(calendarList)}`,
        data: { exitCode: calendarList.exitCode }
      }
    };
  }

  const parsedCalendars = parseJson(calendarList.stdout);
  const calendars = extractCalendars(parsedCalendars);
  if (calendars.length === 0) {
    return {
      ok: false,
      calendarCount: 0,
      response: {
        ok: false,
        content: [
          '飞书日历列表为空，无法读取日程。',
          '如果飞书客户端能看到订阅日历，请确认当前 lark-cli profile 使用的是用户授权 token，并且授权 scope 已更新。'
        ].join('\n'),
        data: { calendarList: parsedCalendars ?? calendarList.stdout }
      }
    };
  }

  const agendaResults = [];
  for (const calendar of calendars) {
    throwIfAborted(signal ?? new AbortController().signal);
    const cli = await runCli(cliPath, buildCalendarAgendaArgs({
      calendarId: calendar.calendarId,
      identity: input.identity,
      start: input.start,
      end: input.end
    }), signal);
    agendaResults.push({
      calendar,
      ok: cli.exitCode === 0,
      exitCode: cli.exitCode,
      agenda: parseJson(cli.stdout) ?? cli.stdout,
      stderr: cli.stderr
    });
  }

  const failed = agendaResults.filter((item) => !item.ok);
  const content = JSON.stringify({
    ok: failed.length === 0,
    calendarCount: calendars.length,
    failedCalendarCount: failed.length,
    calendars,
    agendas: agendaResults
  }, null, 2);
  return {
    ok: failed.length === 0,
    calendarCount: calendars.length,
    response: {
      ok: failed.length === 0,
      content,
      data: { calendarCount: calendars.length, failedCalendarCount: failed.length, calendars }
    }
  };
}

function extractCalendars(input: unknown) {
  const seen = new Set<string>();
  const calendars: Array<{ calendarId: string; summary?: string; type?: string; role?: string }> = [];
  const visit = (value: unknown) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const calendarId = firstString(record.calendar_id, record.calendarId, record.id);
    if (calendarId && !seen.has(calendarId) && looksLikeCalendar(record)) {
      seen.add(calendarId);
      calendars.push({
        calendarId,
        summary: firstString(record.summary, record.name, record.title),
        type: firstString(record.type),
        role: firstString(record.role, record.access_role, record.accessRole)
      });
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(input);
  return calendars;
}

function looksLikeCalendar(record: Record<string, unknown>) {
  return 'calendar_id' in record || 'calendarId' in record || 'summary' in record || 'role' in record || 'access_role' in record;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function buildSendTextArgs(receiveIdType: string, receiveId: string, text: string) {
  const targetArgs = receiveIdType === 'chat_id'
    ? ['--chat-id', receiveId]
    : ['--user-id', receiveId];
  return withProfile(['im', '+messages-send', '--as', 'bot', ...targetArgs, '--text', text]);
}

function validateGenericCliArgs(args: string[], expectedRisk: string) {
  if (args.length === 0) return { ok: false, content: 'cliArgs is required for operation=cli' };
  if (args.some((arg) => arg === '--profile')) return { ok: false, content: 'Do not pass --profile; feishu_agent injects --profile openagent.' };
  const blocked = new Set(['config', 'profile', 'update']);
  if (blocked.has(args[0])) return { ok: false, content: `lark-cli ${args[0]} is managed by OpenAgent plugin settings and cannot be run through feishu_agent.` };
  if (args[0] === 'auth' && !['status', 'scopes', 'check', 'list'].includes(args[1] || '')) {
    return { ok: false, content: 'Auth login/logout is managed by the plugin UI “授权所有能力” button.' };
  }
  const inferredWrite = args.some((arg) => /(^|[+:.-])(send|create|update|delete|remove|cancel|reply|upload|overwrite|publish|approve|reject|transfer)([+:.-]|$)/i.test(arg));
  if (inferredWrite && expectedRisk === 'read') {
    return { ok: false, content: 'cliArgs look like a write/send operation. Set expectedRisk to external_send, external_write, or destructive so OpenAgent can request approval.' };
  }
  return { ok: true, content: 'ok' };
}

async function runCli(command: string, args: string[], signal?: AbortSignal, timeoutMs = 30000, stdin?: string) {
  const startedAt = Date.now();
  return new Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    if (stdin) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`CLI timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    const abort = () => {
      child.kill('SIGTERM');
      reject(new Error('CLI aborted'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ exitCode: code ?? -1, stdout: redact(stdout).slice(0, 8000), stderr: redact(stderr).slice(0, 8000), durationMs: Date.now() - startedAt });
    });
  });
}

function formatCliResult(result: { exitCode: number; stdout: string; stderr: string }) {
  return [`exitCode: ${result.exitCode}`, result.stdout ? `stdout:\n${result.stdout}` : '', result.stderr ? `stderr:\n${result.stderr}` : ''].filter(Boolean).join('\n\n');
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new Error('Aborted');
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? input as Record<string, unknown> : {};
}

function optionalString(input: unknown) {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined;
}

function parseJson(text: string) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function redact(text: string) {
  return text.replace(/(appSecret|accessToken|refreshToken|verificationToken|encryptKey|authorization)[=:]\s*[^\s,}]+/gi, '$1=***');
}


function getPrivateLarkCliPath(pluginId: string) {
  return path.join(os.homedir(), '.openagent', 'plugins', pluginId, 'deps', 'node_modules', '.bin', process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli');
}
