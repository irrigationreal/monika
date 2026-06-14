/**
 * Email Service for Codex Forum
 * Handles sending emails via SMTP using nodemailer
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import {
  getVerificationEmailTemplate,
  getWelcomeEmailTemplate
} from './emailTemplates';

/**
 * Email configuration loaded from environment variables
 */
export interface EmailConfig {
  host: string | null;
  port: number;
  secure: boolean;
  user: string | null;
  pass: string | null;
  from: string;
}

/**
 * Interface for the email service
 */
export interface IEmailService {
  /**
   * Send a verification email to a newly registered user
   */
  sendVerificationEmail(to: string, verifyUrl: string, displayName: string): Promise<boolean>;

  /**
   * Send a welcome email after successful verification
   */
  sendWelcomeEmail(to: string, displayName: string): Promise<boolean>;

  /**
   * Check if the email service is configured and ready
   */
  isConfigured(): boolean;
}

/**
 * Load email configuration from environment variables
 */
export function loadEmailConfig(): EmailConfig {
  const host = process.env['SMTP_HOST'] ?? null;
  const port = parseInt(process.env['SMTP_PORT'] ?? '587', 10);
  const secure = process.env['SMTP_SECURE'] === 'true' || port === 465;
  const user = process.env['SMTP_USER'] ?? null;
  const pass = process.env['SMTP_PASS'] ?? null;
  const from = process.env['SMTP_FROM'] ?? 'noreply@codex-forum.local';

  return { host, port, secure, user, pass, from };
}

/**
 * Email service implementation using nodemailer
 */
export class EmailService implements IEmailService {
  private transporter: Transporter | null = null;
  private config: EmailConfig;
  private configured: boolean;

  constructor(config?: EmailConfig) {
    this.config = config ?? loadEmailConfig();
    this.configured = this.initializeTransporter();
  }

  /**
   * Initialize the nodemailer transporter if SMTP is configured
   */
  private initializeTransporter(): boolean {
    const { host, port, secure, user, pass } = this.config;

    // Check if SMTP is configured
    if (!host) {
      console.log('[EmailService] SMTP not configured - emails will be logged to console');
      return false;
    }

    try {
      const transportOptions: nodemailer.TransportOptions = {
        host,
        port,
        secure,
        auth: user && pass ? { user, pass } : undefined
      } as nodemailer.TransportOptions;

      this.transporter = nodemailer.createTransport(transportOptions);
      console.log(`[EmailService] SMTP configured with host: ${host}:${port}`);
      return true;
    } catch (error) {
      console.error('[EmailService] Failed to initialize SMTP transport:', error);
      return false;
    }
  }

  /**
   * Check if the email service is configured and ready
   */
  isConfigured(): boolean {
    return this.configured;
  }

  /**
   * Send an email, falling back to console logging if SMTP is not configured
   */
  private async sendEmail(to: string, subject: string, html: string, text: string): Promise<boolean> {
    const { from } = this.config;

    if (!this.transporter) {
      // Log to console as fallback
      console.log('============================================');
      console.log('[EmailService] Email (console fallback):');
      console.log(`  To: ${to}`);
      console.log(`  From: ${from}`);
      console.log(`  Subject: ${subject}`);
      console.log('  --- Plain Text Content ---');
      console.log(text);
      console.log('============================================');
      return true;
    }

    try {
      const info = await this.transporter.sendMail({
        from,
        to,
        subject,
        text,
        html
      });

      console.log(`[EmailService] Email sent successfully: ${info.messageId}`);
      return true;
    } catch (error) {
      console.error('[EmailService] Failed to send email:', error);
      return false;
    }
  }

  /**
   * Send a verification email to a newly registered user
   */
  async sendVerificationEmail(to: string, verifyUrl: string, displayName: string): Promise<boolean> {
    const { html, text, subject } = getVerificationEmailTemplate({
      displayName,
      verifyUrl
    });

    console.log(`[EmailService] Sending verification email to: ${to}`);
    return this.sendEmail(to, subject, html, text);
  }

  /**
   * Send a welcome email after successful verification
   */
  async sendWelcomeEmail(to: string, displayName: string): Promise<boolean> {
    const { html, text, subject } = getWelcomeEmailTemplate({
      displayName
    });

    console.log(`[EmailService] Sending welcome email to: ${to}`);
    return this.sendEmail(to, subject, html, text);
  }

  /**
   * Verify the SMTP connection (useful for health checks)
   */
  async verifyConnection(): Promise<boolean> {
    if (!this.transporter) {
      return false;
    }

    try {
      await this.transporter.verify();
      console.log('[EmailService] SMTP connection verified');
      return true;
    } catch (error) {
      console.error('[EmailService] SMTP connection verification failed:', error);
      return false;
    }
  }
}

/**
 * Create a singleton email service instance
 */
let emailServiceInstance: EmailService | null = null;

export function getEmailService(config?: EmailConfig): EmailService {
  if (!emailServiceInstance) {
    emailServiceInstance = new EmailService(config);
  }
  return emailServiceInstance;
}

/**
 * Reset the email service instance (useful for testing)
 */
export function resetEmailService(): void {
  emailServiceInstance = null;
}
