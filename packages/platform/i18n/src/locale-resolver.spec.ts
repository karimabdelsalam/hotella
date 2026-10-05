import 'reflect-metadata';
import { Controller, Get, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@hotella/platform-config';
import { ObservabilityModule } from '@hotella/platform-observability';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { I18nModule } from './i18n.module';
import {
  CurrentLocale,
  LOCALE_PREFERENCE_PROVIDER,
  type LocalePreferenceProvider,
} from './locale-resolver';

@Controller('t')
class TController {
  constructor(private readonly locale: CurrentLocale) {}
  @Get()
  read(): { locale: string; requested: string | null; text: string } {
    return {
      locale: this.locale.get(),
      requested: this.locale.requested(),
      text: this.locale.t('common.items', { count: 2 }),
    };
  }
}
const prefs: LocalePreferenceProvider = {
  actorPreference: (req) => (req.headers['x-test-pref'] as string | undefined) ?? null,
  propertyDefault: (req) => (req.headers['x-test-property'] as string | undefined) ?? null,
};
@Module({ controllers: [TController] })
class TModule {}

const env = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://x:x@127.0.0.1:1/x',
  VALKEY_URL: 'redis://127.0.0.1:1',
};

describe('LocaleResolver chain (Spec §79.3)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ env }),
        ObservabilityModule.forRoot(),
        I18nModule.forRoot({
          preferences: { provide: LOCALE_PREFERENCE_PROVIDER, useValue: prefs },
        }),
        TModule,
      ],
    }).compile();
    app = ref.createNestApplication({ logger: false });
    await app.init();
  });
  afterAll(() => app.close());

  it('explicit ?lang= wins over everything and sets Content-Language', async () => {
    const res = await request(app.getHttpServer())
      .get('/t?lang=ar')
      .set('Accept-Language', 'en')
      .set('x-test-pref', 'en')
      .expect(200);
    expect(res.headers['content-language']).toBe('ar');
    expect(res.body).toEqual({ locale: 'ar', requested: 'ar', text: 'عنصران' });
  });
  it('actor preference beats Accept-Language, which beats property default, which beats platform default', async () => {
    expect(
      (
        await request(app.getHttpServer())
          .get('/t')
          .set('x-test-pref', 'ar')
          .set('Accept-Language', 'en')
      ).body.locale,
    ).toBe('ar');
    expect(
      (
        await request(app.getHttpServer())
          .get('/t')
          .set('Accept-Language', 'ar-EG,ar;q=0.9')
          .set('x-test-property', 'en')
      ).body.locale,
    ).toBe('ar');
    expect(
      (
        await request(app.getHttpServer())
          .get('/t')
          .set('Accept-Language', 'fr')
          .set('x-test-property', 'ar')
      ).body.locale,
    ).toBe('ar');
    expect(
      (await request(app.getHttpServer()).get('/t').set('Accept-Language', 'fr')).body.locale,
    ).toBe('en');
  });
  it('requested() is null when the locale is only a property or platform fallback', async () => {
    const detected = await request(app.getHttpServer()).get('/t').set('Accept-Language', 'ar');
    expect(detected.body.requested).toBe('ar');
    const property = await request(app.getHttpServer())
      .get('/t')
      .set('Accept-Language', 'fr')
      .set('x-test-property', 'ar');
    expect(property.body).toMatchObject({ locale: 'ar', requested: null });
    const fallback = await request(app.getHttpServer()).get('/t');
    expect(fallback.body).toMatchObject({ locale: 'en', requested: null });
  });
  it('ignores unsupported explicit choices', async () => {
    expect(
      (await request(app.getHttpServer()).get('/t?lang=fr').set('Accept-Language', 'ar')).body
        .locale,
    ).toBe('ar');
  });
});
