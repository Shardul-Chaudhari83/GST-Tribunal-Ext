/**
 * background.js (MV3 service worker)
 *
 * Content scripts cannot call chrome.downloads directly, so the panel in
 * content.js sends a blob: URL for the merged PDF here (not the bytes
 * themselves — chrome.runtime.sendMessage has a ~64MiB payload cap that a
 * document-heavy case's merged PDF can exceed), and this worker performs
 * the actual chrome.downloads.download() call. Chrome's downloads API
 * turns "/" in the filename into real subfolders under the browser's
 * default Downloads directory, which is how the
 * "GST Appellate Tribunal/<Case Title>/<Case Title>.pdf" structure gets
 * created.
 *
 * Note: if the user has Chrome's "Ask where to save each file before
 * downloading" setting on, Chrome will still prompt for every download —
 * no extension API can suppress that per-file dialog once that setting is
 * enabled; the fix is to turn that setting off in chrome://settings/downloads.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'GST_DOWNLOAD_PDF') return false;

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
});
