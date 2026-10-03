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
    { code: 'ai.execution.read', descriptionKey: 'ai.permission.execution_read', risk: 'READ' },
  ],
  events: [],
  // Tools v1 (BUILD_PLAN 6.2): the risk decides autonomy; the permission is all an agent holds for the tool.
  aiTools: [
    { code: 'guest.get_current_stay', risk: 'READ', requiredPermission: 'stay.read' },
    { code: 'catalog.list_services', risk: 'READ', requiredPermission: 'catalog.read' },
    { code: 'operations.find_open_requests', risk: 'READ', requiredPermission: 'request.read' },
    {
      code: 'operations.create_service_request',
      risk: 'MEDIUM',
      requiredPermission: 'request.create',
    },
    {
      code: 'operations.cancel_service_request',
      risk: 'HIGH',
      requiredPermission: 'request.manage',
    },
    { code: 'communication.send_message', risk: 'LOW', requiredPermission: 'inbox.reply' },
  ],
  localeNamespaces: ['ai'],
});
