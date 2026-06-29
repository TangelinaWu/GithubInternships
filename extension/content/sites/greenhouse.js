// Greenhouse ATS handler
// Supports: boards.greenhouse.io and job-boards.greenhouse.io

window.__jaHandler = {
  detectionRules: {
    urlPatterns: [/greenhouse\.io/i],
    selectors: [
      "#application_form",
      "#application-form",
      "form#app_application",
      "[id*='greenhouse']",
    ],
  },

  _paused: false,

  pause() {
    this._paused = true;
  },

  async run(profile, onUnknown) {
    this._paused = false;
    floatingButton.setState(floatingButton.STATES.RUNNING);

    try {
      await this._fillForm(profile, onUnknown);
    } catch (err) {
      console.error("[JobApplier] Greenhouse error:", err);
      floatingButton.setState(floatingButton.STATES.ERROR);
      chrome.runtime.sendMessage({
        type: MSG.FILL_LOG,
        payload: { severity: 'warn', text: `⚠ Greenhouse error: ${err.message}` },
      }).catch(() => {});
    }
  },

  async _fillForm(profile, onUnknown) {
    const form =
      document.getElementById("application_form") ||
      document.getElementById("application-form") ||
      document.querySelector("form#app_application") ||
      document.querySelector("form[action*='application']") ||
      document.querySelector("form");

    if (!form) {
      floatingButton.setState(floatingButton.STATES.ERROR);
      chrome.runtime.sendMessage({
        type: MSG.FILL_LOG,
        payload: { severity: 'warn', text: '⚠ Greenhouse: application form not found on this page' },
      }).catch(() => {});
      return;
    }

    // Scan form fields before filling so we capture the pristine form
    const scannedFields = formScanner.scan(form)
    formScanner.report({
      site: 'greenhouse',
      company: document.querySelector('.company-name, h1.company')?.textContent.trim() || '',
      role: (document.querySelector("meta[property='og:title']")?.content || document.title).trim(),
      url: window.location.href,
      fields: scannedFields,
    })

    floatingButton.setProgress("Uploading resume…");
    chrome.runtime.sendMessage({ type: MSG.FILL_LOG, payload: { label: 'Resume', status: 'uploading' } }).catch(() => {});

    // Upload to "Autofill from resume" section first — lets Greenhouse pre-populate
    // fields before our filler runs. Also uploads to any regular resume file input.
    const autofilled = await this._handleAutofillFromResume(profile);
    if (autofilled) {
      // Give Greenhouse's autofill logic time to populate the form fields
      await new Promise((r) => setTimeout(r, 1800));
    } else {
      // No autofill section — fall back to direct resume file input
      await this._handleResumeUpload(form, profile);
    }

    floatingButton.setProgress("Filling form…");

    // Fill standard fields
    await formFiller.fillContainer(form, profile, onUnknown);

    if (this._paused) {
      floatingButton.setState(floatingButton.STATES.PAUSED);
      return;
    }

    // Greenhouse may have a separate demographic/EEOC section below the main form
    await this._handleEeocSection(profile, onUnknown);

    // Some Greenhouse boards have a second confirmation/review step — advance if present.
    const advanced = await formFiller.advanceStep();
    if (advanced) {
      await formFiller.fillContainer(document.body, profile, onUnknown);
    }

    floatingButton.setState(floatingButton.STATES.DONE);
    floatingButton.setProgress("Review & submit");

    if (profile.autoSubmit) {
      await humanDelay.beforeClick();
      const submitBtn =
        document.querySelector('input[type="submit"]#submit_app') ||
        document.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.click();
    }

    this._logApplication(profile);
  },

  // Upload resume to the "Autofill from resume" section.
  // Greenhouse hides the <input type="file"> and triggers it from a visible button —
  // we assign the file directly so no click simulation is needed.
  // Returns true if the upload was performed.
  async _handleAutofillFromResume(profile) {
    if (!profile.resumeDataUrl) return false;

    // Find the autofill section. Try specific selectors first, then text search.
    const section =
      document.querySelector("#resume_upload") ||
      document.querySelector("[data-testid*='resume-upload']") ||
      document.querySelector("[class*='autofill-resume']") ||
      document.querySelector("[class*='resume-autofill']") ||
      this._findSectionByText("autofill from resume");

    if (!section) return false;

    // The file input may be hidden (display:none) — assign to it directly.
    const fileInput =
      section.querySelector("input[type='file']") ||
      section.parentElement?.querySelector("input[type='file']");

    if (!fileInput) return false;

    await formFiller.fillFileInput(fileInput, profile.resumeDataUrl, profile.resumeFileName);
    await humanDelay.betweenFields();
    return true;
  },

  // Find the smallest element whose text content contains the given string.
  _findSectionByText(text) {
    const lower = text.toLowerCase();
    let best = null;
    for (const el of document.querySelectorAll("div, section, li")) {
      if ((el.textContent || "").toLowerCase().includes(lower)) {
        if (!best || el.textContent.length < best.textContent.length) {
          best = el;
        }
      }
    }
    return best;
  },

  async _handleResumeUpload(form, profile) {
    if (!profile.resumeDataUrl) return;

    // Search the form and the full document (Greenhouse sometimes renders
    // the resume widget outside the <form> element in newer board layouts).
    const scopes = [form, document];
    let fileInput = null;
    for (const scope of scopes) {
      fileInput =
        scope.querySelector("#resume_upload input[type='file']") ||
        scope.querySelector("input[type='file'][name*='resume']") ||
        scope.querySelector("input[type='file'][name*='cv']") ||
        scope.querySelector("input[type='file'][accept*='pdf']") ||
        scope.querySelector("input[type='file']");
      if (fileInput) break;
    }

    if (fileInput) {
      await formFiller.fillFileInput(fileInput, profile.resumeDataUrl, profile.resumeFileName);
      await humanDelay.betweenFields();
    }
  },

  async _handleEeocSection(profile, onUnknown) {
    // Greenhouse renders EEOC fields in a separate div after the main form
    const eeocSection = document.querySelector(
      "#demographic_questions, .demographic-questions, [id*='eeoc'], [class*='eeoc']"
    );
    if (!eeocSection) return;

    await formFiller.fillContainer(eeocSection, profile, onUnknown);
  },

  _logApplication(profile) {
    const meta = document.querySelector("meta[property='og:title']");
    const role = meta ? meta.content : document.title;
    chrome.runtime.sendMessage({
      type: MSG.LOG_APPLICATION,
      payload: {
        site: "greenhouse",
        company: document.querySelector(".company-name, h1.company")?.textContent.trim() || "",
        role: role.trim(),
        url: window.location.href,
      },
    }).catch(() => {});
  },
};
