import { getTransporter } from "./transport";

export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const transporter = getTransporter();

  if (!transporter) {
    console.log(`[email] SMTP not configured. Would send to ${to}: ${subject}`);
    return false;
  }

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM ?? "noreply@yavio.dev",
      to,
      subject,
      html,
    });
    return true;
  } catch (error) {
    console.error("[email] Failed to send:", error);
    return false;
  }
}
