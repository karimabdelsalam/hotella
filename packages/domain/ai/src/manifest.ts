import { defineManifest } from '@hotella/platform-manifest';

export const AI_MANIFEST = defineManifest({
  code: 'ai',
  schema: 'ai',
  description:
    'AI platform: the Model Gateway (providers, models, capability routing, egress policy, cost), tool registry, agents and execution audit.',
  permissions: [
    { code: 'ai.provider.manage', descriptionKey: 'ai.permission.provider_manage', risk: 'HIGH' },
    { code: 'ai.routing.manage', descriptionKey: 'ai.permission.routing_manage', risk: 'MEDIUM' },
    { code: 'ai.usage.read', descriptionKey: 'ai.permission.usage_read', risk: 'READ' },
  ],
  events: [],
  localeNamespaces: ['ai'],
});
