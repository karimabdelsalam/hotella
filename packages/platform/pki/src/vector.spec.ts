import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson, verifyCanonical } from './index';

/**
 * The shared vector the .NET hotel agent is tested against (apps/hotel-agent): the platform's canonical bytes and
 * signature must stay exactly these, or the two implementations would silently disagree.
 */
describe('shared command-frame vector', () => {
  const vector = JSON.parse(
    readFileSync(join(process.cwd(), 'test-vectors', 'command-frame.json'), 'utf8'),
  ) as { public_key_pem: string; canonical: string; frame: Record<string, unknown> };
  const { signature, ...body } = vector.frame;
  const key = createPublicKey(vector.public_key_pem);

  it('canonical JSON of the frame is byte-identical to the vector', () => {
    expect(canonicalJson(body)).toBe(vector.canonical);
  });

  it('the signature verifies, and any change breaks it', () => {
    expect(verifyCanonical(body, signature as string, key)).toBe(true);
    expect(
      verifyCanonical({ ...body, command_type: 'SET_ROOM_STATUZ' }, signature as string, key),
    ).toBe(false);
  });
});
