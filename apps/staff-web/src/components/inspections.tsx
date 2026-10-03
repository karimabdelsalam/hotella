'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, cx, ImageIcon } from '@hotella/ui';
import { Header } from './header';
import { useRouter } from '../i18n/navigation';
import { permissionsAt, usePropertiesWith } from '../lib/access';
import { useStaffBrand } from '../lib/brand';
import { ApiError, useSession } from '../lib/session';
import type {
  ChecklistItem,
  InspectionDetail,
  InspectionSummary,
  InspectionTemplate,
  RoomRow,
  Severity,
} from '../lib/types';

const SEVERITY_TONE: Record<Severity, 'neutral' | 'info' | 'warning' | 'danger'> = {
  INFO: 'neutral',
  MINOR: 'info',
  MAJOR: 'warning',
  CRITICAL: 'danger',
};
const card = 'rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5';
const choice = (on: boolean) =>
  cx(
    'min-w-16 rounded-xl px-3 py-2.5 text-sm font-semibold ring-1 transition',
    on
      ? 'bg-brand text-white ring-transparent'
      : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50',
  );

/**
 * Inspections for staff (Spec §11, BUILD_PLAN 9.1): start a published checklist on a room, answer item by item on a
 * phone (every answer is saved at once), complete it and see the findings — critical ones already have urgent work.
 * The result is computed by the platform's rules, never typed in. Logical properties only, so it mirrors in Arabic.
 */
export function InspectionsApp() {
  const t = useTranslations('staff.insp');
  const tStaff = useTranslations('staff');
  const format = useFormatter();
  const session = useSession();
  const router = useRouter();
  const { me, properties, propertyId, setPropertyId, failed } =
    usePropertiesWith('inspection.read');
  const { show: showBrand } = useStaffBrand();
  const [list, setList] = useState<InspectionSummary[]>([]);
  const [templates, setTemplates] = useState<InspectionTemplate[]>([]);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [start, setStart] = useState({ templateId: '', locationId: '' });
  const [open, setOpen] = useState<InspectionDetail | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (session.state === 'anonymous') router.replace('/login');
  }, [session.state, router]);
  useEffect(() => showBrand(propertyId), [propertyId, showBrand]);
  const fail = useCallback(
    (e: unknown) => setError(e instanceof ApiError && e.detail ? e.detail : tStaff('inbox.error')),
    [tStaff],
  );
  useEffect(() => {
    if (failed) fail(failed);
  }, [failed, fail]);
  const canPerform = useMemo(
    () => (me && propertyId ? permissionsAt(me, propertyId).has('inspection.perform') : false),
    [me, propertyId],
  );

  const base = propertyId ? `/properties/${propertyId}` : null;
  const load = useCallback(async () => {
    if (!base) return;
    const [inspections, all, roomRows] = await Promise.all([
      session.api<InspectionSummary[]>(`${base}/inspections`),
      session.api<InspectionTemplate[]>('/inspection/templates'),
      session.api<RoomRow[]>(`${base}/rooms`),
    ]);
    setList(inspections);
    setTemplates(all.filter((x) => x.publishedVersionNo !== null));
    setRooms(roomRows);
  }, [session, base]);
  useEffect(() => {
    load().catch(fail);
  }, [load, fail]);

  const openInspection = useCallback(
    async (id: string) => {
      if (!base) return;
      const detail = await session.api<InspectionDetail>(`${base}/inspections/${id}`);
      // Typed values not yet saved survive a refresh of the same inspection.
      setOpen((current) => {
        if (current?.id !== id) setDraft({});
        return detail;
      });
    },
    [session, base],
  );

  async function run(action: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (done) setNotice(done);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  const answered = useMemo(
    () => new Map(open?.answers.map((a) => [a.itemCode, a.answer.value]) ?? []),
    [open],
  );
  const save = (item: ChecklistItem, value: unknown) =>
    run(async () => {
      await session.api(`${base}/inspections/${open!.id}/answers`, {
        method: 'PUT',
        body: { itemCode: item.code, answer: { kind: item.rule.kind, value } },
      });
      await openInspection(open!.id);
    });
  const photo = (item: ChecklistItem, file: File | undefined) =>
    file &&
    run(async () => {
      const { key } = await session.api<{ key: string }>(`${base}/inspections/${open!.id}/photos`, {
        method: 'POST',
        file,
      });
      const previous = (answered.get(item.code) as string[] | undefined) ?? [];
      await session.api(`${base}/inspections/${open!.id}/answers`, {
        method: 'PUT',
        body: { itemCode: item.code, answer: { kind: 'PHOTO', value: [...previous, key] } },
      });
      await openInspection(open!.id);
    });

  const control = (item: ChecklistItem) => {
    const value = answered.get(item.code);
    const editable = canPerform && open?.status === 'IN_PROGRESS';
    const buttons = (opts: ReadonlyArray<readonly [unknown, string]>) => (
      <div className="flex flex-wrap gap-2" role="group" aria-label={item.label}>
        {opts.map(([v, label]) => (
          <button
            key={String(v)}
            type="button"
            disabled={!editable || busy}
            aria-pressed={value === v}
            className={choice(value === v)}
            onClick={() => void save(item, v)}
          >
            {label}
          </button>
        ))}
      </div>
    );
    switch (item.rule.kind) {
      case 'PASS_FAIL':
        return buttons([
          ['PASS', t('pass')],
          ['FAIL', t('fail')],
        ]);
      case 'YES_NO':
        return buttons([
          ['YES', t('yes')],
          ['NO', t('no')],
        ]);
      case 'SCORE':
        return buttons(
          Array.from(
            { length: (item.rule.scaleMax ?? 5) + 1 },
            (_, n) => [n, String(n)] as const,
          ).slice(1),
        );
      case 'MULTI_SELECT': {
        const chosen = (value as string[] | undefined) ?? [];
        return (
          <div className="flex flex-wrap gap-2" role="group" aria-label={item.label}>
            {(item.rule.options ?? []).map((o) => {
              const on = chosen.includes(o);
              return (
                <button
                  key={o}
                  type="button"
                  disabled={!editable || busy}
                  aria-pressed={on}
                  className={choice(on)}
                  onClick={() =>
                    void save(item, on ? chosen.filter((x) => x !== o) : [...chosen, o])
                  }
                >
                  {item.optionLabels[o] ?? o}
                </button>
              );
            })}
          </div>
        );
      }
      case 'NUMBER':
      case 'TEXT': {
        const current = draft[item.code] ?? (value === undefined ? '' : String(value));
        return (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!current.trim()) return;
              void save(item, item.rule.kind === 'NUMBER' ? Number(current) : current.trim());
            }}
          >
            <input
              aria-label={item.label}
              type={item.rule.kind === 'NUMBER' ? 'number' : 'text'}
              step="any"
              dir={item.rule.kind === 'NUMBER' ? 'ltr' : 'auto'}
              disabled={!editable}
              className="min-w-0 flex-1 rounded-xl border border-slate-300 px-3 py-2 text-base text-start"
              value={current}
              onChange={(e) => setDraft({ ...draft, [item.code]: e.target.value })}
            />
            {editable && (
              <Button type="submit" variant="secondary" disabled={busy || !current.trim()}>
                {t('save')}
              </Button>
            )}
          </form>
        );
      }
      case 'PHOTO': {
        const keys = (value as string[] | undefined) ?? [];
        return (
          <div className="flex flex-wrap items-center gap-2">
            {keys.map((k) => (
              <img
                key={k}
                src={`/hotella${base}/inspections/${open!.id}/photos/${k.split('/').at(-1)}`}
                alt=""
                className="size-16 rounded-lg object-cover ring-1 ring-slate-900/10"
              />
            ))}
            {editable && (
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold ring-1 ring-slate-300 hover:bg-slate-50">
                <ImageIcon className="size-4" />
                {t('add_photo')}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  capture="environment"
                  className="sr-only"
                  data-testid={`photo-${item.code}`}
                  onChange={(e) => {
                    void photo(item, e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </label>
            )}
          </div>
        );
      }
    }
  };

  if (session.state !== 'signed-in') return <Header />;
  return (
    <>
      <Header />
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5 text-sm">
        <h1 className="text-base font-bold">{t('title')}</h1>
        {properties && properties.length > 1 && (
          <select
            aria-label={tStaff('inbox.property')}
            className="rounded-full border border-slate-300 bg-white px-3 py-1"
            value={propertyId ?? ''}
            onChange={(e) => {
              setPropertyId(e.target.value);
              setOpen(null);
            }}
          >
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && (
        <p role="alert" className="bg-red-50 px-4 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="bg-emerald-50 px-4 py-2 text-sm text-emerald-800">
          {notice}
        </p>
      )}
      {properties && properties.length === 0 ? (
        <p className="p-6 text-sm text-slate-600">{t('no_property')}</p>
      ) : (
        <main className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
          <section className="flex flex-col gap-3" aria-labelledby="list-title">
            {canPerform && (
              <form
                aria-label={t('start')}
                className={cx(card, 'flex flex-col gap-2')}
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const created = await session.api<{ id: string }>(`${base}/inspections`, {
                      method: 'POST',
                      body: start,
                    });
                    await load();
                    await openInspection(created.id);
                  });
                }}
              >
                <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
                  {t('checklist')}
                  <select
                    className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                    value={start.templateId}
                    onChange={(e) => setStart({ ...start, templateId: e.target.value })}
                  >
                    <option value="">{t('choose')}</option>
                    {templates.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
                  {t('room')}
                  <select
                    className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                    value={start.locationId}
                    onChange={(e) => setStart({ ...start, locationId: e.target.value })}
                  >
                    <option value="">{t('choose')}</option>
                    {rooms.map((r) => (
                      <option key={r.locationId} value={r.locationId}>
                        {r.roomNumber}
                      </option>
                    ))}
                  </select>
                </label>
                <div>
                  <Button type="submit" disabled={busy || !start.templateId || !start.locationId}>
                    {t('start')}
                  </Button>
                </div>
              </form>
            )}
            <h2 id="list-title" className="px-1 text-sm font-bold text-slate-500">
              {t('recent')}
            </h2>
            {list.length === 0 && <p className={cx(card, 'text-sm text-slate-500')}>{t('none')}</p>}
            <ul className="flex flex-col gap-2">
              {list.map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    data-inspection={i.number}
                    aria-pressed={open?.id === i.id}
                    onClick={() => void openInspection(i.id).catch(fail)}
                    className={cx(
                      card,
                      'flex w-full flex-wrap items-center gap-2 text-start',
                      open?.id === i.id && 'ring-2 ring-[var(--brand-primary,#0f4c81)]',
                    )}
                  >
                    <span className="font-bold">#{i.number}</span>
                    <span className="text-sm">{i.templateName}</span>
                    {i.roomNumber && (
                      <span className="bg-brand-soft text-brand rounded-full px-2 py-0.5 text-xs font-bold">
                        {t('room_n', { room: i.roomNumber })}
                      </span>
                    )}
                    <span className="ms-auto">
                      {i.status === 'COMPLETED' ? (
                        <Badge tone={i.result === 'PASS' ? 'success' : 'danger'}>
                          {t(`result.${i.result}`)} · {i.score}%
                        </Badge>
                      ) : (
                        <Badge tone="neutral">{t(`status.${i.status}`)}</Badge>
                      )}
                    </span>
                    <span className="w-full text-xs text-slate-500">
                      {format.dateTime(new Date(i.startedAt), {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section className="flex flex-col gap-3 self-start" aria-labelledby="run-title">
            {!open ? (
              <p id="run-title" className={cx(card, 'text-sm text-slate-500')}>
                {t('pick')}
              </p>
            ) : (
              <>
                <div className={cx(card, 'flex flex-wrap items-center gap-2')}>
                  <h2 id="run-title" className="text-lg font-bold">
                    {t('inspection_title', { number: open.number, name: open.templateName ?? '' })}
                  </h2>
                  {open.roomNumber && (
                    <span className="bg-brand-soft text-brand rounded-full px-2.5 py-0.5 text-sm font-bold">
                      {t('room_n', { room: open.roomNumber })}
                    </span>
                  )}
                  {open.status === 'COMPLETED' && (
                    <span className="ms-auto" data-testid="result">
                      <Badge tone={open.result === 'PASS' ? 'success' : 'danger'}>
                        {t(`result.${open.result}`)} · {open.score}%
                      </Badge>
                    </span>
                  )}
                </div>
                {open.checklist.sections.map((s) => (
                  <fieldset key={s.id} className={cx(card, 'flex flex-col gap-4')}>
                    <legend className="sr-only">{s.title}</legend>
                    <h3 className="text-sm font-bold text-slate-500" aria-hidden>
                      {s.title}
                    </h3>
                    {s.items.map((item) => (
                      <div key={item.id} className="flex flex-col gap-2" data-item={item.code}>
                        <p className="text-sm font-semibold">
                          {item.label}
                          {item.rule.required && (
                            <span className="text-red-600" aria-hidden>
                              {' '}
                              *
                            </span>
                          )}
                        </p>
                        {item.help && <p className="text-xs text-slate-500">{item.help}</p>}
                        {control(item)}
                      </div>
                    ))}
                  </fieldset>
                ))}
                {open.status === 'IN_PROGRESS' && canPerform && (
                  <div className="flex gap-2">
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await session.api(`${base}/inspections/${open.id}/complete`, {
                            method: 'POST',
                            body: {},
                          });
                          await Promise.all([load(), openInspection(open.id)]);
                        }, t('completed'))
                      }
                    >
                      {t('complete')}
                    </Button>
                  </div>
                )}
                {open.findings.length > 0 && (
                  <div className={cx(card, 'flex flex-col gap-2')} aria-labelledby="findings-title">
                    <h3 id="findings-title" className="font-bold">
                      {t('findings')}
                    </h3>
                    <ul className="flex flex-col divide-y divide-slate-100">
                      {open.findings.map((f) => {
                        const item = open.checklist.sections
                          .flatMap((s) => s.items)
                          .find((i) => i.code === f.itemCode);
                        return (
                          <li
                            key={f.id}
                            className="flex flex-wrap items-center gap-2 py-2 text-sm"
                            data-finding={f.itemCode}
                          >
                            <Badge tone={SEVERITY_TONE[f.severity]}>
                              {t(`severity.${f.severity}`)}
                            </Badge>
                            <span className="min-w-0 flex-1">{item?.label ?? f.itemCode}</span>
                            {f.status === 'LINKED' && (
                              <span className="text-xs text-slate-500">{t('work_opened')}</span>
                            )}
                            {f.status === 'OPEN' && canPerform && (
                              <Button
                                variant="secondary"
                                disabled={busy}
                                onClick={() =>
                                  void run(async () => {
                                    await session.api(`${base}/inspection-findings/${f.id}/work`, {
                                      method: 'POST',
                                      body: {},
                                    });
                                    await openInspection(open.id);
                                  }, t('work_created'))
                                }
                              >
                                {t('open_work')}
                              </Button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </>
            )}
          </section>
        </main>
      )}
    </>
  );
}
