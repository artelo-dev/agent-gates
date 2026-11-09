import { readFileSync } from 'node:fs';

/** Version from package.json (dist/cli/version.js → ../../package.json; same depth from src/cli in tests). */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
