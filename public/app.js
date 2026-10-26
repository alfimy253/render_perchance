/* Frontend for the Perchance image generator. Vanilla JS, no dependencies.
 * The server is stateless; only UI preferences (last prompt/style/API key) live in localStorage. */
(() => {
  'use strict';

  const IMAGE_COUNT = 2;
  const STORE = { prompt: 'pig.prompt', type: 'pig.type', key: 'pig.apiKey' };

  const $ = (id) => document.getElementById(id);
  const els = {
    form: $('genForm'),
    prompt: $('prompt'),
    promptCount: $('promptCount'),
    promptError: $('promptError'),
    type: $('type'),
    apiKeyField: $('apiKeyField'),
    apiKey: $('apiKey'),
    button: $('generateBtn'),
    status: $('status'),
    statusText: $('statusText'),
    elapsed: $('elapsed'),
    errorBox: $('errorBox'),
    errorCode: $('errorCode'),
    errorMessage: $('errorMessage'),
    errorHint: $('errorHint'),
    resultsSection: $('resultsSection'),
    resultsMeta: $('resultsMeta'),
    grid: $('grid'),
    downloadAll: $('downloadAll'),
    lightbox: $('lightbox'),
    lightboxImg: $('lightboxImg'),
    mockBanner: $('mockBanner'),
  };

  const state = { busy: false, authRequired: false, images: [], lastPrompt: '', lastType: '', timer: null };

  const storage = {
    get: (k) => {
      try {
        return localStorage.getItem(k) || '';
      } catch {
        return '';
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* private mode */
      }
    },
  };

  init();

  async function init() {
    els.prompt.value = storage.get(STORE.prompt);
    els.apiKey.value = storage.get(STORE.key);
    updateCount();
    renderApiExamples();

    els.prompt.addEventListener('input', () => {
      updateCount();
      els.promptError.hidden = true;
      storage.set(STORE.prompt, els.prompt.value);
    });
    els.prompt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        els.form.requestSubmit();
      }
    });
    els.type.addEventListener('change', () => {
      storage.set(STORE.type, els.type.value);
      renderApiExamples();
    });
    els.apiKey.addEventListener('input', () => storage.set(STORE.key, els.apiKey.value));
    els.form.addEventListener('submit', (e) => {
      e.preventDefault();
      generate();
    });
    els.downloadAll.addEventListener('click', downloadAll);
    els.lightbox.addEventListener('click', (e) => {
      if (e.target === els.lightbox || e.target === els.lightboxImg) els.lightbox.close();
    });

    await loadTypes();
  }

  async function loadTypes() {
    try {
      const res = await fetch('/api/types', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      populateTypes(data.types || [], data.default);
      state.authRequired = Boolean(data.authRequired);
      els.apiKeyField.hidden = !state.authRequired;
      els.mockBanner.hidden = data.mode !== 'mock';
      els.button.disabled = false;
    } catch (err) {
      els.type.innerHTML = '<option>Unavailable</option>';
      showError({
        code: 'TYPES_UNAVAILABLE',
        message: `Could not load the art styles (${err.message}).`,
        hint: 'Is the server running?',
      });
    }
  }

  function populateTypes(types, defaultType) {
    const remembered = storage.get(STORE.type);
    const selected = types.includes(remembered) ? remembered : defaultType || types[0];
    const frag = document.createDocumentFragment();
    for (const label of types) {
      const opt = document.createElement('option');
      opt.value = label; // value === label === Perchance's dropdown text
      opt.textContent = label;
      if (label === selected) opt.selected = true;
      frag.appendChild(opt);
    }
    els.type.replaceChildren(frag);
    els.type.disabled = false;
    renderApiExamples();
  }

  async function generate() {
    if (state.busy) return;
    const prompt = els.prompt.value.trim();
    if (!prompt) {
      els.promptError.hidden = false;
      els.prompt.focus();
      return;
    }
    if (state.authRequired && !els.apiKey.value.trim()) {
      showError({
        code: 'UNAUTHORIZED',
        message: 'This server requires an API key.',
        hint: 'Enter it in the 🔑 field.',
      });
      els.apiKey.focus();
      return;
    }

    const type = els.type.value;
    state.lastPrompt = prompt;
    state.lastType = type;
    hideError();
    setBusy(true);
    renderSkeletons();

    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (els.apiKey.value.trim()) headers['X-API-Key'] = els.apiKey.value.trim();

    try {
      const res = await fetch('/generator', { method: 'POST', headers, body: JSON.stringify({ prompt, type }) });
      let data = null;
      try {
        data = await res.json();
      } catch {
        // Non-JSON (e.g. platform timeout page)
      }

      if (!res.ok || !data || !data.success) {
        const error = (data && data.error) || {
          code: `HTTP_${res.status}`,
          message:
            res.status === 504
              ? 'The server timed out before Perchance finished.'
              : `Request failed (${res.status} ${res.statusText}).`,
        };
        if (error.code === 'UNAUTHORIZED') {
          // The server wants a key. /api/types may be a cached copy from before API_KEY was set,
          // so the 🔑 field can still be hidden: show it now.
          state.authRequired = true;
          els.apiKeyField.hidden = false;
          renderApiExamples();
          if (!error.hint) {
            error.hint = els.apiKey.value.trim()
              ? "The key in the 🔑 field doesn't match the server's API_KEY."
              : 'Enter the key in the 🔑 field.';
          }
          els.apiKey.focus();
        }
        showError(error);
        const partial = error.details && Array.isArray(error.details.partialImages) ? error.details.partialImages : [];
        if (partial.length) renderImages(partial, `Partial result: ${partial.length} of ${IMAGE_COUNT} images`);
        else hideResults();
        return;
      }

      const seconds = data.timings && data.timings.totalMs ? `${(data.timings.totalMs / 1000).toFixed(1)}s` : '';
      renderImages(data.images, `${data.count} images · ${escapeHtml(data.type)}${seconds ? ` · ${seconds}` : ''}`);
    } catch (err) {
      showError({
        code: 'NETWORK_ERROR',
        message: err.message || 'Network error',
        hint: 'Check your connection and retry.',
      });
      hideResults();
    } finally {
      setBusy(false);
    }
  }

  function setBusy(busy) {
    state.busy = busy;
    els.button.disabled = busy;
    els.prompt.readOnly = busy;
    els.type.disabled = busy;
    els.button.querySelector('.btn-label').textContent = busy ? '⏳ generating…' : '✨ generate';
    els.status.hidden = !busy;
    clearInterval(state.timer);
    if (busy) {
      const started = performance.now();
      els.statusText.textContent = 'Playwright is driving Perchance (usually 20–60 s)…';
      els.elapsed.textContent = '0.0s';
      state.timer = setInterval(() => {
        els.elapsed.textContent = `${((performance.now() - started) / 1000).toFixed(1)}s`;
      }, 100);
    }
  }

  function renderSkeletons() {
    els.resultsSection.hidden = false;
    els.resultsMeta.textContent = 'Waiting for Perchance…';
    els.downloadAll.hidden = true;
    els.grid.replaceChildren(
      ...Array.from({ length: IMAGE_COUNT }, (_, i) => {
        const card = document.createElement('div');
        card.className = 'card skeleton';
        card.innerHTML = `<div class="card-media">Image ${i + 1}</div><div class="card-foot">&nbsp;</div>`;
        return card;
      }),
    );
  }

  function renderImages(images, metaHtml) {
    state.images = images;
    els.resultsSection.hidden = false;
    els.resultsMeta.innerHTML = metaHtml || '';
    els.downloadAll.hidden = images.length === 0;
    els.grid.replaceChildren(
      ...images.map((img, i) => {
        const card = document.createElement('figure');
        card.className = 'card';
        card.style.margin = '0';

        const media = document.createElement('div');
        media.className = 'card-media';
        const el = document.createElement('img');
        el.src = img.dataUrl;
        el.alt = `${state.lastType}: ${state.lastPrompt}`.slice(0, 300);
        el.loading = 'lazy';
        el.addEventListener('click', () => openLightbox(img.dataUrl, el.alt));
        media.appendChild(el);

        const foot = document.createElement('figcaption');
        foot.className = 'card-foot';
        const info = document.createElement('span');
        const parts = [`#${img.index || i + 1}`];
        if (img.seed !== null && img.seed !== undefined) parts.push(`seed ${img.seed}`);
        if (img.sizeBytes) parts.push(formatBytes(img.sizeBytes));
        info.textContent = parts.join(' · ');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-ghost';
        btn.textContent = '⬇ Download';
        btn.addEventListener('click', () => downloadImage(img, i));
        foot.append(info, btn);

        card.append(media, foot);
        return card;
      }),
    );
  }

  function hideResults() {
    els.resultsSection.hidden = true;
    els.grid.replaceChildren();
  }

  function openLightbox(src, alt) {
    els.lightboxImg.src = src;
    els.lightboxImg.alt = alt;
    if (typeof els.lightbox.showModal === 'function') els.lightbox.showModal();
  }

  function downloadImage(img, i) {
    const blob = dataUrlToBlob(img.dataUrl);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `perchance-${slug(state.lastType)}-${slug(state.lastPrompt).slice(0, 40) || 'image'}-${img.index || i + 1}.${img.extension || 'jpg'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function downloadAll() {
    for (let i = 0; i < state.images.length; i += 1) {
      downloadImage(state.images[i], i);
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  function showError(error) {
    els.errorBox.hidden = false;
    els.errorCode.textContent = error.code || 'ERROR';
    els.errorMessage.textContent = error.message || 'Something went wrong.';
    els.errorHint.textContent = error.hint || '';
    els.errorHint.hidden = !error.hint;
  }

  function hideError() {
    els.errorBox.hidden = true;
  }

  function updateCount() {
    els.promptCount.textContent = String(els.prompt.value.length);
  }

  function renderApiExamples() {
    const origin =
      window.location.origin && window.location.origin !== 'null'
        ? window.location.origin
        : 'https://your-app.vercel.app';
    const type = els.type.value && els.type.value !== 'Loading…' ? els.type.value : 'Cinematic';
    const body = JSON.stringify({ prompt: 'a red fox in a snowy forest, golden hour', type });
    const keyHeader = state.authRequired ? " \\\n  -H 'X-API-Key: <your key>'" : '';
    $('curlPost').textContent =
      `curl -X POST '${origin}/generator' \\\n  -H 'Content-Type: application/json'${keyHeader} \\\n  -d '${body.replace(/'/g, "'\\''")}'`;
    $('curlGet').textContent =
      `curl '${origin}/generator?prompt=${encodeURIComponent('a red fox in a snowy forest')}&type=${encodeURIComponent(type)}'`;
    $('curlTypes').textContent = `curl '${origin}/api/types'`;
  }

  function dataUrlToBlob(dataUrl) {
    const [header, b64] = dataUrl.split(',');
    const mime = (/data:([^;]+)/.exec(header) || [])[1] || 'application/octet-stream';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function slug(s) {
    return String(s || '')
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '-');
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  }
})();
