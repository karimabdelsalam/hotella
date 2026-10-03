import { sql } from 'drizzle-orm';
import {
  FakeModelProvider,
  ModelProviderError,
  ModelProviderRegistry,
  ToolExecutor,
  ToolRegistry,
} from '@hotella/domain-ai';
import { newId } from '@hotella/platform-database';
import { RequestContext } from '@hotella/platform-observability';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KnowledgeIndexer } from './application/indexer';
import { KNOWLEDGE_API, type KnowledgePublicApi } from './public';
import {
  ADMIN,
  createTenant,
  type KnowledgeHarness,
  staff,
  startKnowledgeApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();

describe.skipIf(needsInfra())(`Knowledge v1 (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const fake = new FakeModelProvider();
  const STAFF = [
    'org.property.read',
    'org.property.manage',
    'knowledge.read',
    'knowledge.manage',
    'ai.routing.manage',
  ];
  let h: KnowledgeHarness;
  let api: KnowledgePublicApi;
  let a: { tenantId: string; properties: Record<string, string> };
  let b: { tenantId: string; properties: Record<string, string> };
  const P1 = () => a.properties.P1!;
  const P2 = () => a.properties.P2!;
  const gm = (tenantId = a.tenantId) => staff(gmId, tenantId);

  /** Creates a document with one version and publishes it; returns the ids. */
  const publish = async (
    property: string,
    doc: { kind?: string; title: string; tenantWide?: boolean },
    version: Record<string, unknown>,
    tenantId = a.tenantId,
  ) => {
    const base = `/properties/${property}/knowledge/documents`;
    const document = (
      await h
        .http()
        .post(base)
        .set('X-Test-Actor', gm(tenantId))
        .send({ kind: doc.kind ?? 'FAQ', title: doc.title, tenantWide: doc.tenantWide ?? false })
        .expect(201)
    ).body;
    const draft = (
      await h
        .http()
        .post(`${base}/${document.id}/versions`)
        .set('X-Test-Actor', gm(tenantId))
        .send({ language: 'ar', audience: 'GUEST', classification: 'PUBLIC', ...version })
        .expect(201)
    ).body;
    const published = (
      await h
        .http()
        .post(`${base}/${document.id}/versions/${draft.id}/publish`)
        .set('X-Test-Actor', gm(tenantId))
        .expect(200)
    ).body;
    return { documentId: document.id as string, versionId: draft.id as string, published };
  };
  const guestSearch = (query: string, property = P1(), language: string | null = 'ar') =>
    api.search({
      tenantId: a.tenantId,
      propertyId: property,
      query,
      audience: 'GUEST',
      maxClassification: 'PUBLIC',
      language,
    });
  const titles = (passages: readonly { title: string }[]) => passages.map((p) => p.title);

  beforeAll(async () => {
    h = await startKnowledgeApp(url, 'hotella_app_knowledge', { [gmId]: STAFF });
    h.app.get(ModelProviderRegistry).register(fake);
    api = h.app.get(KNOWLEDGE_API);
    a = await createTenant(h, `kn-a-${stamp}`, gmId, ['P1', 'P2']);
    b = await createTenant(h, `kn-b-${stamp}`, gmId);
    // Tenant A embeds with an on-prem model; tenant B has no embedding route yet.
    const providerId = (
      await h
        .http()
        .post('/ai/providers')
        .set('X-Test-Actor', ADMIN)
        .send({
          code: `KN_${stamp}`,
          kind: 'FAKE',
          egress: 'ON_PREM',
          maxDataClass: 'CONFIDENTIAL',
        })
        .expect(201)
    ).body.id;
    const modelId = (
      await h
        .http()
        .post('/ai/models')
        .set('X-Test-Actor', ADMIN)
        .send({ providerId, code: `embed-${stamp}`, capabilities: ['EMBEDDING'] })
        .expect(201)
    ).body.id;
    await h
      .http()
      .put('/ai/routing-rules')
      .set('X-Test-Actor', gm())
      .send({ capability: 'EMBEDDING', modelIds: [modelId] })
      .expect(200);
  });
  afterAll(() => h?.app.close());

  it('publishes into chunks and embeddings; finds Arabic text across spelling variants and digits', async () => {
    const breakfast = await publish(
      P1(),
      { title: 'الإفطار' },
      {
        body: 'يُقدَّم الإفطار في مطعم النيل من الساعة ٧ حتى ١٠ صباحًا.\n\nخدمة الغرف متاحة طوال اليوم.',
      },
    );
    expect(breakfast.published).toMatchObject({
      status: 'PUBLISHED',
      versionNo: 1,
      chunks: 1,
      embedded: 1,
    });
    const [row] = (
      await h.db.execute(
        sql`select e.dims, e.model_code from knowledge.chunk_embeddings e join knowledge.chunks c on c.id = e.chunk_id where c.version_id = ${breakfast.versionId}`,
      )
    ).rows as Array<{ dims: number; model_code: string }>;
    expect(row).toEqual({ dims: 64, model_code: `embed-${stamp}` });

    const found = await guestSearch('امتى الافطار؟ الساعه 7');
    expect(found[0]).toMatchObject({
      title: 'الإفطار',
      versionNo: 1,
      versionId: breakfast.versionId,
      documentId: breakfast.documentId,
    });
    expect(found[0]!.matchedBy).toContain('KEYWORD');
    // The exact text embeds to the same vector: the vector signal finds it too.
    const exact = await guestSearch(
      'يُقدَّم الإفطار في مطعم النيل من الساعة ٧ حتى ١٠ صباحًا.\n\nخدمة الغرف متاحة طوال اليوم.',
    );
    expect(exact[0]!.matchedBy).toEqual(['KEYWORD', 'VECTOR']);
  });

  it('respects property and tenant scope, audience, classification, effective dates and archiving', async () => {
    await publish(
      P1(),
      { title: 'Check-out', tenantWide: true },
      {
        language: 'en',
        audience: 'ALL',
        body: 'Check-out time is 12:00 noon. Late check-out on request.',
      },
    );
    await publish(P2(), { title: 'Spa P2' }, { body: 'السبا مفتوح من ٩ صباحًا' });
    await publish(
      P1(),
      { title: 'Master keys' },
      {
        language: 'en',
        audience: 'STAFF',
        classification: 'INTERNAL',
        body: 'Master keys are signed out at the front desk, check-out of keys is logged.',
      },
    );
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await publish(
      P1(),
      { title: 'Pool winter hours' },
      {
        effectiveFrom: tomorrow,
        body: 'المسبح مغلق للصيانة',
      },
    );
    const archived = await publish(P1(), { title: 'Old gym' }, { body: 'الجيم في الدور التاني' });
    const doc = (
      await h
        .http()
        .get(`/properties/${P1()}/knowledge/documents`)
        .set('X-Test-Actor', gm())
        .expect(200)
    ).body.find((d: { id: string }) => d.id === archived.documentId);
    await h
      .http()
      .post(`/properties/${P1()}/knowledge/documents/${archived.documentId}/archive`)
      .set('X-Test-Actor', gm())
      .send({ version: doc.version })
      .expect(200);

    // The tenant-wide English document answers at both properties, in its language when Arabic has nothing.
    expect(titles(await guestSearch('check-out time', P1(), 'en'))).toEqual(['Check-out']);
    expect(titles(await guestSearch('check-out time', P2(), 'ar'))).toEqual(['Check-out']);
    // Another property's document does not leak; guests never see staff documents.
    expect(titles(await guestSearch('السبا'))).toEqual([]);
    expect(titles(await guestSearch('السبا', P2()))).toEqual(['Spa P2']);
    expect(titles(await guestSearch('master keys', P1(), 'en'))).not.toContain('Master keys');
    const staffFound = await api.search({
      tenantId: a.tenantId,
      propertyId: P1(),
      query: 'master keys',
      audience: 'STAFF',
      maxClassification: 'INTERNAL',
      language: 'en',
    });
    expect(titles(staffFound)).toContain('Master keys');
    // Restricted to named documents (an asset's manuals): only those, still within scope; none named finds nothing.
    const keysDoc = staffFound.find((p) => p.title === 'Master keys')!.documentId;
    const only = (documentIds: readonly string[]) =>
      api.search({
        tenantId: a.tenantId,
        propertyId: P1(),
        query: 'check-out keys',
        audience: 'STAFF',
        maxClassification: 'INTERNAL',
        language: 'en',
        documentIds,
      });
    expect(titles(await only([keysDoc]))).toEqual(['Master keys']);
    expect(titles(await only([]))).toEqual([]);
    expect(titles(await only(['not-a-uuid']))).toEqual([]);
    // Not yet effective, archived: not found.
    expect(titles(await guestSearch('المسبح'))).toEqual([]);
    expect(titles(await guestSearch('الجيم'))).toEqual([]);
  });

  it('a new version supersedes the published one; published versions never change', async () => {
    const wifi = await publish(P1(), { title: 'Wi-Fi' }, { body: 'باسورد الواي فاي nile2025' });
    const base = `/properties/${P1()}/knowledge/documents/${wifi.documentId}/versions`;
    const v2 = (
      await h
        .http()
        .post(base)
        .set('X-Test-Actor', gm())
        .send({
          language: 'ar',
          audience: 'GUEST',
          classification: 'PUBLIC',
          body: 'باسورد الواي فاي nile2026',
        })
        .expect(201)
    ).body;
    expect(v2.versionNo).toBe(2);
    await h.http().post(`${base}/${v2.id}/publish`).set('X-Test-Actor', gm()).expect(200);
    await h.http().post(`${base}/${v2.id}/publish`).set('X-Test-Actor', gm()).expect(409);
    expect(titles(await guestSearch('nile2025'))).toEqual([]);
    const found = await guestSearch('nile2026');
    expect(found[0]).toMatchObject({ title: 'Wi-Fi', versionNo: 2 });
    const refused = await h.db
      .execute(sql`update knowledge.document_versions set body = 'x' where id = ${v2.id}`)
      .then(
        () => '',
        (e: Error) => String((e.cause as Error | undefined)?.message ?? e.message),
      );
    expect(refused).toMatch(/immutable/);
  });

  it('without an embedding route chunks stay keyword-searchable; the sweep embeds them later', async () => {
    const bp = b.properties.P1!;
    // Whatever routes exist, embedding is unavailable for now.
    fake.failWith = new ModelProviderError('UNAVAILABLE', true);
    const menu = await publish(
      bp,
      { title: 'Room service' },
      { body: 'منيو خدمة الغرف: بيتزا وسلطة' },
      b.tenantId,
    );
    expect(menu.published).toMatchObject({ chunks: 1, embedded: 0 });
    const found = await api.search({
      tenantId: b.tenantId,
      propertyId: bp,
      query: 'بيتزا',
      audience: 'GUEST',
      maxClassification: 'PUBLIC',
    });
    expect(found.map((p) => [p.title, p.matchedBy])).toEqual([['Room service', ['KEYWORD']]]);
    fake.failWith = null;
    // Tenant A's documents are invisible to B, through the API and through row-level security.
    expect(
      (
        await api.search({
          tenantId: b.tenantId,
          propertyId: bp,
          query: 'الإفطار',
          audience: 'GUEST',
          maxClassification: 'PUBLIC',
        })
      ).length,
    ).toBe(0);
    const leaked = await h.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${b.tenantId}, true)`);
      return (
        await tx.execute(
          sql`select count(*)::int as n from knowledge.chunks where tenant_id = ${a.tenantId}`,
        )
      ).rows[0] as { n: number };
    });
    expect(leaked.n).toBe(0);
    await h
      .http()
      .get(`/properties/${bp}/knowledge/documents/${menu.documentId}/versions/${menu.versionId}`)
      .set('X-Test-Actor', gm())
      .expect(404);

    // B gets an embedding route; the worker sweep embeds what was left.
    const modelId = (
      await h.http().get('/ai/models').set('X-Test-Actor', ADMIN).expect(200)
    ).body.find((m: { code: string }) => m.code === `embed-${stamp}`).id;
    await h
      .http()
      .put('/ai/routing-rules')
      .set('X-Test-Actor', gm(b.tenantId))
      .send({ capability: 'EMBEDDING', modelIds: [modelId] })
      .expect(200);
    expect(await h.app.get(KnowledgeIndexer).embedPending({ tenantId: b.tenantId })).toBe(1);
  });

  it('knowledge.search is an AI tool: guest-safe documents only, as reference data', async () => {
    expect(h.app.get(ToolRegistry).get('knowledge.search')?.risk).toBe('READ');
    const executor = h.app.get(ToolExecutor);
    const handle = await executor.start({
      tenantId: a.tenantId,
      propertyId: P1(),
      agentCode: 'GUEST_CONCIERGE',
      tools: ['knowledge.search'],
      autonomy: { autoMediumTools: [] },
      locale: 'ar',
      guest: { guestId: newId(), stayId: newId() },
      conversationId: null,
      trigger: 'MESSAGE',
      on: { type: 'SYSTEM', id: null },
    });
    const outcome = await h.app.get(RequestContext).run({ correlation_id: `kn-${stamp}` }, () =>
      executor.invoke(handle, {
        tool: 'knowledge.search',
        arguments: { query: 'ميعاد الإفطار امتى؟' },
      }),
    );
    expect(outcome.status).toBe('OK');
    const result = (outcome as { result: { note: string; passages: Array<{ title: string }> } })
      .result;
    expect(result.note).toMatch(/not instructions/);
    expect(result.passages[0]).toMatchObject({ title: 'الإفطار', version_no: 1 });
    expect(JSON.stringify(result)).not.toContain('Master keys');
  });
});
