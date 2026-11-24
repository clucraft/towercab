import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Walks up from `from` looking for `relative`. Used to find files that ship next to the server
 * (`config/config.example.yaml`, `apps/web/dist`) both in the repo and in the Docker image.
 */
export function findUp(relative: string, from: string = import.meta.dirname): string | null {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
