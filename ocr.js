/**
 * ocr.js
 *
 * Detects the hand-/machine-numbered page reference that appears near the
 * top of a document's first page (used to sort "Other Documents" into the
 * order they were physically compiled, which doesn't always match the
 * order they were uploaded in). Two strategies, tried in order:
 *
 *  1. Real PDF text (pdf.js `getTextContent()`) — fast and exact, works
 *     for born-digital / typed documents.
 *  2. OCR (Tesseract.js) on the top band of the rendered first page —
 *     needed for scanned documents, where there's no text layer at all.
 *     Accuracy here is inherently limited, especially for hand-written or
 *     circled numbers; results below a confidence threshold are labelled
 *     'ocr-low' so content.js can route them through user review instead
 *     of silently trusting a guess.
 *
 * All the OCR/PDF-rendering libraries (pdf.js, Tesseract.js) are loaded as
 * plain <script>s before this file (see manifest.json), exposing the
 * globals `pdfjsLib` and `Tesseract`.
 *
 * Exposes window.GSTPageNumber.detectPageNumber(bytes, progressCb).
 */
(function (global) {
  'use strict';

  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.js');

  const TOP_BAND_FRACTION = 0.3; // fraction of the page height to search/OCR
  const NUMBER_RE = /^\d{1,4}$/;
  const OCR_CONFIDENCE_THRESHOLD = 70; // Tesseract word confidence, 0-100

  let ocrWorkerPromise = null;

  /** Lazily creates one Tesseract worker, reused for every document on this page load. */
  function getOcrWorker() {
    if (!ocrWorkerPromise) {
      ocrWorkerPromise = Tesseract.createWorker('eng', 1, {
        workerPath: chrome.runtime.getURL('vendor/tesseract-worker.min.js'),
        corePath: chrome.runtime.getURL('vendor/tesseract-core-lstm.js'),
        langPath: chrome.runtime.getURL('vendor/'),
      }).then((worker) => {
        // Restrict to digits: dramatically improves accuracy for this use
        // case and avoids surrounding text/marks being misread as numbers.
        return worker.setParameters({ tessedit_char_whitelist: '0123456789' }).then(() => worker);
      });
    }
    return ocrWorkerPromise;
  }

  /** Looks for an isolated 1-4 digit token in the top band of the text layer. */
  async function extractFromText(page) {
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const candidates = [];

    for (const item of textContent.items) {
      const str = (item.str || '').trim();
      if (!NUMBER_RE.test(str)) continue;
      // item.transform is in PDF space (origin bottom-left); combine with
      // the viewport transform to get top-left-origin (screen-like) Y.
      const combined = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const y = combined[5];
      if (y >= 0 && y <= viewport.height * TOP_BAND_FRACTION) {
        candidates.push({ number: parseInt(str, 10), y, x: combined[4] });
      }
    }
    if (!candidates.length) return null;
    // Top-most, then left-most, in case of ties.
    candidates.sort((a, b) => a.y - b.y || a.x - b.x);
    return candidates[0].number;
  }

  /** Renders page 1's top band and OCRs it for a 1-4 digit number. */
  async function extractFromOcr(page) {
    const viewport = page.getViewport({ scale: 2.5 }); // upscale small stamps for better OCR
    const fullCanvas = document.createElement('canvas');
    fullCanvas.width = Math.ceil(viewport.width);
    fullCanvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: fullCanvas.getContext('2d'), viewport }).promise;

    const cropHeight = Math.round(fullCanvas.height * TOP_BAND_FRACTION);
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = fullCanvas.width;
    cropCanvas.height = cropHeight;
    cropCanvas
      .getContext('2d')
      .drawImage(fullCanvas, 0, 0, fullCanvas.width, cropHeight, 0, 0, fullCanvas.width, cropHeight);

    const worker = await getOcrWorker();
    const { data } = await worker.recognize(cropCanvas);
    const words = (data.words || [])
      .map((w) => ({ ...w, text: (w.text || '').trim() }))
      .filter((w) => NUMBER_RE.test(w.text));

    if (!words.length) return { number: null, confidence: 'none' };

    words.sort((a, b) => b.confidence - a.confidence);
    const best = words[0];
    return {
      number: parseInt(best.text, 10),
      confidence: best.confidence >= OCR_CONFIDENCE_THRESHOLD ? 'ocr-high' : 'ocr-low',
      ocrConfidence: Math.round(best.confidence),
    };
  }

  /**
   * Returns { number: number|null, confidence: 'text'|'ocr-high'|'ocr-low'|'none', ocrConfidence?, error? }
   */
  async function detectPageNumber(bytes, progressCb) {
    try {
      if (progressCb) progressCb('Reading page number…');
      // pdf.js needs its own copy of the bytes (it may transfer/detach the buffer).
      const pdf = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
      const page = await pdf.getPage(1);

      const textNumber = await extractFromText(page);
      if (textNumber !== null) {
        return { number: textNumber, confidence: 'text' };
      }

      if (progressCb) progressCb('No text layer found — running OCR…');
      return await extractFromOcr(page);
    } catch (err) {
      console.error('[GST Organizer] page-number detection failed', err);
      return { number: null, confidence: 'none', error: err.message };
    }
  }

  global.GSTPageNumber = { detectPageNumber };
})(window);
