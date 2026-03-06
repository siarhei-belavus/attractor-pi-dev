import * as fs from "node:fs";
import * as path from "node:path";

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export function writeJsonAtomic(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

export function readJsonOrNull<T>(
  filePath: string,
  onError?: (error: Error) => void,
): T | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err) {
    onError?.(asError(err));
    return null;
  }
}

export function readJsonOrThrow<T>(filePath: string, context: string): T {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err) {
    const message = asError(err).message;
    throw new Error(`${context} (${filePath}): ${message}`);
  }
}
