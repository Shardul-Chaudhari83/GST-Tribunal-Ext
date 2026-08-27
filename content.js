/**
 * content.js
 *
 * Drives the GST Appellate Tribunal "Submitted Documents" workflow:
 *
 *  1. On the case list (`submittedDoc.drt`), paginate through every page
 *     of the DataTable to collect every case's Filing No + Case Title.
 *  2. Let the user review/edit/remove cases, then start the run.
 *  3. For each case, navigate to its document list
 *     (`submittedDoc.drt?reply=&refrenceNo=<filingNo>`), paginate through
 *     ITS DataTable too, fetch every PDF (decoding the site's XOR-hex
 *     document-id scheme via scraper.js), merge them, and save as
 *     `GST Appellate Tribunal/<Case Title>/merged.pdf`.
 *
 * Because each case lives on its own server-rendered URL, this can't run
 * as one continuous in-memory loop — the extension re-runs on every page
 * load, so progress is persisted in chrome.storage.local and each load
 * picks up exactly where the last one left off.
 */
(function () {
  'use strict';

  const ROOT_FOLDER = 'GST Appellate Tribunal - Split';
  const STORAGE_KEY = 'gstAutomation';
  // Doc Type value (case-insensitive, trimmed) that gets saved as its own
  // file instead of going into the combined "Other Documents" merge.
  const SPLIT_DOC_TYPE = 'appeal';
  const NAV_DELAY_MS = 700; // be polite to the server between case pages

  let scanCancelled = false;
  let stopRequested = false;

  // --- storage helpers ---------------------------------------------------

  function loadState() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (res) => resolve(res[STORAGE_KEY] || null));
    });
  }

  function saveState(state) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: state }, resolve);
    });
  }

  function log(state, msg) {
    state.log = state.log || [];
    state.log.push(msg);
    if (state.log.length > 300) state.log = state.log.slice(-300);
  }

  // --- filesystem-safe names ---------------------------------------------

  function sanitizeSegment(name, fallback) {
    let s = (name || '').toString();
    s = s.replace(/[\x00-\x1F<>:"/\\|?*]/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/[. ]+$/g, '');
    if (s.length > 120) s = s.slice(0, 120).trim();
    return s || fallback;
  }

  // --- panel shell ---------------------------------------------------------

  function ensurePanel() {
    let panel = document.getElementById('gst-organizer-panel');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'gst-organizer-panel';
    panel.innerHTML = `
      <div id="gst-organizer-header">
        <span>GST Tribunal PDF Organizer</span>
        <div>
          <button id="gst-organizer-reset" class="gst-header-reset" title="Clear saved scan/run progress and start over">Reset</button>
          <button id="gst-organizer-min" title="Minimize">_</button>
        </div>
      </div>
      <div id="gst-organizer-body"></div>
    `;
    document.documentElement.appendChild(panel);
    panel.querySelector('#gst-organizer-min').addEventListener('click', () => {
      panel.classList.toggle('gst-minimized');
    });
    panel.querySelector('#gst-organizer-reset').addEventListener('click', async () => {
      if (!confirm('Clear saved scan/run progress and start over from scratch?')) return;
      stopRequested = true;
      await chrome.storage.local.remove(STORAGE_KEY);
      // Land back on the plain case list (not wherever we currently are —
      // e.g. mid-run this could be a specific case's document-list page,
      // which the idle panel's "Scan All Cases" can't work from).
      location.href = new URL('submittedDoc.drt', document.baseURI).href;
    });
    return panel;
  }

  function body() {
    return ensurePanel().querySelector('#gst-organizer-body');
  }

  // --- IDLE MODE: scan + review -------------------------------------------

  function renderIdle(lastState) {
    const failedCount = lastState ? lastState.results.filter((r) => r.status === 'error').length : 0;
    body().innerHTML = `
      <p class="gst-organizer-hint">
        Paginates through <strong>every page of the case list</strong>, then for each
        case fetches, merges, and downloads its PDFs. Nothing is uploaded anywhere &mdash;
        everything runs locally in your browser.
      </p>
      ${lastState ? `<div id="gst-last-summary">${renderSummaryHtml(lastState)}</div>` : ''}
      <div id="gst-organizer-actions">
        ${failedCount ? `<button id="gst-organizer-retry" class="gst-btn gst-btn-danger">Retry Failed (${failedCount})</button>` : ''}
        <button id="gst-organizer-scan" class="gst-btn gst-btn-primary">Scan All Cases</button>
      </div>
      <div id="gst-organizer-status"></div>
      <div id="gst-organizer-results"></div>
    `;
    document.getElementById('gst-organizer-scan').addEventListener('click', onScanButtonClick);
    if (failedCount) {
      document.getElementById('gst-organizer-retry').addEventListener('click', onRetryFailed(lastState));
    }
  }

  /** Builds a fresh mini-run that re-processes only the cases that errored last time. */
  function onRetryFailed(lastState) {
    return async () => {
      const failed = lastState.results.filter((r) => r.status === 'error');
      if (!failed.length) return;
      const queue = failed.map((r) => ({ filingNo: r.filingNo, title: r.title, status: 'pending' }));
      const state = {
        active: true,
        queue,
        currentIndex: 0,
        results: [],
        log: [],
        usedFolderNames: [],
        startedAt: Date.now(),
      };
      log(state, `Retrying ${queue.length} previously failed case(s).`);
      await saveState(state);
      location.href = window.GSTScraper.buildCaseUrl(queue[0].filingNo);
    };
  }

  function setIdleStatus(msg, kind) {
    const el = document.getElementById('gst-organizer-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = kind ? 'gst-status-' + kind : '';
  }

  let reviewCases = [];
  let scanning = false;

  function onScanButtonClick() {
    if (scanning) {
      scanCancelled = true;
      return;
    }
    onScanAll();
  }

  async function onScanAll() {
    const btn = document.getElementById('gst-organizer-scan');
    scanning = true;
    scanCancelled = false;
    btn.textContent = 'Stop Scanning';

    setIdleStatus('Scanning page 1…', 'info');
    try {
      const result = await window.GSTScraper.scanAllCasePages(({ page, count }) => {
        setIdleStatus(`Scanning page ${page}… ${count} case(s) found so far.`, 'info');
        if (scanCancelled) throw new Error('__CANCELLED__');
      });
      if (result.error) {
        setIdleStatus(result.error, 'error');
        return;
      }
      reviewCases = result.cases.map((c) => ({ ...c, include: true }));
      renderReview();
      setIdleStatus(`Found ${reviewCases.length} case(s). Review below, then start.`, 'success');
    } catch (err) {
      if (err.message === '__CANCELLED__') {
        setIdleStatus('Scan stopped.', 'warn');
      } else {
        console.error('[GST Organizer] scan failed', err);
        setIdleStatus('Scan failed: ' + err.message, 'error');
      }
    } finally {
      scanning = false;
      btn.textContent = 'Scan All Cases';
    }
  }

  function renderReview() {
    const container = document.getElementById('gst-organizer-results');
    container.innerHTML = `
      <div id="gst-organizer-start-row">
        <button id="gst-organizer-start" class="gst-btn gst-btn-success">
          Start: Merge &amp; Download All (${reviewCases.filter((c) => c.include).length})
        </button>
      </div>
      <ul class="gst-case-review-list"></ul>
    `;
    const list = container.querySelector('.gst-case-review-list');

    reviewCases.forEach((c, idx) => {
      const li = document.createElement('li');
      li.className = 'gst-case-review-row';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = c.include;
      cb.addEventListener('change', () => {
        c.include = cb.checked;
        document.getElementById('gst-organizer-start').textContent =
          `Start: Merge & Download All (${reviewCases.filter((x) => x.include).length})`;
      });

      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.className = 'gst-case-title-input';
      titleInput.value = c.title;
      titleInput.addEventListener('input', () => {
        c.title = titleInput.value;
      });

      const filingLabel = document.createElement('span');
      filingLabel.className = 'gst-filing-no';
      filingLabel.textContent = c.filingNo;

      li.appendChild(cb);
      li.appendChild(titleInput);
      li.appendChild(filingLabel);
      list.appendChild(li);
    });

    document.getElementById('gst-organizer-start').addEventListener('click', onStartAutomation);
  }

  async function onStartAutomation() {
    const queue = reviewCases
      .filter((c) => c.include)
      .map((c) => ({ filingNo: c.filingNo, title: c.title, status: 'pending' }));
    if (!queue.length) {
      setIdleStatus('No cases selected.', 'error');
      return;
    }
    const state = {
      active: true,
      queue,
      currentIndex: 0,
      results: [],
      log: [],
      startedAt: Date.now(),
    };
    log(state, `Starting run: ${queue.length} case(s).`);
    await saveState(state);
    location.href = window.GSTScraper.buildCaseUrl(queue[0].filingNo);
  }

  // --- AUTOMATION MODE -----------------------------------------------------

  function renderAutomationPanel(state) {
    const current = state.queue[state.currentIndex];
    body().innerHTML = `
      <div id="gst-auto-status">
        <strong>Case ${Math.min(state.currentIndex + 1, state.queue.length)} of ${state.queue.length}</strong>
        ${current ? `<div class="gst-auto-current">${escapeHtml(current.title)}</div>` : ''}
      </div>
      <div id="gst-auto-progress"></div>
      <div id="gst-organizer-actions">
        <button id="gst-organizer-stop" class="gst-btn gst-btn-danger">Stop After This Case</button>
      </div>
      <div id="gst-auto-log"></div>
    `;
    document.getElementById('gst-organizer-stop').addEventListener('click', async () => {
      stopRequested = true;
      const fresh = (await loadState()) || state;
      fresh.active = false;
      log(fresh, 'Stop requested by user.');
      await saveState(fresh);
      setAutoProgress('Will stop after the current case finishes downloading…', 'warn');
    });
    renderLog(state);
  }

  function setAutoProgress(msg, kind) {
    const el = document.getElementById('gst-auto-progress');
    if (!el) return;
    el.textContent = msg;
    el.className = kind ? 'gst-status-' + kind : '';
  }

  function renderLog(state) {
    const el = document.getElementById('gst-auto-log');
    if (!el) return;
    const lines = (state.log || []).slice(-8);
    el.innerHTML = lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('');
  }

  function renderFinished(state) {
    const failedCount = state.results.filter((r) => r.status === 'error').length;
    body().innerHTML = `
      <p class="gst-organizer-hint">Run finished.</p>
      ${renderSummaryHtml(state)}
      <div id="gst-organizer-actions">
        ${failedCount ? `<button id="gst-organizer-retry" class="gst-btn gst-btn-danger">Retry Failed (${failedCount})</button>` : ''}
        <button id="gst-organizer-scan" class="gst-btn gst-btn-primary">Scan All Cases Again</button>
      </div>
    `;
    document.getElementById('gst-organizer-scan').addEventListener('click', () => {
      renderIdle(null); // rebuild the containers onScanAll/renderReview expect
      onScanButtonClick();
    });
    if (failedCount) {
      document.getElementById('gst-organizer-retry').addEventListener('click', onRetryFailed(state));
    }
  }

  function renderSummaryHtml(state) {
    const done = state.results.filter((r) => r.status === 'done').length;
    const empty = state.results.filter((r) => r.status === 'empty').length;
    const errored = state.results.filter((r) => r.status === 'error').length;
    const rows = state.results
      .map(
        (r) =>
          `<div class="gst-summary-row gst-status-${r.status === 'done' ? 'success' : r.status === 'empty' ? 'warn' : 'error'}">` +
          `${escapeHtml(r.title)} &mdash; ${escapeHtml(r.detail || r.status)}</div>`
      )
      .join('');
    return `
      <p><strong>Last run:</strong> ${done} saved, ${empty} had no documents, ${errored} failed.</p>
      <div class="gst-summary-list">${rows}</div>
    `;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function fetchPdfBytes(url) {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    const head = new Uint8Array(buf.slice(0, 5));
    const isPdfMagic = String.fromCharCode(...head) === '%PDF-';
    const contentType = resp.headers.get('content-type') || '';
    if (!isPdfMagic && !/pdf/i.test(contentType)) {
      throw new Error('Response is not a PDF (session expired?)');
    }
    return buf;
  }

  /**
   * chrome.runtime.sendMessage has a ~64MiB payload cap, and a merged PDF
   * for a document-heavy case can exceed that as base64. So instead of
   * sending the bytes themselves, we create a blob: URL here (a short
   * opaque string) and send just that — chrome.downloads.download() in
   * background.js can fetch a blob: URL created by this content script's
   * page directly, without the data ever passing through the message
   * channel.
   */
  function requestDownload(filename, bytes) {
    return new Promise((resolve, reject) => {
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      chrome.runtime.sendMessage({ type: 'GST_DOWNLOAD_PDF', filename, url: blobUrl }, (response) => {
        // The download has been handed to Chrome by now (or failed to be);
        // either way this content script's copy of the blob is no longer needed.
        URL.revokeObjectURL(blobUrl);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response && response.ok) resolve(response.downloadId);
        else reject(new Error((response && response.error) || 'Unknown download error'));
      });
    });
  }

  // Folder-name de-duplication has to survive across page loads (each case
  // is processed on its own navigation, in a fresh JS context), so it's
  // tracked in the persisted state rather than a module-level Set.
  function uniqueFolderName(state, title, fallback) {
    state.usedFolderNames = state.usedFolderNames || [];
    const used = new Set(state.usedFolderNames);
    let base = sanitizeSegment(title, fallback);
    let candidate = base;
    let n = 2;
    while (used.has(candidate.toLowerCase())) {
      candidate = `${base} (${n})`;
      n += 1;
    }
    state.usedFolderNames.push(candidate.toLowerCase());
    return candidate;
  }

  /** Fetches + merges one group of docs into a single PDF's bytes. */
  async function mergeDocs(docs, groupLabel) {
    const merged = await PDFLib.PDFDocument.create();
    let ok = 0;
    const errors = [];
    for (const doc of docs) {
      setAutoProgress(`Fetching ${groupLabel}: ${doc.fileName}…`, 'info');
      try {
        const bytes = await fetchPdfBytes(doc.url);
        const src = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
        const pages = await merged.copyPages(src, src.getPageIndices());
        pages.forEach((p) => merged.addPage(p));
        ok += 1;
      } catch (err) {
        errors.push(`${doc.fileName}: ${err.message}`);
      }
    }
    if (ok === 0) return { bytes: null, ok, errors };
    return { bytes: await merged.save(), ok, errors };
  }

  /** Merges one doc group (if non-empty) and saves it as <folderName>/<fileLabel>.pdf. */
  async function mergeAndSave(docs, groupLabel, fileLabel, folderName) {
    if (!docs.length) return { attempted: false };
    const r = await mergeDocs(docs, groupLabel);
    if (!r.bytes) return { attempted: true, saved: false, total: docs.length, errors: r.errors };

    const path = `${ROOT_FOLDER}/${folderName}/${fileLabel}.pdf`;
    setAutoProgress('Saving ' + path + ' …', 'info');
    await requestDownload(path, r.bytes);
    return { attempted: true, saved: true, ok: r.ok, total: docs.length, errors: r.errors };
  }

  /** Processes the case whose document-list page we're currently on. */
  async function processCurrentCase(state, current) {
    setAutoProgress('Scanning document pages…', 'info');
    const scan = await window.GSTScraper.scanAllDocPages(({ page, count }) => {
      setAutoProgress(`Scanning document page ${page}… ${count} PDF(s) found.`, 'info');
    });

    if (scan.error) {
      log(state, `${current.title}: ${scan.error}`);
      state.results.push({ filingNo: current.filingNo, title: current.title, status: 'error', detail: scan.error });
      return;
    }
    if (!scan.docs.length) {
      log(state, `${current.title}: no documents found.`);
      state.results.push({ filingNo: current.filingNo, title: current.title, status: 'empty', detail: 'No documents' });
      return;
    }

    // Doc Type = SPLIT_DOC_TYPE (e.g. "Appeal") is saved as its own file;
    // everything else is merged into one "Other Documents" file alongside it.
    const splitDocs = scan.docs.filter((d) => (d.docType || '').trim().toLowerCase() === SPLIT_DOC_TYPE);
    const otherDocs = scan.docs.filter((d) => (d.docType || '').trim().toLowerCase() !== SPLIT_DOC_TYPE);

    const folderName = uniqueFolderName(state, current.title, `Case ${state.currentIndex + 1}`);
    const groups = [
      { label: 'Appeal', file: 'Appeal', result: await mergeAndSave(splitDocs, 'Appeal', 'Appeal', folderName) },
      {
        label: 'Other Documents',
        file: 'Other Documents',
        result: await mergeAndSave(otherDocs, 'Other Documents', 'Other Documents', folderName),
      },
    ];

    const savedParts = [];
    const allErrors = [];
    groups.forEach(({ label, result }) => {
      if (!result.attempted) return;
      if (result.saved) {
        savedParts.push(`${label}.pdf (${result.ok}/${result.total})`);
      } else {
        allErrors.push(`${label}: could not read any of ${result.total} PDF(s)`);
      }
      result.errors.forEach((e) => allErrors.push(`${label} - ${e}`));
    });

    if (!savedParts.length) {
      const detail = allErrors.length ? allErrors.join('; ') : 'Nothing could be saved.';
      log(state, `${current.title}: ${detail}`);
      state.results.push({ filingNo: current.filingNo, title: current.title, status: 'error', detail });
      return;
    }

    const detail = savedParts.join(', ') + (allErrors.length ? ` — issues: ${allErrors.join('; ')}` : '');
    log(state, `${current.title}: ${detail}`);
    state.results.push({ filingNo: current.filingNo, title: current.title, status: 'done', detail });
  }

  async function runAutomationStep(state) {
    if (state.currentIndex >= state.queue.length || !state.active) {
      state.active = false;
      log(state, 'Run finished.');
      await saveState(state);
      renderFinished(state);
      // Clean the URL back to the plain case list, if we're not there already.
      if (window.GSTScraper.getRefFromUrl()) {
        await sleep(NAV_DELAY_MS);
        location.href = new URL('submittedDoc.drt', document.baseURI).href;
      }
      return;
    }

    const current = state.queue[state.currentIndex];
    const urlRef = window.GSTScraper.getRefFromUrl();

    if (urlRef !== current.filingNo) {
      renderAutomationPanel(state);
      setAutoProgress(`Navigating to case ${state.currentIndex + 1} of ${state.queue.length}…`, 'info');
      location.href = window.GSTScraper.buildCaseUrl(current.filingNo);
      return;
    }

    renderAutomationPanel(state);
    try {
      await processCurrentCase(state, current);
    } catch (err) {
      console.error('[GST Organizer] case failed', current.title, err);
      log(state, `${current.title}: unexpected error — ${err.message}`);
      state.results.push({ filingNo: current.filingNo, title: current.title, status: 'error', detail: err.message });
    }

    state.currentIndex += 1;

    // If Stop was clicked while we were mid-download, its handler already
    // wrote active:false to storage — fold that into our own `state` object
    // (set synchronously via the module-level flag, so no race) rather than
    // re-reading storage and risking two writers stomping on each other.
    if (stopRequested) {
      state.active = false;
      log(state, 'Stop requested by user.');
    }
    await saveState(state);

    if (!state.active) {
      renderFinished(state);
      return;
    }

    await sleep(NAV_DELAY_MS);
    if (state.currentIndex >= state.queue.length) {
      location.href = new URL('submittedDoc.drt', document.baseURI).href;
    } else {
      location.href = window.GSTScraper.buildCaseUrl(state.queue[state.currentIndex].filingNo);
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // --- boot ----------------------------------------------------------------

  async function boot() {
    ensurePanel();
    const state = await loadState();
    if (state && state.active) {
      await runAutomationStep(state);
    } else if (state && state.results && state.results.length) {
      renderIdle(state);
    } else {
      renderIdle(null);
    }
  }

  boot();
})();
