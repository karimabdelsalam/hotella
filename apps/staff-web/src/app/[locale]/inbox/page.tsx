import { InboxApp } from '../../../components/inbox';
import { webConfig } from '../../../lib/config';

/** The realtime URL is configuration of the server, handed to the client at render (not baked into the bundle). */
export default function InboxPage() {
  return <InboxApp realtimeUrl={webConfig().realtimeUrl} />;
}

export const dynamic = 'force-dynamic';
