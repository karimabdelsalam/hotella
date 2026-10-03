import 'server-only';
import { loadWebConfigFromEnv, type WebConfig } from '@hotella/platform-config/web';

let cached: WebConfig | null = null;

/** Server-side configuration of the guest web app (read once, validated by platform-config). */
export function webConfig(): WebConfig {
  cached ??= loadWebConfigFromEnv();
  return cached;
}
