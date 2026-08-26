# GST-Tribunal-Ext

A Chrome extension that organizes case documents from the GST Appellate
Tribunal e-filing portal's **Submitted Documents** page
(`https://efiling.gstat.gov.in/submittedDoc.drt`).

For every case listed on that page, it downloads all of that case's PDF
attachments, merges them into a single PDF, and saves it into a per-case
folder, producing this structure inside your normal Downloads folder:

```
Downloads/
└── GST Appellate Tribunal/
    ├── <Case Title 1>/
    │   └── merged.pdf
    ├── <Case Title 2>/
    │   └── merged.pdf
    └── ...
```

Everything happens locally in your browser — no case data, PDFs, or
filenames are sent anywhere other than the tribunal's own site.

## Why an extension, and why "only this page"

`submittedDoc.drt` typically only shows documents for cases tied to your
logged-in e-filing session, and the PDFs are served from behind that
session's cookies. A generic script run outside the browser wouldn't have
that session, so this is built as a browser extension that runs on the page
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

1. Click **Scan Page for Cases**. The extension looks for every PDF link on
   the page and groups them by the case they belong to.
2. Review the results:
   - Edit a case's title inline if you want a different folder name.
   - Uncheck any PDF you don't want included in that case's merged file.
   - Use the **Move to…** dropdown next to a PDF if it got grouped under
     the wrong case — pick the correct case and it moves over.
   - Click **Remove case** to drop a case from the list entirely (this only
     affects the list in the panel, not the site).
3. Click **Download All (Merged PDFs)**. For each case, the extension:
   - Fetches every included PDF (using your existing logged-in session),
   - Merges them into one PDF (page order = order the links appear on the
     page),
   - Saves it as `GST Appellate Tribunal/<Case Title>/merged.pdf` under
     your browser's default Downloads folder.
4. Per-case progress and any errors (e.g. a broken link, or a PDF that
   failed to load because the session expired) are shown under each case
   card, and a final summary is shown at the bottom of the panel.

## How the scraping works

The exact HTML structure of `submittedDoc.drt` wasn't available while
building this extension (the domain isn't reachable from the build
environment), so `scraper.js` doesn't rely on one fixed set of CSS
selectors. Instead it layers a few heuristics, in order, and uses whichever
one successfully accounts for the PDF links on the page:

1. **Table rows** — if the PDF links live in a `<table>`, PDFs are grouped
   by row, with support for a case-name cell that spans multiple rows via
   `rowspan` (a common pattern for "one case, many documents" tables).
2. **Headings** — if there's no table, each PDF link is grouped under the
   nearest preceding heading-like element (`<h1>`–`<h6>`, or an element
   whose class/id suggests it's a case/section title).
3. **Nearest shared container** — as a last resort, PDF links are clustered
   by the smallest containing element they share with other nearby links.

Because a heuristic can't be guaranteed to match a page it has never seen,
the review step (editable titles, per-PDF include checkbox, and the
**Move to…** control) exists specifically so you can correct any
mis-grouping before anything is downloaded. If the scraper doesn't find any
PDFs at all, make sure the page/table has fully finished loading before
clicking **Scan Page for Cases**.

## Notes & limitations

- The merge order within a case is the order its PDF links appear on the
  page.
- If a case's PDF fails to download (link is stale, session expired, file
  is encrypted, etc.), that one file is skipped and noted in the case's
  status line — the rest of that case's PDFs are still merged.
- Folder/file names are sanitized for filesystem compatibility (invalid
  characters like `\ / : * ? " < > |` are stripped) and de-duplicated if two
  cases end up with the same name.
- This extension only requests the `downloads`, `scripting`, and
  `activeTab` permissions, plus host access to
  `https://efiling.gstat.gov.in/*`, and injects its content script only on
  `submittedDoc.drt`.

## Project structure

```
manifest.json     Manifest V3 extension config
background.js     Service worker: performs the actual chrome.downloads call
content.js        Injects the review panel; fetches, merges, and saves PDFs
scraper.js         Heuristic case/PDF grouping logic (see above)
content.css        Panel styling
vendor/pdf-lib.min.js   Bundled locally (MIT licensed) — no CDN dependency
```

No custom toolbar icon is bundled, so Chrome shows its default
puzzle-piece icon for this extension — purely cosmetic. Drop your own
16/48/128px PNGs into an `icons/` folder and reference them from
`manifest.json`'s `icons` / `action.default_icon` fields if you'd like one.
