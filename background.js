/**
 * background.js (MV3 service worker)
 *
 * Content scripts cannot call chrome.downloads directly, so the panel in
 * content.js sends the merged PDF (as a data: URL) here, and this worker
 * performs the actual chrome.downloads.download() call. Chrome's downloads
 * API turns "/" in the filename into real subfolders under the browser's
 * default Downloads directory, which is how the
 * "GST Appellate Tribunal/<Case Title>/merged.pdf" structure gets created.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'GST_DOWNLOAD_PDF') return false;

  const { filename, dataUrl } = message;

  chrome.downloads.download(
    {
      url: dataUrl,
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
});
