import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  PROVIDERS,
  isPrivateHost,
  readSecret,
  requestProvider,
  resolveRawProviderConfig,
} from './assistant/provider.js';

function clientError(message: string, status = 400): Error & { status: number; expose: boolean } {
  return Object.assign(new Error(message), { status, expose: true });
}

function readRawConfig(configFile?: string): { raw: Record<string, any>; configError?: string } {
  if (!configFile) return { raw: { enabled: false, provider: 'deepseek' } };
  try {
    return { raw: JSON.parse(fs.readFileSync(configFile, 'utf8')) };
  } catch (error: any) {
    if (error.code === 'ENOENT') return { raw: { enabled: false, provider: 'deepseek' } };
    return { raw: { enabled: false, provider: 'deepseek' }, configError: 'AI 配置文件无法读取或不是有效 JSON' };
  }
}

function providerList() {
  return Object.entries(PROVIDERS).map(([id, provider]) => ({
    id,
    label: provider.label,
    apiUrl: provider.apiUrl || '',
    apiStyle: provider.apiStyle,
  }));
}

export function sanitizeDraft(input: Record<string, any> | undefined, { requireComplete = false } = {}) {
  const provider = String(input?.provider || '').trim();
  const preset = PROVIDERS[provider];
  if (!preset) throw clientError('请选择支持的 AI 提供方');
  const model = String(input?.model || '').trim();
  const apiUrl = String(input?.apiUrl || preset.apiUrl || '').trim();
  const apiStyle = String(input?.apiStyle || preset.apiStyle || '').trim() as 'responses' | 'chat-completions';
  const enabled = input?.enabled === true;
  const allowNoKey = input?.allowNoKey === true;
  if (model.length > 200) throw clientError('模型名称不能超过 200 个字符');
  if (apiUrl.length > 2048) throw clientError('API URL 不能超过 2048 个字符');
  if (!['responses', 'chat-completions'].includes(apiStyle)) throw clientError('不支持的 API 格式');
  if ((enabled || requireComplete) && !model) throw clientError('请填写模型名称');
  if ((enabled || requireComplete) && !apiUrl) throw clientError('请填写 API URL');

  if (apiUrl) {
    let parsed: URL;
    try {
      parsed = new URL(apiUrl);
    } catch {
      throw clientError('API URL 格式不正确');
    }
    if (parsed.username || parsed.password) throw clientError('API URL 不能包含用户名或密码');
    if (allowNoKey && !isPrivateHost(parsed.hostname)) throw clientError('无需 Key 仅适用于本机或私网接口');
    for (const name of parsed.searchParams.keys()) {
      if (/key|token|secret|password/i.test(name)) throw clientError('API Key 不能放在 URL 查询参数中');
    }
    const probe = resolveRawProviderConfig({
      enabled: true,
      provider,
      model: model || 'disabled-placeholder',
      apiUrl,
      apiStyle,
      allowNoKey: true,
    });
    if (!probe.enabled) throw clientError(probe.configError || 'AI 配置无效');
  }

  return { enabled, provider, model, apiUrl, apiStyle, allowNoKey };
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(temporary, filePath);
    await fs.promises.chmod(filePath, 0o600);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export function createAiConfigService(options: { configFile?: string; keyFile?: string; auditFile?: string }) {
  const { configFile, keyFile, auditFile } = options;
  let saveQueue: Promise<any> = Promise.resolve();

  function current() {
    const { raw, configError } = readRawConfig(configFile);
    const preset = PROVIDERS[raw.provider] || PROVIDERS.deepseek;
    const configuredKeyFile = raw.apiKeyFile || keyFile;
    return {
      enabled: raw.enabled === true,
      provider: PROVIDERS[raw.provider] ? raw.provider : 'deepseek',
      model: String(raw.model || ''),
      apiUrl: String(raw.apiUrl || preset.apiUrl || ''),
      apiStyle: String(raw.apiStyle || preset.apiStyle),
      allowNoKey: raw.allowNoKey === true,
      hasApiKey: Boolean(readSecret(configuredKeyFile)),
      configError,
      providers: providerList(),
    };
  }

  async function appendAudit(entry: Record<string, unknown>) {
    if (!auditFile) return;
    await fs.promises.mkdir(path.dirname(auditFile), { recursive: true, mode: 0o700 });
    await fs.promises.appendFile(auditFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  async function save(input: Record<string, any>, context: { actor?: string } = {}) {
    const operation = async () => {
      const previous = readRawConfig(configFile).raw;
      const draft = sanitizeDraft(input);
      const suppliedKey = String(input?.apiKey || '').trim();
      if (suppliedKey.length > 4096) throw clientError('API Key 长度超出限制');
      if (draft.enabled && draft.provider !== previous.provider && !suppliedKey && !draft.allowNoKey) {
        throw clientError('切换提供方时必须填写新的 API Key');
      }
      const existingKey = readSecret(previous.apiKeyFile || keyFile);
      const effectiveKey = suppliedKey || existingKey;
      if (draft.enabled && !effectiveKey && !draft.allowNoKey) throw clientError('启用模型前请填写 API Key');
      if (draft.enabled) {
        const resolved = resolveRawProviderConfig({ ...draft, enabled: true }, effectiveKey);
        if (!resolved.enabled) throw clientError(resolved.configError || 'AI 配置无效');
      }
      if (suppliedKey && keyFile) await atomicWrite(keyFile, `${suppliedKey}\n`);
      const stored = { ...draft, apiKeyFile: keyFile };
      if (configFile) await atomicWrite(configFile, `${JSON.stringify(stored, null, 2)}\n`);
      await appendAudit({
        id: crypto.randomUUID(),
        actionId: 'ai:configure',
        action: '更新 AI 模型配置',
        risk: 'change',
        actor: context.actor || 'unknown',
        provider: draft.provider,
        model: draft.model,
        enabled: draft.enabled,
        status: 'succeeded',
        completedAt: new Date().toISOString(),
      });
      return current();
    };
    const result = saveQueue.then(operation);
    saveQueue = result.catch(() => {});
    return result;
  }

  async function testConnection(input: Record<string, any>, context: { actor?: string } = {}) {
    const startedAt = Date.now();
    const draft = sanitizeDraft(input, { requireComplete: true });
    const suppliedKey = String(input?.apiKey || '').trim();
    if (suppliedKey.length > 4096) throw clientError('API Key 长度超出限制');
    const existing = current();
    const existingKey = readSecret(readRawConfig(configFile).raw.apiKeyFile || keyFile);
    if (draft.provider !== existing.provider && !suppliedKey && !draft.allowNoKey) {
      throw clientError('测试新的提供方时请填写对应 API Key');
    }
    const apiKey = suppliedKey || existingKey;
    const resolved = resolveRawProviderConfig({ ...draft, enabled: true }, apiKey);
    if (!resolved.enabled) throw clientError(resolved.configError || 'AI 配置无效');
    let output: string;
    try {
      output = await requestProvider(resolved, {
        systemPrompt: '这是连接测试。不要使用工具，只回复 OK。',
        userPrompt: '请回复 OK。',
        actor: context.actor,
        maxTokens: 20,
      });
    } catch (error: any) {
      throw clientError(`连接测试失败：${error.name === 'AbortError' ? '请求超时' : error.message}`, 502);
    }
    return {
      ok: true,
      provider: PROVIDERS[draft.provider].label,
      model: draft.model,
      latencyMs: Date.now() - startedAt,
      response: String(output).slice(0, 200),
    };
  }

  return { current, save, testConnection };
}

export type AiConfigService = ReturnType<typeof createAiConfigService>;
