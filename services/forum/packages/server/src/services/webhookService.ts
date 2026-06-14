import { createHmac } from 'node:crypto';
import type { ForumStore } from '../store';

export interface WebhookPayload {
  event: string;
  timestamp: string;
  data: unknown;
}

export class WebhookService {
  constructor(private readonly store: ForumStore) {}

  /**
   * Dispatch an event to all registered webhooks for that event type.
   * Fire and forget - does not block on webhook delivery.
   * Includes basic retry logic (1 retry on failure).
   */
  dispatch(eventType: string, data: unknown): void {
    const webhooks = this.store.listWebhooksForEvent(eventType);

    if (webhooks.length === 0) {
      return;
    }

    const payload: WebhookPayload = {
      event: eventType,
      timestamp: new Date().toISOString(),
      data
    };

    const payloadStr = JSON.stringify(payload);

    for (const webhook of webhooks) {
      // Fire and forget - don't await
      this.sendWebhook(webhook.url, webhook.secret, payloadStr).catch(() => {
        // Ignore errors - fire and forget
      });
    }
  }

  /**
   * Send a webhook request with HMAC-SHA256 signature.
   * Retries once on failure.
   */
  private async sendWebhook(url: string, secret: string, payload: string, isRetry = false): Promise<void> {
    const signature = this.signPayload(payload, secret);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
          'User-Agent': 'CodexForum-Webhook/1.0'
        },
        body: payload,
        signal: AbortSignal.timeout(10000) // 10 second timeout
      });

      if (!response.ok && !isRetry) {
        // Retry once on non-2xx response
        await this.delay(1000);
        await this.sendWebhook(url, secret, payload, true);
      }
    } catch (error) {
      if (!isRetry) {
        // Retry once on network error
        await this.delay(1000);
        await this.sendWebhook(url, secret, payload, true);
      }
      // On retry failure, silently fail (fire and forget)
    }
  }

  /**
   * Sign a payload with HMAC-SHA256 using the webhook secret.
   */
  private signPayload(payload: string, secret: string): string {
    const hmac = createHmac('sha256', secret);
    hmac.update(payload);
    return `sha256=${hmac.digest('hex')}`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
