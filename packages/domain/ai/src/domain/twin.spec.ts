import { describe, expect, it } from 'vitest';
import { neighbourhood, type TwinEdge, type TwinRef } from './twin';

const r = (kind: TwinRef['kind'], id: string): TwinRef => ({ kind, id });
const at = new Date('2026-10-05T10:00:00Z');
const edge = (from: TwinRef, relation: TwinEdge['relation'], to: TwinRef): TwinEdge => ({
  from,
  relation,
  to,
  validFrom: at,
  validTo: null,
});

// guest ← stay → room ← work order → asset ; work order → work item → staff
const stay = r('STAY', 's1');
const graph: TwinEdge[] = [
  edge(stay, 'HAS_GUEST', r('GUEST', 'g1')),
  edge(stay, 'IN_ROOM', r('LOCATION', 'room504')),
  edge(r('WORK_ORDER', 'wo1'), 'AT', r('LOCATION', 'room504')),
  edge(r('WORK_ORDER', 'wo1'), 'ON_ASSET', r('ASSET', 'ac1')),
  edge(r('WORK_ORDER', 'wo1'), 'TRACKS', r('WORK_ITEM', 'w1')),
  edge(r('WORK_ITEM', 'w1'), 'ASSIGNED_TO', r('STAFF', 'u1')),
];
const key = (x: TwinRef) => `${x.kind}:${x.id}`;
const loader = (calls: string[][]) => async (refs: readonly TwinRef[]) => {
  calls.push(refs.map(key));
  const wanted = new Set(refs.map(key));
  return graph.filter((e) => wanted.has(key(e.from)) || wanted.has(key(e.to)));
};

describe('twin neighbourhood (BUILD_PLAN 12.3)', () => {
  it('walks both directions hop by hop, nearest first, and stops at the asked depth', async () => {
    const calls: string[][] = [];
    const one = await neighbourhood(stay, 1, loader(calls));
    expect(one.nodes.map((n) => `${n.distance}:${key(n)}`)).toEqual([
      '0:STAY:s1',
      '1:GUEST:g1',
      '1:LOCATION:room504',
    ]);
    const three = await neighbourhood(stay, 3, loader([]));
    expect(three.nodes.map((n) => `${n.distance}:${key(n)}`)).toEqual([
      '0:STAY:s1',
      '1:GUEST:g1',
      '1:LOCATION:room504',
      '2:WORK_ORDER:wo1',
      '3:ASSET:ac1',
      '3:WORK_ITEM:w1',
    ]);
    // The edge to the staff member is one hop further: neither it nor its node is in the answer.
    expect(three.edges.map((e) => e.relation).sort()).toEqual([
      'AT',
      'HAS_GUEST',
      'IN_ROOM',
      'ON_ASSET',
      'TRACKS',
    ]);
    expect(three.truncated).toBe(false);
    expect(calls).toEqual([['STAY:s1']]);
  });

  it('is deterministic whatever order the store answers in, and clamps the depth to 1–3', async () => {
    const reversed = async (refs: readonly TwinRef[]) => (await loader([])(refs)).reverse();
    expect(await neighbourhood(stay, 3, reversed)).toEqual(
      await neighbourhood(stay, 3, loader([])),
    );
    expect((await neighbourhood(stay, 9, loader([]))).nodes.at(-1)?.distance).toBe(3);
    expect((await neighbourhood(stay, 0, loader([]))).nodes.at(-1)?.distance).toBe(1);
  });
});
