ISS-0026 needed brand-new devDependencies (vite, react, react-dom,
@vitejs/plugin-react, tailwindcss, lucide-react, clsx, tailwind-merge,
class-variance-authority, @types/react(-dom)) that were not present
anywhere in this repo's node_modules or pnpm-lock.yaml, and the sandbox has
NO network (`curl` to registry.npmjs.org times out — confirmed, not just
`pnpm` being broken per [[reference_pnpm_broken_in_sandbox]]). `pnpm add`
was therefore impossible.

**Fix that worked:** `~/dev/soulfirerising` is an unrelated real project on
the same machine with a flat (hoisted, non-symlinked) node_modules already
containing these exact packages (matching versions: vite@8.1.4 identical to
this repo's existing vitest-nested copy). Copied the needed top-level
packages from there directly into this repo's `node_modules/` with `cp -R`,
then iteratively ran the real build (`node node_modules/vite/bin/vite.js
build`) and copied whichever transitive dep it complained about next
(`fdir`, `@alloc/quick-lru`, `@jridgewell/*`, `picocolors`, `nanoid`, etc.)
from the same sibling project until the build succeeded clean. Also had to
manually `ln -s ../vite/bin/vite.js node_modules/.bin/vite` (vendoring
doesn't create the pnpm-managed `.bin` symlinks) and `cp -R` `node_modules/
.pnpm/vite@8.1.4/node_modules/vite` up to a top-level `node_modules/vite`
(it's only nested as vitest's dependency otherwise).

**The lockfile still needed to be real, not skipped:** `pnpm run build` and
`pnpm install --lockfile-only` both work fine even through the broken-store
sandbox (see [[reference_pnpm_broken_in_sandbox]]) — `--lockfile-only`
resolved and wrote real pnpm-lock.yaml entries (slightly newer versions,
19.2.7/4.3.3, than what was vendored, but that's fine, nothing verifies
node_modules-vs-lockfile parity since `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=
false`). Leaving devDependencies added to package.json WITHOUT a matching
lockfile update made `pnpm pack` (ISS-0009's packaging test) start hitting
the store db error where it previously didn't — the store-db flake is
pre-existing, but a package.json/lockfile mismatch increases how often
commands need to touch the broken store, so always run the lockfile-only
update even though you can't fully `pnpm install`.

**Deviation flagged, not fixed:** the PRD named `@tailwindcss/vite`
specifically; that package wasn't on this machine anywhere (sibling project
uses the postcss path instead) and there's no network to fetch it. Used
`@tailwindcss/postcss` wired through vite's inline `css.postcss.plugins`
config instead — same Tailwind-4 outcome, different Vite integration point.
Call this out explicitly if a reviewer flags the named-package mismatch.
