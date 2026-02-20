import { escapeHtml } from "../escape-html";

interface PasswordResetEmailProps {
  name: string;
  resetUrl: string;
}

export function renderPasswordResetEmail({ name, resetUrl }: PasswordResetEmailProps): string {
  return `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h1 style="color: #0a0a0a;">Reset your password</h1>
      <p>Hi ${escapeHtml(name)},</p>
      <p>We received a request to reset your password. Click the button below to set a new password:</p>
      <a href="${escapeHtml(resetUrl)}" style="display: inline-block; background: #0a0a0a; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; margin: 16px 0;">
        Reset Password
      </a>
      <p style="color: #737373; font-size: 14px;">This link expires in 1 hour.</p>
      <p style="color: #737373; font-size: 14px;">If you didn't request this, you can ignore this email.</p>
    </div>
  `;
}
