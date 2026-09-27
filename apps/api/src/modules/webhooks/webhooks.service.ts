import { createHash } from 'node:crypto';

import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { outgoingWebhookFailuresTotal } from '@remnaray/metrics';
import { z } from 'zod';

import { Infrastructure } from '../../infra/infra.module';
import { SettingsService } from '../settings/settings.service';
import { outgoingEventSchema, signature, type OutgoingEventBody } from './outgoing';

type Recipient = { url: string; secret: string; events: string[]; enabled: boolean };

/**
 * A delivery names its recipient by `recipientKey(url)`: the URL belongs to the
 * secret `webhooks.outgoing` setting and often carries a token, so it is not
 * copied into `outbox_jobs` or the BullMQ job. `url` is what jobs queued
 * before R84 carry.
 */
const deliverSchema = z.union([
  z.object({ event: outgoingEventSchema, recipient: z.string().regex(/^[0-9a-f]{16}$/u) }),
  z.object({ event: outgoingEventSchema, url: z.url() }),
]);

/** Section 9.8: 10 s per attempt. */
const DELIVERY_TIMEOUT_MS = 10_000;

/** Section 9.8 outgoing webhooks: fan-out and delivery. */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly infra: Infrastructure,
    private readonly settings: SettingsService,
  ) {}

  /**
   * One `webhooks.deliver` per recipient subscribed to the event, so a
   * recipient that fails is retried alone. The job id makes a repeated
   * dispatch of one event a duplicate BullMQ ignores.
   */
  async dispatch(body: unknown): Promise<{ recipients: number }> {
    const event = outgoingEventSchema.parse(body);
    const recipients = (await this.recipients()).filter((recipient) =>
      subscribed(recipient, event),
    );
    await this.infra.db.$transaction(async (tx) => {
      for (const recipient of recipients)
        await tx.outboxJob.create({
          data: {
            queue: 'webhooks',
            name: 'webhooks.deliver',
            payload: { event, recipient: recipientKey(recipient.url) } as never,
            jobId: `webhook:${event.id}:${recipientKey(recipient.url)}`,
          },
        });
    });
    return { recipients: recipients.length };
  }

  /**
   * One attempt. The recipient is read from the settings on every attempt, so
   * a changed secret signs the retry and a removed or unsubscribed recipient
   * is not called again. Anything but a 2xx answer fails the job, and BullMQ
   * retries it on the section 9.8 schedule.
   */
  async deliver(body: unknown): Promise<{ status: 'delivered' | 'skipped' }> {
    const delivery = deliverSchema.parse(body);
    const { event } = delivery;
    const key = 'recipient' in delivery ? delivery.recipient : recipientKey(delivery.url);
    const recipient = (await this.recipients()).find(
      (candidate) => recipientKey(candidate.url) === key && subscribed(candidate, event),
    );
    if (!recipient) return { status: 'skipped' };
    const { url } = recipient;
    const payload = JSON.stringify(event);
    let failure: string;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'RemnaRay-Webhook',
          'X-RemnaRay-Signature': signature(payload, recipient.secret),
          'X-RemnaRay-Event': event.type,
          'X-RemnaRay-Delivery': event.id,
        },
        body: payload,
        // A redirect is not a delivery, and following one would send the
        // signed body wherever the recipient pointed.
        redirect: 'manual',
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (response.status >= 200 && response.status < 300) return { status: 'delivered' };
      failure = `HTTP ${String(response.status)}`;
    } catch (error) {
      failure = error instanceof Error ? error.name : 'error';
    }
    outgoingWebhookFailuresTotal.inc();
    this.logger.warn(
      `outgoing webhook ${event.type} ${event.id} to ${new URL(url).host} failed: ${failure}`,
    );
    throw new BadGatewayException('WEBHOOK_DELIVERY_FAILED');
  }

  private async recipients(): Promise<Recipient[]> {
    return (await this.settings.get('webhooks.outgoing')) as Recipient[];
  }
}

function subscribed(recipient: Recipient, event: OutgoingEventBody): boolean {
  return recipient.enabled && recipient.events.includes(event.type);
}

export function recipientKey(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}
