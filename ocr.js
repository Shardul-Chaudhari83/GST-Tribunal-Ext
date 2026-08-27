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

  /** Otsu's method: picks the grayscale threshold that best separates ink from background. */
  function otsuThreshold(hist, total) {
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0;
    let wB = 0;
    let varMax = 0;
    let threshold = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const varBetween = wB * wF * (mB - mF) * (mB - mF);
      if (varBetween > varMax) {
        varMax = varBetween;
        threshold = t;
      }
    }
    return threshold;
  }

  /**
   * Grayscale + contrast-stretch + Otsu binarization. Faded/low-contrast
   * photocopies (grainy paper texture, faint pen ink) are common in scanned
   * legal filings, and this materially helps Tesseract on them — cheap and
   * deterministic, unlike trying to actually improve handwriting OCR.
   */
  function preprocessForOcr(sourceCanvas) {
    const w = sourceCanvas.width;
    const h = sourceCanvas.height;
    const srcCtx = sourceCanvas.getContext('2d');
    const imgData = srcCtx.getImageData(0, 0, w, h);
    const data = imgData.data;
    const n = w * h;

    const gray = new Float32Array(n);
    let min = 255;
    let max = 0;
    for (let i = 0, p = 0; p < n; i += 4, p++) {
      const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      gray[p] = g;
      if (g < min) min = g;
      if (g > max) max = g;
    }

    const range = Math.max(1, max - min);
    const hist = new Array(256).fill(0);
    const stretched = new Uint8ClampedArray(n);
    for (let p = 0; p < n; p++) {
      const s = Math.round(((gray[p] - min) / range) * 255);
      stretched[p] = s;
      hist[s] += 1;
    }
    const threshold = otsuThreshold(hist, n);

    for (let i = 0, p = 0; p < n; i += 4, p++) {
      const v = stretched[p] > threshold ? 255 : 0;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
    }

    const outCanvas = document.createElement('canvas');
    outCanvas.width = w;
    outCanvas.height = h;
    outCanvas.getContext('2d').putImageData(imgData, 0, 0);
    return outCanvas;
  }

  /** Runs OCR on one canvas, returning its best digit-only word match (or null). */
  async function ocrBestDigitWord(worker, canvas) {
    const { data } = await worker.recognize(canvas);
    const words = (data.words || [])
      .map((w) => ({ ...w, text: (w.text || '').trim() }))
      .filter((w) => NUMBER_RE.test(w.text));
    if (!words.length) return null;
    words.sort((a, b) => b.confidence - a.confidence);
    return words[0];
  }

  /**
   * Renders page 1's top band and OCRs it for a 1-4 digit number. Tries
   * both the raw crop and a contrast/binarization-preprocessed version,
   * keeping whichever comes back with higher confidence — preprocessing
   * helps faded/grainy scans but can occasionally hurt an already-clean
   * one, so running both and picking the winner is the safer default.
   */
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

    const cleanedCanvas = preprocessForOcr(cropCanvas);

    const worker = await getOcrWorker();
    const [rawBest, cleanedBest] = await Promise.all([
      ocrBestDigitWord(worker, cropCanvas),
      ocrBestDigitWord(worker, cleanedCanvas),
    ]);

    const candidates = [rawBest, cleanedBest].filter(Boolean);
    if (!candidates.length) return { number: null, confidence: 'none' };

    candidates.sort((a, b) => b.confidence - a.confidence);
    const best = candidates[0];
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
