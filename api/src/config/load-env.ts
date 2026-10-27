import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

export function loadRepositoryEnv(): void {
  if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'test')
    return;

  // src/config and dist/config have the same depth relative to the repository root.
  const result = config({
    path: fileURLToPath(new URL('../../../.env.development', import.meta.url)),
    override: false,
    quiet: true,
  });
  if (
    result.error &&
    (result.error as NodeJS.ErrnoException).code !== 'ENOENT'
  ) {
    throw new Error('Could not load the repository development environment');
  }
}
