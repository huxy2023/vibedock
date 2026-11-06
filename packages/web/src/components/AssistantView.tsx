import React, { useState, useEffect, useRef } from 'react';
import { Settings, Plus, Send, Zap, Bot, User as UserIcon, Play } from 'lucide-react';
import { apiFetch, renderMarkdownHtml } from '../api';
import type { ChatMessage, ChatTraceStep, PendingAction, User } from '../types';
import { Badge, Button, Card, Input, Select } from './ui';

interface AssistantViewProps {
  user: User;
  initialPrompt?: string;
  onConsumeInitialPrompt?: () => void;
  onCatalogRefresh: () => void;
}

interface ConversationSummary {
  id: string;
  title: string;
  updatedAt?: string;
}

const DEFAULT_SUGGESTIONS = [
  '当前有哪些项目和端口？',
  '推荐下一个可用端口',
  '如何通过 Skill 部署一个新应用？',
  '检查当前所有服务的在线状态',
];

function mapMessageActions(msgObj: any, fallbackPayload?: any): PendingAction[] {
  const actionIds: string[] = Array.isArray(msgObj?.actionIds)
    ? msgObj.actionIds
    : Array.isArray(fallbackPayload?.suggestions)
    ? fallbackPayload.suggestions
    : [];
  const reasons: Record<string, string> =
    msgObj?.actionReasons || fallbackPayload?.actionReasons || {};

  if (actionIds.length > 0) {
    return actionIds.map((actionId) => ({
      id: actionId,
      type: actionId,
      targetId: '',
      title: actionId,
      summary: reasons[actionId] || '受控运维动作（需管理员点击确认后执行）',
      risk: actionId.includes('restart') || actionId.includes('reload') ? 'change' : 'low',
      status: 'pending',
    }));
  }

  const proposals: any[] = msgObj?.actionProposals || msgObj?.actions || [];
  return proposals.map((a: any) => ({
    id: a.actionId || a.id,
    type: a.actionId || a.id,
    targetId: a.projectId || '',
    title: a.label || a.title || a.actionId || a.id,
    summary: a.reason || a.summary || '',
    risk: a.risk || 'low',
    status: a.status || 'pending',
    commandPreview: a.commandPreview,
  }));
}

export const AssistantView: React.FC<AssistantViewProps> = ({
  user,
  initialPrompt,
  onConsumeInitialPrompt,
  onCatalogRefresh,
}) => {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [liveTrace, setLiveTrace] = useState<ChatTraceStep[]>([]);
  const [aiConfig, setAiConfig] = useState<any | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [providerInput, setProviderInput] = useState('deepseek');
  const [protocolInput, setProtocolInput] = useState('openai');
  const [baseUrlInput, setBaseUrlInput] = useState('');
  const [modelInput, setModelInput] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [configMsg, setConfigMsg] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  const loadConversationDetail = async (id: string) => {
    if (!id) return;
    setConversationId(id);
    try {
      const detail = await apiFetch<{ messages: Array<any> }>(
        `/api/assistant/conversations/${encodeURIComponent(id)}`
      );
      if (Array.isArray(detail.messages)) {
        setMessages(
          detail.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.markdown || m.content || m.answer || '',
            mode: m.agentMode || m.mode,
            provider: m.providerLabel || m.provider,
            model: m.model,
            trace: m.agentRun?.steps || m.steps || [],
            pendingActions: mapMessageActions(m),
          }))
        );
      }
    } catch {
      // ignore
    }
  };

  const loadHistoryAndConfig = async () => {
    try {
      const convList = await apiFetch<{ conversations: ConversationSummary[] }>(
        '/api/assistant/conversations'
      );
      const list = convList.conversations || [];
      setConversations(list);
      const firstId = list[0]?.id;
      if (firstId) {
        await loadConversationDetail(String(firstId));
      }
    } catch {
      // ignore
    }
    if (user.role === 'admin') {
      try {
        const cfg = await apiFetch<any>('/api/ai/config');
        setAiConfig(cfg);
        setProviderInput(cfg.provider || 'deepseek');
        setProtocolInput(cfg.protocol || 'openai');
        setBaseUrlInput(cfg.baseUrl || '');
        setModelInput(cfg.model || '');
      } catch {
        // ignore
      }
    }
  };

  useEffect(() => {
    loadHistoryAndConfig();
  }, [user.role]);

  useEffect(() => {
    if (initialPrompt && !streaming) {
      const promptToRun = initialPrompt;
      onConsumeInitialPrompt?.();
      sendMessage(promptToRun);
    }
  }, [initialPrompt]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [messages, liveTrace, streaming]);

  const sendMessage = async (rawText?: string) => {
    const text = (rawText ?? input).trim();
    if (!text || streaming) return;
    if (!rawText) setInput('');

    const userMsg: ChatMessage = { role: 'user', content: text };
    setMessages((prev) => [...prev, userMsg]);
    setStreaming(true);
    setLiveTrace([]);

    try {
      const started = await apiFetch<{
        agentRun: { id: string };
        conversationId?: string;
      }>('/api/assistant/agent-runs', {
        method: 'POST',
        body: JSON.stringify({
          question: text,
          conversationId,
          permission: user.role === 'admin' ? 'change' : 'read',
        }),
      });
      if (started.conversationId) {
        const convId = String(started.conversationId);
        setConversationId(convId);
        setConversations((prev) => {
          if (prev.some((c) => String(c.id) === convId)) return prev;
          return [{ id: convId, title: text.slice(0, 24) }, ...prev];
        });
      }

      const runId = started.agentRun.id;
      const es = new EventSource(`/api/assistant/agent-runs/${encodeURIComponent(runId)}/events`);
      const traceBuffer: ChatTraceStep[] = [];
      let finished = false;

      es.addEventListener('step', (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data);
          const stepObj = payload.step || payload;
          const step: ChatTraceStep = {
            type: stepObj.type || stepObj.kind || 'step',
            title: stepObj.title || stepObj.toolName || '诊断步骤',
            summary: stepObj.outputExcerpt || stepObj.summary || stepObj.detail || '',
          };
          traceBuffer.push(step);
          setLiveTrace([...traceBuffer]);
        } catch {
          // ignore
        }
      });

      es.addEventListener('final', (event) => {
        finished = true;
        es.close();
        setStreaming(false);
        setLiveTrace([]);
        try {
          const payload = JSON.parse((event as MessageEvent).data);
          const msgObj = payload.assistantMessage || payload.result || payload;
          const assistantMsg: ChatMessage = {
            id: msgObj.id,
            role: 'assistant',
            content: msgObj.markdown || msgObj.answer || msgObj.reply || '',
            mode: msgObj.agentMode || msgObj.mode || payload.agentRun?.mode,
            provider: msgObj.providerLabel || msgObj.provider || payload.agentRun?.provider,
            model: msgObj.model || payload.agentRun?.model,
            trace: msgObj.agentRun?.steps || traceBuffer,
            pendingActions: mapMessageActions(msgObj, payload),
          };
          setMessages((prev) => [...prev, assistantMsg]);
        } catch {
          // ignore
        }
      });

      es.addEventListener('error', () => {
        if (finished) return;
        finished = true;
        es.close();
        setStreaming(false);
        setLiveTrace([]);
      });
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `请求失败: ${(err as Error).message}`,
        },
      ]);
      setStreaming(false);
      setLiveTrace([]);
    }
  };

  const handleNewConversation = async () => {
    try {
      const created = await apiFetch<{ id: string | number; title: string }>(
        '/api/assistant/conversations',
        {
          method: 'POST',
          body: JSON.stringify({ title: '新运维会话' }),
        }
      );
      const convId = String(created.id);
      const conv = { id: convId, title: created.title || '新运维会话' };
      setConversationId(convId);
      setConversations((prev) => [conv, ...prev]);
      setMessages([]);
    } catch {
      setMessages([]);
    }
  };

  const handleExecuteAction = async (action: PendingAction) => {
    try {
      const res = await apiFetch<{ summary?: string; status?: string }>(
        `/api/actions/${encodeURIComponent(action.id)}/execute`,
        {
          method: 'POST',
          body: JSON.stringify({
            confirmed: true,
            reason: action.summary || '在 AI 运维助手中批准执行',
          }),
        }
      );
      setMessages((prev) =>
        prev.map((m) => ({
          ...m,
          pendingActions: (m.pendingActions || []).map((a) =>
            a.id === action.id
              ? {
                  ...a,
                  status: 'executed',
                  result: { ok: true, message: res.summary || '执行完成' },
                }
              : a
          ),
        }))
      );
      onCatalogRefresh();
    } catch (err) {
      alert(`执行失败: ${(err as Error).message}`);
    }
  };

  const handleSaveAiConfig = async (event: React.FormEvent) => {
    event.preventDefault();
    setConfigMsg('保存中…');
    try {
      const updated = await apiFetch<any>('/api/ai/config', {
        method: 'PUT',
        body: JSON.stringify({
          enabled: true,
          provider: providerInput,
          protocol: protocolInput,
          baseUrl: baseUrlInput,
          model: modelInput,
          ...(apiKeyInput.trim() ? { apiKey: apiKeyInput.trim() } : {}),
        }),
      });
      setAiConfig(updated);
      setApiKeyInput('');
      setConfigMsg('✓ AI 模型配置已保存生效');
      setTimeout(() => setConfigMsg(''), 2500);
    } catch (err) {
      setConfigMsg(`保存失败: ${(err as Error).message}`);
    }
  };

  const handleTestAiConnection = async () => {
    setConfigMsg('正在测试模型连通性…');
    try {
      const res = await apiFetch<{ ok?: boolean; message?: string; model?: string }>(
        '/api/ai/config/test',
        {
          method: 'POST',
          body: JSON.stringify({
            enabled: true,
            provider: providerInput,
            protocol: protocolInput,
            baseUrl: baseUrlInput,
            model: modelInput,
            ...(apiKeyInput.trim() ? { apiKey: apiKeyInput.trim() } : {}),
          }),
        }
      );
      setConfigMsg(`✓ 连接成功 (${res.model || modelInput})：${res.message || '响应正常'}`);
    } catch (err) {
      setConfigMsg(`连接测试失败: ${(err as Error).message}`);
    }
  };

  return (
    <section className="mx-auto max-w-4xl space-y-4">
      <Card className="flex flex-col justify-between gap-4 p-5 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-base font-semibold text-zinc-900">AI 运维与导航助手</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            支持查询目录、推荐端口、诊断文件与创建受控审批动作
            {aiConfig?.model ? ` · 当前引擎: ${aiConfig.provider} (${aiConfig.model})` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {conversations.length > 0 && (
            <Select
              className="w-44 text-xs"
              value={conversationId}
              onChange={(e) => loadConversationDetail(e.target.value)}
              aria-label="切换历史会话"
            >
              {conversations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title || c.id}
                </option>
              ))}
            </Select>
          )}
          {user.role === 'admin' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfigOpen((prev) => !prev)}
            >
              <Settings className="h-3.5 w-3.5" />
              模型设置
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" onClick={handleNewConversation}>
            <Plus className="h-3.5 w-3.5" />
            新建会话
          </Button>
        </div>
      </Card>

      {user.role === 'admin' && configOpen && (
        <Card className="p-5">
          <form onSubmit={handleSaveAiConfig} className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-zinc-700">服务商 Preset</label>
                <Select
                  value={providerInput}
                  onChange={(e) => setProviderInput(e.target.value)}
                >
                  <option value="deepseek">DeepSeek</option>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic Claude</option>
                  <option value="gemini">Google Gemini</option>
                  <option value="openrouter">OpenRouter</option>
                  <option value="ollama">Ollama (Local)</option>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-zinc-700">协议类型</label>
                <Select
                  value={protocolInput}
                  onChange={(e) => setProtocolInput(e.target.value)}
                >
                  <option value="openai">OpenAI Compatible</option>
                  <option value="anthropic">Anthropic Messages</option>
                  <option value="gemini">Google Gemini</option>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-zinc-700">Base URL</label>
                <Input
                  type="text"
                  value={baseUrlInput}
                  onChange={(e) => setBaseUrlInput(e.target.value)}
                  placeholder="https://api.deepseek.com/v1"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-zinc-700">模型名称 (Model)</label>
                <Input
                  type="text"
                  value={modelInput}
                  onChange={(e) => setModelInput(e.target.value)}
                  placeholder="deepseek-chat"
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <label className="text-xs font-medium text-zinc-700">
                  API Key (留空则沿用已保存密钥)
                </label>
                <Input
                  type="password"
                  placeholder="sk-..."
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm">
                保存模型配置
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleTestAiConnection}
              >
                <Zap className="h-3.5 w-3.5" />
                测试连接
              </Button>
              {configMsg && <span className="text-xs text-zinc-600">{configMsg}</span>}
            </div>
          </form>
        </Card>
      )}

      {/* Quick Suggestions */}
      <div className="flex flex-wrap gap-2">
        {DEFAULT_SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => sendMessage(s)}
            disabled={streaming}
            className="rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs font-medium text-zinc-700 shadow-2xs transition-colors hover:bg-zinc-100 disabled:opacity-50 cursor-pointer"
          >
            {s}
          </button>
        ))}
      </div>

      {/* Chat Log */}
      <Card className="flex h-[520px] flex-col overflow-hidden">
        <div ref={logRef} className="flex-1 space-y-4 overflow-y-auto p-5">
          {messages.length === 0 && !streaming && (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <Bot className="h-8 w-8 text-zinc-300" />
              <p className="mt-2 max-w-md text-xs text-zinc-500">
                向运维助手提问：查看已部署项目、分配空闲端口、读取日志或生成受控重启审批单。
              </p>
            </div>
          )}

          {messages.map((msg, idx) => {
            const isUser = msg.role === 'user';
            return (
              <div
                key={msg.id || idx}
                className={`rounded-xl border p-4 ${
                  isUser
                    ? 'ml-8 border-zinc-200 bg-zinc-100/70'
                    : 'mr-4 border-zinc-200 bg-white shadow-2xs'
                }`}
              >
                <div className="mb-2 flex items-center gap-2 text-xs">
                  {isUser ? (
                    <UserIcon className="h-3.5 w-3.5 text-zinc-600" />
                  ) : (
                    <Bot className="h-3.5 w-3.5 text-blue-600" />
                  )}
                  <strong className="font-semibold text-zinc-900">
                    {isUser ? user.username : 'VibeDock Assistant'}
                  </strong>
                  {!isUser && msg.provider && (
                    <Badge variant="secondary" className="text-[10px]">
                      {msg.provider} {msg.model ? `/ ${msg.model}` : ''}
                    </Badge>
                  )}
                </div>

                {!isUser && msg.trace && msg.trace.length > 0 && (
                  <details className="mb-2.5 rounded-lg border border-zinc-200/80 bg-zinc-50 px-3 py-2 text-xs">
                    <summary className="cursor-pointer font-medium text-zinc-600">
                      查看推理与工具调用轨迹（{msg.trace.length} 步）
                    </summary>
                    <ul className="mt-2 list-disc space-y-1 pl-4 text-zinc-600">
                      {msg.trace.map((step, sIdx) => (
                        <li key={sIdx}>
                          <strong className="text-zinc-800">{step.title || step.type}</strong>
                          {step.summary ? ` — ${step.summary}` : ''}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}

                <div
                  className="chat-markdown"
                  dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(msg.content) }}
                />

                {msg.pendingActions && msg.pendingActions.length > 0 && (
                  <div className="mt-3 space-y-2 border-t border-zinc-100 pt-3">
                    {msg.pendingActions.map((act) => (
                      <div
                        key={act.id}
                        className="rounded-lg border border-zinc-200 bg-zinc-50 p-3"
                      >
                        <div className="flex items-center justify-between">
                          <strong className="text-xs font-semibold text-zinc-900">
                            ⚡ 建议运维动作：{act.title}
                          </strong>
                          <Badge
                            variant={act.status === 'executed' ? 'success' : 'outline'}
                          >
                            {act.status}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs text-zinc-600">{act.summary}</p>
                        {act.status === 'pending' && user.role === 'admin' && (
                          <div className="mt-2">
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => handleExecuteAction(act)}
                            >
                              <Play className="h-3 w-3" />
                              批准并执行
                            </Button>
                          </div>
                        )}
                        {act.result?.message && (
                          <p className="mt-1.5 text-xs font-medium text-emerald-700">
                            执行结果：{act.result.message}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {streaming && (
            <div className="mr-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-2xs">
              <div className="flex items-center gap-2 text-xs">
                <Bot className="h-3.5 w-3.5 animate-pulse text-blue-600" />
                <strong className="font-semibold text-zinc-900">VibeDock Assistant</strong>
                <span className="text-zinc-400">思考与调用工具中…</span>
              </div>
              {liveTrace.length > 0 && (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-zinc-600">
                  {liveTrace.map((step, idx) => (
                    <li key={idx}>
                      <strong>{step.title || step.type}</strong>
                      {step.summary ? ` — ${step.summary}` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <form
          className="flex items-center gap-2 border-t border-zinc-200 bg-zinc-50/70 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            sendMessage();
          }}
        >
          <Input
            type="text"
            placeholder="输入运维问题或指令，回车发送…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={streaming}
          />
          <Button type="submit" disabled={streaming}>
            <Send className="h-4 w-4" />
            {streaming ? '处理中…' : '发送'}
          </Button>
        </form>
      </Card>
    </section>
  );
};
