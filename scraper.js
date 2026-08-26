/**
 * scraper.js
 *
 * Heuristic scraper for the GST Appellate Tribunal "Submitted Documents"
 * page (https://efiling.gstat.gov.in/submittedDoc.drt).
 *
 * The live page layout was not available while building this extension
 * (the domain is not reachable from the build environment), so this scraper
 * does not hard-code a single fixed set of CSS selectors. Instead it uses a
 * layered set of heuristics to find PDF links and group them under the case
 * they belong to, and the panel in content.js lets you review/fix the
 * result before anything is downloaded.
 *
 * Exposes a single global: window.GSTScraper.scanPage()
 */
(function (global) {
  'use strict';

  const PDF_HREF_RE = /\.pdf(?:[?#]|$)/i;
  const PDF_IN_STRING_RE = /(['"])((?:https?:\/\/|\.{0,2}\/)[^'"<>]*?\.pdf(?:\?[^'"<>]*)?)\1/i;
  const TITLE_HINT_RE = /(case|appeal|matter|party|assessee|title|petitioner|respondent|order|no\.?\s*$|number)/i;

  function absoluteUrl(href) {
    try {
      return new URL(href, document.baseURI).href;
    } catch (e) {
      return null;
    }
  }

  /** Try to resolve a plausible absolute PDF URL for a clickable element. */
  function resolvePdfUrl(el) {
    const href = el.getAttribute && el.getAttribute('href');
    if (href && href.trim() && !/^\s*javascript:/i.test(href) && href.trim() !== '#') {
      if (PDF_HREF_RE.test(href)) {
        const abs = absoluteUrl(href);
        if (abs) return abs;
      }
    }

    // Look through common attributes govt/JSP portals use for JS-driven downloads.
    const attrsToCheck = ['onclick', 'data-url', 'data-href', 'data-file', 'data-doc', 'data-path', 'title'];
    for (const attr of attrsToCheck) {
      const val = el.getAttribute && el.getAttribute(attr);
      if (!val) continue;
      const m = val.match(PDF_IN_STRING_RE);
      if (m) {
        const abs = absoluteUrl(m[2]);
        if (abs) return abs;
      }
    }

    return null;
  }

  function findPdfElements(root) {
    const candidates = root.querySelectorAll(
      'a, button, input[type="button"], input[type="submit"], span[onclick], div[onclick], td[onclick], li[onclick]'
    );
    const found = [];
    const seenEl = new Set();
    candidates.forEach((el) => {
      if (seenEl.has(el)) return;
      const url = resolvePdfUrl(el);
      if (url) {
        seenEl.add(el);
        found.push({
          el,
          url,
          text: cleanText(el.textContent) || cleanText(el.getAttribute('title')) || '',
        });
      }
    });
    return found;
  }

  function cleanText(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function filenameFromUrl(url, fallback) {
    try {
      const u = new URL(url);
      const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
      if (last) return last;
    } catch (e) {
      /* ignore */
    }
    return fallback || 'document.pdf';
  }

  function textExcludingElements(container, excludeEls) {
    const clone = container.cloneNode(true);
    // Remove the corresponding nodes in the clone by matching against a
    // fresh query - simplest robust approach: strip all anchor/button tags
    // whose text overlaps excluded ones. We instead just walk original DOM
    // and skip subtrees rooted at excluded elements.
    let out = '';
    const excludeSet = new Set(excludeEls);
    (function walk(node) {
      if (excludeSet.has(node)) return;
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.nodeValue + ' ';
        return;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        for (const child of node.childNodes) walk(child);
      }
    })(container);
    return cleanText(out);
  }

  /** Strategy 1: table rows, with support for rowSpan'd case-title cells. */
  function groupByTable(pdfItems) {
    const rowMap = new Map(); // tr -> [items]
    for (const item of pdfItems) {
      const tr = item.el.closest('tr');
      if (!tr) return null; // not all items are in a table row -> bail out of this strategy
      if (!rowMap.has(tr)) rowMap.set(tr, []);
      rowMap.get(tr).push(item);
    }

    const tables = new Set();
    rowMap.forEach((_items, tr) => {
      const table = tr.closest('table');
      if (table) tables.add(table);
    });
    if (tables.size === 0) return null;

    const groups = [];
    tables.forEach((table) => {
      const rows = Array.from(table.querySelectorAll('tr'));

      // Guess which column holds the case title, using header text hints.
      let titleColIndex = 0;
      const headerCells = Array.from(table.querySelectorAll('thead th, thead td'));
      if (headerCells.length) {
        const hintIdx = headerCells.findIndex((th) => TITLE_HINT_RE.test(cleanText(th.textContent)));
        if (hintIdx >= 0) titleColIndex = hintIdx;
      }

      // rowSpan tracking per column index so a case name merged across
      // several document rows is correctly inherited by the later rows.
      const spanCarry = new Map(); // colIndex -> { text, remaining }
      let currentTitle = null;

      rows.forEach((row) => {
        const items = rowMap.get(row) || [];
        const cells = Array.from(row.children).filter((c) => /^(td|th)$/i.test(c.tagName));
        if (!cells.length) return;

        // Decrement any carried-over rowspans that apply to this row first.
        spanCarry.forEach((carry, colIdx) => {
          if (carry.remaining > 0) {
            carry.remaining -= 1;
          }
        });

        let titleCell = cells[titleColIndex] || cells[0];
        let rowTitle = null;

        if (titleCell) {
          const linkEls = (rowMap.get(row) || []).map((it) => it.el);
          const text = textExcludingElements(titleCell, linkEls);
          if (text) {
            rowTitle = text;
            if (titleCell.rowSpan && titleCell.rowSpan > 1) {
              spanCarry.set(titleColIndex, { text, remaining: titleCell.rowSpan - 1 });
            }
          }
        }

        if (!rowTitle) {
          const carry = spanCarry.get(titleColIndex);
          if (carry && carry.text) rowTitle = carry.text;
        }

        if (rowTitle) currentTitle = rowTitle;

        if (items.length) {
          groups.push({ title: currentTitle || 'Untitled Case', items });
        }
      });
    });

    if (!groups.length) return null;
    return mergeGroupsByTitle(groups);
  }

  /** Strategy 2: nearest preceding heading-like element in document order. */
  function groupByHeading(pdfItems) {
    const itemsByEl = new Map(pdfItems.map((it) => [it.el, it]));
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null);
    let currentTitle = null;
    const buckets = new Map(); // title -> items[]
    let node = walker.currentNode;
    while (node) {
      if (itemsByEl.has(node)) {
        const key = currentTitle || 'Ungrouped Documents';
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(itemsByEl.get(node));
      } else if (isHeadingLike(node)) {
        const text = cleanText(node.textContent);
        if (text && text.length < 200) currentTitle = text;
      }
      node = walker.nextNode();
    }
    if (buckets.size === 0) return null;
    const groups = Array.from(buckets.entries()).map(([title, items]) => ({ title, items }));
    return mergeGroupsByTitle(groups);
  }

  function isHeadingLike(el) {
    if (/^H[1-6]$/.test(el.tagName)) return true;
    const cls = (el.className && String(el.className)) || '';
    const id = el.id || '';
    if (/case|title|matter|appeal|panel-heading|accordion-header|section-header|card-header/i.test(cls + ' ' + id)) {
      // Avoid treating huge wrapper containers as headings.
      return el.children.length <= 3;
    }
    return false;
  }

  /** Strategy 3 (last resort): smallest common ancestor shared by 2+ links. */
  function groupByContainer(pdfItems) {
    const groups = [];
    const used = new Set();
    for (const item of pdfItems) {
      if (used.has(item)) continue;
      const cluster = [item];
      used.add(item);
      let container = item.el.parentElement;
      // Walk up until we find a container that holds other un-clustered pdf items too.
      for (let depth = 0; depth < 6 && container; depth++, container = container.parentElement) {
        const siblingsWithPdf = pdfItems.filter(
          (other) => !used.has(other) && container.contains(other.el)
        );
        if (siblingsWithPdf.length) {
          siblingsWithPdf.forEach((s) => {
            cluster.push(s);
            used.add(s);
          });
          break;
        }
      }
      const container2 = item.el.closest('li, div, section, article') || item.el.parentElement || document.body;
      const title =
        cleanText(container2.getAttribute('title')) ||
        cleanText((container2.previousElementSibling && container2.previousElementSibling.textContent) || '') ||
        `Case ${groups.length + 1}`;
      groups.push({ title, items: cluster });
    }
    return mergeGroupsByTitle(groups);
  }

  function mergeGroupsByTitle(groups) {
    const byTitle = new Map();
    groups.forEach((g) => {
      const key = g.title || 'Untitled Case';
      if (!byTitle.has(key)) byTitle.set(key, []);
      byTitle.get(key).push(...g.items);
    });
    return Array.from(byTitle.entries()).map(([title, items]) => ({ title, items }));
  }

  function finalizeGroups(rawGroups) {
    const result = [];
    const seenTitles = new Map();
    let anonCounter = 0;

    rawGroups.forEach((g) => {
      let title = cleanText(g.title) || '';
      if (!title) {
        anonCounter += 1;
        title = `Case ${anonCounter}`;
      }
      const dupCount = seenTitles.get(title) || 0;
      seenTitles.set(title, dupCount + 1);
      const displayTitle = dupCount > 0 ? `${title} (${dupCount + 1})` : title;

      const seenUrls = new Set();
      const pdfs = [];
      g.items.forEach((it) => {
        if (seenUrls.has(it.url)) return;
        seenUrls.add(it.url);
        pdfs.push({
          url: it.url,
          filename: filenameFromUrl(it.url, (it.text || 'document') + '.pdf'),
          linkText: it.text,
          include: true,
        });
      });

      if (pdfs.length) {
        result.push({
          id: 'case-' + result.length + '-' + Math.random().toString(36).slice(2, 8),
          title: displayTitle,
          pdfs,
        });
      }
    });

    return result;
  }

  function scanPage() {
    const pdfItems = findPdfElements(document);
    if (!pdfItems.length) {
      return { strategy: 'none', groups: [] };
    }

    let groups = groupByTable(pdfItems);
    let strategy = 'table';

    if (!groups || !groups.length) {
      groups = groupByHeading(pdfItems);
      strategy = 'heading';
    }

    if (!groups || !groups.length) {
      groups = groupByContainer(pdfItems);
      strategy = 'container';
    }

    return { strategy, groups: finalizeGroups(groups || []) };
  }

  global.GSTScraper = { scanPage, resolvePdfUrl, cleanText };
})(window);
