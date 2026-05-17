import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs-extra';

export class BrowserAgent {
  constructor({ headless = false, videoDir = null, sessionId }) {
    // Force headless when running inside Docker (no display available).
    // Detected via SKOPIX_DATA_DIR which is only set in the container entrypoint.
    // Also respect the SKOPIX_HEADLESS env var as an explicit override.
    const inDocker = !!process.env.SKOPIX_DATA_DIR;
    const envOverride = process.env.SKOPIX_HEADLESS;
    if (inDocker && !envOverride) {
      this.headless = true;
    } else if (envOverride === 'true') {
      this.headless = true;
    } else if (envOverride === 'false') {
      this.headless = false;
    } else {
      this.headless = headless;
    }
    this.videoDir = videoDir;
    this.sessionId = sessionId;
    this.browser = null;
    this.context = null;
    this.page = null;
    // DOM caching
    this._cachedDOM = null;
    this._cachedURL = null;
    this._stepCount = 0;
  }

  async launch() {
    this.browser = await chromium.launch({
      headless: this.headless,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--disable-features=IsolateOrigins,site-per-process,SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure',
        '--disable-site-isolation-trials',
        '--allow-insecure-localhost',
      ],
    });

    const contextOptions = {
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-GB',
    };

    if (this.videoDir) {
      await fs.ensureDir(this.videoDir);
      contextOptions.recordVideo = { dir: this.videoDir, size: { width: 1280, height: 800 } };
    }

    this.context = await this.browser.newContext(contextOptions);
    this.page = await this.context.newPage();

    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    this.consoleErrors = [];
    this.page.on('console', (msg) => {
      if (msg.type() === 'error') this.consoleErrors.push(msg.text());
    });

    this.networkErrors = [];
    this.page.on('response', (response) => {
      if (response.status() >= 400) {
        this.networkErrors.push({ url: response.url(), status: response.status() });
      }
    });
  }

  async goto(url) {
    if (!url.startsWith('http')) url = 'https://' + url;
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page.waitForTimeout(2000);
    this._cachedDOM = null; // clear cache on navigation
  }

  async currentUrl() {
    return this.page.url();
  }

  async screenshot(filePath) {
    try {
      await this.page.screenshot({ path: filePath, fullPage: false });
      return filePath;
    } catch {
      return null;
    }
  }

  async extractDOM() {
    this._stepCount++;
    const currentUrl = await this.page.url();
    const urlChanged = currentUrl !== this._cachedURL;
    const previousTitle = this._cachedTitle;

    // Always do full extraction
    const raw = await this._extractRawDOM();

    // Compress the DOM - remove noise and deduplicate
    const compressed = this._compressDOM(raw);

    // On first step or URL change: full snapshot
    if (!this._cachedDOM || urlChanged || this._stepCount <= 1) {
      this._cachedDOM = compressed;
      this._cachedURL = currentUrl;
      this._cachedTitle = raw.title;
      return {
        raw,
        text: this._serialise(compressed, false, null, previousTitle),
      };
    }

    const diff = this._diffDOM(this._cachedDOM, compressed);
    diff.titleChanged = previousTitle !== raw.title;
    diff.previousTitle = previousTitle;
    this._cachedDOM = compressed;
    this._cachedURL = currentUrl;
    this._cachedTitle = raw.title;

    return {
      raw,
      text: this._serialise(compressed, true, diff, previousTitle),
    };
  }

  async _extractRawDOM() {
    const result = await this.page.evaluate(() => {
      const interactive = [];

      function getText(el) {
        return (el.textContent || el.innerText || el.value || el.placeholder || el.alt || el.title || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      }

      function getRole(el) {
        return el.getAttribute('role') || el.tagName.toLowerCase();
      }

      function isRedOrWarning(el) {
        try {
          const style = window.getComputedStyle(el);
          const combined = (style.color + style.backgroundColor).toLowerCase();
          if (combined.includes('rgb(255, 0') || combined.includes('rgb(220') || combined.includes('rgb(239') || combined.includes('rgb(211')) return true;
          const cls = (el.className || '').toLowerCase();
          if (cls.includes('warn') || cls.includes('error') || cls.includes('danger') || cls.includes('alert') || cls.includes('critical')) return true;
          return false;
        } catch { return false; }
      }

      const seen = new Set();
      const selectors = [
        'a[href]', 'button', 'input', 'select', 'textarea',
        '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]',
        '[onclick]', '[tabindex]', 'svg', 'i[class]', 'span[class]', 'div[class]',
      ];

      document.querySelectorAll(selectors.join(',')).forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        if (rect.width > 600 && rect.height > 400) return;
        if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'SVG') return;

        const key = Math.round(rect.x) + ',' + Math.round(rect.y) + ',' + Math.round(rect.width);
        if (seen.has(key)) return;
        seen.add(key);

        const cls = typeof el.className === 'string' ? el.className : '';
        const text = getText(el);
        const ariaLabel = el.getAttribute('aria-label') || '';
        const title = el.getAttribute('title') || '';
        const isSmall = rect.width < 80 && rect.height < 80;
        const hasMeaning = text || ariaLabel || title || isRedOrWarning(el) || cls.includes('icon') || cls.includes('btn') || cls.includes('warn') || cls.includes('error');

        if (!isSmall && !hasMeaning) return;

        interactive.push({
          tag: el.tagName.toLowerCase(),
          type: el.type || null,
          text: text.slice(0, 60),
          cls: cls.slice(0, 100),
          ariaLabel: ariaLabel.slice(0, 60),
          title: title.slice(0, 60),
          disabled: el.disabled || false,
          isWarning: isRedOrWarning(el),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        });
      });

      // Content - only headings and visible error/alert text
      const content = [];
      document.querySelectorAll('h1,h2,h3,h4,[role="heading"],[class*="error"],[class*="warning"],[class*="exception"],[class*="alert"]').forEach((el) => {
        const text = getText(el);
        if (text.length > 3) content.push({ tag: el.tagName.toLowerCase(), text });
      });

      // Overlays - tooltips, modals, popups
      const overlays = [];
      document.querySelectorAll('[class*="tooltip"],[class*="modal"],[class*="popup"],[class*="dialog"],[role="dialog"],[role="tooltip"]').forEach((el) => {
        const text = getText(el);
        if (text.length > 3) overlays.push(text);
      });

      const alerts = [];
      document.querySelectorAll('[role="alert"],.error,.alert,[class*="error"],[class*="exception"]').forEach((el) => {
        const text = getText(el);
        if (text.length > 3) alerts.push(text);
      });

      const forms = Array.from(document.forms).map((f) => ({
        action: f.action,
        fields: Array.from(f.elements).map((e) => ({
          id: e.id, name: e.name, type: e.type, placeholder: e.placeholder, required: e.required,
          label: (function() {
            if (e.id) {
              const lbl = document.querySelector('label[for="' + e.id + '"]');
              if (lbl) return (lbl.textContent || '').trim().slice(0, 50);
            }
            return '';
          })(),
          value: e.type === 'password' ? '[hidden]' : (e.value || '').slice(0, 40),
        })),
      }));

      // Change 5 (v2): hierarchical navigation tree extraction.
      // Detects standard navs PLUS Bootstrap list-group, custom collapsible widgets,
      // FontAwesome chevron icons, and any repeated category-style structures.
      const navTree = (function buildNavTree() {
        const items = [];

        // Helper: visible check, doesn't trust just rect (CSS visibility/opacity matter too)
        function isVisible(el) {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          try {
            const cs = window.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
          } catch {}
          return true;
        }

        // 1) Find containers. Three tiers of broadness:
        //    Tier A: explicit nav semantics (nav, aside, role=navigation, etc.)
        //    Tier B: well-known class patterns (sidebar, menu, tree, categories, collapsible, list-group)
        //    Tier C: structural fallback (any container with 3+ similar repeating children that look clickable)
        const containers = new Set();

        const tierASelectors = [
          'nav', 'aside',
          '[role="navigation"]', '[role="tree"]', '[role="menu"]', '[role="listbox"]',
        ];
        const tierBSelectors = [
          '[class*="sidebar" i]', '[class*="side-bar" i]',
          '[class*="sidenav" i]', '[class*="side-nav" i]',
          '[class*="navmenu" i]', '[class*="nav-menu" i]',
          '[class*="category-list" i]', '[class*="categories" i]',
          '[class*="tree" i]', '[class*="menu-tree" i]',
          '[class*="list-group" i]', '[class*="listgroup" i]',
          '[class*="collapsible" i]', '[class*="collapse-list" i]',
          '[class*="accordion" i]',
          '[id*="sidebar" i]', '[id*="nav" i]', '[id*="menu" i]',
        ];
        for (const sel of [...tierASelectors, ...tierBSelectors]) {
          try {
            document.querySelectorAll(sel).forEach(c => {
              if (isVisible(c)) containers.add(c);
            });
          } catch {}
        }

        // Tier C fallback: find any element with 3+ similar repeating children (sibling pattern).
        // This catches custom widgets like Panintelligence's that don't match standard class names.
        // We look for a parent whose direct children share a common class prefix.
        if (containers.size < 2) {
          const allCandidates = document.querySelectorAll('div, ul, section');
          for (const parent of allCandidates) {
            if (!isVisible(parent)) continue;
            const r = parent.getBoundingClientRect();
            // Heuristic: must be reasonably sized and not the whole page
            if (r.width < 100 || r.width > 700) continue;
            if (r.height < 100) continue;
            const children = Array.from(parent.children).filter(c => isVisible(c));
            if (children.length < 3) continue;
            // Compare first-child class prefix
            const firstCls = ((children[0].className || '') + '').split(/\s+/)[0] || '';
            if (!firstCls || firstCls.length < 4) continue;
            const matching = children.filter(c => ((c.className || '') + '').includes(firstCls)).length;
            if (matching / children.length < 0.6) continue;
            containers.add(parent);
          }
        }

        // 2) Detect expandable state for an item
        function isExpandable(el) {
          if (!el) return null;
          // Strongest: aria-expanded
          const aria = el.getAttribute('aria-expanded');
          if (aria !== null) return { expandable: true, expanded: aria === 'true' };

          // Check for FontAwesome / icon chevrons that toggle visibility
          // Pattern: two sibling icons, one for collapsed state, one for expanded.
          // Whichever is visible tells us the current state.
          const chevronDown = el.querySelector('[class*="chevron-down" i], [class*="caret-down" i], [class*="angle-down" i], [class*="arrow-down" i]');
          const chevronRight = el.querySelector('[class*="chevron-right" i], [class*="caret-right" i], [class*="angle-right" i], [class*="arrow-right" i]');
          const chevronUp = el.querySelector('[class*="chevron-up" i], [class*="caret-up" i], [class*="angle-up" i], [class*="arrow-up" i]');
          if (chevronDown || chevronRight || chevronUp) {
            // Determine which one is visible
            const downVisible = chevronDown && isVisible(chevronDown);
            const rightVisible = chevronRight && isVisible(chevronRight);
            const upVisible = chevronUp && isVisible(chevronUp);
            // chevron-down OR chevron-up shown = expanded
            // chevron-right shown = collapsed
            if (downVisible || upVisible) return { expandable: true, expanded: true };
            if (rightVisible) return { expandable: true, expanded: false };
            // Both exist but we couldn't determine visibility - assume collapsed (safer default)
            return { expandable: true, expanded: false };
          }

          // Generic class hints
          const cls = ((el.className || '') + '').toLowerCase();
          const hasChevronClass = /\b(chevron|caret|arrow|toggle|expand|collapse|disclosure)\b/.test(cls);
          const hasChevronChild = el.querySelector('[class*="chevron" i], [class*="caret" i], [class*="arrow" i], [class*="expand" i]');
          const hasChevronUnicode = /[▸▶▾▼►▽]/.test(el.textContent || '');
          if (hasChevronClass || hasChevronChild || hasChevronUnicode) {
            const expanded = /\b(open|expanded|active|in)\b/.test(cls);
            return { expandable: true, expanded: !!expanded };
          }

          // Nested UL/OL/div that's currently hidden = collapsed expandable
          const nested = el.querySelector(':scope > ul, :scope > ol, :scope > div > ul, :scope > [class*="submenu" i], :scope > [class*="children" i]');
          if (nested) {
            return { expandable: true, expanded: isVisible(nested) };
          }

          // Has a data-toggle attribute (Bootstrap collapse pattern)
          if (el.getAttribute('data-toggle') === 'collapse' || el.hasAttribute('data-bs-toggle')) {
            return { expandable: true, expanded: false };
          }

          return null;
        }

        function getItemText(el) {
          // Try most-specific labels first
          // 1. title attribute on element or its labelled span
          const titleSpan = el.querySelector('[title]');
          if (titleSpan && titleSpan.title && titleSpan.title.length > 1) return titleSpan.title.slice(0, 60);
          if (el.title && el.title.length > 1) return el.title.slice(0, 60);
          // 2. aria-label
          const aria = el.getAttribute('aria-label');
          if (aria && aria.length > 1) return aria.slice(0, 60);
          // 3. direct text nodes on the element itself (not descendants)
          const ownText = Array.from(el.childNodes)
            .filter(n => n.nodeType === 3)
            .map(n => n.textContent || '')
            .join(' ').trim();
          if (ownText.length > 2) return ownText.slice(0, 60);
          // 4. First label-bearing span/anchor
          const span = el.querySelector('span, a, [class*="label" i], [class*="title" i], [class*="name" i], [class*="text" i]');
          if (span) {
            const t = (span.textContent || '').trim();
            if (t.length > 0) return t.slice(0, 60);
          }
          // 5. Last resort: all text content
          return (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
        }

        function buildPath(el, container) {
          const labels = [];
          let cur = el.parentElement;
          let depth = 0;
          while (cur && cur !== container && depth < 6) {
            const role = cur.getAttribute && cur.getAttribute('role');
            const isPotentialParent = cur.tagName === 'LI' || role === 'treeitem' || role === 'menuitem' ||
              ((cur.className || '') + '').toLowerCase().match(/\b(list-group-item|category|menu-item|nav-item|collapsible-item)\b/);
            if (isPotentialParent) {
              const parentLabel = getItemText(cur);
              if (parentLabel && parentLabel.length > 1) labels.unshift(parentLabel);
            }
            cur = cur.parentElement;
            depth++;
          }
          return labels;
        }

        // 3) Walk each container and collect items
        // First pass: items by recognised selectors. These are the "obvious" nav items.
        const explicitItemSelectors = [
          'a[href]', 'li',
          '[role="menuitem"]', '[role="treeitem"]', '[role="option"]', '[role="button"]',
          '[class*="menu-item" i]', '[class*="nav-item" i]',
          '[class*="list-group-item" i]:not([class*="chevron" i]):not([class*="icon" i])',
          '[class*="listgroup-item" i]',
          '[class*="collapsible-item" i]',
          '[onclick]', '[ng-click]',
          // Test-id attributes are strong nav-item signals on custom widgets
          '[pi-test-identifier]', '[data-testid]', '[data-test]',
        ].join(',');

        function isItemLike(el) {
          // Heuristic for divs / spans that look like nav items even without classes
          if (!el || !el.tagName) return false;
          // Skip leaf icons or pure-text spans that are children of other items
          if (el.tagName === 'I' || el.tagName === 'SVG') return false;
          // Must have direct text content OR a child with text + a clickable behaviour
          const hasIdentifier = el.hasAttribute('pi-test-identifier') || el.hasAttribute('data-testid') || el.hasAttribute('data-test');
          if (hasIdentifier) return true;
          return false;
        }

        containers.forEach(container => {
          let candidates;
          try { candidates = Array.from(container.querySelectorAll(explicitItemSelectors)); }
          catch { return; }

          // Second pass: also walk children of container looking for item-like divs
          // (e.g. <div pi-test-identifier="..."> without a recognised class)
          try {
            container.querySelectorAll('div, span').forEach(el => {
              if (isItemLike(el)) candidates.push(el);
            });
          } catch {}

          candidates.forEach(el => {
            if (!isVisible(el)) return;
            const text = getItemText(el);
            if (!text || text.length < 1) return;
            // Avoid emitting things that are themselves the container
            if (containers.has(el)) return;
            // Avoid emitting standalone chevron icons even if they slipped through
            const tag = el.tagName.toLowerCase();
            if (tag === 'i' || tag === 'svg') return;
            // Avoid emitting spans/icons that are children of another item we've already captured
            // (we want the outer clickable, not the label inside it)
            const cls = ((el.className || '') + '').toLowerCase();
            if (cls.match(/\b(chevron|caret|arrow|icon|fa-)\b/)) return;
            const parents = buildPath(el, container);
            const exp = isExpandable(el);
            // Generate a stable selector
            let selector = null;
            if (el.id) selector = '#' + el.id;
            else if (el.tagName === 'A' && el.href) selector = 'a[href="' + el.href + '"]';
            else if (el.getAttribute('pi-test-identifier')) selector = '[pi-test-identifier="' + el.getAttribute('pi-test-identifier') + '"]';
            else if (el.getAttribute('data-testid')) selector = '[data-testid="' + el.getAttribute('data-testid') + '"]';
            else if (el.getAttribute('data-test')) selector = '[data-test="' + el.getAttribute('data-test') + '"]';
            const r = el.getBoundingClientRect();
            items.push({
              text, parents, depth: parents.length,
              x: Math.round(r.x), y: Math.round(r.y),
              w: Math.round(r.width), h: Math.round(r.height),
              expandable: exp ? exp.expandable : false,
              expanded: exp ? exp.expanded : false,
              tag: el.tagName.toLowerCase(),
              selector,
            });
          });
        });

        // Deduplicate by text + depth + approximate y position
        const seen = new Set();
        const deduped = [];
        for (const it of items) {
          const key = it.text + '|' + it.depth + '|' + Math.round(it.y / 10);
          if (seen.has(key)) continue;
          seen.add(key);
          deduped.push(it);
        }
        return deduped;
      })();

      return {
        url: window.location.href,
        title: document.title,
        interactive: interactive.slice(0, 100),
        content: content.slice(0, 20),
        overlays: overlays.slice(0, 5),
        alerts: alerts.slice(0, 8),
        forms,
        navTree: navTree.slice(0, 60),
      };
    });

    // Add console/network errors
    result.consoleErrors = (this.consoleErrors || []).slice(-3);
    result.networkErrors = (this.networkErrors || []).slice(-3);
    return result;
  }

  _compressDOM(raw) {
    // Deduplicate interactive elements that are identical in text+class
    const seen = new Map();
    const deduped = [];
    for (const el of raw.interactive) {
      const key = el.tag + '|' + el.text + '|' + el.cls.slice(0, 40);
      if (seen.has(key)) {
        seen.get(key).count = (seen.get(key).count || 1) + 1;
        continue;
      }
      const item = { ...el };
      seen.set(key, item);
      deduped.push(item);
    }

    // Group nav/sidebar items - if more than 5 similar items collapse them
    const navItems = deduped.filter(el => el.x < 280 && !el.isWarning);
    const mainItems = deduped.filter(el => el.x >= 280 || el.isWarning);

    return {
      ...raw,
      interactive: deduped,
      navItems: navItems.slice(0, 15),
      mainItems: mainItems.slice(0, 50),
      navTree: raw.navTree || [], // pass through from raw extraction
    };
  }

  _diffDOM(prev, curr) {
    const diff = { added: [], removed: [], changed: [], overlaysChanged: false, alertsChanged: false };

    // Check for new/removed elements by text+position key
    const prevKeys = new Set(prev.interactive.map(e => e.tag + '|' + e.text + '|' + e.x + ',' + e.y));
    const currKeys = new Set(curr.interactive.map(e => e.tag + '|' + e.text + '|' + e.x + ',' + e.y));

    curr.interactive.forEach(el => {
      const key = el.tag + '|' + el.text + '|' + el.x + ',' + el.y;
      if (!prevKeys.has(key)) diff.added.push(el);
    });

    prev.interactive.forEach(el => {
      const key = el.tag + '|' + el.text + '|' + el.x + ',' + el.y;
      if (!currKeys.has(key)) diff.removed.push({ tag: el.tag, text: el.text });
    });

    // Check overlays and alerts changed
    const prevOverlays = JSON.stringify(prev.overlays);
    const currOverlays = JSON.stringify(curr.overlays);
    diff.overlaysChanged = prevOverlays !== currOverlays;
    diff.newOverlays = curr.overlays;

    const prevAlerts = JSON.stringify(prev.alerts);
    const currAlerts = JSON.stringify(curr.alerts);
    diff.alertsChanged = prevAlerts !== currAlerts;
    diff.newAlerts = curr.alerts;

    return diff;
  }

  _serialise(dom, isDiff, diff, previousTitle) {
    const lines = [
      'PAGE: ' + dom.title,
      'URL: ' + dom.url,
    ];

    if (isDiff && diff && diff.titleChanged) {
      lines.push('*** PAGE TITLE CHANGED FROM "' + (previousTitle || '') + '" TO "' + dom.title + '" - This usually means navigation succeeded! Set goalAchieved if appropriate. ***');
    }
    lines.push('');

    if (isDiff && diff) {
      lines.push('--- PAGE CHANGES SINCE LAST STEP ---');

      if (diff.added.length === 0 && diff.removed.length === 0 && !diff.overlaysChanged && !diff.alertsChanged) {
        lines.push('(no changes detected)');
      }

      if (diff.added.length > 0) {
        lines.push('NEW ELEMENTS:');
        diff.added.slice(0, 20).forEach(el => {
          const label = el.ariaLabel || el.title || el.text || '(no label)';
          const warn = el.isWarning ? ' WARNING-STYLED' : '';
          lines.push('  + ' + el.tag + ' | "' + label + '" | class:"' + el.cls.slice(0, 60) + '" | pos:(' + el.x + ',' + el.y + ') | size:' + el.w + 'x' + el.h + warn);
        });
      }

      if (diff.removed.length > 0) {
        lines.push('REMOVED ELEMENTS:');
        diff.removed.slice(0, 10).forEach(el => {
          lines.push('  - ' + el.tag + ' | "' + el.text + '"');
        });
      }

      if (diff.overlaysChanged && diff.newOverlays.length > 0) {
        lines.push('OVERLAY/TOOLTIP/MODAL TEXT:');
        diff.newOverlays.forEach(t => lines.push('  OVERLAY: ' + t));
      }

      if (diff.alertsChanged && diff.newAlerts.length > 0) {
        lines.push('ALERTS/ERRORS:');
        diff.newAlerts.forEach(a => lines.push('  ALERT: ' + a));
      }

      // After expansion, the nav tree often has NEW items revealed.
      // Show the current full nav tree on every step so the LLM can see expanded children.
      if (dom.navTree && dom.navTree.length > 0) {
        lines.push('', '--- NAVIGATION/SIDEBAR (current state) ---');
        dom.navTree.forEach((it, i) => {
          const indent = '  '.repeat(it.depth);
          const hints = [];
          if (it.expandable && !it.expanded) hints.push('[expandable, COLLAPSED - click to reveal children]');
          else if (it.expandable && it.expanded) hints.push('[expandable, expanded]');
          const path = it.parents.length > 0 ? ' under: ' + it.parents.join(' > ') : '';
          const sel = it.selector ? ' selector:"' + it.selector + '"' : '';
          lines.push('[nav-' + i + '] ' + indent + it.tag + ' | "' + it.text + '"' + path + sel + ' ' + hints.join(' '));
        });
      }

      // Always include form fields with their selectors - critical for TYPE actions
      if (dom.forms && dom.forms.length > 0) {
        lines.push('', '--- FORM FIELDS (always use the id selector for TYPE/SELECT) ---');
        dom.forms.forEach(f => {
          f.fields.forEach(field => {
            if (!field.type || field.type === 'hidden' || field.type === 'submit' || field.type === 'button') return;
            const targetSel = field.id ? '#' + field.id : (field.name ? '[name="' + field.name + '"]' : '');
            if (!targetSel) return;
            lines.push('  TARGET: "' + targetSel + '" | label:"' + (field.label || '') + '" | type:' + field.type + ' | value:"' + (field.value || '') + '"' + (field.required ? ' REQUIRED' : ''));
          });
        });
      }

      // Always include warning-styled elements regardless of diff
      const warnings = dom.mainItems.filter(el => el.isWarning);
      if (warnings.length > 0) {
        lines.push('', 'WARNING/ERROR ELEMENTS (always shown):');
        warnings.forEach(el => {
          const label = el.ariaLabel || el.title || el.text || '(no label)';
          lines.push('  ! ' + el.tag + ' | "' + label + '" | class:"' + el.cls.slice(0, 60) + '" | pos:(' + el.x + ',' + el.y + ') | size:' + el.w + 'x' + el.h);
        });
      }

    } else {
      // Full snapshot on first step
      lines.push('--- NAVIGATION/SIDEBAR ---');
      // Prefer the hierarchical nav tree when available (gives the LLM parent/child + expandable hints)
      if (dom.navTree && dom.navTree.length > 0) {
        dom.navTree.forEach((it, i) => {
          const indent = '  '.repeat(it.depth);
          const hints = [];
          if (it.expandable && !it.expanded) hints.push('[expandable, COLLAPSED - click to reveal children]');
          else if (it.expandable && it.expanded) hints.push('[expandable, expanded]');
          const path = it.parents.length > 0 ? ' under: ' + it.parents.join(' > ') : '';
          const sel = it.selector ? ' selector:"' + it.selector + '"' : '';
          lines.push('[nav-' + i + '] ' + indent + it.tag + ' | "' + it.text + '"' + path + sel + ' | pos:(' + it.x + ',' + it.y + ') ' + hints.join(' '));
        });
      } else {
        // Fallback to the old flat navItems list
        dom.navItems.forEach((el, i) => {
          const label = el.ariaLabel || el.title || el.text || '(no label)';
          lines.push('[nav-' + i + '] ' + el.tag + ' | "' + label + '" | pos:(' + el.x + ',' + el.y + ')');
        });
      }

      lines.push('', '--- MAIN CONTENT ELEMENTS ---');
      dom.mainItems.forEach((el, i) => {
        const label = el.ariaLabel || el.title || el.text || '(no label)';
        const warn = el.isWarning ? ' WARNING-STYLED' : '';
        lines.push('[' + i + '] ' + el.tag + ' | "' + label + '" | class:"' + el.cls.slice(0, 60) + '" | pos:(' + el.x + ',' + el.y + ') | size:' + el.w + 'x' + el.h + warn);
      });

      if (dom.forms && dom.forms.length > 0) {
        lines.push('', '--- FORM FIELDS (use the id as the target for TYPE/SELECT actions) ---');
        dom.forms.forEach(f => {
          f.fields.forEach(field => {
            if (!field.type || field.type === 'hidden' || field.type === 'submit' || field.type === 'button') return;
            const targetSel = field.id ? '#' + field.id : (field.name ? '[name="' + field.name + '"]' : '');
            if (!targetSel) return;
            lines.push('  TARGET: "' + targetSel + '" | label:"' + (field.label || '') + '" | type:' + field.type + ' | placeholder:"' + (field.placeholder || '') + '" | value:"' + (field.value || '') + '"' + (field.required ? ' REQUIRED' : ''));
          });
        });
      }

      if (dom.content.length > 0) {
        lines.push('', '--- PAGE CONTENT ---');
        dom.content.forEach(c => lines.push(c.tag + ': ' + c.text));
      }

      if (dom.overlays.length > 0) {
        lines.push('', '--- OVERLAYS/TOOLTIPS ---');
        dom.overlays.forEach(t => lines.push('  OVERLAY: ' + t));
      }

      if (dom.alerts.length > 0) {
        lines.push('', '--- ALERTS/ERRORS ---');
        dom.alerts.forEach(a => lines.push('  ALERT: ' + a));
      }
    }

    if (dom.consoleErrors && dom.consoleErrors.length > 0) {
      lines.push('', '--- CONSOLE ERRORS ---');
      dom.consoleErrors.forEach(e => lines.push('  JS: ' + e));
    }

    if (dom.networkErrors && dom.networkErrors.length > 0) {
      lines.push('', '--- NETWORK ERRORS ---');
      dom.networkErrors.forEach(e => lines.push('  HTTP ' + e.status + ': ' + e.url));
    }

    return lines.join('\n');
  }

  async _waitForStable() {
    // Adaptive wait - waits for network idle, capped at 3s for slow pages
    try {
      await Promise.race([
        this.page.waitForLoadState('networkidle', { timeout: 3000 }),
        this.page.waitForTimeout(3000),
      ]);
    } catch {
      // networkidle timed out, that's fine
    }
    // Always give DOM at least 400ms to settle for animations
    await this.page.waitForTimeout(400);
  }

  async executeAction(decision) {
    const { action, target, value } = decision;

    if (['CLICK', 'TYPE', 'SELECT', 'PRESS', 'NAVIGATE', 'CLICK_AT', 'BATCH'].includes(action)) {
      this._cachedDOM = null;
    }

    // Handle BATCH - execute multiple actions in sequence
    if (action === 'BATCH' && Array.isArray(decision.actions)) {
      const results = [];
      for (const subAction of decision.actions) {
        const subResult = await this.executeAction(subAction);
        results.push({ action: subAction.action, target: subAction.target, ...subResult });
        if (!subResult.success) break; // stop batch on first failure
      }
      const allSucceeded = results.every(r => r.success);
      return {
        success: allSucceeded,
        batchResults: results,
        error: allSucceeded ? null : 'Batch stopped at: ' + (results.find(r => !r.success)?.action || 'unknown'),
      };
    }

    try {
      switch (action) {
        case 'CLICK': {
          const el = await this._resolveElement(target);
          if (!el) throw new Error('Element not found: ' + target);
          try {
            await el.scrollIntoViewIfNeeded({ timeout: 2000 });
          } catch {}

          // Change 4: pre-submit form completeness check.
          // If this looks like a submit button, scan the containing form for empty
          // required inputs. If any are empty, refuse the click and surface a clear
          // error - the LLM sees this in history and re-plans to fill the missing field.
          const targetLowerEarly = (target || '').toLowerCase();
          const looksLikeSubmitEarly = targetLowerEarly.includes('login') || targetLowerEarly.includes('submit') || targetLowerEarly.includes('sign in') || targetLowerEarly.includes('sign up') || targetLowerEarly.includes('continue') || targetLowerEarly.includes('register') || targetLowerEarly.includes('next');
          if (looksLikeSubmitEarly) {
            try {
              const emptyRequired = await this.page.evaluate(() => {
                // Find the most relevant form: visible, has required inputs.
                const forms = Array.from(document.forms);
                if (forms.length === 0) return [];
                // Pick the first visible form
                const form = forms.find(f => {
                  const r = f.getBoundingClientRect();
                  return r.width > 0 && r.height > 0;
                }) || forms[0];
                const empties = [];
                for (const field of Array.from(form.elements)) {
                  // Skip non-input things, hidden inputs, disabled, buttons
                  if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(field.tagName)) continue;
                  if (field.type === 'hidden' || field.type === 'submit' || field.type === 'button') continue;
                  if (field.disabled) continue;
                  // Only consider visible fields
                  const r = field.getBoundingClientRect();
                  if (r.width === 0 || r.height === 0) continue;
                  // Only consider those that look required (required attr, aria-required, or labelled required)
                  const isRequired = field.required || field.getAttribute('aria-required') === 'true';
                  if (!isRequired) continue;
                  const value = (field.value || '').trim();
                  if (value.length === 0) {
                    const id = field.id || field.name || field.type || field.tagName;
                    empties.push(id);
                  }
                }
                return empties;
              });
              if (emptyRequired && emptyRequired.length > 0) {
                throw new Error('Form has empty required field(s): ' + emptyRequired.join(', ') + '. Fill these before submitting.');
              }
            } catch (err) {
              // Only rethrow the "empty required" error - other evaluate errors we swallow
              if (err.message && err.message.includes('empty required')) throw err;
            }
          }

          // Capture state before click to verify it actually did something
          const urlBefore = this.page.url();
          const titleBefore = await this.page.title();

          try {
            await el.click({ timeout: 5000 });
          } catch (err) {
            await el.click({ timeout: 3000, force: true });
          }
          await this._waitForStable();

          // Check if click did anything visible
          const urlAfter = this.page.url();
          const titleAfter = await this.page.title();
          const targetLower = (target || '').toLowerCase();
          const looksLikeSubmit = targetLower.includes('login') || targetLower.includes('submit') || targetLower.includes('sign in') || targetLower.includes('continue') || targetLower.includes('next');

          // If click was on a submit-like button but nothing changed, try submitting the form as a fallback
          if (looksLikeSubmit && urlBefore === urlAfter && titleBefore === titleAfter) {
            try {
              const submitted = await this.page.evaluate(() => {
                const form = document.querySelector('form');
                if (form) {
                  // Try native submit first
                  if (typeof form.requestSubmit === 'function') {
                    form.requestSubmit();
                  } else {
                    form.submit();
                  }
                  return true;
                }
                return false;
              });
              if (submitted) {
                await this._waitForStable();
              }
            } catch {}

            // Also try pressing Enter on the password field as another fallback
            const stillSamePage = this.page.url() === urlBefore;
            if (stillSamePage) {
              try {
                const passwordField = await this.page.locator('input[type="password"]').first();
                if (await passwordField.count() > 0) {
                  await passwordField.focus();
                  await this.page.keyboard.press('Enter');
                  await this._waitForStable();
                }
              } catch {}
            }
          }

          return { success: true };
        }
        case 'TYPE': {
          let el = null;
          const directTries = [
            () => this.page.locator('input[id="' + target.replace('#','') + '"]').first(),
            () => this.page.locator(target).first(),
            () => this.page.getByPlaceholder(target).first(),
            () => this.page.getByLabel(target).first(),
            () => this.page.locator('input, textarea').filter({ hasText: target }).first(),
            () => this.page.locator('input[name="' + target + '"]').first(),
          ];
          for (const t of directTries) {
            try {
              const candidate = t();
              if (await candidate.count() > 0 && await candidate.isVisible().catch(() => false)) {
                el = candidate;
                break;
              }
            } catch { continue; }
          }
          if (!el) el = await this._resolveElement(target);
          if (!el) throw new Error('Element not found: ' + target);
          // Use focus+type instead of fill to trigger framework input events properly
          await el.click({ force: true });
          await this.page.waitForTimeout(50);
          await el.fill('');
          const expectedValue = value || '';
          await el.type(expectedValue, { delay: 20 });
          await this.page.waitForTimeout(150);

          // Change 3: verify value actually landed. Some apps swallow input events;
          // we want to know NOW rather than discovering it later via a failed login.
          // We skip the check for password fields and any element that doesn't expose .inputValue()
          let elementType = null;
          try { elementType = (await el.getAttribute('type')) || null; } catch {}
          const isPasswordField = elementType === 'password';
          if (!isPasswordField && expectedValue.length > 0) {
            let actualValue = null;
            try { actualValue = await el.inputValue({ timeout: 500 }); } catch {}
            if (actualValue !== null && actualValue !== expectedValue) {
              // Retry once with a longer delay and a fill() instead of type()
              try { await el.fill(''); } catch {}
              try { await el.fill(expectedValue); } catch {}
              await this.page.waitForTimeout(200);
              let retryValue = null;
              try { retryValue = await el.inputValue({ timeout: 500 }); } catch {}
              if (retryValue !== null && retryValue !== expectedValue) {
                throw new Error('TYPE verification failed for ' + target + ': expected "' + expectedValue.slice(0,30) + '" but field contains "' + (retryValue || '').slice(0,30) + '"');
              }
            }
          }
          return { success: true };
        }
        case 'SELECT': {
          const el = await this._resolveElement(target);
          if (!el) throw new Error('Element not found: ' + target);
          await el.selectOption(value || '');
          await this.page.waitForTimeout(200);
          return { success: true };
        }
        case 'PRESS': {
          await this.page.keyboard.press(value || 'Enter');
          await this._waitForStable();
          return { success: true };
        }
        case 'SCROLL': {
          const direction = (value || 'down').toLowerCase();
          await this.page.evaluate((dir) => { window.scrollBy(0, dir === 'down' ? 400 : -400); }, direction);
          await this.page.waitForTimeout(200);
          return { success: true };
        }
        case 'NAVIGATE': {
          const url = value || target;
          await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await this._waitForStable();
          this._cachedDOM = null;
          return { success: true };
        }
        case 'WAIT': {
          const ms = parseInt(value) || 2000;
          await this.page.waitForTimeout(Math.min(ms, 5000));
          return { success: true };
        }
        case 'HOVER': {
          const el = await this._resolveElement(target);
          if (!el) throw new Error('Element not found: ' + target);
          await el.hover();
          await this.page.waitForTimeout(400);
          this._cachedDOM = null; // hover may reveal tooltips
          return { success: true };
        }
        case 'CLICK_AT': {
          const [cx, cy] = (target || value || '').split(',').map(Number);
          if (!isNaN(cx) && !isNaN(cy)) {
            await this.page.mouse.click(cx, cy);
            await this._waitForStable();
            return { success: true };
          }
          throw new Error('CLICK_AT requires x,y coordinates');
        }
        case 'STOP':
        case 'OBSERVE':
          return { success: true };
        default:
          return { success: false, error: 'Unknown action: ' + action };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async _resolveElement(target) {
    if (!target) return null;

    // Parse "button:Login" or "link:Submit" style targets
    let parsedRole = null;
    let parsedName = target;
    const roleMatch = target.match(/^(button|link|input|menuitem|tab):(.+)$/i);
    if (roleMatch) {
      parsedRole = roleMatch[1].toLowerCase();
      parsedName = roleMatch[2].trim();
    }

    const strategies = [
      // If parsed role:name format, try those first
      ...(parsedRole ? [
        () => this.page.getByRole(parsedRole, { name: parsedName }).first(),
        () => this.page.getByText(parsedName, { exact: false }).first(),
      ] : []),
      // Direct CSS selector
      () => this.page.locator(target).first(),
      // Text matches
      () => this.page.getByText(target, { exact: true }).first(),
      () => this.page.getByText(target, { exact: false }).first(),
      // Labels/placeholders
      () => this.page.getByLabel(target).first(),
      () => this.page.getByPlaceholder(target).first(),
      // Role-based
      () => this.page.getByRole('button', { name: target }).first(),
      () => this.page.getByRole('link', { name: target }).first(),
      // Attributes
      () => this.page.locator('[title="' + target + '"]').first(),
      () => this.page.locator('[title*="' + target + '"]').first(),
      () => this.page.locator('[aria-label*="' + target + '"]').first(),
      // Class fragment match (case-insensitive)
      () => this.page.locator('[class*="' + target.toLowerCase() + '"]').first(),
      // Look for clickable parent of an element with this text
      () => this.page.locator('button, [role="button"], a, [tabindex]').filter({ hasText: target }).first(),
      // Custom widget pattern: any DIV/SPAN that contains exactly this text and looks like a list/menu item
      () => this.page.locator('div, span').filter({ hasText: new RegExp('^\\s*' + (target||'').replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + '\\s*$') }).locator('xpath=ancestor-or-self::*[contains(@class, "list-group-item") or contains(@class, "collapsible") or contains(@class, "category") or contains(@class, "menu-item") or contains(@class, "nav-item")][1]').first(),
      // Generic: clickable ancestor (div with onclick handler, role=button, etc.) of an exact-text match
      () => this.page.locator('span, i, em').filter({ hasText: target }).locator('xpath=ancestor::*[@onclick or @ng-click or self::a or self::button or @role="button"][1]').first(),
      // Common login button patterns
      ...(target.toLowerCase().includes('login') || target.toLowerCase().includes('submit') || target.toLowerCase().includes('sign in') ? [
        () => this.page.locator('button[type="submit"]').first(),
        () => this.page.locator('[class*="login"], [class*="submit"], [class*="sign-in"]').first(),
        () => this.page.locator('paper-button, [class*="paper-button"]').first(),
      ] : []),
    ];

    for (const strategy of strategies) {
      try {
        const el = strategy();
        const count = await el.count();
        if (count > 0) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) return el;
        }
      } catch {
        continue;
      }
    }

    if (/^\d+,\d+$/.test(target)) {
      const [x, y] = target.split(',').map(Number);
      return { click: async () => this.page.mouse.click(x, y), hover: async () => this.page.mouse.move(x, y) };
    }

    return null;
  }

  async close() {
    let videoPath = null;
    try {
      if (this.page) {
        const video = this.page.video();
        if (video) videoPath = await video.path().catch(() => null);
        await this.page.close();
      }
      if (this.context) await this.context.close();
      if (this.browser) await this.browser.close();
    } catch {}
    return videoPath;
  }
}
