import { escapeHtml } from "../escape-html";

interface AccountLockedEmailProps {
  name: string;
  lockMinutes: number;
  attempts: number;
}

export function renderAccountLockedEmail({
  name,
  lockMinutes,
  attempts,
}: AccountLockedEmailProps): string {
  return `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h1 style="color: #ef4444;">Account temporarily locked</h1>
      <p>Hi ${escapeHtml(name)},</p>
      <p>Your account has been temporarily locked after ${String(attempts)} failed login attempts.</p>
      <p>You can try again in <strong>${String(lockMinutes)} minutes</strong>.</p>
      <p>If this wasn't you, please reset your password immediately.</p>
      <p style="color: #737373; font-size: 14px;">This is an automated security notification from Yavio.</p>
    </div>
  `;
}
