/**
 * scraper.js
 *
 * Site-specific scraper for the GST Appellate Tribunal e-filing portal
 * (https://efiling.gstat.gov.in/submittedDoc.drt).
 *
 * Reverse-engineered from the live page (its own inline <script>), since
 * the domain isn't reachable from the build environment this extension was
 * written in:
 *
 *  - The case list (`submittedDoc.drt`) is a jQuery DataTable, 5 rows/page,
 *    paginated in-page (no full reload on "Next").
 *  - A specific case's document list is reachable directly via
 *    `submittedDoc.drt?reply=&refrenceNo=<filingNo>` (no need to tick the
 *    checkbox + click "Proceed To Document List" — confirmed working by
 *    direct navigation). It is ALSO a paginated DataTable, 5 rows/page.
 *  - Each PDF's "View" link is not a plain <a href>. It's:
 *      <a onclick="redirectDocument(598127)" href="#"><img ...></a>
 *    where the page's own inline script does:
 *      function redirectDocument(documentId){
 *        var encId = encryptStringWithXORtoHex(documentId,'SecretKey');
 *        window.open("viewDocAll.drt?docid="+encId);
 *      }
 *      function encryptStringWithXORtoHex(input,key){
 *        var c=''; input=String(input);
 *        while (key.length<input.length) key+=key;
 *        for (var i=0;i<input.length;i++){
 *          var xor = input.charCodeAt(i) ^ key.charCodeAt(i);
 *          var hex = xor.toString(16);
 *          if (hex.length<2) hex='0'+hex;
 *          c+=hex;
 *        }
 *        return c;
 *      }
 *    This file ports that exact algorithm so the PDF's real URL
 *    (`viewDocAll.drt?docid=<hex>`) can be computed and `fetch()`-ed
 *    directly, instead of relying on `window.open` (which would pop a
 *    separate tab per document instead of letting us merge them).
 *
 * Exposes window.GSTScraper.
 */
(function (global) {
  'use strict';

  const XOR_KEY = 'SecretKey';
  const ONCLICK_DOCID_RE = /redirectDocument\(\s*(\d+)\s*\)/i;

  function cleanText(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  /** Port of the page's own encryptStringWithXORtoHex(input, key). */
  function xorHex(input, key) {
    let c = '';
    input = String(input);
    let k = key;
    while (k.length < input.length) k += key;
    for (let i = 0; i < input.length; i++) {
      let hex = (input.charCodeAt(i) ^ k.charCodeAt(i)).toString(16);
      if (hex.length < 2) hex = '0' + hex;
      c += hex;
    }
    return c;
  }

  function buildDocUrl(docId) {
    const encId = xorHex(docId, XOR_KEY);
    return new URL('viewDocAll.drt?docid=' + encId, document.baseURI).href;
  }

  function buildCaseUrl(filingNo) {
    return new URL('submittedDoc.drt?reply=&refrenceNo=' + encodeURIComponent(filingNo), document.baseURI).href;
  }

  function getRefFromUrl(href) {
    try {
      return new URL(href || location.href).searchParams.get('refrenceNo');
    } catch (e) {
      return null;
    }
  }

  // --- Table discovery -------------------------------------------------

  function headerCells(table) {
    const inThead = Array.from(table.querySelectorAll('thead th, thead td'));
    if (inThead.length) return inThead;
    const firstRow = table.rows && table.rows[0];
    return firstRow ? Array.from(firstRow.cells) : [];
  }

  /** Find the (populated) table whose header row contains all given substrings. */
  function findTableByHeaders(requiredSubstrings) {
    const tables = Array.from(document.querySelectorAll('table'));
    for (const table of tables) {
      const headers = headerCells(table).map((c) => cleanText(c.textContent).toLowerCase());
      const ok = requiredSubstrings.every((req) => headers.some((h) => h.includes(req.toLowerCase())));
      if (ok) return table;
    }
    return null;
  }

  function getColumnIndex(table, headerSubstr) {
    const headers = headerCells(table).map((c) => cleanText(c.textContent).toLowerCase());
    const idx = headers.findIndex((h) => h.includes(headerSubstr.toLowerCase()));
    return idx;
  }

  function findCaseListTable() {
    return findTableByHeaders(['Filing No', 'Case Title']);
  }

  function findDocListTable() {
    return findTableByHeaders(['Doc Type', 'File Name']) || findTableByHeaders(['File Name', 'View']);
  }

  // --- DataTables pagination helpers -----------------------------------

  function getWrapper(table) {
    return table.closest('.dataTables_wrapper') || table.parentElement || document.body;
  }

  function getInfoText(wrapper) {
    const el = wrapper.querySelector('.dataTables_info');
    return el ? cleanText(el.textContent) : '';
  }

  /** Parses "Showing 6 to 10 of 10 entries" -> {from:6,to:10,total:10}. */
  function parseInfoText(text) {
    const m = text.match(/(\d+)\s+to\s+(\d+)\s+of\s+(\d+)/i);
    if (!m) return null;
    return { from: Number(m[1]), to: Number(m[2]), total: Number(m[3]) };
  }

  function findControl(wrapper, label) {
    const candidates = Array.from(wrapper.querySelectorAll('a, button, li, span'));
    const re = new RegExp('^\\s*' + label + '\\s*$', 'i');
    return candidates.find((el) => re.test(el.textContent || '')) || null;
  }

  function isDisabled(el) {
    if (!el) return true;
    const cls = (el.className && String(el.className)) || '';
    if (/disabled/i.test(cls)) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    return false;
  }

  function tableSignature(table) {
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    return rows.map((r) => cleanText(r.textContent)).join('|').slice(0, 500);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Clicks the "Next" pagination control for `table` and waits for the
   * table's rendered rows to actually change (DataTables' own pagination
   * is in-page/AJAX-driven, no full page reload). Returns true if it
   * advanced to a new page, false if there was no next page.
   */
  async function clickNextAndWait(table, timeoutMs) {
    const wrapper = getWrapper(table);
    const info = parseInfoText(getInfoText(wrapper));
    if (info && info.to >= info.total) return false; // already on last page

    const nextEl = findControl(wrapper, 'next');
    if (!nextEl || isDisabled(nextEl)) return false;

    const before = tableSignature(table);
    nextEl.click();

    const deadline = Date.now() + (timeoutMs || 6000);
    while (Date.now() < deadline) {
      await sleep(150);
      if (tableSignature(table) !== before) return true;
    }
    return false; // click didn't seem to change anything (e.g. network stall)
  }

  // --- Page-specific scraping -------------------------------------------

  function scrapeCaseListCurrentPage(table) {
    const filingIdx = getColumnIndex(table, 'Filing No');
    const titleIdx = getColumnIndex(table, 'Case Title');
    if (filingIdx < 0 || titleIdx < 0) return [];
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    return rows
      .map((row) => {
        const cells = Array.from(row.children);
        const filingNo = cleanText(cells[filingIdx] && cells[filingIdx].textContent);
        const title = cleanText(cells[titleIdx] && cells[titleIdx].textContent);
        return filingNo && title ? { filingNo, title } : null;
      })
      .filter(Boolean);
  }

  function scrapeDocListCurrentPage(table) {
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    const docTypeIdx = getColumnIndex(table, 'Doc Type');
    const fileNameIdx = getColumnIndex(table, 'File Name');
    const out = [];
    rows.forEach((row) => {
      const link = row.querySelector('a[onclick*="redirectDocument"]');
      if (!link) return;
      const m = (link.getAttribute('onclick') || '').match(ONCLICK_DOCID_RE);
      if (!m) return;
      const docId = m[1];
      const cells = Array.from(row.children);
      const docType = docTypeIdx >= 0 ? cleanText(cells[docTypeIdx] && cells[docTypeIdx].textContent) : '';
      const fileName =
        (fileNameIdx >= 0 ? cleanText(cells[fileNameIdx] && cells[fileNameIdx].textContent) : '') ||
        (docType ? docType + '.pdf' : 'document-' + docId + '.pdf');
      out.push({ docId, url: buildDocUrl(docId), docType, fileName });
    });
    return out;
  }

  /** Paginates through the whole case-list table, collecting every case. */
  async function scanAllCasePages(onProgress) {
    const table = await waitForTable(findCaseListTable);
    if (!table) return { cases: [], error: 'Could not find the case list table on this page.' };

    const seen = new Map(); // filingNo -> {filingNo, title}
    let page = 1;
    for (;;) {
      scrapeCaseListCurrentPage(table).forEach((c) => seen.set(c.filingNo, c));
      if (onProgress) onProgress({ page, count: seen.size });
      const advanced = await clickNextAndWait(table);
      if (!advanced) break;
      page += 1;
      if (page > 500) break; // sanity backstop
    }
    return { cases: Array.from(seen.values()), error: null };
  }

  /** Paginates through the current case's document-list table. */
  async function scanAllDocPages(onProgress) {
    const table = await waitForTable(findDocListTable);
    if (!table) return { docs: [], error: 'Could not find the document list table on this page.' };

    const seen = new Map(); // docId -> doc
    let page = 1;
    for (;;) {
      scrapeDocListCurrentPage(table).forEach((d) => seen.set(d.docId, d));
      if (onProgress) onProgress({ page, count: seen.size });
      const advanced = await clickNextAndWait(table);
      if (!advanced) break;
      page += 1;
      if (page > 500) break;
    }
    return { docs: Array.from(seen.values()), error: null };
  }

  /** Polls for a table (site's tables can render async) before giving up. */
  async function waitForTable(finder, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 4000);
    for (;;) {
      const table = finder();
      if (table) return table;
      if (Date.now() >= deadline) return null;
      await sleep(200);
    }
  }

  function detectPageType() {
    if (findDocListTable()) return 'docList';
    if (findCaseListTable()) return 'caseList';
    return 'unknown';
  }

  global.GSTScraper = {
    xorHex,
    buildDocUrl,
    buildCaseUrl,
    getRefFromUrl,
    detectPageType,
    scanAllCasePages,
    scanAllDocPages,
    cleanText,
  };
})(window);
