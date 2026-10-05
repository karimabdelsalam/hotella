import { createHmac } from 'node:crypto';
import {
  MAX_TELEMETRY_SAMPLES,
  TELEMETRY_BATCH_MESSAGE,
  type TelemetrySample,
} from '@hotella/contracts-connectors';

/** One simulated point: its external code and its value at each minute of the scenario. */
export interface SimPoint {
  readonly code: string;
  readonly valueAt: (minute: number) => number;
}

/**
 * The BMS face of the simulator (BUILD_PLAN 13.2): a small plant room whose values follow a deterministic curve,
 * sent as Planova Telemetry Profile v1 batches through the signed webhook ingress (Connector SDK v2). The default
 * scenario is the acceptance story: a chiller's supply temperature climbs past its limit, stays there, then recovers.
 */
export const CHILLER_SCENARIO: readonly SimPoint[] = [
  {
    code: 'CH-1.SUPPLY_T',
    // 6.5 °C, climbing from minute 5 to 10.5 °C at minute 9, back to 6.5 °C from minute 14.
    valueAt: (m) => (m < 5 ? 6.5 : m < 9 ? 6.5 + (m - 4) : m < 12 ? 10.5 : m < 14 ? 8.5 : 6.5),
  },
  { code: 'CH-1.POWER_KW', valueAt: (m) => (m < 5 || m >= 14 ? 42 : 55) },
  { code: 'AHU-2.RH', valueAt: (m) => 48 + (m % 3) },
];

/** Samples of the scenario's minutes `[from, to)`, one per point and minute, stamped from `start`. */
export function samplesBetween(
  points: readonly SimPoint[],
  start: Date,
  from: number,
  to: number,
): TelemetrySample[] {
  const out: TelemetrySample[] = [];
  for (let m = from; m < to; m++)
    for (const p of points)
      out.push({
        point: p.code,
        value: p.valueAt(m),
        at: new Date(start.getTime() + m * 60_000 + 5_000).toISOString(),
      });
  return out;
}

/** The ingress body: the samples as `TELEMETRY_BATCH` messages of at most the profile's size. */
export function inboundBody(samples: readonly TelemetrySample[], idPrefix: string): string {
  const messages = [];
  for (let i = 0; i < samples.length; i += MAX_TELEMETRY_SAMPLES)
    messages.push({
      message_type: TELEMETRY_BATCH_MESSAGE,
      source_message_id: `${idPrefix}-${i / MAX_TELEMETRY_SAMPLES}`,
      payload: { samples: samples.slice(i, i + MAX_TELEMETRY_SAMPLES) },
    });
  return JSON.stringify({ messages });
}

/** `X-Hotella-Signature` over the exact body: `t=<unix>,v1=HMAC-SHA256(secret, "t.body")`. */
export function inboundSignature(secret: string, body: string, now = new Date()): string {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/** Posts one signed batch to `<api>/integrations/inbound/<endpointId>`; returns the per-message results. */
export async function postInbound(
  apiBaseUrl: string,
  endpointId: string,
  secret: string,
  body: string,
): Promise<unknown> {
  const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/integrations/inbound/${endpointId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hotella-signature': inboundSignature(secret, body),
    },
    body,
  });
  if (!res.ok) throw new Error(`inbound endpoint answered ${res.status}`);
  return res.json();
}
