import crypto from 'node:crypto';
import fs from 'node:fs';

export const PROVIDERS: Record<string, { label: string; apiStyle: 'responses' | 'chat-completions'; apiUrl?: string }> = Object.freeze({
  openai: {
    label: 'OpenAI',
    apiStyle: 'responses',
    apiUrl: 'https://api.openai.com/v1/responses',
  },
  deepseek: {
    label: 'DeepSeek',
    apiStyle: 'chat-completions',
    apiUrl: 'https://api.deepseek.com/chat/completions',
  },
  qwen: {
    label: '通义千问',
    apiStyle: 'chat-completions',
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  },
  kimi: {
    label: 'Kimi',
    apiStyle: 'chat-completions',
    apiUrl: 'https://api.moonshot.ai/v1/chat/completions',
  },
  zhipu: {
    label: '智谱 GLM',
    apiStyle: 'chat-completions',
    apiUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  },
  doubao: {
    label: '豆包 / 火山方舟',
    apiStyle: 'chat-completions',
    apiUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
  },
  custom: {
    label: '自定义兼容接口',
    apiStyle: 'chat-completions',
  },
});

export function readSecret(filePath?: string): string {
  if (!filePath) return '';
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch (error: any) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

export function isPrivateHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  );
}

export function extractOutputText(payload: Record<string, any>): string {
  if (typeof payload.output_text === 'string') return payload.output_text.trim();
  return (payload.output || [])
    .flatMap((item: any) => item.content || [])
    .filter((item: any) => item.type === 'output_text')
    .map((item: any) => item.text)
    .join('\n')
    .trim();
}

export function extractChatText(payload: Record<string, any>): string {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((item: any) => item.type === 'text')
      .map((item: any) => item.text)
      .join('\n')
      .trim();
  }
  if (content && typeof content.text === 'string') return content.text.trim();
  if (typeof payload.choices?.[0]?.text === 'string') return payload.choices[0].text.trim();
  return '';
}

export function extractModelReply(
  output: unknown,
  actions: Array<{ id: string }>,
): { markdown: string; actionIds: string[]; actionReasons: Record<string, string> } {
  const fallback = { markdown: String(output || '').trim(), actionIds: [] as string[], actionReasons: {} as Record<string, string> };
  const normalized = fallback.markdown.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const parsed = JSON.parse(normalized);
    if (!parsed || typeof parsed.markdown !== 'string') return fallback;
    const allowed = new Set(actions.map((action) => action.id));
    const rawIds: string[] = Array.isArray(parsed.actionIds)
      ? parsed.actionIds.filter((id: unknown): id is string => typeof id === 'string' && allowed.has(id))
      : [];
    const actionIds: string[] = Array.from(new Set<string>(rawIds)).slice(0, 6);
    const actionReasons: Record<string, string> = {};
    for (const actionId of actionIds) {
      const reason = parsed.actionReasons?.[actionId];
      if (typeof reason === 'string') actionReasons[actionId] = reason.trim().slice(0, 300);
    }
    return { markdown: parsed.markdown.trim(), actionIds, actionReasons };
  } catch {
    return fallback;
  }
}

export function modelFailureReason(error: any): string {
  const message = String(error?.message || '');
  if (error?.name === 'AbortError') return '请求超时';
  if (/finish=length|exceeded max_tokens|达到.*长度/i.test(message)) return '模型输出达到长度上限';
  const httpStatus = message.match(/API HTTP (\d{3})/i)?.[1];
  if (httpStatus) return `模型接口返回 HTTP ${httpStatus}`;
  if (/returned no text|no text|空响应/i.test(message)) return '模型没有返回有效正文';
  return '模型服务响应异常';
}

export interface ResolvedProviderConfig {
  enabled: boolean;
  provider: string;
  label: string;
  apiStyle?: 'responses' | 'chat-completions';
  apiUrl?: string;
  model?: string;
  apiKey?: string;
  configError?: string;
}

export function resolveRawProviderConfig(raw: Record<string, any> | undefined, apiKey = ''): ResolvedProviderConfig {
  if (!raw || raw.enabled !== true) return { enabled: false, provider: 'catalog', label: '目录智能检索' };
  const preset = PROVIDERS[raw.provider];
  if (!preset) {
    return { enabled: false, provider: 'catalog', label: '目录智能检索', configError: `不支持的 AI 提供方：${raw.provider}` };
  }
  const apiStyle = (raw.apiStyle || preset.apiStyle) as 'responses' | 'chat-completions';
  const apiUrl = raw.apiUrl || preset.apiUrl;
  const model = String(raw.model || '').trim();
  if (!apiUrl || !model) {
    return { enabled: false, provider: 'catalog', label: '目录智能检索', configError: 'AI 配置缺少 apiUrl 或 model' };
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(apiUrl);
  } catch {
    return { enabled: false, provider: 'catalog', label: '目录智能检索', configError: 'AI apiUrl 不是有效 URL' };
  }
  if (parsedUrl.protocol !== 'https:' && !(parsedUrl.protocol === 'http:' && isPrivateHost(parsedUrl.hostname))) {
    return {
      enabled: false,
      provider: 'catalog',
      label: '目录智能检索',
      configError: '外部 AI 接口必须使用 HTTPS；HTTP 仅允许本机或私网地址',
    };
  }
  if (!apiKey && raw.allowNoKey !== true) {
    return { enabled: false, provider: 'catalog', label: '目录智能检索', configError: 'AI Key 文件不存在或为空' };
  }
  return {
    enabled: true,
    provider: raw.provider,
    label: raw.label || preset.label,
    apiStyle,
    apiUrl: parsedUrl.toString(),
    model,
    apiKey,
  };
}

export function resolveProviderConfig(configFile?: string): ResolvedProviderConfig {
  if (!configFile) return { enabled: false, provider: 'catalog', label: '目录智能检索' };
  try {
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    return resolveRawProviderConfig(raw, readSecret(raw.apiKeyFile));
  } catch (error: any) {
    if (error.code === 'ENOENT') return { enabled: false, provider: 'catalog', label: '目录智能检索' };
    return { enabled: false, provider: 'catalog', label: '目录智能检索', configError: 'AI 配置文件无法读取或不是有效 JSON' };
  }
}

export async function requestProvider(
  config: ResolvedProviderConfig,
  options: { systemPrompt: string; userPrompt: string; actor?: string; maxTokens?: number; jsonOutput?: boolean },
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  const maxTokens = options.maxTokens || 500;
  const requestBody =
    config.apiStyle === 'responses'
      ? {
          model: config.model,
          instructions: options.systemPrompt,
          input: options.userPrompt,
          reasoning: { effort: 'low' },
          text: { verbosity: 'low' },
          max_output_tokens: maxTokens,
          store: false,
          safety_identifier: `internal-${crypto.createHash('sha256').update(String(options.actor || 'unknown')).digest('hex').slice(0, 20)}`,
        }
      : {
          model: config.model,
          messages: [
            { role: 'system', content: options.systemPrompt },
            { role: 'user', content: options.userPrompt },
          ],
          stream: false,
          max_tokens: maxTokens,
          ...(config.provider === 'deepseek'
            ? {
                thinking: { type: 'disabled' },
                ...(options.jsonOutput ? { response_format: { type: 'json_object' } } : {}),
              }
            : {}),
        };
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const response = await fetch(config.apiUrl!, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${config.label} API HTTP ${response.status}`);
    const payload = (await response.json()) as Record<string, any>;
    const output = config.apiStyle === 'responses' ? extractOutputText(payload) : extractChatText(payload);
    if (!output) {
      const choice = payload.choices?.[0];
      const message = choice?.message;
      const reasoningChars = typeof message?.reasoning_content === 'string' ? message.reasoning_content.length : 0;
      throw new Error(
        `${config.label} API returned no text (finish=${choice?.finish_reason || 'unknown'}, content=${typeof message?.content}, reasoningChars=${reasoningChars})`,
      );
    }
    return output;
  } finally {
    clearTimeout(timer);
  }
}

export function assistantCapabilities(configFile?: string) {
  const config = resolveProviderConfig(configFile);
  return {
    mode: config.enabled ? 'model' : 'catalog',
    providerLabel: config.enabled ? `${config.label} · ${config.model}` : '目录智能检索',
    modelConfigured: config.enabled,
    debugEnabled: config.enabled,
    configError: config.configError,
    supportedProviders: Object.entries(PROVIDERS).map(([id, item]) => ({ id, label: item.label })),
  };
}
