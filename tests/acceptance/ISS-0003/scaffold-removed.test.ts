// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

describe('placeholder scaffold test removal', () => {
  it('The placeholder test tests/scaffold.test.ts no longer exists in the tree', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    // this file lives at <repoRoot>/tests/acceptance/ISS-0003/scaffold-removed.test.ts
    const repoRoot = resolve(here, '../../../');
    const scaffoldPath = join(repoRoot, 'tests', 'scaffold.test.ts');

    expect(existsSync(scaffoldPath)).toBe(false);
  });
});
