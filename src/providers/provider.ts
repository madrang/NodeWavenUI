/**
 * The contract every inference provider plugin implements.
 * A provider turns a conversation into one completion from a model.
 * Backends live beside this file, one module per backend, and stay exchangeable through this interface.
 */

/** Role of a message in a conversation. */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** One tool the model may call. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** The JSON Schema of the arguments. The root type is object. */
  readonly inputSchema: Record<string, unknown>;
}

/** One tool call the model requested. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** The arguments as serialized JSON. */
  readonly arguments: string;
}

/** One message in a conversation. */
export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
  /** The reasoning of an assistant reply. Backends that replay reasoning send it again with the next request. */
  readonly reasoning?: string;
  /** The tool calls of an assistant reply, when the model requests tools instead of text. */
  readonly toolCalls?: readonly ToolCall[];
  /** The tool call this message answers, on role tool. */
  readonly toolCallId?: string;
}

/** One streamed piece of a completion, while the model still works. */
export interface CompletionDelta {
  readonly content?: string;
  readonly reasoning?: string;
}

/** Request for one completion from a model. */
export interface CompletionRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /** Receives every streamed piece. A backend that cannot stream completes without calling it. */
  readonly onDelta?: (delta: CompletionDelta) => void;
  /** The tools the model may call. An empty list sends no tools. */
  readonly tools?: readonly ToolDefinition[];
}

/** Token counts of one completion, when the provider reports them. */
export interface CompletionUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/** Result of one completion. */
export interface CompletionResult {
  readonly content: string;
  readonly model: string;
  /** The reasoning text of the reply, when the model reports one. */
  readonly reasoning?: string;
  /** The tool calls the model requested, when it asks for tools instead of text. */
  readonly toolCalls?: readonly ToolCall[];
  readonly usage?: CompletionUsage;
}

/** Runs inference through one backend. */
export interface InferenceProvider {
  /** Stable identifier of this provider instance. */
  readonly id: string;

  /**
   * Completes a conversation.
   *
   * @param request The conversation and the model to run.
   * @returns The completion text, the model that answered, and usage counts when the backend reports them.
   * @throws ProviderError when the backend fails or answers with an invalid payload.
   */
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

/**
 * Checks that a value satisfies the InferenceProvider shape.
 * Use this guard at plugin registration, where modules arrive without type backing.
 *
 * @param value The value to check. It can have any type.
 * @returns True when the value carries an id string and a complete function.
 */
export function isInferenceProvider(value: unknown): value is InferenceProvider {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.complete === 'function'
  );
}

/** Error every provider throws on failure. */
export class ProviderError extends Error {
  /**
   * @param message What failed, in a sentence a user can act on.
   * @param options The optional standard cause of this error.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderError';
  }
}
