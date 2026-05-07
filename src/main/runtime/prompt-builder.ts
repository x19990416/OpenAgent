import type { RuntimeMessage } from './runtime-types.js';

export interface PromptBuilderInput {
  workspaceRoot: string;
  agentId: string;
  messages: RuntimeMessage[];
  prompt: string;
}

export function buildSystemPrompt(input: Pick<PromptBuilderInput, 'workspaceRoot' | 'agentId'>) {
  return [
    '你是 OpenAgent 的主 Agent runtime。',
    '当前 runtime 已具备 OpenAgent 托管的只读 tool 执行层，可通过工具读取、列目录、搜索文件和检索文本。',
    `agentId: ${input.agentId}`,
    `workspaceRoot: ${input.workspaceRoot}`,
    '工具能力边界：只读文件系统工具包括 ls、read、find、grep；命令型只读统计/搜索任务可委托 shell_agent；相对路径从 workspaceRoot 解析，绝对路径可用于只读查询。',
    '当用户请求统计、搜索、查看文件或目录时，应优先调用合适的 tool 获取真实结果；其中统计/搜索这类命令型任务优先用 shell_agent，不要仅凭文本模式解释无法执行。',
    '不要假装已经执行工具；如果 tool 调用失败，请说明具体失败结果、权限限制或下一步可行方案。'
  ].join('\n');
}

export function buildModelPrompt(input: PromptBuilderInput) {
  const recentMessages = input.messages.slice(-12).map((message) => `${message.role}: ${message.content}`);
  return [buildSystemPrompt(input), '', 'Recent transcript:', ...recentMessages, '', `user: ${input.prompt}`, 'assistant:'].join('\n');
}
