/**
 * The Z.AI endpoints: the coding plan and the open platform, both OpenAI-compatible
 * (see the vault note `Z.AI/HTTP API.md`).
 * The dialect quirk: a thinking level rides the effort field beside the thinking flag, and the
 * endpoints answer `max` where the app vocabulary says high.
 */

import type { ProviderPreset } from './index.js';

function zaiBeforeRequest(body: Record<string, unknown>): void {
  if (typeof body.reasoning_effort !== 'string') {
    return;
  }
  body.thinking = { type: 'enabled' };
  if (body.reasoning_effort === 'high') {
    body.reasoning_effort = 'max';
  }
}

export const ZAI_CODING_PRESET: ProviderPreset = {
  id: 'zai-coding',
  label: 'Z.AI Coding Plan',
  baseUrl: 'https://api.z.ai/api/coding/paas/v4',
  beforeRequest: zaiBeforeRequest,
};

export const ZAI_API_PRESET: ProviderPreset = {
  id: 'zai-api',
  label: 'Z.AI API',
  baseUrl: 'https://api.z.ai/api/paas/v4',
  beforeRequest: zaiBeforeRequest,
};
