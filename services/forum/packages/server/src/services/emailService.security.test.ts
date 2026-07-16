/**
 * EmailService compatibility and security regression tests
 *
 * Validates that the EmailService SMTP send path and no-SMTP fallback
 * remain functional after the nodemailer major upgrade, and that only
 * ordinary text/html message fields are used (no raw, file-path, or URL
 * message features that could be abused).
 *
 * Uses nodemailer.createTransport('jsonTransport') as a safe local
 * transport that captures the fully-built message as JSON without
 * network access. Falls back to stream transport if jsonTransport
 * is unavailable.
 */
import nodemailer from 'nodemailer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EmailService, loadEmailConfig, resetEmailService } from './emailService';

import type { EmailConfig } from './emailService';

describe('EmailService compatibility', () => {
  afterEach(() => {
    resetEmailService();
  });

  describe('no-SMTP fallback', () => {
    it('logs to console and returns true when SMTP is not configured', async () => {
      const config: EmailConfig = {
        host: null,
        port: 587,
        secure: false,
        user: null,
        pass: null,
        from: 'test@example.com',
      };

      const svc = new EmailService(config);
      expect(svc.isConfigured()).toBe(false);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const result = await svc.sendVerificationEmail(
          'user@example.com',
          'https://example.com/verify?token=abc',
          'TestUser'
        );
        expect(result).toBe(true);
        // Should have logged the email content
        const joined = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(joined).toContain('user@example.com');
        expect(joined).toContain('console fallback');
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('sends welcome email via console fallback', async () => {
      const config: EmailConfig = {
        host: null,
        port: 587,
        secure: false,
        user: null,
        pass: null,
        from: 'test@example.com',
      };

      const svc = new EmailService(config);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const result = await svc.sendWelcomeEmail('user@example.com', 'TestUser');
        expect(result).toBe(true);
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });

  describe('SMTP transport path', () => {
    it('sendMail uses only safe message fields (from, to, subject, text, html)', async () => {
      // Use a jsonTransport to capture the exact message nodemailer builds
      // without making any network connection.
      const transport = nodemailer.createTransport({ jsonTransport: true } as any);
      const sendMailSpy = vi.spyOn(transport, 'sendMail');

      // Construct an EmailService with SMTP configured, then replace the
      // internal transporter with our json transport.
      const config: EmailConfig = {
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        user: 'user',
        pass: 'pass',
        from: 'noreply@example.com',
      };

      const createTransportSpy = vi.spyOn(nodemailer, 'createTransport');
      const svc = new EmailService(config);
      expect(createTransportSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          disableFileAccess: true,
          disableUrlAccess: true,
        })
      );
      createTransportSpy.mockRestore();

      // Replace the real SMTP transport with the local JSON transport.
      (svc as any).transporter = transport;

      const result = await svc.sendVerificationEmail(
        'recipient@example.com',
        'https://example.com/verify?token=abc123',
        'TestRecipient'
      );
      expect(result).toBe(true);

      // Verify the sendMail call used only safe fields
      expect(sendMailSpy).toHaveBeenCalledTimes(1);
      const mailOptions = sendMailSpy.mock.calls[0]![0];

      // Must have the basic safe fields
      expect(mailOptions).toHaveProperty('from');
      expect(mailOptions).toHaveProperty('to', 'recipient@example.com');
      expect(mailOptions).toHaveProperty('subject');
      expect(mailOptions).toHaveProperty('text');
      expect(mailOptions).toHaveProperty('html');

      // Must NOT contain dangerous fields that could trigger file/URL access
      expect(mailOptions).not.toHaveProperty('raw');
      expect(mailOptions).not.toHaveProperty('path');
      expect(mailOptions).not.toHaveProperty('href');
      expect(mailOptions).not.toHaveProperty('content');

      sendMailSpy.mockRestore();
    });

    it('handles sendMail failure gracefully', async () => {
      const transport = nodemailer.createTransport({ jsonTransport: true } as any);
      vi.spyOn(transport, 'sendMail').mockRejectedValueOnce(new Error('SMTP fail'));

      const config: EmailConfig = {
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        user: 'user',
        pass: 'pass',
        from: 'noreply@example.com',
      };

      const svc = new EmailService(config);
      (svc as any).transporter = transport;

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await svc.sendVerificationEmail(
          'recipient@example.com',
          'https://example.com/verify',
          'TestUser'
        );
        expect(result).toBe(false);
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });

  describe('loadEmailConfig', () => {
    it('returns null host when SMTP_HOST is not set', () => {
      const original = process.env['SMTP_HOST'];
      delete process.env['SMTP_HOST'];
      try {
        const config = loadEmailConfig();
        expect(config.host).toBeNull();
      } finally {
        if (original !== undefined) process.env['SMTP_HOST'] = original;
      }
    });

    it('defaults to port 587 and non-secure', () => {
      const origHost = process.env['SMTP_HOST'];
      const origPort = process.env['SMTP_PORT'];
      const origSecure = process.env['SMTP_SECURE'];
      delete process.env['SMTP_HOST'];
      delete process.env['SMTP_PORT'];
      delete process.env['SMTP_SECURE'];
      try {
        const config = loadEmailConfig();
        expect(config.port).toBe(587);
        expect(config.secure).toBe(false);
      } finally {
        if (origHost !== undefined) process.env['SMTP_HOST'] = origHost;
        if (origPort !== undefined) process.env['SMTP_PORT'] = origPort;
        if (origSecure !== undefined) process.env['SMTP_SECURE'] = origSecure;
      }
    });

    it('enables secure when port is 465', () => {
      const origPort = process.env['SMTP_PORT'];
      const origSecure = process.env['SMTP_SECURE'];
      process.env['SMTP_PORT'] = '465';
      delete process.env['SMTP_SECURE'];
      try {
        const config = loadEmailConfig();
        expect(config.secure).toBe(true);
      } finally {
        if (origPort !== undefined) process.env['SMTP_PORT'] = origPort;
        else delete process.env['SMTP_PORT'];
        if (origSecure !== undefined) process.env['SMTP_SECURE'] = origSecure;
      }
    });
  });
});
