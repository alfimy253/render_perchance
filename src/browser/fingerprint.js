/**
 * Headless Chromium announces itself as "HeadlessChrome" in BOTH the User-Agent string
 * and the `sec-ch-ua` client hints. Perchance's Cloudflare rules answer requests carrying
 * that brand (e.g. the image embeds) with a 403 challenge, so we replace both with the
 * values a regular desktop Chrome of the same version would send.
 *
 * This is applied through CDP on the page target; with site isolation disabled (see
 * launch.js) every iframe of the page shares that override.
 */

/** Build the UA string + UA-CH metadata for a given full Chromium version (e.g. "153.0.8010.12"). */
export function buildUserAgent(fullVersion) {
  const safeFull = /^\d+(\.\d+){3}$/.test(fullVersion) ? fullVersion : '153.0.0.0';
  const major = safeFull.split('.')[0];
  const userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  const userAgentMetadata = {
    brands: [
      { brand: 'Google Chrome', version: major },
      { brand: 'Chromium', version: major },
      { brand: 'Not.A/Brand', version: '99' },
    ],
    fullVersionList: [
      { brand: 'Google Chrome', version: safeFull },
      { brand: 'Chromium', version: safeFull },
      { brand: 'Not.A/Brand', version: '99.0.0.0' },
    ],
    fullVersion: safeFull,
    platform: 'Linux',
    platformVersion: '6.1.0',
    architecture: 'x86',
    model: '',
    mobile: false,
    bitness: '64',
    wow64: false,
  };
  return { userAgent, userAgentMetadata, major, fullVersion: safeFull };
}

/**
 * Apply the override to a page. Returns the UA that is now in effect.
 * @param {import('playwright-core').BrowserContext} context
 * @param {import('playwright-core').Page} page
 */
export async function applyClientHints(context, page) {
  // The session is intentionally kept attached for the page's lifetime so the
  // override stays in effect on every Chromium version.
  const cdp = await context.newCDPSession(page);

  let fullVersion = '';
  try {
    const { product } = await cdp.send('Browser.getVersion'); // e.g. "HeadlessChrome/153.0.8010.12"
    fullVersion = String(product || '').split('/')[1] || '';
  } catch {
    // Some remote providers block the Browser domain – fall back to a sane default.
  }

  const ua = buildUserAgent(fullVersion);
  await cdp.send('Network.setUserAgentOverride', {
    userAgent: ua.userAgent,
    acceptLanguage: 'en-US,en;q=0.9',
    platform: 'Linux x86_64',
    userAgentMetadata: ua.userAgentMetadata,
  });
  return ua;
}
