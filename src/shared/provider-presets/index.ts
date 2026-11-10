/**
 * The catalog of known provider endpoints: the base URL the add form prefills and the
 * `beforeRequest` hook that gives each endpoint the last word on the outgoing request body.
 * One file per provider sits beside this index, so adding a provider touches nothing else.
 * An account records a preset id; a custom account with no preset runs the plain OpenAI dialect.
 */

import { ZAI_API_PRESET, ZAI_CODING_PRESET } from './zai.js';
import { VENICE_PRESET } from './venice.js';

/** One known provider endpoint. */
export interface ProviderPreset {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  /**
   * Rewrites the outgoing request body of every call. It runs after the standard OpenAI build,
   * before the request leaves, and may change or add any field — so an endpoint quirk needs no
   * support in the provider core.
   */
  readonly beforeRequest?: (body: Record<string, unknown>) => void;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [ZAI_CODING_PRESET, ZAI_API_PRESET, VENICE_PRESET];

/** Reads one preset by id. Null for an absent or unknown id. */
export function providerPresetOf(id: string | undefined): ProviderPreset | null {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** Reads the preset of one account: the recorded id first, then a base URL match, so an account
 * added before the catalog or by hand still earns its hook. Null when nothing matches. */
export function presetOfAccount(account: { presetId?: string; baseUrl: string }): ProviderPreset | null {
  const byUrl = PROVIDER_PRESETS.find((preset) => preset.baseUrl === account.baseUrl) ?? null;
  return providerPresetOf(account.presetId) ?? byUrl;
}
