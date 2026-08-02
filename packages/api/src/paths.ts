import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function findProjectRoot(start = process.cwd()): string {
  let current = start;

  while (true) {
    if (existsSync(resolve(current, "package.json")) && existsSync(resolve(current, "packages"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return start;
    }

    current = parent;
  }
}

export function projectPath(...parts: string[]): string {
  return resolve(findProjectRoot(), ...parts);
}
