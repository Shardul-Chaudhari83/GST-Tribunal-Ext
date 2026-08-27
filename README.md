# GST-Tribunal-Ext

A Chrome extension that organizes case documents from the GST Appellate
Tribunal e-filing portal's **Submitted Documents** page
(`https://efiling.gstat.gov.in/submittedDoc.drt`).

It paginates through your full case list, and for every case downloads all
of its PDF attachments into a per-case folder — the document whose **Doc
Type** is "Appeal" is saved on its own as `Appeal.pdf`, and everything
else (Affidavit, Annexure, Show Cause Notice, etc.) is merged into one
`Other Documents.pdf`, **ordered by the page number printed near the top
of each document** (not upload order) — producing this structure inside
your normal Downloads folder:

```
Downloads/
└── GST Appellate Tribunal - Split/
    ├── <Case Title 1>/
    │   ├── Appeal.pdf
    │   └── Other Documents.pdf
    ├── <Case Title 2>/
    │   ├── Appeal.pdf
    │   └── Other Documents.pdf
    └── ...
```

(A case with no "Appeal"-typed document just gets `Other Documents.pdf`;
one where every document is typed "Appeal" just gets `Appeal.pdf`.)

Everything happens locally in your browser — no case data, PDFs, or
filenames are sent anywhere other than the tribunal's own site.

> **Before your first run**, open `chrome://settings/downloads` and turn
> **off** "Ask where to save each file before downloading". If it's on,
> Chrome will pop a Save-As dialog for *every single case* and — because
> that dialog doesn't reliably follow the per-case subfolder the extension
> requests — files can end up overwriting each other in whatever folder the
> dialog was last pointed at. No extension can override this setting; it's
> an intentional browser safeguard. With it off, every save is silent and
> lands exactly where expected.

## Why an extension, and why "only this page"

`submittedDoc.drt` only shows documents for cases tied to your logged-in
e-filing session, and the PDFs are served from behind that session's
cookies. A generic script run outside the browser wouldn't have that
session, so this is built as a browser extension that runs on the page
itself, reusing your existing login. Per the task, it is scoped (via
`host_permissions` and the content script's `matches` pattern) to only
`https://efiling.gstat.gov.in/submittedDoc.drt*` — it does not touch any
other page or site.

## Install (unpacked, for now)

1. Open `chrome://extensions` (also works in Edge/Brave via their
   `://extensions` page).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this project's folder.
4. Log in to the e-filing portal and navigate to the Submitted Documents
   page: `https://efiling.gstat.gov.in/submittedDoc.drt`.
5. A **GST Tribunal PDF Organizer** panel appears in the top-right corner
   of the page.

## Usage

1. Click **Scan All Cases**. The extension pages through the entire case
   list (clicking through every page of the table) collecting every case's
   Filing No and Case Title. This can take a little while for a large
   list — the panel shows live progress, and you can click the button again
   to stop early.
2. Review the results: uncheck any case you don't want processed, or edit
   its title if you want a different folder name.
3. Click **Start: Merge & Download All**. The extension then works through
   the queue, one case at a time:
   - Navigates to that case's document list
     (`submittedDoc.drt?reply=&refrenceNo=<filingNo>`),
   - Pages through *that* case's own document table (a case can have more
     documents than fit on one page),
   - Fetches every PDF, splitting out the one(s) with Doc Type "Appeal"
     from the rest,
   - Detects each "Other Documents" PDF's page number (see below) and
     sorts by it before merging,
   - Saves `GST Appellate Tribunal - Split/<Case Title>/Appeal.pdf` and/or
     `.../Other Documents.pdf` under your browser's default Downloads
     folder (whichever group has documents),
   - Moves on to the next case — unless the page-number detection wasn't
     confident, in which case it **pauses on that case** for you to
     review (see below) before continuing.

   Because each case lives on its own page, this involves real page
   navigations — the panel's progress (current case, current step, and a
   running log) persists across them, so you can watch it work. Click
   **Stop After This Case** at any point to halt the run once the
   in-progress case finishes.
4. When the run finishes, a summary shows how many cases were saved, had no
   documents, or failed, along with the reason for any failure.
5. If any cases failed, a **Retry Failed (N)** button appears alongside
   the summary — it re-processes only those cases (not the ones that
   already succeeded), so you don't have to redo an entire large run over
   a handful of failures.
6. **Reset** (top of the panel) clears any saved scan/run progress and
   sends you back to the plain case list — use it if you want to abandon
   a run partway through and start over instead. Chrome's `conflictAction:
   'uniquify'` means re-running from case 1 won't overwrite files already
   saved from a prior run; it'll save alongside them as `Name (1).pdf`
   etc. Delete the `GST Appellate Tribunal - Split` folder first if you
   want a clean slate.

## How it actually works (reverse-engineered from the live page)

The page's own inline `<script>` was read via the browser console to figure
this out, since the domain isn't reachable from the environment this
extension was built in:

- The case list and each case's document list are both jQuery **DataTables**
  that paginate **in-page** (no full reload when you click "Next") — so
  `scraper.js` clicks through pages and waits for the row content to
  actually change, rather than assuming everything is in the DOM at once.
- A case's document list is directly reachable by URL —
  `submittedDoc.drt?reply=&refrenceNo=<filingNo>` — so the extension
  navigates straight there instead of using the checkbox + "Proceed To
  Document List" button.
- Each PDF's "View" icon isn't a plain link. It's
  `<a onclick="redirectDocument(598127)" href="#">`, and the page's own
  script does:
  ```js
  function redirectDocument(documentId){
    var encId = encryptStringWithXORtoHex(documentId,'SecretKey');
    window.open("viewDocAll.drt?docid="+encId);
  }
  ```
  i.e. it XORs the numeric document ID against the fixed key `"SecretKey"`,
  hex-encodes the result, and opens `viewDocAll.drt?docid=<hex>`.
  `scraper.js` ports that exact algorithm so it can compute the PDF's real
  URL and `fetch()` it directly (instead of `window.open`, which would pop
  a separate tab per document instead of letting them be merged).

Because each case is processed on its own page load, progress (the case
queue, current position, results, and folder-name de-duplication) is kept
in `chrome.storage.local` under the key `gstAutomation` and picked back up
on every page load — this is also what makes **Stop After This Case** and
resuming after an accidental reload work.

## How the page-number ordering works, and the review pause

Court filings are typically hand-compiled with a page number written near
the top of each document (sometimes typed, sometimes hand-written and
circled — see examples worked out with the user while building this). For
each "Other Documents" PDF, `ocr.js` tries, in order:

1. **Real PDF text** (`pdf.js`'s `getTextContent()`) — looks for an
   isolated 1–4 digit token in the top ~30% of the first page. Fast and
   exact; works for typed/born-digital documents.
2. **OCR** (`Tesseract.js`, restricted to digits only) — renders the top
   band of the first page to a canvas, for documents with no text layer
   (scanned documents). It's read twice — once as rendered, once after a
   grayscale + contrast-stretch + Otsu-binarization cleanup pass (helps
   with the grainy, low-contrast photocopies common in scanned filings) —
   and whichever attempt comes back more confident wins. A result is only
   trusted automatically if that confidence score is ≥ 70; below that it's
   marked `ocr-low`. This cleanup step is a real, measurable help for
   faded/grainy scans; it does not turn OCR into reliable handwriting
   recognition — a hand-written, circled number is still going to need
   the review step below more often than a typed one.

If a case has more than one "Other Document" and **any** of them came back
`ocr-low` or undetected, the run **pauses on that case** instead of
guessing: the panel shows every document with its detected number (in an
editable box) and a confidence badge (green = text, blue = OCR, red = low
confidence/unknown), sorted by best guess. Fix any numbers that look
wrong, then:

- **Confirm & Merge** — merges in the order given by the numbers currently
  in the boxes (edited or not).
- **Skip (upload order)** — ignores detected numbers entirely for this
  case and merges in the order the documents were uploaded.

The run then continues to the next case automatically. This is a real,
inherent accuracy trade-off — OCR on a hand-written, circled number is not
reliable, and this review step exists specifically so a bad guess never
gets baked into a merged PDF silently.

**Things worth knowing:**
- This added ~6.9MB of bundled libraries (`pdf.js` + `Tesseract.js` + its
  WASM OCR core + a compact English trained-data file, all vendored
  locally — no CDN, per Manifest V3 rules). OCR itself (now two passes per
  document — raw and cleaned-up) also makes document-heavy, scanned-
  document cases noticeably slower to process than before.
- The split/merge logic (`SPLIT_DOC_TYPE` in `content.js`), the OCR
  confidence threshold, and the "top band" search region
  (`OCR_CONFIDENCE_THRESHOLD` / `TOP_BAND_FRACTION` in `ocr.js`) are all
  small, named constants if they need tuning.
- **`ocr.js` runs inside `background.js` (the service worker), not the
  content script.** The first version of this feature ran it in the
  content script and hit exactly the failure mode flagged as a risk up
  front: pdf.js/Tesseract.js each need to spin up their own Worker, and
  creating one from a content script means the worker script (extension
  origin) is cross-origin from the page it's injected into (the site),
  which forces a blob-URL relay — and this site's CSP has no `worker-src`
  (falling back to `script-src`, which doesn't allow `blob:`), so Chrome
  blocked it outright (`Creating a worker from 'blob:...' violates the
  following Content Security Policy directive`). A service worker isn't a
  "page" and isn't bound by the site's CSP at all, and there both the
  worker script and its creator are the same extension origin, so no blob
  relay is needed. `content.js` sends each document's bytes to
  `background.js` for detection (small enough per-document to go straight
  through `chrome.runtime.sendMessage`, unlike a merged PDF) and gets back
  just the `{number, confidence}` result. This needed `OffscreenCanvas`
  instead of a real `<canvas>` (no DOM in a service worker) and an
  explicit `'wasm-unsafe-eval'` in `manifest.json`'s
  `content_security_policy.extension_pages` for Tesseract's WASM core —
  both are in place, but this exact combination (pdf.js + Tesseract.js
  inside an MV3 service worker) is still something I reasoned through
  rather than watched run, so if a *new* error shows up, check the
  **service worker's own console**, not the page's: `chrome://extensions`
  → this extension → **service worker** (Brave: **Inspect views**) — that
  opens a separate DevTools window for `background.js` specifically.

## Notes & limitations

- This was built and reverse-engineered without direct access to the site
  (only screenshots, a screen recording, and pasted browser-console output
  were available), so some of it — especially exact table/column detection
  — is written defensively (matched by header text, not hard-coded
  indexes) but hasn't been run against the live site by the author. If
  something doesn't work, open the panel's automation log and DevTools
  console (errors are prefixed `[GST Organizer]`) and share what you see.
- If a case's PDF fails to download (link is stale, session expired, file
  is encrypted, etc.), that one file is skipped and the rest of that
  group's PDFs are still merged; a case with zero documents is recorded as
  such rather than treated as an error.
- The Appeal/Other split is a simple exact match on the row's **Doc Type**
  column text (case-insensitive, trimmed) equal to `"appeal"` — see
  `SPLIT_DOC_TYPE` in `content.js`. If the site uses a different label for
  some cases (e.g. "Appeal Memo"), those rows land in "Other Documents"
  instead of being split out; tell me the actual label(s) you see and it's
  a one-line change.
- The merged PDF is handed to the background service worker as a `blob:`
  URL, not as bytes in the message itself — `chrome.runtime.sendMessage`
  has a ~64MiB payload cap that a document-heavy case's merged PDF can
  exceed as base64.
- Folder/file names are sanitized for filesystem compatibility (invalid
  characters like `\ / : * ? " < > |` are stripped) and de-duplicated if two
  cases end up with the same title.
- The extension is polite about it: there's a short pause between
  navigating from one case to the next.
- This extension only requests the `downloads`, `scripting`, `activeTab`,
  and `storage` permissions, plus host access to
  `https://efiling.gstat.gov.in/*`, and injects its content script only on
  `submittedDoc.drt`.

## Project structure

```
manifest.json     Manifest V3 extension config
background.js     Service worker: chrome.downloads calls + page-number detection (imports ocr.js)
content.js        Panel UI + the cross-page automation state machine (runs in the page)
scraper.js        Site-specific scraping: pagination, XOR-hex PDF URLs (runs in the page)
ocr.js            Page-number detection: pdf.js text layer, Tesseract.js OCR fallback
                    (imported by background.js — see "How the page-number ordering works")
content.css       Panel styling
vendor/           Bundled locally (all Apache-2.0/MIT) — no CDN dependency:
  pdf-lib.min.js         builds/merges PDFs (used by content.js)
  pdf.min.js + pdf.worker.min.js         reads PDF text/renders pages (pdf.js, used by ocr.js)
  tesseract.min.js + tesseract-worker.min.js
    + tesseract-core-lstm.{js,wasm} + eng.traineddata.gz   OCR (Tesseract.js, used by ocr.js)
```

No custom toolbar icon is bundled, so Chrome shows its default
puzzle-piece icon for this extension — purely cosmetic. Drop your own
16/48/128px PNGs into an `icons/` folder and reference them from
`manifest.json`'s `icons` / `action.default_icon` fields if you'd like one.
