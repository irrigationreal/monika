/**
 * Email Templates for Codex Forum
 * Provides HTML and plain text versions of all email templates
 */

export interface VerificationEmailData {
  displayName: string;
  verifyUrl: string;
}

export interface WelcomeEmailData {
  displayName: string;
}

/**
 * Generate verification email content
 */
export function getVerificationEmailTemplate(data: VerificationEmailData): { html: string; text: string; subject: string } {
  const { displayName, verifyUrl } = data;

  const subject = 'Verify your Codex Forum account';

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify your email</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f5f5f5;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);">
          <tr>
            <td style="padding: 40px 40px 20px;">
              <h1 style="margin: 0 0 20px; font-size: 24px; font-weight: 600; color: #1a1a1a;">
                Welcome to Codex Forum
              </h1>
              <p style="margin: 0 0 20px; font-size: 16px; line-height: 1.5; color: #4a4a4a;">
                Hi ${escapeHtml(displayName)},
              </p>
              <p style="margin: 0 0 20px; font-size: 16px; line-height: 1.5; color: #4a4a4a;">
                Thank you for registering! Please verify your email address by clicking the button below:
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding: 0 40px 30px;">
              <a href="${escapeHtml(verifyUrl)}" style="display: inline-block; padding: 14px 32px; background-color: #2563eb; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 500; border-radius: 6px;">
                Verify Email Address
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 40px 30px;">
              <p style="margin: 0 0 10px; font-size: 14px; line-height: 1.5; color: #6b6b6b;">
                Or copy and paste this link into your browser:
              </p>
              <p style="margin: 0; font-size: 14px; line-height: 1.5; color: #2563eb; word-break: break-all;">
                ${escapeHtml(verifyUrl)}
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 40px 40px;">
              <p style="margin: 0; font-size: 14px; line-height: 1.5; color: #6b6b6b;">
                This link will expire in 24 hours. If you did not create an account, you can safely ignore this email.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 40px; background-color: #f9fafb; border-radius: 0 0 8px 8px;">
              <p style="margin: 0; font-size: 12px; color: #9ca3af; text-align: center;">
                Codex Forum
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const text = `
Welcome to Codex Forum

Hi ${displayName},

Thank you for registering! Please verify your email address by clicking the link below:

${verifyUrl}

This link will expire in 24 hours. If you did not create an account, you can safely ignore this email.

---
Codex Forum
  `.trim();

  return { html, text, subject };
}

/**
 * Generate welcome email content (sent after verification)
 */
export function getWelcomeEmailTemplate(data: WelcomeEmailData): { html: string; text: string; subject: string } {
  const { displayName } = data;

  const subject = 'Welcome to Codex Forum!';

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to Codex Forum</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f5f5f5;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);">
          <tr>
            <td style="padding: 40px 40px 20px;">
              <h1 style="margin: 0 0 20px; font-size: 24px; font-weight: 600; color: #1a1a1a;">
                Welcome to Codex Forum!
              </h1>
              <p style="margin: 0 0 20px; font-size: 16px; line-height: 1.5; color: #4a4a4a;">
                Hi ${escapeHtml(displayName)},
              </p>
              <p style="margin: 0 0 20px; font-size: 16px; line-height: 1.5; color: #4a4a4a;">
                Your account has been verified and you're all set to start using Codex Forum.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 40px 30px;">
              <h2 style="margin: 0 0 15px; font-size: 18px; font-weight: 600; color: #1a1a1a;">
                Getting Started
              </h2>
              <ul style="margin: 0; padding: 0 0 0 20px; font-size: 16px; line-height: 1.8; color: #4a4a4a;">
                <li>Browse existing topics and discussions</li>
                <li>Create new topics to start conversations</li>
                <li>Reply to posts and engage with the community</li>
                <li>React to posts to show your support</li>
              </ul>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 40px 40px;">
              <p style="margin: 0; font-size: 16px; line-height: 1.5; color: #4a4a4a;">
                We're excited to have you as part of our community!
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 40px; background-color: #f9fafb; border-radius: 0 0 8px 8px;">
              <p style="margin: 0; font-size: 12px; color: #9ca3af; text-align: center;">
                Codex Forum
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const text = `
Welcome to Codex Forum!

Hi ${displayName},

Your account has been verified and you're all set to start using Codex Forum.

Getting Started:
- Browse existing topics and discussions
- Create new topics to start conversations
- Reply to posts and engage with the community
- React to posts to show your support

We're excited to have you as part of our community!

---
Codex Forum
  `.trim();

  return { html, text, subject };
}

/**
 * Escape HTML special characters to prevent XSS
 */
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
