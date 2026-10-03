import { Inject, Injectable, Optional } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { SecretResolver } from '@hotella/platform-secrets';

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

/** Delivery channel for e-mail (Spec §25: intent ≠ channel). Swappable for a provider adapter or a test double. */
export interface EmailChannel {
  /** False when no transport is configured: e-mail deliveries are recorded as skipped. */
  readonly configured: boolean;
  send(message: EmailMessage): Promise<{ readonly providerRef: string | null }>;
}
export const EMAIL_CHANNEL = Symbol.for('hotella.ops.email-channel');

/** SMTP through nodemailer (Mailpit locally); the password is a SecretRef (CLAUDE.md rule 13). */
@Injectable()
export class SmtpEmailChannel implements EmailChannel {
  private transport: Promise<Transporter> | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    // Explicit token: see AgentKeys (a nullable type would emit `Object` as metadata).
    @Optional() @Inject(SecretResolver) private readonly secrets?: SecretResolver,
  ) {}

  get configured(): boolean {
    return this.config.notifications.smtp !== null;
  }

  async send(message: EmailMessage): Promise<{ providerRef: string | null }> {
    const info = (await (this.transport ??= this.open())).sendMail({
      from: this.config.notifications.emailFrom,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    const sent = await info;
    return { providerRef: typeof sent.messageId === 'string' ? sent.messageId : null };
  }

  private async open(): Promise<Transporter> {
    const smtp = this.config.notifications.smtp;
    if (!smtp) throw new Error('E-mail is not configured (NOTIFY_SMTP_HOST)');
    const pass =
      smtp.passwordRef && this.secrets ? await this.secrets.resolve(smtp.passwordRef) : undefined;
    return createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      ...(smtp.user ? { auth: { user: smtp.user, pass } } : {}),
    });
  }
}
