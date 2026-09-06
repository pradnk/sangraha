'use client';

import { useEffect, useState } from 'react';
import { CloudUpload } from 'lucide-react';
import { m } from '@/lib/messages';
import { startQueueDraining, subscribeToQueue, type QueuedSubmission } from '@/lib/submission-queue';

/**
 * "2 waiting to send" — and nothing at all when there is nothing waiting.
 *
 * An earlier version showed a permanent "Everything is sent" reassurance. That
 * was wrong twice over: it reported on a send queue the worker does not know
 * exists, and because it was always there it carried no information. A status
 * that never changes is furniture, not feedback.
 *
 * The confirmation screen after each submission is what tells a worker their
 * record saved. This exists only for the exception — something is held on the
 * device because the network was unavailable — so it appears only then.
 */
export function QueueIndicator({ locale }: { locale: string }) {
  const [queue, setQueue] = useState<QueuedSubmission[]>([]);

  // Draining is started regardless of whether anything renders: the queue has
  // to keep retrying even while it is empty of *visible* items.
  useEffect(() => {
    const unsubscribe = subscribeToQueue(setQueue);
    const stopDraining = startQueueDraining();
    return () => {
      unsubscribe();
      stopDraining();
    };
  }, []);

  if (queue.length === 0) return null;

  return (
    <span
      role="status"
      className="flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-field-sm font-medium text-amber-900"
    >
      <CloudUpload aria-hidden className="h-5 w-5" />
      {m(locale, 'waitingToSend', { count: queue.length })}
    </span>
  );
}
