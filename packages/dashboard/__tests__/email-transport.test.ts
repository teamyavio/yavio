import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks ──────────────────────────────────────────────────────────
const mockSendMail = vi.fn();

vi.mock("../lib/email/transport", () => ({
  getTransporter: vi.fn(() => null),
}));

import { sendEmail } from "../lib/email/send";
import { getTransporter } from "../lib/email/transport";

const mockGetTransporter = getTransporter as ReturnType<typeof vi.fn>;

// ── tests ──────────────────────────────────────────────────────────
describe("sendEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false when no SMTP transporter configured", async () => {
    mockGetTransporter.mockReturnValue(null);
    const result = await sendEmail("test@example.com", "Test", "<p>Hello</p>");
    expect(result).toBe(false);
  });

  it("returns true when email sends successfully", async () => {
    mockSendMail.mockResolvedValue({ messageId: "msg-1" });
    mockGetTransporter.mockReturnValue({ sendMail: mockSendMail });

    const result = await sendEmail("to@test.com", "Subject", "<p>Body</p>");
    expect(result).toBe(true);
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "to@test.com",
        subject: "Subject",
        html: "<p>Body</p>",
      }),
    );
  });

  it("returns false when transporter throws", async () => {
    mockSendMail.mockRejectedValue(new Error("SMTP error"));
    mockGetTransporter.mockReturnValue({ sendMail: mockSendMail });

    const result = await sendEmail("to@test.com", "Fail", "<p>Err</p>");
    expect(result).toBe(false);
  });

  it("uses SMTP_FROM env var for from address", async () => {
    const originalFrom = process.env.SMTP_FROM;
    process.env.SMTP_FROM = "custom@yavio.dev";
    mockSendMail.mockResolvedValue({});
    mockGetTransporter.mockReturnValue({ sendMail: mockSendMail });

    await sendEmail("to@test.com", "Test", "<p>Hi</p>");
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: "custom@yavio.dev" }),
    );

    process.env.SMTP_FROM = originalFrom;
  });

  it("defaults from address to noreply@yavio.dev", async () => {
    const originalFrom = process.env.SMTP_FROM;
    Reflect.deleteProperty(process.env, "SMTP_FROM");
    mockSendMail.mockResolvedValue({});
    mockGetTransporter.mockReturnValue({ sendMail: mockSendMail });

    await sendEmail("to@test.com", "Test", "<p>Hi</p>");
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: "noreply@yavio.dev" }),
    );

    process.env.SMTP_FROM = originalFrom;
  });
});
