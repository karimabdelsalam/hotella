import {
  AiAgentReleased,
  AiEvaluationCompleted,
  AiInsightRaised,
  AiInsightStatusChanged,
} from '@hotella/contracts-events';
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
    { code: 'ai.evaluation.read', descriptionKey: 'ai.permission.evaluation_read', risk: 'READ' },
    {
      code: 'ai.evaluation.manage',
      descriptionKey: 'ai.permission.evaluation_manage',
      risk: 'MEDIUM',
    },
    { code: 'ai.agent.release', descriptionKey: 'ai.permission.agent_release', risk: 'HIGH' },
    { code: 'ai.twin.read', descriptionKey: 'ai.permission.twin_read', risk: 'READ' },
    { code: 'ai.insight.read', descriptionKey: 'ai.permission.insight_read', risk: 'READ' },
    { code: 'ai.insight.act', descriptionKey: 'ai.permission.insight_act', risk: 'LOW' },
    { code: 'ai.manager.use', descriptionKey: 'ai.permission.manager_use', risk: 'READ' },
    {
      code: 'ai.intelligence.cross_property',
      descriptionKey: 'ai.permission.intelligence_cross_property',
      risk: 'READ',
    },
  ],
  events: [
    AiEvaluationCompleted.name,
    AiAgentReleased.name,
    AiInsightRaised.name,
    AiInsightStatusChanged.name,
  ],
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
    // The Manager assistant's tools (BUILD_PLAN 12.5): read only.
    { code: 'intelligence.pulse', risk: 'READ', requiredPermission: 'ai.insight.read' },
    { code: 'intelligence.insights', risk: 'READ', requiredPermission: 'ai.insight.read' },
    { code: 'intelligence.twin', risk: 'READ', requiredPermission: 'ai.twin.read' },
    {
      code: 'intelligence.compare',
      risk: 'READ',
      requiredPermission: 'ai.intelligence.cross_property',
    },
    { code: 'agents.consult', risk: 'READ', requiredPermission: 'ai.insight.read' },
  ],
  entitlements: ['AI_GUEST', 'AI_ENGINEERING', 'AI_MANAGER', 'AI_INTELLIGENCE'],
  localeNamespaces: ['ai'],
});
