import { chromium } from 'playwright';
import fs from 'fs-extra';
import path from 'path';

export class RecordingSession {
  constructor({ url, sessionId, screenshotDir }) {
    this.startUrl = url;
    this.sessionId = sessionId;
    this.screenshotDir = screenshotDir;
    this.steps = [];
    this.stepCounter = 0;
    this.browser = null;
    this.context = null;
    this.page = null;
    this._stopping = false;
  }

  emit(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
  }

  nextId() {
    return 'step-' + String(++this.stepCounter).padStart(3, '0');
  }

  async launch() {
    this.browser = await chromium.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--allow-insecure-localhost',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-GB',
    });

    // Expose capture function ONCE at context level — persists across all navigations
    await this.context.exposeFunction('__skopixCapture', async (actionData) => {
      if (this._stopping) return;
      if (actionData.action === 'stop') {
        await this.stop();
        process.exit(0);
        return;
      }
      await this._captureStep(actionData);
    });

    // The big init script — injected on every page load automatically
    await this.context.addInitScript(() => {
      if (window.__skopixRecording) return;
      window.__skopixRecording = true;

      // ─── Selector builder ─────────────────────────────────────────────────
      function getSelector(el) {
        if (!el || el === document.body) return 'body';
        const testAttrs = ['data-testid', 'data-test', 'pi-test-identifier', 'data-cy', 'data-qa'];
        for (const attr of testAttrs) {
          const val = el.getAttribute(attr);
          if (val) return '[' + attr + '="' + val + '"]';
        }
        if (el.id && !/^\d/.test(el.id)) return '#' + el.id;
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel && ['button', 'a', 'input'].includes(el.tagName.toLowerCase())) {
          return el.tagName.toLowerCase() + '[aria-label="' + ariaLabel + '"]';
        }
        if (el.name && el.tagName === 'INPUT') return 'input[name="' + el.name + '"]';
        const parts = [];
        let cur = el;
        let depth = 0;
        while (cur && cur !== document.body && depth < 4) {
          let seg = cur.tagName.toLowerCase();
          if (cur.id && !/^\d/.test(cur.id)) { parts.unshift('#' + cur.id); break; }
          const sib = Array.from(cur.parentElement ? cur.parentElement.children : []).filter(c => c.tagName === cur.tagName);
          if (sib.length > 1) seg += ':nth-of-type(' + (sib.indexOf(cur) + 1) + ')';
          parts.unshift(seg);
          cur = cur.parentElement;
          depth++;
        }
        return parts.join(' > ');
      }

      function getElementInfo(el) {
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          name: el.name || null,
          type: el.type || null,
          text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().slice(0, 80),
          selector: getSelector(el),
          classes: el.className ? el.className.toString().trim().slice(0, 100) : null,
        };
      }

      // ─── Action listeners ─────────────────────────────────────────────────
      document.addEventListener('click', function(e) {
        // Don't capture clicks on our own toolbar, popover, or hint overlay
        if (e.target && e.target.closest) {
          if (e.target.closest('#__skopix_toolbar')) return;
          if (e.target.closest('#__skopix_popover')) return;
          if (e.target.closest('#__skopix_hint')) return;
        }
        if (window.__skopixPickMode) return; // picker handles its own clicks
        const el = e.target;
        if (!el || el === document.body || el === document.documentElement) return;
        const rect = el.getBoundingClientRect();
        if (window.__skopixCapture) {
          // Detect checkboxes and radio buttons - use 'check' action
          // The checked state is what it WILL BE after this click (it toggles)
          const isCheckable = el.type === 'checkbox' || el.type === 'radio';
          // Also check if we clicked a label that controls a checkbox
          let checkTarget = null;
          if (!isCheckable && el.tagName === 'LABEL' && el.htmlFor) {
            checkTarget = document.getElementById(el.htmlFor);
          }
          if (!isCheckable && el.tagName === 'LABEL' && !el.htmlFor) {
            checkTarget = el.querySelector('input[type="checkbox"], input[type="radio"]');
          }
          const actualCheckable = isCheckable ? el : checkTarget;
          if (actualCheckable && (actualCheckable.type === 'checkbox' || actualCheckable.type === 'radio')) {
            // By the time the click event fires, checkbox is already toggled
            // so .checked gives us the new state directly
            window.__skopixCapture({
              action: 'check',
              checked: actualCheckable.checked,
              element: getElementInfo(actualCheckable),
              clickX: Math.round(e.clientX),
              clickY: Math.round(e.clientY),
              elementX: Math.round(rect.left + rect.width / 2),
              elementY: Math.round(rect.top + rect.height / 2),
            });
          } else {
            window.__skopixCapture({
              action: 'click',
              element: getElementInfo(el),
              clickX: Math.round(e.clientX),
              clickY: Math.round(e.clientY),
              elementX: Math.round(rect.left + rect.width / 2),
              elementY: Math.round(rect.top + rect.height / 2),
            });
          }
        }
      }, true);

      let typeTimer = null;
      let lastInputEl = null;
      document.addEventListener('input', function(e) {
        const el = e.target;
        if (!el || !['INPUT', 'TEXTAREA'].includes(el.tagName)) return;
        // Checkboxes and radio buttons are handled by the click listener, not type
        if (el.type === 'checkbox' || el.type === 'radio') return;
        if (el.closest && el.closest('#__skopix_toolbar')) return;
        if (el.closest && el.closest('#__skopix_popover')) return;
        lastInputEl = el;
        clearTimeout(typeTimer);
        typeTimer = setTimeout(function() {
          if (!lastInputEl) return;
          if (window.__skopixCapture) {
            window.__skopixCapture({
              action: 'type',
              element: getElementInfo(lastInputEl),
              value: lastInputEl.value,
              isPassword: lastInputEl.type === 'password',
            });
          }
          lastInputEl = null;
        }, 600);
      }, true);

      document.addEventListener('change', function(e) {
        const el = e.target;
        if (!el || el.tagName !== 'SELECT') return;
        if (el.closest && el.closest('#__skopix_toolbar')) return;
        if (el.closest && el.closest('#__skopix_popover')) return;
        const selected = el.options[el.selectedIndex];
        if (window.__skopixCapture) {
          window.__skopixCapture({
            action: 'select',
            element: getElementInfo(el),
            value: el.value,
            label: selected ? selected.text : el.value,
          });
        }
      }, true);

      // Scroll listener - debounced, captures final scroll position
      let scrollTimer = null;
      document.addEventListener('scroll', function(e) {
        const el = e.target;
        // Ignore scrolls on our own UI elements
        if (el && el.closest) {
          if (el.closest('#__skopix_toolbar')) return;
          if (el.closest('#__skopix_popover')) return;
        }
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(function() {
          // Determine what was scrolled - the element itself or the window
          const isWindow = el === document || el === document.documentElement || el === document.body;
          const scrollLeft = isWindow ? window.scrollX : el.scrollLeft;
          const scrollTop = isWindow ? window.scrollY : el.scrollTop;
          // Only capture meaningful scrolls (ignore tiny accidental scrolls)
          if (Math.abs(scrollTop) < 50 && Math.abs(scrollLeft) < 50) return;
          const selector = isWindow ? 'window' : getSelector(el);
          if (window.__skopixCapture) {
            window.__skopixCapture({
              action: 'scroll',
              selector,
              scrollX: Math.round(scrollLeft),
              scrollY: Math.round(scrollTop),
              isWindow,
              element: isWindow ? null : getElementInfo(el),
            });
          }
        }, 400);
      }, true);

      // ─── Floating toolbar ─────────────────────────────────────────────────
      function createToolbar() {
        if (document.getElementById('__skopix_toolbar')) return;

        const toolbar = document.createElement('div');
        toolbar.id = '__skopix_toolbar';
        toolbar.style.cssText = [
          'position:fixed', 'bottom:20px', 'right:20px', 'z-index:2147483647',
          'background:#0f1117', 'border:1px solid #dc2626', 'border-radius:10px',
          'padding:10px 14px', 'display:flex', 'align-items:center', 'gap:10px',
          'font-family:monospace', 'font-size:12px', 'color:#e5e7eb',
          'box-shadow:0 4px 24px rgba(0,0,0,0.6)', 'user-select:none',
          'transition:opacity 0.2s',
        ].join(';');

        toolbar.innerHTML = `
          <span style="color:#dc2626;font-size:14px;animation:skopix_pulse 1s infinite">●</span>
          <span style="color:#9ca3af">Recording</span>
          <span id="__skopix_count" style="color:#22d3ee;font-weight:700;min-width:20px;text-align:center">0</span>
          <span style="color:#4b5563">steps</span>
          <button id="__skopix_assert_btn" style="
            background:#1e3a5f;border:1px solid #2563eb;color:#60a5fa;
            border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px;font-family:monospace;
          ">+ Assert</button>
          <button id="__skopix_stop_btn" style="
            background:#3f0d0d;border:1px solid #dc2626;color:#f87171;
            border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px;font-family:monospace;
          ">■ Stop</button>
        `;

        const style = document.createElement('style');
        style.textContent = '@keyframes skopix_pulse{0%,100%{opacity:1}50%{opacity:0.3}}';
        document.head.appendChild(style);
        document.body.appendChild(toolbar);

        document.getElementById('__skopix_stop_btn').addEventListener('click', function(e) {
          e.stopPropagation();
          if (window.__skopixCapture) window.__skopixCapture({ action: 'stop' });
        });

        document.getElementById('__skopix_assert_btn').addEventListener('click', function(e) {
          e.stopPropagation();
          startPickMode();
        });
      }

      function updateStepCount(n) {
        const el = document.getElementById('__skopix_count');
        if (el) el.textContent = n;
      }

      // ─── Element picker mode ──────────────────────────────────────────────
      let pickerOverlay = null;
      let lastHovered = null;

      function startPickMode() {
        window.__skopixPickMode = true;
        document.body.style.cursor = 'crosshair';

        // Dim the toolbar
        const tb = document.getElementById('__skopix_toolbar');
        if (tb) tb.style.opacity = '0.5';

        // Show hint
        const hint = document.createElement('div');
        hint.id = '__skopix_hint';
        hint.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1e3a5f;border:1px solid #2563eb;color:#60a5fa;padding:8px 18px;border-radius:8px;font-family:monospace;font-size:13px;pointer-events:none';
        hint.textContent = 'Click any element to add an assertion';
        document.body.appendChild(hint);

        pickerOverlay = document.createElement('div');
        pickerOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483646;pointer-events:auto;cursor:crosshair';
        document.body.appendChild(pickerOverlay);

        let highlight = document.createElement('div');
        highlight.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483645;background:rgba(37,99,235,0.15);border:2px solid #2563eb;border-radius:3px;transition:all 0.1s;display:none';
        document.body.appendChild(highlight);

        pickerOverlay.addEventListener('mousemove', function(e) {
          pickerOverlay.style.pointerEvents = 'none';
          const el = document.elementFromPoint(e.clientX, e.clientY);
          pickerOverlay.style.pointerEvents = 'auto';
          if (!el || el === document.body || el.id === '__skopix_toolbar') {
            highlight.style.display = 'none';
            return;
          }
          lastHovered = el;
          const r = el.getBoundingClientRect();
          highlight.style.display = 'block';
          highlight.style.top = r.top + 'px';
          highlight.style.left = r.left + 'px';
          highlight.style.width = r.width + 'px';
          highlight.style.height = r.height + 'px';
        });

        pickerOverlay.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          pickerOverlay.style.pointerEvents = 'none';
          const el = document.elementFromPoint(e.clientX, e.clientY);
          pickerOverlay.style.pointerEvents = 'auto';
          if (!el || el === document.body) { stopPickMode(); return; }

          stopPickMode();
          showAssertionPopover(el, highlight);
        });

        document.addEventListener('keydown', function escHandler(e) {
          if (e.key === 'Escape') { stopPickMode(); document.removeEventListener('keydown', escHandler); }
        });
      }

      function stopPickMode() {
        window.__skopixPickMode = false;
        document.body.style.cursor = '';
        if (pickerOverlay) { pickerOverlay.remove(); pickerOverlay = null; }
        const hint = document.getElementById('__skopix_hint');
        if (hint) hint.remove();
        const tb = document.getElementById('__skopix_toolbar');
        if (tb) tb.style.opacity = '1';
      }

      // ─── Assertion popover ────────────────────────────────────────────────
      function showAssertionPopover(el, highlightEl) {
        const existing = document.getElementById('__skopix_popover');
        if (existing) existing.remove();

        const sel = getSelector(el);
        const currentText = (el.innerText || el.textContent || '').trim().slice(0, 100);
        const tag = el.tagName.toLowerCase();
        const rect = el.getBoundingClientRect();

        // Smart defaults
        let suggestedType = 'visible';
        let suggestedValue = '';

        // If element has a title/alt/aria-label, suggest attribute_contains
        const titleAttr = el.getAttribute('title') || el.getAttribute('alt');
        if (titleAttr && titleAttr.length > 0) {
          suggestedType = 'attribute_contains';
          suggestedValue = titleAttr.slice(0, 80);
        } else if (currentText && currentText.length > 0 && currentText.length < 80) {
          suggestedType = 'text_contains';
          // For numbers, suggest exact value. For text, suggest contains.
          suggestedValue = currentText.replace(/\s+/g, ' ').trim();
        }
        // Count suggestion for tables/lists
        if (['table', 'tbody', 'ul', 'ol'].includes(tag) || el.querySelectorAll('tr, li').length > 1) {
          const rows = el.querySelectorAll('tr:not(thead tr), li').length;
          if (rows > 0) { suggestedType = 'element_count'; suggestedValue = String(rows); }
        }

        // Highlight selected element in green
        if (highlightEl) {
          highlightEl.style.background = 'rgba(34,197,94,0.15)';
          highlightEl.style.borderColor = '#22c55e';
          highlightEl.style.display = 'block';
          highlightEl.style.top = rect.top + 'px';
          highlightEl.style.left = rect.left + 'px';
          highlightEl.style.width = rect.width + 'px';
          highlightEl.style.height = rect.height + 'px';
        }

        const popover = document.createElement('div');
        popover.id = '__skopix_popover';

        // Position popover — prefer below element, fall back to above
        const popHeight = 280;
        const topPos = rect.bottom + 8 + popHeight > window.innerHeight
          ? Math.max(8, rect.top - popHeight - 8)
          : rect.bottom + 8;
        const leftPos = Math.min(rect.left, window.innerWidth - 360);

        popover.style.cssText = [
          'position:fixed', 'z-index:2147483647',
          'top:' + topPos + 'px', 'left:' + leftPos + 'px',
          'width:350px', 'background:#0f1117',
          'border:1px solid #2563eb', 'border-radius:10px',
          'padding:16px', 'font-family:monospace', 'font-size:12px', 'color:#e5e7eb',
          'box-shadow:0 8px 32px rgba(0,0,0,0.7)',
        ].join(';');

        popover.innerHTML = `
          <div style="color:#60a5fa;font-size:11px;letter-spacing:0.1em;margin-bottom:12px">ADD ASSERTION</div>

          <div style="margin-bottom:10px">
            <div style="color:#9ca3af;font-size:10px;margin-bottom:4px">SELECTED ELEMENT</div>
            <div style="background:#1a1d2e;padding:6px 10px;border-radius:6px;color:#22d3ee;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${sel}">${sel}</div>
            ${currentText ? '<div style="color:#6b7280;font-size:10px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Current text: "' + currentText.slice(0,50) + (currentText.length > 50 ? '...' : '') + '"</div>' : ''}
          </div>

          <div style="margin-bottom:10px">
            <div style="color:#9ca3af;font-size:10px;margin-bottom:4px">ASSERTION TYPE</div>
            <select id="__skopix_assert_type" style="width:100%;background:#1a1d2e;border:1px solid #374151;color:#e5e7eb;padding:6px 8px;border-radius:6px;font-family:monospace;font-size:12px">
              <option value="visible"${suggestedType==='visible'?' selected':''}>Element is visible</option>
              <option value="text_contains"${suggestedType==='text_contains'?' selected':''}>Text contains</option>
              <option value="text_equals"${suggestedType==='text_equals'?' selected':''}>Text equals</option>
              <option value="url_contains">URL contains</option>
              <option value="element_count"${suggestedType==='element_count'?' selected':''}>Element count</option>
              <option value="attribute_contains">Attribute contains (title, alt, etc.)</option>
            </select>
          </div>

          <div id="__skopix_attr_row" style="margin-bottom:10px;display:none">
            <div style="color:#9ca3af;font-size:10px;margin-bottom:4px">ATTRIBUTE NAME</div>
            <input id="__skopix_assert_attr" type="text" value="title" placeholder="e.g. title, alt, aria-label" style="width:100%;box-sizing:border-box;background:#1a1d2e;border:1px solid #374151;color:#e5e7eb;padding:6px 8px;border-radius:6px;font-family:monospace;font-size:12px">
          </div>

          <div id="__skopix_value_row" style="margin-bottom:10px;${suggestedType==='visible'?'display:none':''}">
            <div style="color:#9ca3af;font-size:10px;margin-bottom:4px" id="__skopix_value_label">EXPECTED VALUE</div>
            <input id="__skopix_assert_value" type="text" value="${suggestedValue.replace(/"/g, '&quot;')}" placeholder="Expected value..." style="width:100%;box-sizing:border-box;background:#1a1d2e;border:1px solid #374151;color:#e5e7eb;padding:6px 8px;border-radius:6px;font-family:monospace;font-size:12px">
          </div>

          <div style="margin-bottom:14px">
            <div style="color:#9ca3af;font-size:10px;margin-bottom:4px">DESCRIPTION (optional)</div>
            <input id="__skopix_assert_desc" type="text" placeholder="e.g. First row should be sales" style="width:100%;box-sizing:border-box;background:#1a1d2e;border:1px solid #374151;color:#e5e7eb;padding:6px 8px;border-radius:6px;font-family:monospace;font-size:12px">
          </div>

          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button id="__skopix_assert_cancel" style="background:transparent;border:1px solid #374151;color:#9ca3af;border-radius:6px;padding:6px 14px;cursor:pointer;font-family:monospace;font-size:12px">Cancel</button>
            <button id="__skopix_assert_add" style="background:#1e3a5f;border:1px solid #2563eb;color:#60a5fa;border-radius:6px;padding:6px 14px;cursor:pointer;font-family:monospace;font-size:12px;font-weight:700">Add ✓</button>
          </div>
        `;

        document.body.appendChild(popover);

        // Show/hide value field based on type
        const typeSelect = popover.querySelector('#__skopix_assert_type');
        const valueRow = popover.querySelector('#__skopix_value_row');
        const valueLabel = popover.querySelector('#__skopix_value_label');
        const valueInput = popover.querySelector('#__skopix_assert_value');
        const attrRow = popover.querySelector('#__skopix_attr_row');

        typeSelect.addEventListener('change', function() {
          const t = typeSelect.value;
          attrRow.style.display = t === 'attribute_contains' ? 'block' : 'none';
          if (t === 'visible') {
            valueRow.style.display = 'none';
          } else {
            valueRow.style.display = 'block';
            if (t === 'element_count') {
              valueLabel.textContent = 'EXPECTED COUNT (number)';
              valueInput.placeholder = 'e.g. 9';
            } else if (t === 'url_contains') {
              valueLabel.textContent = 'URL MUST CONTAIN';
              valueInput.placeholder = 'e.g. /dashboard';
              valueInput.value = '';
            } else if (t === 'attribute_contains') {
              valueLabel.textContent = 'ATTRIBUTE VALUE MUST CONTAIN';
              valueInput.placeholder = 'e.g. SVG equivalent';
              // Pre-fill with the title attribute value if it exists
              const titleVal = el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('aria-label') || '';
              if (titleVal && !valueInput.value) valueInput.value = titleVal.slice(0, 80);
            } else {
              valueLabel.textContent = 'EXPECTED VALUE';
              valueInput.placeholder = 'Expected text...';
            }
          }
        });

        popover.querySelector('#__skopix_assert_cancel').addEventListener('click', function(e) {
          e.stopPropagation();
          if (highlightEl) highlightEl.style.display = 'none';
          popover.remove();
        });

        popover.querySelector('#__skopix_assert_add').addEventListener('click', function(e) {
          e.stopPropagation();
          const assertType = typeSelect.value;
          const value = popover.querySelector('#__skopix_assert_value').value.trim();
          const description = popover.querySelector('#__skopix_assert_desc').value.trim();

          if (assertType !== 'visible' && assertType !== 'url_contains' && !value) {
            popover.querySelector('#__skopix_assert_value').style.borderColor = '#dc2626';
            return;
          }

          if (window.__skopixCapture) {
            const attrInput = popover.querySelector('#__skopix_assert_attr');
            window.__skopixCapture({
              action: 'assert',
              assertType,
              attribute: assertType === 'attribute_contains' ? (attrInput ? attrInput.value.trim() || 'title' : 'title') : null,
              selector: assertType === 'url_contains' ? null : sel,
              value: value || null,
              description: description || null,
              element: assertType === 'url_contains' ? null : getElementInfo(el),
            });
          }

          if (highlightEl) highlightEl.style.display = 'none';
          popover.remove();

          // Flash the assert button green briefly to confirm
          const assertBtn = document.getElementById('__skopix_assert_btn');
          if (assertBtn) {
            const orig = assertBtn.style.cssText;
            assertBtn.textContent = '✓ Added';
            assertBtn.style.background = '#14532d';
            assertBtn.style.borderColor = '#22c55e';
            assertBtn.style.color = '#4ade80';
            setTimeout(() => { assertBtn.textContent = '+ Assert'; assertBtn.style.cssText = orig; }, 1500);
          }
        });

        // Focus the value input if visible
        setTimeout(() => {
          if (valueRow.style.display !== 'none') valueInput.focus();
        }, 50);
      }

      // Boot the toolbar once DOM is ready
      if (document.body) {
        createToolbar();
      } else {
        document.addEventListener('DOMContentLoaded', createToolbar);
      }

      // Re-create toolbar after navigation if it got wiped
      new MutationObserver(() => {
        if (!document.getElementById('__skopix_toolbar')) createToolbar();
      }).observe(document.documentElement, { childList: true, subtree: false });

      // Listen for step count updates from parent
      window.__skopixUpdateCount = function(n) { updateStepCount(n); };
    });

    this.context.on('page', (newPage) => {
      newPage.on('framenavigated', async (frame) => {
        if (frame !== newPage.mainFrame()) return;
        const url = frame.url();
        if (url === 'about:blank' || url === this.startUrl) return;
        this.emit({ type: 'navigate', url });
      });
    });

    this.page = await this.context.newPage();

    this.page.on('framenavigated', async (frame) => {
      if (frame !== this.page.mainFrame()) return;
      const url = frame.url();
      if (url === 'about:blank') return;
      this.emit({ type: 'navigate', url });
      // Update step count in toolbar after navigation
      setTimeout(async () => {
        try {
          await this.page.evaluate((n) => {
            if (window.__skopixUpdateCount) window.__skopixUpdateCount(n);
          }, this.steps.length);
        } catch {}
      }, 500);
    });

    await this.page.goto(this.startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    this.emit({ type: 'ready' });
  }

  async _captureStep(actionData) {
    const id = this.nextId();
    const page = this.page;
    const step = {
      id,
      action: actionData.action,
      assertType: actionData.assertType || null,
      selector: actionData.selector || (actionData.element ? actionData.element.selector : null),
      element: actionData.element || null,
      value: actionData.value || null,
      isPassword: actionData.isPassword || false,
      label: actionData.label || null,
      clickX: actionData.clickX || null,
      clickY: actionData.clickY || null,
      elementX: actionData.elementX || null,
      elementY: actionData.elementY || null,
      description: actionData.description || null,
      url: page ? page.url() : '',
      timestamp: Date.now(),
      stableSelector: null,
      screenshotPath: null,
    };

    // Update toolbar step count
    setTimeout(async () => {
      try {
        await page.evaluate((n) => {
          if (window.__skopixUpdateCount) window.__skopixUpdateCount(n);
        }, this.steps.length + 1);
      } catch {}
    }, 100);

    // Screenshot after short delay
    setTimeout(async () => {
      try {
        if (this.screenshotDir && page) {
          await fs.ensureDir(this.screenshotDir);
          const screenshotPath = path.join(this.screenshotDir, id + '.png');
          await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
          step.screenshotPath = screenshotPath;
          this.emit({ type: 'screenshot', stepId: id, path: screenshotPath });
        }
      } catch {}
    }, 400);

    this.steps.push(step);
    this.emit({ type: 'step', step });
  }

  async stop() {
    this._stopping = true;
    try {
      if (this.screenshotDir && this.page) {
        await fs.ensureDir(this.screenshotDir);
        await this.page.screenshot({ path: path.join(this.screenshotDir, 'final.png'), fullPage: false }).catch(() => {});
      }
    } catch {}
    try { await this.browser.close(); } catch {}
    this.emit({ type: 'done', steps: this.steps });
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────
const [,, url, sessionId, screenshotDir] = process.argv;
if (!url) { process.stderr.write('Usage: recorder.js <url> <sessionId> <screenshotDir>\n'); process.exit(1); }

const session = new RecordingSession({ url, sessionId, screenshotDir });
session.launch().catch((err) => { session.emit({ type: 'error', message: err.message }); process.exit(1); });

process.stdin.setEncoding('utf8');
process.stdin.on('data', async (data) => {
  if (data.trim() === 'stop') { await session.stop(); process.exit(0); }
});
process.on('SIGTERM', async () => { await session.stop(); process.exit(0); });
