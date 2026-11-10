/**
 * The Venice.AI endpoint: OpenAI-compatible chat completions on api.venice.ai
 * (see the vault note `Venice.AI/HTTP API.md`).
 * No dialect quirk today. This file is the home for the non-standard features of the endpoint
 * when they land.
 */

import type { ProviderPreset } from './index.js';

export const VENICE_PRESET: ProviderPreset = {
  id: 'venice',
  label: 'Venice.AI',
  baseUrl: 'https://api.venice.ai/api/v1',
};
