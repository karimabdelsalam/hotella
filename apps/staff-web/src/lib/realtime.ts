'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Inbox notices over the realtime gateway (BUILD_PLAN §8.9, notes for 4.4): authenticate with the access token in the
 * first frame, subscribe to the property, call `onNotice` for every change. Reconnects with backoff.
 */
export function useInboxRealtime(
  url: string,
  propertyId: string | null,
  token: () => string | null,
  onNotice: (conversationId: string) => void,
): boolean {
  const [live, setLive] = useState(false);
  const notice = useRef(onNotice);
  notice.current = onNotice;

  useEffect(() => {
    if (!propertyId) return;
    let socket: WebSocket | null = null;
    let stopped = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      const access = token();
      if (!access) {
        retry = setTimeout(connect, 1000);
        return;
      }
      socket = new WebSocket(url);
      socket.onopen = () => socket?.send(JSON.stringify({ type: 'auth', token: access }));
      socket.onmessage = (e) => {
        const frame = JSON.parse(String(e.data)) as { type: string; conversationId?: string };
        if (frame.type === 'ready') socket?.send(JSON.stringify({ type: 'subscribe', propertyId }));
        else if (frame.type === 'subscribed') {
          attempt = 0;
          setLive(true);
        } else if (frame.type === 'event' && frame.conversationId)
          notice.current(frame.conversationId);
      };
      socket.onclose = () => {
        setLive(false);
        if (stopped) return;
        attempt += 1;
        retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [url, propertyId, token]);

  return live;
}
