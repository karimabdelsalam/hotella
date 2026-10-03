import { defineManifest } from '@hotella/platform-manifest';

export const KNOWLEDGE_MANIFEST = defineManifest({
  code: 'knowledge',
  schema: 'knowledge',
  description:
    'Knowledge: scoped, versioned hotel documents with Arabic-aware keyword and vector retrieval traceable to document versions; the knowledge.search AI tool.',
  permissions: [
    { code: 'knowledge.read', descriptionKey: 'knowledge.permission.read', risk: 'READ' },
    { code: 'knowledge.manage', descriptionKey: 'knowledge.permission.manage', risk: 'MEDIUM' },
  ],
  events: [],
  aiTools: [{ code: 'knowledge.search', risk: 'READ', requiredPermission: 'knowledge.read' }],
  localeNamespaces: ['knowledge'],
});
