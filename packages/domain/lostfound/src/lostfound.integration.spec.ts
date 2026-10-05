import { sql } from 'drizzle-orm';
import type { EventEnvelope } from '@hotella/contracts-events';
import { newId } from '@hotella/platform-database';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { AttributesService } from './application/attributes.service';
import { VisionService } from './application/vision.service';
import { LOSTFOUND_API, type LostFoundPublicApi } from './public';
import {
  ADMIN,
  createHotel,
  ENTITLED,
  GATEWAY,
  type Hotel,
  type LostFoundHarness,
  OBJECTS,
  staff,
  startLostFoundApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();
/** A real 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe.skipIf(needsInfra())(`Lost & Found (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const attendantId = newId();
  const deskId = newId();
  let h: LostFoundHarness;
  let hotel: Hotel;
  let other: Hotel;
  let foundId: string;
  const attendant = () => staff(attendantId, hotel.tenantId);
  const desk = () => staff(deskId, hotel.tenantId);
  const base = () => `/properties/${hotel.propertyId}/lostfound`;
  const outbox = async (type: string) =>
    (
      (
        await h.db.execute(
          sql`select envelope from platform.outbox where tenant_id = ${hotel.tenantId} and event_type = ${type} order by id`,
        )
      ).rows as Array<{ envelope: EventEnvelope }>
    ).map((r) => r.envelope.payload as Record<string, unknown>);
  const register = (body: object, actor = desk()) =>
    h.http().post(`${base()}/items`).set('X-Test-Actor', actor).send(body);
  const item = async (id: string) =>
    (await h.http().get(`${base()}/items/${id}`).set('X-Test-Actor', desk()).expect(200)).body;
  const cause = (e: Error & { cause?: Error }) => e.cause?.message ?? e.message;

  beforeAll(async () => {
    h = await startLostFoundApp(url, 'hotella_app_lostfound', {
      [gmId]: [
        'org.property.read',
        'org.property.manage',
        'org.location.manage',
        'lostfound.read',
        'lostfound.register',
        'lostfound.manage',
        'lostfound.release',
      ],
      [attendantId]: ['lostfound.register'],
      [deskId]: ['lostfound.read', 'lostfound.register', 'lostfound.manage', 'lostfound.release'],
    });
    hotel = await createHotel(h, `lf-a-${stamp}`, gmId);
    other = await createHotel(h, `lf-b-${stamp}`, gmId);
  });
  afterAll(() => h?.app.close());

  it('an attendant hands in a found phone; the guest’s lost report is matched by rules with reasons', async () => {
    const found = await register(
      {
        kind: 'FOUND',
        category: 'PHONE',
        colour: 'BLACK',
        brand: 'Samsung',
        description: 'Black Samsung phone under the bed, cracked corner',
        locationId: hotel.roomId,
      },
      attendant(),
    ).expect(201);
    foundId = found.body.id;
    expect(found.body).toMatchObject({
      number: 1,
      kind: 'FOUND',
      status: 'REGISTERED',
      valuable: true,
      reportedByType: 'USER',
    });
    expect(found.body.retentionUntil).toBe(
      new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10),
    );
    // Recording a guest's loss is the desk's job, not the attendant's.
    await register(
      { kind: 'LOST', category: 'PHONE', description: 'My phone' },
      attendant(),
    ).expect(403);

    const lost = await register({
      kind: 'LOST',
      category: 'PHONE',
      colour: 'BLACK',
      brand: 'samsung',
      description: 'Guest lost a black Samsung, probably in the room',
      stayId: hotel.stayId,
      occurredAt: daysAgo(1),
    }).expect(201);
    // No place given: the guest's room is assumed.
    expect(lost.body).toMatchObject({
      number: 2,
      locationId: hotel.roomId,
      guestId: hotel.guestId,
      retentionUntil: null,
    });

    const matches = await h.http().get(`${base()}/matches`).set('X-Test-Actor', desk()).expect(200);
    expect(matches.body).toEqual([
      expect.objectContaining({
        foundItemId: foundId,
        lostItemId: lost.body.id,
        score: 100,
        reasons: ['CATEGORY', 'COLOUR', 'BRAND', 'LOCATION', 'DATE_CLOSE'],
        status: 'PROPOSED',
        found: expect.objectContaining({ number: 1, roomNumber: '504' }),
      }),
    ]);

    // A second, vaguer report of the same phone is also proposed; confirming one rejects the other.
    const vague = await register({
      kind: 'LOST',
      category: 'PHONE',
      colour: 'BLACK',
      description: 'A phone left behind',
      occurredAt: daysAgo(1),
    }).expect(201);
    const proposals = (
      await h.http().get(`${base()}/matches`).set('X-Test-Actor', desk()).expect(200)
    ).body as Array<{ id: string; lostItemId: string; version: number }>;
    expect(proposals).toHaveLength(2);
    const best = proposals.find((p) => p.lostItemId === lost.body.id)!;
    await h
      .http()
      .post(`${base()}/matches/${best.id}/confirm`)
      .set('X-Test-Actor', attendant())
      .send({ version: 1 })
      .expect(403);
    await h
      .http()
      .post(`${base()}/matches/${best.id}/confirm`)
      .set('X-Test-Actor', desk())
      .send({ version: 1 })
      .expect(200);
    const detail = await item(foundId);
    expect(detail.status).toBe('MATCHED');
    expect(
      detail.matches.map((m: { lostItemId: string; status: string }) => [m.lostItemId, m.status]),
    ).toEqual(
      expect.arrayContaining([
        [lost.body.id, 'CONFIRMED'],
        [vague.body.id, 'REJECTED'],
      ]),
    );
    expect((await item(lost.body.id)).status).toBe('MATCHED');
    expect((await item(vague.body.id)).status).toBe('REGISTERED');
  });

  it('photos are stored with the item and served only to readers', async () => {
    const added = await h
      .http()
      .post(`${base()}/items/${foundId}/photos`)
      .set('X-Test-Actor', attendant())
      .set('content-type', 'image/png')
      .send(PNG)
      .expect(201);
    expect(OBJECTS.has(`lostfound/${hotel.tenantId}/${foundId}/${added.body.name}`)).toBe(true);
    await h
      .http()
      .post(`${base()}/items/${foundId}/photos`)
      .set('X-Test-Actor', attendant())
      .set('content-type', 'text/plain')
      .send(Buffer.from('not an image'))
      .expect(415);
    const served = await h
      .http()
      .get(`${base()}/items/${foundId}/photos/${added.body.name}`)
      .set('X-Test-Actor', desk())
      .expect(200);
    expect(served.headers['content-type']).toBe('image/png');
    await h
      .http()
      .get(`${base()}/items/${foundId}/photos/${added.body.name}`)
      .set('X-Test-Actor', attendant())
      .expect(403);
  });

  it('releases a found item only against a claim; the guest’s report is settled and the record cannot change', async () => {
    const detail = await item(foundId);
    const lostId = detail.matches.find((m: { status: string }) => m.status === 'CONFIRMED')
      .lostItemId as string;
    await h
      .http()
      .post(`${base()}/items/${foundId}/release`)
      .set('X-Test-Actor', desk())
      .send({ version: detail.version, claimantName: 'M', idDocument: 'PASSPORT' })
      .expect(400);
    const released = await h
      .http()
      .post(`${base()}/items/${foundId}/release`)
      .set('X-Test-Actor', desk())
      .send({
        version: detail.version,
        claimantName: 'Mona Delta',
        stayId: hotel.stayId,
        idDocument: 'PASSPORT',
        verificationNote:
          'Unlocked the phone in front of the desk; passport name matches the stay.',
      })
      .expect(200);
    expect(released.body.item).toMatchObject({ status: 'RELEASED' });
    expect(released.body.claim).toMatchObject({
      claimantGuestId: hotel.guestId,
      handover: 'IN_PERSON',
      idDocument: 'PASSPORT',
    });
    expect((await item(lostId)).status).toBe('CLAIMED');
    expect(await outbox('lostfound.item.released')).toEqual([
      expect.objectContaining({ item_id: foundId, lost_item_id: lostId, handover: 'IN_PERSON' }),
    ]);
    await h
      .http()
      .post(`${base()}/items/${foundId}/release`)
      .set('X-Test-Actor', desk())
      .send({
        version: released.body.item.version,
        claimantName: 'Someone else',
        idDocument: 'OTHER',
        verificationNote: 'again',
      })
      .expect(409);

    const claimEdit = await h.db
      .execute(sql`update lostfound.claims set claimant_name = 'x' where item_id = ${foundId}`)
      .then(() => null, cause);
    expect(claimEdit).toMatch(/append-only/);
    const descriptionEdit = await h.db
      .execute(sql`update lostfound.items set description = 'changed' where id = ${foundId}`)
      .then(() => null, cause);
    expect(descriptionEdit).toMatch(/never overwritten/);
    const history = (await item(foundId)).history.map((e: { event: string }) => e.event);
    expect(history).toEqual(['REGISTERED', 'MATCHED', 'PHOTO', 'RELEASED']);
  });

  it('AI attributes from the description are kept apart and can bring a match the rules alone missed', async () => {
    const lost = await register({
      kind: 'LOST',
      category: 'GLASSES',
      colour: 'BROWN',
      brand: 'Ray-Ban',
      description: 'Brown Ray-Ban sunglasses',
      occurredAt: daysAgo(5),
    }).expect(201);
    const found = await register(
      {
        kind: 'FOUND',
        category: 'GLASSES',
        description: 'Sunglasses by the pool, brown frame, says RayBan on the arm',
        placeNote: 'Pool bar',
      },
      attendant(),
    ).expect(201);
    const before = (await item(found.body.id)).matches;
    expect(before).toEqual([]);

    const attributes = h.app.get(AttributesService);
    GATEWAY.fail = true;
    expect(await attributes.derive(hotel.tenantId, found.body.id)).toBe('FAILED');
    GATEWAY.fail = false;
    GATEWAY.answer = JSON.stringify({
      object_type: 'sunglasses',
      colours: ['BROWN'],
      brand: 'RayBan',
      keywords: ['brown frame'],
    });
    expect(await attributes.derive(hotel.tenantId, found.body.id)).toBe('DERIVED');
    expect(await attributes.derive(hotel.tenantId, found.body.id)).toBe('SKIPPED');
    expect(GATEWAY.calls.at(-1)).toMatchObject({ capability: 'STRUCTURED_OUTPUT' });

    const detail = await item(found.body.id);
    expect(detail.description).toBe('Sunglasses by the pool, brown frame, says RayBan on the arm');
    expect(detail.colour).toBeNull();
    expect(detail.ai).toEqual({
      objectType: 'sunglasses',
      colours: ['BROWN'],
      brand: 'RayBan',
      keywords: ['brown frame'],
    });
    expect(detail.matches).toEqual([
      expect.objectContaining({
        lostItemId: lost.body.id,
        score: 60,
        reasons: ['CATEGORY', 'COLOUR_AI', 'BRAND_AI'],
        status: 'PROPOSED',
      }),
    ]);
  });

  it('photos are read by a vision model only when the property and the licence allow it, without metadata (9.5)', async () => {
    const vision = h.app.get(VisionService);
    const lost = await register({
      kind: 'LOST',
      category: 'GLASSES',
      colour: 'BLACK',
      brand: 'Oakley',
      description: 'Black Oakley sports sunglasses',
      occurredAt: daysAgo(5),
    }).expect(201);
    const found = await register(
      {
        kind: 'FOUND',
        category: 'GLASSES',
        description: 'Sunglasses on a sunbed',
        placeNote: 'Beach',
      },
      attendant(),
    ).expect(201);
    // A phone photo carrying its owner's name and the place in its metadata.
    const photo = await sharp({
      create: { width: 2400, height: 1800, channels: 3, background: { r: 10, g: 10, b: 10 } },
    })
      .withExif({
        IFD0: { Artist: 'Giulia Rossi' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '30/1 2/1 44/1' },
      })
      .jpeg()
      .toBuffer();
    const upload = async (itemId: string) =>
      (
        await h
          .http()
          .post(`${base()}/items/${itemId}/photos`)
          .set('X-Test-Actor', attendant())
          .set('content-type', 'image/jpeg')
          .send(photo)
          .expect(201)
      ).body.name as string;
    const name = await upload(found.body.id);
    expect(await outbox('lostfound.item.photo_added')).toContainEqual({
      item_id: found.body.id,
      kind: 'FOUND',
      photo: name,
    });

    // Off by default: nothing is sent.
    GATEWAY.calls.length = 0;
    GATEWAY.answer = JSON.stringify({
      object_type: 'sunglasses',
      category: 'GLASSES',
      description: 'Black wraparound sports sunglasses with mirrored lenses.',
      colours: ['BLACK'],
      material: 'plastic',
      brand: 'Oakley',
      keywords: ['mirrored lenses', 'wraparound'],
    });
    expect(await vision.read(hotel.tenantId, found.body.id, name)).toBe('SKIPPED');
    await h
      .http()
      .put('/config/values/lostfound.ai.vision')
      .set('X-Test-Actor', ADMIN)
      .send({
        scope: 'PROPERTY',
        tenantId: hotel.tenantId,
        propertyId: hotel.propertyId,
        value: true,
      })
      .expect(200);
    // Turned on, but the hotel's licence does not include AI vision.
    expect(await vision.read(hotel.tenantId, found.body.id, name)).toBe('SKIPPED');
    expect(GATEWAY.calls).toEqual([]);

    ENTITLED.add(`${hotel.tenantId}:AI_VISION`);
    GATEWAY.fail = true;
    expect(await vision.read(hotel.tenantId, found.body.id, name)).toBe('FAILED');
    GATEWAY.fail = false;
    expect(await vision.read(hotel.tenantId, found.body.id, name)).toBe('READ');
    expect(await vision.read(hotel.tenantId, found.body.id, name)).toBe('SKIPPED');

    // What left the platform: a fixed instruction and the re-encoded photo, nothing about the guest, room or staff.
    const call = GATEWAY.calls.at(-1)!;
    expect(call).toMatchObject({ capability: 'VISION', agentCode: 'LOSTFOUND_VISION' });
    const [message] = call.messages as Array<{
      content: string;
      dataClass: string;
      images: Array<{ mediaType: string; data: Uint8Array; dataClass: string }>;
    }>;
    expect(message!.content).toBe(
      'Describe the object in this photo for the lost-and-found register.',
    );
    expect(JSON.stringify(call.system)).not.toContain('Beach');
    expect(JSON.stringify(call.system)).not.toContain('sunbed');
    const [image] = message!.images;
    expect(image).toMatchObject({ mediaType: 'image/jpeg', dataClass: 'SENSITIVE' });
    const sent = Buffer.from(image!.data);
    expect(sent.includes('Giulia Rossi')).toBe(false);
    const meta = await sharp(sent).metadata();
    expect(meta.exif).toBeUndefined();
    expect(Math.max(meta.width!, meta.height!)).toBe(1568);

    // Suggestions stand apart from the staff's words and bring the match the rules alone missed.
    const detail = await item(found.body.id);
    expect(detail.description).toBe('Sunglasses on a sunbed');
    expect(detail.colour).toBeNull();
    expect(detail.vision).toEqual([
      expect.objectContaining({
        photo: name,
        objectType: 'sunglasses',
        category: 'GLASSES',
        colours: ['BLACK'],
        material: 'plastic',
        brand: 'Oakley',
      }),
    ]);
    expect(detail.matches).toEqual([
      expect.objectContaining({
        lostItemId: lost.body.id,
        reasons: ['CATEGORY', 'COLOUR_AI', 'BRAND_AI'],
        status: 'PROPOSED',
      }),
    ]);

    // The same sunglasses handed in again at the beach bar: the desk sees a possible duplicate.
    const again = await register(
      { kind: 'FOUND', category: 'GLASSES', description: 'Sunglasses at the beach bar' },
      attendant(),
    ).expect(201);
    const second = await upload(again.body.id);
    expect(await vision.read(hotel.tenantId, again.body.id, second)).toBe('READ');
    expect((await item(found.body.id)).possibleDuplicates).toEqual([
      expect.objectContaining({
        score: 80,
        reasons: ['OBJECT_TYPE', 'COLOUR', 'BRAND'],
        item: expect.objectContaining({ id: again.body.id }),
      }),
    ]);

    // A guest's own photo of what they lost is never sent.
    const lostPhoto = await upload(lost.body.id);
    expect(await vision.read(hotel.tenantId, lost.body.id, lostPhoto)).toBe('SKIPPED');

    // The desk confirms the first pair; the other proposal for the same report is rejected with it.
    const proposal = (await item(found.body.id)).matches[0] as { id: string; version: number };
    await h
      .http()
      .post(`${base()}/matches/${proposal.id}/confirm`)
      .set('X-Test-Actor', desk())
      .send({ version: proposal.version })
      .expect(200);
  });

  it('an unclaimed item is disposed of only after its retention date, by an explicit audited action', async () => {
    const umbrella = await register(
      { kind: 'FOUND', category: 'OTHER', description: 'Blue umbrella in the lobby' },
      attendant(),
    ).expect(201);
    const dispose = (version: number) =>
      h
        .http()
        .post(`${base()}/items/${umbrella.body.id}/dispose`)
        .set('X-Test-Actor', desk())
        .send({ version, method: 'DONATED', note: 'Unclaimed after retention; donated.' });
    await dispose(1).expect(409);
    await h.db.execute(
      sql`update lostfound.items set retention_until = current_date - 1 where id = ${umbrella.body.id}`,
    );
    const due = await h
      .http()
      .get(`${base()}/items?due=true`)
      .set('X-Test-Actor', desk())
      .expect(200);
    expect(due.body.map((i: { id: string }) => i.id)).toEqual([umbrella.body.id]);
    expect(due.body[0].retentionDue).toBe(true);
    const counts = await h.app
      .get<LostFoundPublicApi>(LOSTFOUND_API)
      .openCounts(hotel.tenantId, hotel.propertyId);
    expect(counts).toMatchObject({ retentionDue: 1, proposedMatches: 1 });

    const disposed = await dispose(1).expect(200);
    expect(disposed.body).toMatchObject({ status: 'DISPOSED', disposalMethod: 'DONATED' });
    expect(await outbox('lostfound.item.disposed')).toEqual([
      expect.objectContaining({ item_id: umbrella.body.id, method: 'DONATED' }),
    ]);
    const audit = await h.db.execute(
      sql`select action, reason from audit.audit_log where entity_id = ${umbrella.body.id} order by id`,
    );
    expect(audit.rows).toEqual([
      { action: 'lostfound.item.register_found', reason: null },
      { action: 'lostfound.item.dispose', reason: 'Unclaimed after retention; donated.' },
    ]);
  });

  it('isolates tenants: another tenant’s items are not found, and RLS hides them', async () => {
    const foreign = staff(gmId, other.tenantId);
    await h
      .http()
      .get(`/properties/${other.propertyId}/lostfound/items/${foundId}`)
      .set('X-Test-Actor', foreign)
      .expect(404);
    await h
      .http()
      .post(`/properties/${other.propertyId}/lostfound/items/${foundId}/dispose`)
      .set('X-Test-Actor', foreign)
      .send({ version: 1, method: 'DESTROYED', note: 'probe' })
      .expect(404);
    const rows = await h.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${other.tenantId}, true)`);
      return (
        await tx.execute(
          sql`select count(*)::int as n from lostfound.items where tenant_id = ${hotel.tenantId}`,
        )
      ).rows;
    });
    expect(rows).toEqual([{ n: 0 }]);
  });
});
