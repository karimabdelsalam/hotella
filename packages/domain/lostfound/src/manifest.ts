import {
  LostFoundItemDisposed,
  LostFoundItemRegistered,
  LostFoundItemReleased,
} from '@hotella/contracts-events';
import { defineManifest } from '@hotella/platform-manifest';

export const LOSTFOUND_MANIFEST = defineManifest({
  code: 'lostfound',
  schema: 'lostfound',
  description:
    'Lost & Found: found items and lost reports with photos, rule-based matching (AI-derived attributes kept apart from the staff description), claims with audited release, retention and explicit disposal.',
  permissions: [
    { code: 'lostfound.read', descriptionKey: 'lostfound.permission.read', risk: 'READ' },
    { code: 'lostfound.register', descriptionKey: 'lostfound.permission.register', risk: 'LOW' },
    { code: 'lostfound.manage', descriptionKey: 'lostfound.permission.manage', risk: 'LOW' },
    { code: 'lostfound.release', descriptionKey: 'lostfound.permission.release', risk: 'MEDIUM' },
  ],
  events: [LostFoundItemRegistered.name, LostFoundItemReleased.name, LostFoundItemDisposed.name],
  entitlements: ['LOST_AND_FOUND'],
  localeNamespaces: ['lostfound'],
});
