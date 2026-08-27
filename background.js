/**
 * background.js (MV3 service worker)
 *
 * Two jobs:
 *
 * 1. Downloads. Content scripts cannot call chrome.downloads directly, so
 *    the panel in content.js sends a blob: URL for the merged PDF here (not
 *    the bytes themselves — chrome.runtime.sendMessage has a ~64MiB payload
 *    cap that a document-heavy case's merged PDF can exceed), and this
 *    worker performs the actual chrome.downloads.download() call. Chrome's
 *    downloads API turns "/" in the filename into real subfolders under the
 *    browser's default Downloads directory, which is how the
 *    "GST Appellate Tribunal/<Case Title>/<Case Title>.pdf" structure gets
 *    created.
 *
 *    Note: if the user has Chrome's "Ask where to save each file before
 *    downloading" setting on, Chrome will still prompt for every download —
 *    no extension API can suppress that per-file dialog once that setting
 *    is enabled; the fix is to turn that setting off in
 *    chrome://settings/downloads.
 *
 * 2. Page-number detection (ocr.js, via pdf.js + Tesseract.js). This runs
 *    here rather than in the content script specifically because both
 *    libraries need to spin up their own Workers, and doing that from a
 *    content script means the worker is created cross-origin from the page
 *    it's injected into — which forces a blob-URL relay that a strict site
 *    CSP can block outright (confirmed happening on this site: its CSP has
 *    no worker-src, so it falls back to script-src, which doesn't allow
 *    blob:). A service worker isn't a "page" and isn't bound by the site's
 *    CSP at all, and here the worker script and its creator are both the
 *    extension's own origin, so no blob relay is ever needed.
 */

importScripts('vendor/pdf.min.js', 'vendor/tesseract.min.js', 'ocr.js');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  if (message.type === 'GST_DOWNLOAD_PDF') {
    const { filename, url } = message;
    chrome.downloads.download(
      {
        url,
        filename,
        saveAs: false,
        conflictAction: 'uniquify',
      },
      (downloadId) => {
        if (chrome.runtime.lastError || downloadId === undefined) {
          sendResponse({
            ok: false,
            error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Download failed to start',
          });
          return;
        }
        sendResponse({ ok: true, downloadId });
      }
    );
    return true; // keep the message channel open for the async sendResponse
  }

  if (message.type === 'GST_DETECT_PAGE_NUMBER') {
    self.GSTPageNumber.detectPageNumber(message.bytes).then(sendResponse);
    return true;
  }

  return false;
});
