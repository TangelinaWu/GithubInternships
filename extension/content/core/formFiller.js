// Generic form fill engine.
// Handles: text inputs, textareas, <select>, radio groups, checkboxes, file uploads,
// and ARIA comboboxes (custom dropdowns used by LinkedIn/Greenhouse).
//
// profileSchema.js and humanDelay.js must be loaded before this file.

const formFiller = {
  // Set a value on a React-controlled, plain input/textarea, or contentEditable element.
  // Uses the native prototype setter (bypasses JS-level paste guards and React's own setter).
  // Dispatches InputEvent with inputType:"insertText" so paste-detection listeners don't
  // mistake this for a paste and clear the field.
  setInputValue(element, value) {
    const tag = element.tagName.toLowerCase();

    if (element.isContentEditable || element.contentEditable === "true") {
      element.focus();
      element.textContent = "";
      element.textContent = value;
      element.dispatchEvent(new InputEvent("input", {
        bubbles: true, cancelable: true, inputType: "insertText",
      }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    const isTextArea = tag === "textarea";
    const proto = isTextArea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value").set;
    nativeSetter.call(element, value);
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true, cancelable: true, inputType: "insertText",
    }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  },

  // Normalize a string for fuzzy matching:
  // lowercase, strip punctuation/accents, collapse whitespace.
  _norm(s) {
    return (s || "")
      .toLowerCase()
      .replace(/[''`.,\-\/\\()]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  },

  // Score how well two normalized strings match (0 = no match, higher = better).
  // Used to pick the closest option when multiple candidates pass the includes check.
  _matchScore(a, b) {
    if (a === b) return 3;
    if (a.includes(b) || b.includes(a)) return 2;
    // Word-overlap: count shared words (length ≥ 3 to ignore "of", "in", etc.)
    const wa = new Set(a.split(" ").filter(w => w.length >= 3));
    const wb = b.split(" ").filter(w => w.length >= 3);
    const shared = wb.filter(w => wa.has(w)).length;
    return shared > 0 ? shared : 0;
  },

  // Fill a native <select> by finding the best-matching option.
  // Three passes: exact → substring → word-overlap.
  fillSelect(element, value) {
    const nv = this._norm(value);
    if (!nv) return false;

    // Skip placeholder/empty options
    const options = [...element.options].filter(o => o.value !== "" && o.text.trim() !== "");

    let best = null, bestScore = 0;
    for (const opt of options) {
      const nt = this._norm(opt.text);
      const nv2 = this._norm(opt.value);
      const score = Math.max(this._matchScore(nv, nt), this._matchScore(nv, nv2));
      if (score > bestScore) { bestScore = score; best = opt; }
    }

    if (best && bestScore > 0) {
      element.value = best.value;
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  },

  // Fill a radio group — find the radio whose label best matches the value.
  fillRadioGroup(radios, value) {
    const nv = this._norm(value);
    if (!nv) return false;

    let best = null, bestScore = 0;
    for (const radio of radios) {
      const label = this._norm(this.getLabelText(radio));
      const val   = this._norm(radio.value);
      const score = Math.max(this._matchScore(nv, label), this._matchScore(nv, val));
      if (score > bestScore) { bestScore = score; best = radio; }
    }

    if (best && bestScore > 0) {
      best.click();
      best.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  },

  // Fill a checkbox to the desired boolean state
  fillCheckbox(element, value) {
    const desired = value === true || value === "true" || value === "yes" || value === "1";
    if (element.checked !== desired) {
      element.click();
    }
  },

  // Fill a file input from a base64 Data URL stored in the profile.
  // Handles hidden inputs (common on ATS sites) and React-controlled inputs.
  async fillFileInput(element, dataUrl, fileName) {
    if (!dataUrl) return false;
    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const file = new File([blob], fileName || "resume.pdf", { type: "application/pdf" });
      const dt = new DataTransfer();
      dt.items.add(file);

      // Many ATS sites hide the real <input type="file"> behind a custom button.
      // Temporarily expose it so events fire correctly.
      const style = window.getComputedStyle(element);
      const wasHidden = style.display === "none" || style.visibility === "hidden" || style.opacity === "0";
      if (wasHidden) {
        element.style.setProperty("display",    "block",    "important");
        element.style.setProperty("visibility", "visible",  "important");
        element.style.setProperty("opacity",    "1",        "important");
        element.style.setProperty("position",   "fixed",    "important");
        element.style.setProperty("left",       "-9999px",  "important");
      }

      // Use the native files setter so React-controlled inputs pick up the change
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set;
      if (nativeSetter) {
        nativeSetter.call(element, dt.files);
      } else {
        element.files = dt.files;
      }

      element.dispatchEvent(new Event("input",  { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));

      if (wasHidden) {
        element.style.removeProperty("display");
        element.style.removeProperty("visibility");
        element.style.removeProperty("opacity");
        element.style.removeProperty("position");
        element.style.removeProperty("left");
      }

      return element.files.length > 0;
    } catch {
      return false;
    }
  },

  // Fill an ARIA combobox (custom dropdown): click → type filter → pick option.
  // Used by LinkedIn, Greenhouse, and others that avoid native <select>.
  async fillCombobox(container, value) {
    const input = container.querySelector("input") || container;
    container.click();
    await humanDelay.short();

    this.setInputValue(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await humanDelay.short();

    // Wait up to 2 seconds for the listbox to appear
    const listbox = await this.waitForSelector('[role="listbox"], [role="option"]', 2000, container.getRootNode());
    if (!listbox) return false;

    // The listbox may be the element itself or a descendant
    const scope = listbox.getAttribute("role") === "listbox" ? listbox : document;
    const options = [...scope.querySelectorAll('[role="option"]')];
    const nv = this._norm(value);

    // Best-score match (same fuzzy logic as fillSelect)
    let best = null, bestScore = 0;
    for (const opt of options) {
      const score = this._matchScore(nv, this._norm(opt.textContent.trim()));
      if (score > bestScore) { bestScore = score; best = opt; }
    }

    if (best && bestScore > 0) {
      best.click();
      return true;
    }
    return false;
  },

  // Classify a form element into a fill strategy
  classifyElement(element) {
    const tag = element.tagName.toLowerCase();
    const type = (element.type || "").toLowerCase();
    const role = (element.getAttribute("role") || "").toLowerCase();

    if (tag === "input") {
      if (type === "file") return "file";
      if (type === "radio") return "radio";
      if (type === "checkbox") return "checkbox";
      if (type === "hidden") return "hidden";
      if (type === "submit" || type === "button" || type === "reset") return "button";
      if (role === "combobox") return "combobox"; // ARIA combobox on an input element
      return "text";
    }
    if (tag === "select") return "select";
    if (tag === "textarea") return "textarea";
    if (role === "combobox") return "combobox";
    if (element.contentEditable === "true") return "richtext";
    return "unknown";
  },

  // Extract visible label text for a form element.
  // Checks six sources in order, from most to least reliable.
  getLabelText(element) {
    // 1. aria-label
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();

    // 2. aria-labelledby (may reference multiple IDs)
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.trim().split(/\s+/)
        .map(id => document.getElementById(id)?.textContent.trim())
        .filter(Boolean).join(" ");
      if (text) return text;
    }

    // 3. <label for="id">
    if (element.id) {
      const label = document.querySelector(`label[for="${element.id}"]`) ||
                    document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (label) return label.textContent.trim();
    }

    // 4. Wrapping <label>
    const wrappingLabel = element.closest("label");
    if (wrappingLabel) {
      return wrappingLabel.textContent.replace(element.value || "", "").trim();
    }

    // 5. Nearest label/legend sibling inside the same field container.
    //    Covers the common ATS pattern: <div class="field"><label>...</label><input /></div>
    const container = element.closest(
      '.field, .form-group, .form-field, .field-group, .input-group, ' +
      '[class*="field"], [class*="form-row"], [class*="question"], [class*="input-wrap"], ' +
      'li, fieldset'
    );
    if (container) {
      const nearby = container.querySelector('label, legend');
      if (nearby && !nearby.contains(element)) {
        const text = nearby.textContent.trim();
        if (text) return text;
      }
    }

    // 6. Placeholder is a good hint; fall back to parsing the name attribute.
    if (element.placeholder) return element.placeholder;

    // Parse bracket-style names: "job_application[first_name]" → "first name"
    const name = element.name || "";
    if (name) {
      const inner = name.match(/\[([^\]]+)\](?:\[\])?$/) || name.match(/^([^[]+)/);
      if (inner) return inner[1].replace(/_/g, " ");
    }

    return "";
  },

  // Send a fill log entry to the control panel.
  _log(label, status) {
    chrome.runtime.sendMessage({
      type: MSG.FILL_LOG,
      payload: { label, status },
    }).catch(() => {});
  },

  // Find the first visible button/input whose text matches a regex.
  findButton(textRegex) {
    for (const el of document.querySelectorAll(
      'button, input[type="submit"], input[type="button"], [role="button"]'
    )) {
      if (!this.isVisible(el)) continue;
      const text = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
      if (textRegex.test(text)) return el;
    }
    return null;
  },

  // Wait for the DOM to stop mutating (SPA page transitions).
  // Resolves once no mutations fire for `quietMs`, or after `timeoutMs`.
  _waitForDomSettle(timeoutMs = 5000, quietMs = 400) {
    return new Promise(resolve => {
      let timer = null;
      const reset = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { observer.disconnect(); resolve(); }, quietMs);
      };
      const observer = new MutationObserver(reset);
      observer.observe(document.body, { childList: true, subtree: true });
      reset();
      setTimeout(() => { observer.disconnect(); resolve(); }, timeoutMs);
    });
  },

  // Click the Next/Continue button on the current step and wait for the new section.
  // Returns true if a button was found and clicked, false if no Next button exists.
  async advanceStep() {
    const NEXT_RE = /^(next|continue|save\s*(and\s*|&\s*)?continue|next\s*step|proceed)$/i;
    const btn = this.findButton(NEXT_RE);
    if (!btn) return false;
    await humanDelay.beforeClick();
    btn.click();
    await this._waitForDomSettle();
    return true;
  },

  // Wait for a selector to appear in the DOM (optional scope).
  waitForSelector(selector, timeoutMs, scope) {
    const root = scope || document;
    return new Promise((resolve) => {
      const existing = root.querySelector(selector);
      if (existing) return resolve(existing);

      const observer = new MutationObserver(() => {
        const found = root.querySelector(selector);
        if (found) {
          observer.disconnect();
          resolve(found);
        }
      });

      observer.observe(root.nodeType === 9 ? root.body || root : root, {
        childList: true,
        subtree: true,
      });

      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeoutMs);
    });
  },

  // Fill a single visible form field.
  // Returns: "filled" | "skipped" | "unknown" (unknown = needs Claude overlay)
  // answers: pre-loaded answers DB entries (from getAnswers()) — avoids redundant Claude calls
  async fillField(element, profile, answers) {
    const type = this.classifyElement(element);
    if (type === "hidden" || type === "button" || type === "unknown") return "skipped";

    // Find label text to look up in profile
    let labelText = this.getLabelText(element);

    // For radio inputs, use the group's fieldset legend or surrounding label
    if (type === "radio") {
      const fieldset = element.closest("fieldset");
      if (fieldset) {
        const legend = fieldset.querySelector("legend");
        if (legend) labelText = legend.textContent.trim();
      }
    }

    if (type === "file") {
      // Treat as resume if: label matches, accept includes pdf, or it's the only file input on the form.
      const container = element.closest('form') || document;
      const isResume = /resume|cv|curriculum/i.test(labelText)
        || (element.accept || '').toLowerCase().includes('pdf')
        || container.querySelectorAll('input[type="file"]').length === 1;
      if (isResume && profile.resumeDataUrl) {
        await this.fillFileInput(element, profile.resumeDataUrl, profile.resumeFileName);
        return "filled";
      }
      return "skipped";
    }

    // Check answers DB first — if Claude already answered this question, reuse it
    const savedAnswer = lookupFromAnswers(labelText, answers || []);
    if (savedAnswer !== null) {
      await humanDelay.short();
      if (type === "select") {
        const filled = this.fillSelect(element, savedAnswer);
        return filled ? "filled" : "unknown";
      }
      if (type === "radio") {
        const fieldset = element.closest("fieldset");
        const radios = fieldset
          ? fieldset.querySelectorAll('input[type="radio"]')
          : document.querySelectorAll(`input[type="radio"][name="${element.name}"]`);
        const filled = this.fillRadioGroup(radios, savedAnswer);
        return filled ? "filled" : "unknown";
      }
      if (type === "checkbox") { this.fillCheckbox(element, savedAnswer); return "filled"; }
      if (type === "combobox") {
        const filled = await this.fillCombobox(element, savedAnswer);
        return filled ? "filled" : "unknown";
      }
      if (type === "text" || type === "textarea" || type === "richtext") {
        this.setInputValue(element, savedAnswer);
        return "filled";
      }
    }

    const profileValue = lookupProfileValue(labelText, profile);

    if (profileValue === null) {
      return "unknown"; // Unrecognized label — ask the overlay
    }

    // Empty profile value: for free-text fields, let Claude provide a value rather
    // than silently skipping — catches fields whose profile key exists but was never filled.
    if (profileValue === "") {
      if (type === "text" || type === "textarea" || type === "richtext") return "unknown";
      return "skipped";
    }

    await humanDelay.short();

    if (type === "select") {
      const filled = this.fillSelect(element, profileValue);
      return filled ? "filled" : "unknown";
    }

    if (type === "radio") {
      const fieldset = element.closest("fieldset");
      const radios = fieldset
        ? fieldset.querySelectorAll('input[type="radio"]')
        : document.querySelectorAll(`input[type="radio"][name="${element.name}"]`);
      const filled = this.fillRadioGroup(radios, profileValue);
      return filled ? "filled" : "unknown";
    }

    if (type === "checkbox") {
      this.fillCheckbox(element, profileValue);
      return "filled";
    }

    if (type === "combobox") {
      const filled = await this.fillCombobox(element, profileValue);
      return filled ? "filled" : "unknown";
    }

    if (type === "text" || type === "textarea" || type === "richtext") {
      this.setInputValue(element, profileValue);
      return "filled";
    }

    return "unknown";
  },

  // Highlight a field with a colored ring and scroll it into view.
  // Removes the previous highlight automatically.
  _highlighted: null,
  _savedOutline: '',
  _savedBoxShadow: '',
  // Elements marked amber because they couldn't be answered; cleared on next fillContainer run.
  _unknownMarked: [],

  highlightField(element) {
    // Restore previous field's styles
    if (this._highlighted) {
      this._highlighted.style.outline   = this._savedOutline;
      this._highlighted.style.boxShadow = this._savedBoxShadow;
    }
    this._savedOutline   = element.style.outline   || '';
    this._savedBoxShadow = element.style.boxShadow || '';
    this._highlighted    = element;

    element.style.outline   = '2px solid #6366f1';
    element.style.boxShadow = '0 0 0 4px rgba(99,102,241,0.25)';

    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  },

  removeHighlight() {
    if (this._highlighted) {
      this._highlighted.style.outline   = this._savedOutline;
      this._highlighted.style.boxShadow = this._savedBoxShadow;
      this._highlighted = null;
    }
  },

  // Scan a container for fillable fields and fill them.
  // Returns an array of { element, labelText, status } for each field found.
  async fillContainer(container, profile, onUnknown) {
    // Clear amber rings from any previous run.
    for (const el of this._unknownMarked) {
      el.style.removeProperty('outline');
      el.style.removeProperty('box-shadow');
    }
    this._unknownMarked = [];

    // Load answers DB once for this fill session so saved Claude answers are reused
    // without redundant overlay calls.
    const answers = (typeof getAnswers === 'function') ? await getAnswers() : [];

    const results = [];

    // Gather all interactive elements, deduplicate radio groups by name
    const seenRadioNames = new Set();
    const elements = [];

    for (const el of container.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), ' +
      "select, textarea, [role='combobox']"
    )) {
      if (!this.isVisible(el)) continue;

      if (el.type === "radio") {
        if (seenRadioNames.has(el.name)) continue;
        seenRadioNames.add(el.name);
      }

      elements.push(el);
    }

    const unanswered = [];

    for (const el of elements) {
      const labelText = this.getLabelText(el);
      let status = await this.fillField(el, profile, answers);

      const wasUnknown = status === "unknown";
      if (status === "unknown" && typeof onUnknown === "function") {
        status = await onUnknown(el, labelText);
      }

      // Field was unknown and the user didn't (or couldn't) provide an answer.
      if (wasUnknown && status !== "filled") {
        el.style.setProperty('outline',    '2px solid #f59e0b', 'important');
        el.style.setProperty('box-shadow', '0 0 0 4px rgba(245,158,11,0.25)', 'important');
        this._unknownMarked.push(el);
        unanswered.push(labelText || '(unlabeled)');
      }

      this._log(labelText || 'field', status);
      results.push({ element: el, labelText, status });
      await humanDelay.betweenFields();
    }

    this.removeHighlight();

    // Notify control panel of any fields that still need attention.
    if (unanswered.length > 0) {
      const preview = unanswered.join(', ').slice(0, 120);
      chrome.runtime.sendMessage({
        type: MSG.FILL_LOG,
        payload: {
          severity: 'warn',
          text: `⚠ Needs attention (${unanswered.length}): ${preview}`,
        },
      }).catch(() => {});
    }

    return results;
  },

  // Check if an element is visible in the viewport
  isVisible(element) {
    if (!element.offsetParent && element.style.display === "none") return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  },
};
