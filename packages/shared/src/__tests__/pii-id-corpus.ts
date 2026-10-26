/**
 * Seeded, synthetic id values for the PII tests (#182): the shapes that
 * tool inputs, outputs and metadata carry and that no PII pattern may cut.
 * Reproducible from the seed, no real data.
 */

/** sfc32: a small seeded PRNG, uniform in [0, 1). */
export function prng(seed: number): () => number {
  let a = 0x9e3779b9 ^ seed;
  let b = 0x243f6a88 ^ (seed * 31);
  let c = 0xb7e15162;
  let d = seed | 1;
  const next = () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 20; i++) next();
  return next;
}

type Random = () => number;

const HEX = "0123456789abcdef";
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function pick(r: Random, alphabet: string, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(r() * alphabet.length)];
  return s;
}
const int = (r: Random, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pad = (n: number, width: number) => String(n).padStart(width, "0");

function uuid4(r: Random): string {
  const h = pick(r, HEX, 32).split("");
  h[12] = "4";
  h[16] = "89ab"[Math.floor(r() * 4)] as string;
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** A valid traceparent: neither id all zeros, version 00. */
function traceparent(r: Random): string {
  let traceId: string;
  let parentId: string;
  do traceId = pick(r, HEX, 32);
  while (/^0+$/.test(traceId));
  do parentId = pick(r, HEX, 16);
  while (/^0+$/.test(parentId));
  return `00-${traceId}-${parentId}-0${r() < 0.5 ? 0 : 1}`;
}

/** A ULID with a realistic time part (2024-2028 in ms), then 80 random bits. */
function ulid(r: Random): string {
  let n = int(r, 1_704_067_200_000, 1_830_297_600_000);
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[n % 32] + time;
    n = Math.floor(n / 32);
  }
  return time + pick(r, CROCKFORD, 16);
}

function stripeLike(r: Random): string {
  const k = Math.floor(r() * 4);
  if (k === 0) return `pi_${pick(r, B62, 24)}`;
  if (k === 1) return `cus_${pick(r, B62, 14)}`;
  if (k === 2) return `ch_${pick(r, B62, 24)}`;
  return `evt_${pick(r, B62, 24)}`;
}

function isoTimestamp(r: Random): string {
  const base = `${int(r, 2000, 2035)}-${pad(int(r, 1, 12), 2)}-${pad(int(r, 1, 28), 2)}T${pad(int(r, 0, 23), 2)}:${pad(int(r, 0, 59), 2)}:${pad(int(r, 0, 59), 2)}`;
  const k = Math.floor(r() * 4);
  if (k === 0) return `${base}.${pad(int(r, 0, 999), 3)}Z`;
  if (k === 1) return `${base}Z`;
  if (k === 2) return `${base}.${pad(int(r, 0, 999), 3)}+0${int(r, 0, 9)}:00`;
  return `${base}.${pick(r, "0123456789", 6)}Z`;
}

function version(r: Random): string {
  const core = `${int(r, 0, 30)}.${int(r, 0, 99)}.${int(r, 0, 999)}`;
  const k = Math.floor(r() * 5);
  if (k === 0) return core;
  if (k === 1) return `v${core}`;
  if (k === 2) return `${core}-rc.${int(r, 0, 20)}`;
  if (k === 3) return `${core}+sha.${pick(r, HEX, 7)}`;
  // CalVer with a build number: the date alone has 13 392 values, too few
  // for the corpus's distinctness check.
  return `${int(r, 2000, 2035)}.${int(r, 1, 12)}.${int(r, 1, 31)}.${int(r, 0, 99_999)}`;
}

/** Id kinds that no phone, card or SSN pattern may cut. */
export const ID_KINDS: Record<string, (r: Random) => string> = {
  "UUID v4": uuid4,
  "UUID v4, upper case": (r) => uuid4(r).toUpperCase(),
  "traceparent inside text": (r) => `traceparent: ${traceparent(r)}`,
  "traceparent, upper case": (r) => traceparent(r).toUpperCase(),
  "hex-24": (r) => pick(r, HEX, 24),
  "hex-32": (r) => pick(r, HEX, 32),
  "hex-40": (r) => pick(r, HEX, 40),
  "hex-64": (r) => pick(r, HEX, 64),
  "nanoid-21": (r) => pick(r, B64URL, 21),
  "base64url-43": (r) => pick(r, B64URL, 43),
  ULID: ulid,
  "Stripe-like id": stripeLike,
  "ISO timestamp": isoTimestamp,
  version,
};
