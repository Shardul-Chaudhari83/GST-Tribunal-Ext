# GST-Tribunal-Ext

A Chrome extension that organizes case documents from the GST Appellate
Tribunal e-filing portal's **Submitted Documents** page
(`https://efiling.gstat.gov.in/submittedDoc.drt`).

It paginates through your full case list, and for every case downloads all
of its PDF attachments, merges them into a single PDF, and saves it into a
per-case folder, producing this structure inside your normal Downloads
folder:

```
Downloads/
└── GST Appellate Tribunal/
    ├── <Case Title 1>/
    │   └── <Case Title 1>.pdf
    ├── <Case Title 2>/
    │   └── <Case Title 2>.pdf
    └── ...
```

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
   - Fetches every PDF and merges them into one,
   - Saves it as `GST Appellate Tribunal/<Case Title>/<Case Title>.pdf`
     under your browser's default Downloads folder,
   - Moves on to the next case.

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
   etc. Delete the `GST Appellate Tribunal` folder first if you want a
   clean slate.

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

## Notes & limitations

- This was built and reverse-engineered without direct access to the site
  (only screenshots, a screen recording, and pasted browser-console output
  were available), so some of it — especially exact table/column detection
  — is written defensively (matched by header text, not hard-coded
  indexes) but hasn't been run against the live site by the author. If
  something doesn't work, open the panel's automation log and DevTools
  console (errors are prefixed `[GST Organizer]`) and share what you see.
- If a case's PDF fails to download (link is stale, session expired, file
  is encrypted, etc.), that one file is skipped and the rest of that case's
  PDFs are still merged; a case with zero documents is recorded as such
  rather than treated as an error.
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
background.js     Service worker: performs the actual chrome.downloads call
content.js        Panel UI + the cross-page automation state machine
scraper.js         Site-specific scraping: pagination, XOR-hex PDF URLs
content.css        Panel styling
vendor/pdf-lib.min.js   Bundled locally (MIT licensed) — no CDN dependency
```

No custom toolbar icon is bundled, so Chrome shows its default
puzzle-piece icon for this extension — purely cosmetic. Drop your own
16/48/128px PNGs into an `icons/` folder and reference them from
`manifest.json`'s `icons` / `action.default_icon` fields if you'd like one.
