/**
 * content.js
 *
 * Injects a review panel into the GST Appellate Tribunal "Submitted
 * Documents" page. Lets the user scan the page for cases + their PDFs,
 * review/fix the grouping, then merges each case's PDFs into a single
 * PDF and saves it as:
 *
 *   GST Appellate Tribunal/<Case Title>/merged.pdf
 *
 * via chrome.downloads (in background.js), using Chrome's subfolder
 * support in the download filename.
 */
(function () {
  'use strict';

  const ROOT_FOLDER = 'GST Appellate Tribunal';
  let state = { groups: [] };

  function sanitizeSegment(name, fallback) {
    let s = (name || '').toString();
    // Strip characters invalid in Windows/macOS/Linux path segments.
    s = s.replace(/[\x00-\x1F<>:"/\\|?*]/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/[. ]+$/g, ''); // trailing dots/spaces break on Windows
    if (s.length > 120) s = s.slice(0, 120).trim();
    return s || fallback;
  }

  function buildPanel() {
    if (document.getElementById('gst-organizer-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'gst-organizer-panel';
    panel.innerHTML = `
      <div id="gst-organizer-header">
        <span>GST Tribunal PDF Organizer</span>
        <div>
          <button id="gst-organizer-min" title="Minimize">_</button>
          <button id="gst-organizer-close" title="Close">×</button>
        </div>
      </div>
      <div id="gst-organizer-body">
        <p class="gst-organizer-hint">
          Scans <strong>this page only</strong> for case titles and their PDF documents.
          Nothing is uploaded anywhere &mdash; everything runs locally in your browser.
        </p>
        <div id="gst-organizer-actions">
          <button id="gst-organizer-scan" class="gst-btn gst-btn-primary">Scan Page for Cases</button>
          <button id="gst-organizer-download" class="gst-btn gst-btn-success" disabled>Download All (Merged PDFs)</button>
        </div>
        <div id="gst-organizer-status"></div>
        <div id="gst-organizer-results"></div>
      </div>
    `;
    document.documentElement.appendChild(panel);

    panel.querySelector('#gst-organizer-close').addEventListener('click', () => panel.remove());
    panel.querySelector('#gst-organizer-min').addEventListener('click', () => {
      panel.classList.toggle('gst-minimized');
    });
    panel.querySelector('#gst-organizer-scan').addEventListener('click', onScan);
    panel.querySelector('#gst-organizer-download').addEventListener('click', onDownloadAll);
  }

  function setStatus(msg, kind) {
    const el = document.getElementById('gst-organizer-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = kind ? 'gst-status-' + kind : '';
  }

  function onScan() {
    setStatus('Scanning page…', 'info');
    let scan;
    try {
      scan = window.GSTScraper.scanPage();
    } catch (err) {
      console.error('[GST Organizer] scan failed', err);
      setStatus('Scan failed: ' + err.message, 'error');
      return;
    }

    if (!scan.groups.length) {
      setStatus(
        'No PDF links were found on this page. Make sure the case list has finished loading, then try again.',
        'error'
      );
      state.groups = [];
      renderResults();
      document.getElementById('gst-organizer-download').disabled = true;
      return;
    }

    state.groups = scan.groups;
    renderResults();
    const totalPdfs = state.groups.reduce((n, g) => n + g.pdfs.length, 0);
    setStatus(
      `Found ${state.groups.length} case(s) with ${totalPdfs} PDF(s) total (using "${scan.strategy}" grouping). Review below, then download.`,
      'success'
    );
    document.getElementById('gst-organizer-download').disabled = false;
  }

  function renderResults() {
    const container = document.getElementById('gst-organizer-results');
    container.innerHTML = '';

    state.groups.forEach((group, gIdx) => {
      const card = document.createElement('div');
      card.className = 'gst-case-card';
      card.dataset.groupIdx = String(gIdx);

      const header = document.createElement('div');
      header.className = 'gst-case-header';

      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.value = group.title;
      titleInput.className = 'gst-case-title-input';
      titleInput.addEventListener('input', () => {
        group.title = titleInput.value;
      });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'gst-btn gst-btn-small gst-btn-danger';
      removeBtn.textContent = 'Remove case';
      removeBtn.title = 'Remove this case from the list (does not affect the site)';
      removeBtn.addEventListener('click', () => {
        state.groups.splice(gIdx, 1);
        renderResults();
      });

      header.appendChild(titleInput);
      header.appendChild(removeBtn);
      card.appendChild(header);

      const pdfList = document.createElement('ul');
      pdfList.className = 'gst-pdf-list';
      group.pdfs.forEach((pdf, pIdx) => {
        const li = document.createElement('li');

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = pdf.include;
        cb.addEventListener('change', () => {
          pdf.include = cb.checked;
        });

        const label = document.createElement('span');
        label.className = 'gst-pdf-name';
        label.textContent = pdf.filename;
        label.title = pdf.url;

        const moveSelect = document.createElement('select');
        moveSelect.className = 'gst-move-select';
        const keepOpt = document.createElement('option');
        keepOpt.value = '';
        keepOpt.textContent = 'Move to…';
        moveSelect.appendChild(keepOpt);
        state.groups.forEach((otherGroup, oIdx) => {
          if (oIdx === gIdx) return;
          const opt = document.createElement('option');
          opt.value = String(oIdx);
          opt.textContent = otherGroup.title;
          moveSelect.appendChild(opt);
        });
        moveSelect.addEventListener('change', () => {
          const targetIdx = parseInt(moveSelect.value, 10);
          if (Number.isNaN(targetIdx)) return;
          group.pdfs.splice(pIdx, 1);
          state.groups[targetIdx].pdfs.push(pdf);
          renderResults();
        });

        li.appendChild(cb);
        li.appendChild(label);
        li.appendChild(moveSelect);
        pdfList.appendChild(li);
      });
      card.appendChild(pdfList);

      const statusLine = document.createElement('div');
      statusLine.className = 'gst-case-status';
      statusLine.id = 'gst-case-status-' + gIdx;
      card.appendChild(statusLine);

      container.appendChild(card);
    });
  }

  function setCaseStatus(gIdx, msg, kind) {
    const el = document.getElementById('gst-case-status-' + gIdx);
    if (!el) return;
    el.textContent = msg;
    el.className = 'gst-case-status ' + (kind ? 'gst-status-' + kind : '');
  }

  async function fetchAsArrayBuffer(url) {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    const contentType = resp.headers.get('content-type') || '';
    const buf = await resp.arrayBuffer();
    // Sanity check: some portals return an HTML login/error page with a 200
    // status when the session has expired. Guard against silently "merging"
    // an HTML error page in as if it were a PDF.
    const head = new Uint8Array(buf.slice(0, 5));
    const isPdfMagic = String.fromCharCode(...head) === '%PDF-';
    if (!isPdfMagic && !/pdf/i.test(contentType)) {
      throw new Error('Response does not look like a PDF (session expired or link changed?)');
    }
    return buf;
  }

  async function mergeCasePdfs(group, gIdx) {
    const included = group.pdfs.filter((p) => p.include);
    if (!included.length) {
      setCaseStatus(gIdx, 'Skipped (no PDFs selected).', 'warn');
      return null;
    }

    const merged = await PDFLib.PDFDocument.create();
    let okCount = 0;
    const errors = [];

    for (const pdf of included) {
      setCaseStatus(gIdx, `Fetching ${pdf.filename}…`, 'info');
      try {
        const bytes = await fetchAsArrayBuffer(pdf.url);
        const src = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
        const pages = await merged.copyPages(src, src.getPageIndices());
        pages.forEach((p) => merged.addPage(p));
        okCount += 1;
      } catch (err) {
        console.error('[GST Organizer] failed on', pdf.url, err);
        errors.push(`${pdf.filename}: ${err.message}`);
      }
    }

    if (okCount === 0) {
      setCaseStatus(gIdx, 'Failed: could not read any of the selected PDFs.', 'error');
      return null;
    }

    setCaseStatus(gIdx, 'Building merged PDF…', 'info');
    const mergedBytes = await merged.save();

    if (errors.length) {
      setCaseStatus(
        gIdx,
        `Merged ${okCount}/${included.length} PDF(s). ${errors.length} skipped: ${errors.join('; ')}`,
        'warn'
      );
    }

    return mergedBytes;
  }

  function bytesToDataUrl(bytes) {
    // Chunked base64 encoding to avoid call-stack issues with very large PDFs.
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    const base64 = btoa(binary);
    return `data:application/pdf;base64,${base64}`;
  }

  function requestDownload(filename, dataUrl) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'GST_DOWNLOAD_PDF', filename, dataUrl }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response && response.ok) resolve(response.downloadId);
        else reject(new Error((response && response.error) || 'Unknown download error'));
      });
    });
  }

  async function onDownloadAll() {
    const downloadBtn = document.getElementById('gst-organizer-download');
    downloadBtn.disabled = true;
    const usedFolderNames = new Set();

    let successCount = 0;
    for (let gIdx = 0; gIdx < state.groups.length; gIdx++) {
      const group = state.groups[gIdx];
      try {
        const mergedBytes = await mergeCasePdfs(group, gIdx);
        if (!mergedBytes) continue;

        let folderName = sanitizeSegment(group.title, `Case ${gIdx + 1}`);
        let unique = folderName;
        let suffix = 2;
        while (usedFolderNames.has(unique.toLowerCase())) {
          unique = `${folderName} (${suffix})`;
          suffix += 1;
        }
        usedFolderNames.add(unique.toLowerCase());

        const dataUrl = bytesToDataUrl(mergedBytes);
        const path = `${ROOT_FOLDER}/${unique}/merged.pdf`;
        setCaseStatus(gIdx, 'Saving to Downloads/' + path + ' …', 'info');
        await requestDownload(path, dataUrl);
        setCaseStatus(gIdx, `Saved to Downloads/${path}`, 'success');
        successCount += 1;
      } catch (err) {
        console.error('[GST Organizer] case failed', group.title, err);
        setCaseStatus(gIdx, 'Error: ' + err.message, 'error');
      }
    }

    setStatus(`Done. ${successCount}/${state.groups.length} case folder(s) saved under "${ROOT_FOLDER}".`, 'success');
    downloadBtn.disabled = false;
  }

  buildPanel();
})();
