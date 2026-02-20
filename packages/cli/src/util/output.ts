import ora from "ora";
import pc from "picocolors";

export function success(msg: string): void {
  console.log(`${pc.green("✓")} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${pc.yellow("⚠")} ${msg}`);
}

export function error(msg: string): void {
  console.error(`${pc.red("✗")} ${msg}`);
}

export function info(msg: string): void {
  console.log(`${pc.cyan("ℹ")} ${msg}`);
}

export function createSpinner(text: string) {
  return ora({ text, color: "cyan" });
}

export function table(rows: [string, string][]): void {
  const maxKey = Math.max(...rows.map(([k]) => k.length));
  for (const [key, value] of rows) {
    console.log(`  ${key.padEnd(maxKey)}  ${value}`);
  }
}
