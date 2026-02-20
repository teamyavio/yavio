import crypto from "node:crypto";

export interface GeneratedApiKey {
  rawKey: string;
  keyHash: string;
  keyPrefix: string;
}

export function generateApiKey(hashSecret: string): GeneratedApiKey {
  const rawKey = `yav_${crypto.randomBytes(32).toString("hex")}`;
  const keyPrefix = rawKey.slice(0, 12);
  const keyHash = crypto.createHmac("sha256", hashSecret).update(rawKey).digest("hex");

  return { rawKey, keyHash, keyPrefix };
}
