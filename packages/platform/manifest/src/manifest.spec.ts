import { z } from 'zod';
import { defineEvent } from '@hotella/contracts-events';
import { describe, expect, it } from 'vitest';
import { defineManifest } from './manifest';
import { PLATFORM_MANIFEST } from './platform.manifest';
import { ManifestRegistry } from './registry';

describe('ModuleManifest', () => {
  it('validates shape and codes at definition time', () => {
    expect(() => defineManifest({ code: 'Bad', schema: 'ops', description: 'x' })).toThrow();
    expect(() =>
      defineManifest({
        code: 'ops',
        schema: 'ops',
        description: 'x',
        permissions: [{ code: 'TaskAssign', descriptionKey: 'k' }],
      }),
    ).toThrow();
    expect(() =>
      defineManifest({ code: 'ops', schema: 'nope' as never, description: 'x' }),
    ).toThrow();
    const m = defineManifest({
      code: 'ops',
      schema: 'ops',
      description: 'x',
      permissions: [{ code: 'task.assign', descriptionKey: 'ops.permission.task_assign' }],
    });
    expect(m.permissions[0]!.risk).toBe('LOW');
  });

  it('platform manifest is valid against the event registry', () => {
    const r = new ManifestRegistry();
    r.register(PLATFORM_MANIFEST);
    expect(r.validate()).toEqual([]);
    expect(r.permissions().map((p) => p.code)).toContain('platform.feature_flag.manage');
  });

  it('flags duplicate permissions, unknown events, foreign events and undeclared events', () => {
    const Stray = defineEvent({
      type: 'opsx.task.assigned',
      version: 1,
      description: 'x',
      payload: z.object({}),
    });
    const r = new ManifestRegistry();
    r.register(PLATFORM_MANIFEST);
    r.register(
      defineManifest({
        code: 'opsx',
        schema: 'ops',
        description: 'x',
        permissions: [{ code: 'platform.feature_flag.read', descriptionKey: 'k' }],
        events: ['opsx.nope.happened.v1', 'platform.ping.requested.v1'],
      }),
    );
    const kinds = r
      .validate()
      .map((p) => p.kind)
      .sort();
    expect(kinds).toEqual([
      'DUPLICATE_PERMISSION',
      'EVENT_OWNERSHIP',
      'UNDECLARED_EVENT',
      'UNKNOWN_EVENT',
    ]);
    expect(() => r.register(PLATFORM_MANIFEST)).toThrow(/twice/);
    expect(() => r.assertValid()).toThrow(/invalid/);
    void Stray;
  });

  it('flags AI tools declared twice or requiring a permission no module declares', () => {
    const r = new ManifestRegistry();
    r.register(PLATFORM_MANIFEST);
    const tool = { code: 'x.do_it', risk: 'LOW' as const, requiredPermission: 'x.thing.do' };
    r.register(defineManifest({ code: 'xa', schema: 'ai', description: 'x', aiTools: [tool] }));
    r.register(defineManifest({ code: 'xb', schema: 'ai', description: 'x', aiTools: [tool] }));
    expect(
      r
        .validate()
        .map((p) => p.kind)
        .sort(),
    ).toEqual(['DUPLICATE_AI_TOOL', 'UNKNOWN_PERMISSION', 'UNKNOWN_PERMISSION']);
  });
});
