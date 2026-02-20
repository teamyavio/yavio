import { escapeHtml } from "../escape-html";

interface InvitationEmailProps {
  workspaceName: string;
  inviterName: string;
  inviteUrl: string;
  role: string;
}

export function renderInvitationEmail({
  workspaceName,
  inviterName,
  inviteUrl,
  role,
}: InvitationEmailProps): string {
  return `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h1 style="color: #0a0a0a;">You've been invited</h1>
      <p>${escapeHtml(inviterName)} has invited you to join <strong>${escapeHtml(workspaceName)}</strong> as a <strong>${escapeHtml(role)}</strong>.</p>
      <a href="${escapeHtml(inviteUrl)}" style="display: inline-block; background: #0a0a0a; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; margin: 16px 0;">
        Accept Invitation
      </a>
      <p style="color: #737373; font-size: 14px;">This invitation expires in 7 days.</p>
    </div>
  `;
}
