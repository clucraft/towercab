import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

/**
 * The folder to keep data in: the one asked for when it can be written to, otherwise one under the
 * system's temporary folder.
 *
 * A folder mounted from the host is often not writable for the user the server runs as (Docker creates a
 * missing host folder as root). Without somewhere to put the airport data the app would show nothing, so
 * it carries on with a folder that is lost when the container is replaced, and says so.
 */
export async function writableDataDir(
  wanted: string,
  log?: { warn(obj: object, msg: string): void },
): Promise<string> {
  const probe = join(wanted, `.write-test-${process.pid}`);
  try {
    await mkdir(wanted, { recursive: true });
    await writeFile(probe, '');
    await rm(probe, { force: true });
    return wanted;
  } catch (err) {
    const fallback = join(tmpdir(), 'towercab-data');
    await mkdir(fallback, { recursive: true });
    log?.warn(
      { dataDir: wanted, using: fallback, user: process.getuid?.(), err: (err as Error).message },
      'the data folder is not writable: using a temporary folder instead. Downloads and the camera queue ' +
        'will be lost when the container is replaced; give this user write access to the data folder',
    );
    return fallback;
  }
}
