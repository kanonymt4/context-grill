import { retry } from '../util/misc.js';
import { log } from '../util/log.js';
import { guardedFetch } from '../util/egress.js';
import { redactMessage } from '../util/redact.js';
import { extractJson } from './jsonschema.js';

/**
 * プロバイダ抽象。呼び出し側は complete() だけを使う。
 * 「どのモデルでも同じ品質」を成立させるため、
 *  - 温度 0 固定（設定で上書き可）
 *  - 構造化出力の強制（Anthropic=tool_use / OpenAI=json_schema / 互換=プロンプト+抽出）
 *  - 使用トークンの共通形式での返却
 * を全プロバイダで揃える。
 */
export function createProvider(cfg) {
  const provider = cfg.provider;
  if (provider === 'dry') return dryProvider(cfg);
  if (provider === 'anthropic') return anthropicProvider(cfg);
  return openaiProvider(cfg);
}

function apiKey(cfg, fallbackEnv) {
  const name = cfg.apiKeyEnv || fallbackEnv;
  const v = process.env[name];
  if (!v) throw Object.assign(new Error(`環境変数 ${name} が未設定です（llm.provider=${cfg.provider}）`), { noRetry: true });
  return v;
}

function dryProvider(cfg) {
  return {
    name: 'dry', model: cfg.model || 'dry-run', supportsCache: false,
    async complete() {
      const e = new Error('llm.provider=dry のため API 呼び出しは行いません（--dry-run 相当）');
      e.code = 'DRY_RUN';
      throw e;
    },
  };
}

function anthropicProvider(cfg) {
  const base = (cfg.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  return {
    name: 'anthropic',
    model: cfg.model,
    supportsCache: true,
    async complete({ systemStatic, systemDynamic, cacheableUser, user, schema, schemaName = 'emit_report', maxTokens, model }) {
      const key = apiKey(cfg, 'ANTHROPIC_API_KEY');
      const system = [];
      if (systemStatic) system.push({ type: 'text', text: systemStatic, ...(cfg.promptCache ? { cache_control: { type: 'ephemeral' } } : {}) });
      if (systemDynamic) system.push({ type: 'text', text: systemDynamic });
      const content = [];
      if (cacheableUser) content.push({ type: 'text', text: cacheableUser, ...(cfg.promptCache ? { cache_control: { type: 'ephemeral' } } : {}) });
      content.push({ type: 'text', text: user });
      const body = {
        model: model || cfg.model,
        max_tokens: maxTokens || cfg.maxOutputTokens,
        temperature: cfg.temperature ?? 0,
        system,
        messages: [{ role: 'user', content }],
      };
      if (cfg.topP != null) body.top_p = cfg.topP;
      if (schema) {
        body.tools = [{ name: schemaName, description: '検証済みレポートを構造化して出力する', input_schema: schema }];
        body.tool_choice = { type: 'tool', name: schemaName };
      }
      const json = await request(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
      }, cfg.timeoutMs);
      const toolUse = (json.content || []).find((c) => c.type === 'tool_use');
      const text = (json.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      return {
        json: toolUse ? toolUse.input : extractJson(text),
        text,
        usage: {
          input: json.usage?.input_tokens ?? 0,
          output: json.usage?.output_tokens ?? 0,
          cacheWrite: json.usage?.cache_creation_input_tokens ?? 0,
          cacheRead: json.usage?.cache_read_input_tokens ?? 0,
        },
        stopReason: json.stop_reason,
        raw: json,
      };
    },
  };
}

function openaiProvider(cfg) {
  const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const compat = cfg.provider === 'openai-compat';
  return {
    name: cfg.provider,
    model: cfg.model,
    supportsCache: false,
    async complete({ systemStatic, systemDynamic, cacheableUser, user, schema, schemaName = 'emit_report', maxTokens, model }) {
      const key = apiKey(cfg, compat ? 'LLM_API_KEY' : 'OPENAI_API_KEY');
      const sys = [systemStatic, systemDynamic].filter(Boolean).join('\n\n');
      const usr = [cacheableUser, user].filter(Boolean).join('\n\n');
      const mk = (useSchema) => {
        const b = {
          model: model || cfg.model,
          temperature: cfg.temperature ?? 0,
          max_tokens: maxTokens || cfg.maxOutputTokens,
          messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
        };
        if (cfg.topP != null) b.top_p = cfg.topP;
        if (schema && useSchema) b.response_format = { type: 'json_schema', json_schema: { name: schemaName, schema, strict: false } };
        else if (schema) b.response_format = { type: 'json_object' };
        return b;
      };
      let json;
      try {
        json = await request(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify(mk(true)),
        }, cfg.timeoutMs);
      } catch (e) {
        if (!schema || !/response_format|json_schema|400/.test(e.message)) throw e;
        log.warn('json_schema 未対応のため json_object モードにフォールバックします');
        json = await request(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify(mk(false)),
        }, cfg.timeoutMs);
      }
      const text = json.choices?.[0]?.message?.content ?? '';
      return {
        json: extractJson(text),
        text,
        usage: {
          input: json.usage?.prompt_tokens ?? 0,
          output: json.usage?.completion_tokens ?? 0,
          cacheWrite: 0,
          cacheRead: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        },
        stopReason: json.choices?.[0]?.finish_reason,
        raw: json,
      };
    },
  };
}

async function request(url, init, timeoutMs = 180000) {
  return retry(async () => {
    const res = await guardedFetch(url, init, { purpose: 'llm', timeoutMs });
    const body = await res.text();
    if (!res.ok) {
      const err = new Error(redactMessage(`LLM API HTTP ${res.status}: ${body.slice(0, 800)}`));
      if ([400, 401, 403, 404, 422].includes(res.status)) err.noRetry = true;
      throw err;
    }
    return JSON.parse(body);
  }, { attempts: 4, baseMs: 1200, onRetry: (e, i, w) => log.warn(`LLM 再試行 ${i + 1} (${w}ms): ${redactMessage(e.message).slice(0, 160)}`) });
}
