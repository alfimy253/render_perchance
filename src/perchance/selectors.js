/**
 * Every Perchance-specific URL / selector / marker lives here, so a markup change on
 * perchance.org only requires editing this one file.
 *
 * Page anatomy (verified against the live site):
 *
 *   perchance.org/ai-text-to-image-generator                 ← top page (Perchance shell)
 *   └─ iframe  https://<hash>.perchance.org/ai-text-to-image-generator   ← "generator frame" (the actual UI)
 *        ├─ textarea[data-name="description"]               ← prompt
 *        ├─ select[data-name="artStyle"]                    ← "🎨 Art Style" (= our "type")
 *        ├─ select[data-name="shape"]                       ← Square / Portrait / Landscape (left at default)
 *        ├─ select[data-name="numImages"]                   ← "🔢 How many?" → we always pick "4"
 *        ├─ button#generateButtonEl                         ← "✨ generate"
 *        └─ 4 × iframe https://image-generation.perchance.org/embed#{…}   ← one "embed" per image
 *              ├─ runs Cloudflare Turnstile → /api/verifyUser → /api/generate → downloads the image
 *              ├─ renders <img id="resultImgEl" src="data:image/…;base64,…">
 *              └─ window.parent.postMessage({ type: "finished", dataUrl, seedUsed, id }, "*")
 */
export const PERCHANCE = Object.freeze({
  generatorFramePattern: /^https:\/\/[a-z0-9-]+\.perchance\.org\/ai-text-to-image-generator(?:[/?#]|$)/i,
  embedFramePattern: /^https:\/\/image-generation\.perchance\.org\/embed/i,
  imageApiOrigin: 'https://image-generation.perchance.org',

  selectors: Object.freeze({
    description: 'textarea[data-name="description"]',
    artStyle: 'select[data-name="artStyle"]',
    shape: 'select[data-name="shape"]',
    numImages: 'select[data-name="numImages"]',
    generateButton: '#generateButtonEl',
    embedResultImage: '#resultImgEl',
  }),

  /** postMessage type sent by every embed when its image is ready. */
  finishedMessageType: 'finished',

  /** Text shown inside an embed when Perchance's Turnstile check fails. */
  antiBotTextPattern: /anti-bot verification failed/i,

  /** Title of Cloudflare's interstitial challenge page. */
  challengeTitlePattern: /just a moment|attention required|checking your browser/i,
});
