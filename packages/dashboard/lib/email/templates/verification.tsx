import { escapeHtml } from "../escape-html";

interface VerificationEmailProps {
  name: string;
  verifyUrl: string;
}

export function renderVerificationEmail({ name, verifyUrl }: VerificationEmailProps): string {
  return `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h1 style="color: #0a0a0a;">Verify your email</h1>
      <p>Hi ${escapeHtml(name)},</p>
      <p>Please verify your email address by clicking the button below:</p>
      <a href="${escapeHtml(verifyUrl)}" style="display: inline-block; background: #0a0a0a; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; margin: 16px 0;">
        Verify Email
      </a>
      <p style="color: #737373; font-size: 14px;">This link expires in 24 hours.</p>
      <p style="color: #737373; font-size: 14px;">If you didn't create an account, you can ignore this email.</p>
    </div>
  `;
}
