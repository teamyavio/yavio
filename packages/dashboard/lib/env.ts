function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

function optionalEnv(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? fallback;
}

export function getEnv() {
  return {
    DATABASE_URL: requireEnv("DATABASE_URL"),
    CLICKHOUSE_URL: optionalEnv("CLICKHOUSE_URL"),
    NEXTAUTH_SECRET: requireEnv("NEXTAUTH_SECRET"),
    NEXTAUTH_URL: optionalEnv("NEXTAUTH_URL"),
    GITHUB_CLIENT_ID: optionalEnv("GITHUB_CLIENT_ID"),
    GITHUB_CLIENT_SECRET: optionalEnv("GITHUB_CLIENT_SECRET"),
    GOOGLE_CLIENT_ID: optionalEnv("GOOGLE_CLIENT_ID"),
    GOOGLE_CLIENT_SECRET: optionalEnv("GOOGLE_CLIENT_SECRET"),
    SMTP_HOST: optionalEnv("SMTP_HOST"),
    SMTP_PORT: optionalEnv("SMTP_PORT", "587"),
    SMTP_USER: optionalEnv("SMTP_USER"),
    SMTP_PASSWORD: optionalEnv("SMTP_PASSWORD"),
    SMTP_FROM: optionalEnv("SMTP_FROM", "noreply@yavio.dev"),
    API_KEY_HASH_SECRET: requireEnv("API_KEY_HASH_SECRET"),
    APP_URL: optionalEnv("APP_URL", "http://localhost:3000"),
  };
}
