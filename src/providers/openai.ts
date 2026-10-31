/**
 * Inference provider for OpenAI-compatible chat-completions endpoints.
 * The wire contract and the retry policy live in the vault note `Kimi Code/HTTP API.md`, distilled from the Kimi platform docs.
 * Any endpoint that speaks the OpenAI chat-completions schema works, for example Moonshot, Venice, or a local vLLM server.
 */

import { isRecord } from '../shared/records.js';
import {
  ProviderError,
  type ChatMessage,
  type CompletionDelta,
  type CompletionRequest,
  type CompletionResult,
  type CompletionUsage,
  type InferenceProvider,
  type ToolCall,
} from './provider.js';

/** Configuration for one OpenAI-compatible endpoint. */
export interface OpenAiProviderConfig {
  /** Identifier of this provider instance. The default is "openai". */
  readonly id?: string;
  /** Base URL of the endpoint, for example "https://api.moonshot.ai/v1". */
  readonly baseUrl: string;
  /** Bearer key that authorizes the calls. */
  readonly apiKey: string;
}

/** Statuses the retry policy treats as transient. */
const RETRYABLE_STATUSES: readonly number[] = [429, 500, 502, 503, 504];
/** Number of retries after the first failed attempt. */
const RETRY_COUNT = 3;
/**
 * The reasoning field the last response used. The next request echoes the same field, the kimi-code replay rule
 * (see the vault note `Kimi Code/Reasoning.md`). Module scope, so the dialect survives per-call provider instances.
 */
let lastReasoningField: 'reasoning_content' | 'reasoning' = 'reasoning_content';

/**
 * Reads one message content as the wire value.
 * A message with images carries content parts, so a vision model sees the pictures.
 * Every other message stays a plain string.
 *
 * @param message The message to serialize.
 * @returns The string or the content-part array of the wire body.
 */
function wireContent(message: ChatMessage): string | readonly unknown[] {
  if (!message.images || message.images.length === 0) {
    return message.content;
  }
  const parts: Record<string, unknown>[] = [];
  if (message.content.length > 0) {
    parts.push({ type: 'text', text: message.content });
  }
  for (const image of message.images) {
    parts.push({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } });
  }
  return parts;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Reads the token counts from a response body.
 *
 * @param value The usage field of the body. It can have any type.
 * @returns The counts, or undefined when the field is missing or malformed.
 */
function readUsage(value: unknown): CompletionUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const promptTokens = value.prompt_tokens;
  const completionTokens = value.completion_tokens;
  const totalTokens = value.total_tokens;
  if (
    typeof promptTokens !== 'number' ||
    typeof completionTokens !== 'number' ||
    typeof totalTokens !== 'number'
  ) {
    return undefined;
  }
  return { promptTokens, completionTokens, totalTokens };
}

/** Reads the tool calls of one full response message. */
function readToolCalls(value: unknown): ToolCall[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const calls: ToolCall[] = [];
  for (const item of value) {
    const record = isRecord(item) ? item : null;
    const fn = record && isRecord(record.function) ? record.function : null;
    const id = record && typeof record.id === 'string' ? record.id : null;
    const name = fn && typeof fn.name === 'string' ? fn.name : null;
    const args = fn && typeof fn.arguments === 'string' ? fn.arguments : '{}';
    if (id && name) {
      calls.push({ id, name, arguments: args });
    }
  }
  return calls.length > 0 ? calls : undefined;
}

/**
 * Validates a full chat-completions response body and reads the completion.
 *
 * @param value The parsed response body. It can have any type.
 * @returns The completion text, the reasoning text, the tool calls, the reported model, and the usage counts, or null when the body does not match the schema.
 */
function readCompletion(
  value: unknown,
): {
  content: string;
  reasoning: string | undefined;
  toolCalls: ToolCall[] | undefined;
  model: string | undefined;
  usage: CompletionUsage | undefined;
} | null {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    return null;
  }
  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    return null;
  }
  const content = choice.message.content;
  if (typeof content !== 'string') {
    return null;
  }
  const reasoningContent = choice.message.reasoning_content;
  const reasoningAlt = choice.message.reasoning;
  let reasoning: string | undefined;
  if (typeof reasoningContent === 'string') {
    reasoning = reasoningContent;
    lastReasoningField = 'reasoning_content';
  } else if (typeof reasoningAlt === 'string') {
    reasoning = reasoningAlt;
    lastReasoningField = 'reasoning';
  }
  return {
    content,
    reasoning,
    toolCalls: readToolCalls(choice.message.tool_calls),
    model: typeof value.model === 'string' ? value.model : undefined,
    usage: readUsage(value.usage),
  };
}

/** Runs inference against an OpenAI-compatible chat-completions endpoint. */
export class OpenAiInferenceProvider implements InferenceProvider {
  readonly id: string;
  private readonly config: OpenAiProviderConfig;

  /**
   * @param config The endpoint base URL, the API key, and an optional instance identifier.
   */
  constructor(config: OpenAiProviderConfig) {
    this.config = config;
    this.id = config.id ?? 'openai';
  }

  /**
   * Completes a conversation with one streaming chat-completions call.
   * The reasoning arrives in `delta.reasoning_content` or `delta.reasoning`, the answer in `delta.content`.
   *
   * @param request The conversation and the model to run. `onDelta` receives every streamed piece.
   * @returns The completion text, the reasoning text, the model that answered, and usage counts when the endpoint reports them.
   * @throws ProviderError when the endpoint stays unreachable, answers a retryable status too often, or returns an invalid body.
   */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const response = await this.fetchWithRetry(url, request);
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const suffix = detail.length > 0 ? ` ${detail}` : '';
      throw new ProviderError(`Provider "${this.id}" answered HTTP ${response.status} from ${url}.${suffix}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.body || !contentType.includes('text/event-stream')) {
      // An endpoint that ignores the streaming flag answers with one full body.
      const payload: unknown = await response.json().catch(() => null);
      const completion = readCompletion(payload);
      if (!completion) {
        throw new ProviderError(`Provider "${this.id}" returned a body that does not match the chat-completions schema.`);
      }
      return {
        content: completion.content,
        model: completion.model ?? request.model,
        ...(completion.reasoning ? { reasoning: completion.reasoning } : {}),
        ...(completion.toolCalls ? { toolCalls: completion.toolCalls } : {}),
        ...(completion.usage ? { usage: completion.usage } : {}),
      };
    }
    return this.readStream(response.body, request);
  }

  /**
   * Reads one server-sent-events stream to its end and reports every piece through the delta callback.
   * Assistant history messages carry their reasoning in the field the last response used, so the model sees its own
   * prior reasoning on the next exchange.
   *
   * @param body The response body stream of the completion call.
   * @param request The request the stream answers. Its `onDelta` receives each piece.
   * @returns The completion text, the reasoning text, the model that answered, and usage counts when the stream reports them.
   * @throws ProviderError when the stream carries no choice at all.
   */
  private async readStream(body: ReadableStream<Uint8Array>, request: CompletionRequest): Promise<CompletionResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    let model: string | undefined;
    let usage: CompletionUsage | undefined;
    let sawChoice = false;
    // Streaming tool calls arrive as index-keyed fragments: id and name once, argument pieces chunked.
    const toolCallParts = new Map<number, { id: string; name: string; args: string }>();
    const finish = (): CompletionResult => {
      if (!sawChoice) {
        throw new ProviderError(`Provider "${this.id}" streamed no completion choice.`);
      }
      const toolCalls =
        toolCallParts.size > 0
          ? [...toolCallParts.entries()].sort((left, right) => left[0] - right[0]).map(([, part]) => ({
              id: part.id,
              name: part.name,
              arguments: part.args,
            }))
          : undefined;
      return {
        content,
        model: model ?? request.model,
        ...(reasoning.length > 0 ? { reasoning } : {}),
        ...(toolCalls ? { toolCalls } : {}),
        ...(usage ? { usage } : {}),
      };
    };
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          return finish();
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          const seen = this.readChunkLine(line, {
            onContent: (piece) => {
              content += piece;
              sawChoice = true;
              request.onDelta?.({ content: piece });
            },
            onReasoning: (piece, field) => {
              lastReasoningField = field;
              reasoning += piece;
              sawChoice = true;
              request.onDelta?.({ reasoning: piece });
            },
            onModel: (reported) => {
              model = reported;
            },
            onUsage: (reported) => {
              usage = reported;
            },
            onToolCall: (fragment) => {
              const existing = toolCallParts.get(fragment.index) ?? { id: '', name: '', args: '' };
            if (fragment.id) {
              existing.id = fragment.id;
            }
            if (fragment.name) {
              existing.name = fragment.name;
            }
            if (fragment.argumentsPiece) {
              existing.args += fragment.argumentsPiece;
            }
              toolCallParts.set(fragment.index, existing);
              sawChoice = true;
            },
          });
          if (seen === 'done') {
            return finish();
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Reads one data line of the event stream and hands its pieces to the callbacks.
   *
   * @param line One raw line of the stream.
   * @param handlers The callbacks for the pieces the line carries.
   * @returns 'done' when the line ends the stream, 'next' otherwise.
   */
  private readChunkLine(
    line: string,
    handlers: {
      onContent: (piece: string) => void;
      onReasoning: (piece: string, field: 'reasoning_content' | 'reasoning') => void;
      onModel: (model: string) => void;
      onUsage: (usage: CompletionUsage) => void;
      onToolCall: (fragment: { index: number; id?: string; name?: string; argumentsPiece?: string }) => void;
    },
  ): 'done' | 'next' {
    if (!line.startsWith('data:')) {
      return 'next';
    }
    const payload = line.slice(5).trim();
    if (payload.length === 0) {
      return 'next';
    }
    if (payload === '[DONE]') {
      return 'done';
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return 'next';
    }
    const record = isRecord(parsed) ? parsed : null;
    if (!record) {
      return 'next';
    }
    if (typeof record.model === 'string') {
      handlers.onModel(record.model);
    }
    const usage = readUsage(record.usage);
    if (usage) {
      handlers.onUsage(usage);
    }
    const choices = Array.isArray(record.choices) ? record.choices : [];
    const choice = isRecord(choices[0]) ? choices[0] : null;
    const delta = choice && isRecord(choice.delta) ? choice.delta : null;
    if (!delta) {
      return 'next';
    }
    const contentPiece = delta.content;
    if (typeof contentPiece === 'string' && contentPiece.length > 0) {
      handlers.onContent(contentPiece);
    }
    const reasoningPiece = delta.reasoning_content;
    const reasoningAlt = delta.reasoning;
    if (typeof reasoningPiece === 'string' && reasoningPiece.length > 0) {
      handlers.onReasoning(reasoningPiece, 'reasoning_content');
    } else if (typeof reasoningAlt === 'string' && reasoningAlt.length > 0) {
      handlers.onReasoning(reasoningAlt, 'reasoning');
    }
    const rawToolCalls = delta.tool_calls;
    if (Array.isArray(rawToolCalls)) {
      for (const raw of rawToolCalls) {
        const record = isRecord(raw) ? raw : null;
        if (!record || typeof record.index !== 'number') {
          continue;
        }
        const fn = record && isRecord(record.function) ? record.function : null;
        const piece: { index: number; id?: string; name?: string; argumentsPiece?: string } = { index: record.index };
        if (typeof record.id === 'string' && record.id.length > 0) {
          piece.id = record.id;
        }
        if (fn && typeof fn.name === 'string' && fn.name.length > 0) {
          piece.name = fn.name;
        }
        if (fn && typeof fn.arguments === 'string' && fn.arguments.length > 0) {
          piece.argumentsPiece = fn.arguments;
        }
        handlers.onToolCall(piece);
      }
    }
    return 'next';
  }

  /**
   * Sends the streaming completion request and retries transient failures.
   * Transient means a network error or one of the retryable statuses, per the policy in the vault note.
   * The retry covers the request up to the response headers: once chunks flow, a broken stream fails the call.
   *
   * @param url The chat-completions URL.
   * @param request The request that becomes the body.
   * @returns The last response, whatever its status is.
   * @throws ProviderError when the request still fails after the retry budget.
   */
  private async fetchWithRetry(url: string, request: CompletionRequest): Promise<Response> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((message) => {
        const wire: Record<string, unknown> = { role: message.role, content: wireContent(message) };
        if (message.role === 'assistant') {
          if (message.reasoning) {
            wire[lastReasoningField] = message.reasoning;
          }
          if (message.toolCalls && message.toolCalls.length > 0) {
            wire['tool_calls'] = message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            }));
          }
        }
        if (message.role === 'tool' && message.toolCallId) {
          wire['tool_call_id'] = message.toolCallId;
        }
        return wire;
      }),
      stream: true,
      // The final chunk carries the usage counts only when the request asks for them.
      stream_options: { include_usage: true },
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      }));
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.maxOutputTokens !== undefined) {
      body.max_completion_tokens = request.maxOutputTokens;
    }
    for (let attempt = 0; ; attempt += 1) {
      let response: Response | null = null;
      let networkError: unknown = null;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        networkError = error;
      }
      const exhausted = attempt >= RETRY_COUNT;
      if (
        response &&
        (response.ok || !RETRYABLE_STATUSES.includes(response.status) || exhausted)
      ) {
        return response;
      }
      if (!response && exhausted) {
        throw new ProviderError(`Provider "${this.id}" could not reach ${url}.`, { cause: networkError });
      }
      await response?.text().catch(() => '');
      await sleep(2 ** attempt * 1000);
    }
  }
}
