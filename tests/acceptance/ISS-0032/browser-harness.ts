// The browser-seam infrastructure this issue owns (docs/issues/ISS-0032.md
// "Contract") -- the browser analogue of tests/acceptance/harness/: launch
// headless chromium, navigate to a URL, read the DOM, capture a screenshot.
// It lives inside this issue's own acceptance directory rather than a shared
// tests/acceptance/browser/ dir -- this campaign's only browser flow is R9
// (browser-flow.test.ts), so a single owner is correct.
//
// playwright is loaded through a variable module specifier rather than a
// static `import "playwright"`: it is added as a devDependency by this
// issue's own implementer (package.json + pnpm-lock.yaml,
// docs/issues/ISS-0032.md "touches"), so at authoring time it is not yet
// installed. A static import would fail module resolution at both
// typecheck and collection; a non-literal specifier keeps this file
// importable (typed `Promise<any>`) either way, and callers see a clean
// `undefined` rather than a thrown module-resolution error until the
// package lands.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const PLAYWRIGHT_MODULE = "playwright";

async function loadPlaywright(): Promise<any> {
  try {
    return await import(PLAYWRIGHT_MODULE);
  } catch {
    return undefined;
  }
}

export interface BrowserSession {
  browser: any;
  page: any;
}

/** Launches headless chromium (chromium preinstalled per the R10a probe) and opens one page. */
export async function launchHeadlessSession(): Promise<BrowserSession | undefined> {
  const pw = await loadPlaywright();
  if (!pw?.chromium) return undefined;
  const browser = await pw.chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  return { browser, page };
}

export async function closeSession(session: BrowserSession): Promise<void> {
  await session.browser.close();
}

export async function gotoUrl(session: BrowserSession, url: string): Promise<void> {
  await session.page.goto(url, { waitUntil: "networkidle" });
}

/**
 * The rendered document's full text content (not `innerText`): a
 * collapsed-by-default `<details>` disclosure chip still carries its reason
 * text in the DOM, just not in the accessibility-rendered text -- the
 * criterion asks for the reason to be "rendered", which it is, disclosed on
 * click. `textContent` reads what is actually in the DOM rather than
 * tripping on that visibility default.
 */
export async function pageText(session: BrowserSession): Promise<string> {
  return session.page.evaluate(() => document.body.textContent ?? "");
}

export async function captureScreenshot(session: BrowserSession, path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await session.page.screenshot({ path, fullPage: true });
}
