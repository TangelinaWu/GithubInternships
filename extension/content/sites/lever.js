// Lever ATS handler
// URLs: jobs.lever.co/{company}/{jobId}/apply

window.__jaHandler = {
  detectionRules: {
    urlPatterns: [/lever\.co\/.+\/apply/i],
    selectors: ["#application-form", "form.application-form", "[data-lever-form]"],
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
      console.error("[JobApplier] Lever error:", err);
      floatingButton.setState(floatingButton.STATES.ERROR);
      chrome.runtime.sendMessage({
        type: MSG.FILL_LOG,
        payload: { severity: 'warn', text: `⚠ Lever error: ${err.message}` },
      }).catch(() => {});
      return;
    }
  },

  async _fillForm(profile, onUnknown) {
    // Lever has a single-page form with standard HTML inputs
    const form =
      document.getElementById("application-form") ||
      document.querySelector("form.application-form") ||
      document.querySelector("form");

    if (!form) {
      floatingButton.setState(floatingButton.STATES.ERROR);
      chrome.runtime.sendMessage({
        type: MSG.FILL_LOG,
        payload: { severity: 'warn', text: '⚠ Lever: application form not found on this page' },
      }).catch(() => {});
      return;
    }

    floatingButton.setProgress("Filling form…");

    // Scan form fields before filling
    formScanner.report({
      site: 'lever',
      company: window.location.pathname.split('/')[1] || '',
      role: document.title.replace(' - Lever', '').trim(),
      url: window.location.href,
      fields: formScanner.scan(form),
    })

    // Log resume upload
    chrome.runtime.sendMessage({ type: MSG.FILL_LOG, payload: { label: 'Resume', status: 'uploading' } }).catch(() => {});
    await this._handleResumeUpload(form, profile);
    chrome.runtime.sendMessage({ type: MSG.FILL_LOG, payload: { label: 'Resume', status: 'uploaded' } }).catch(() => {});

    await formFiller.fillContainer(form, profile, onUnknown);

    if (this._paused) {
      floatingButton.setState(floatingButton.STATES.PAUSED);
      return;
    }

    await humanDelay.beforeClick();

    // Notify user to review and submit
    floatingButton.setState(floatingButton.STATES.DONE);
    floatingButton.setProgress("Review & submit");

    // If autoSubmit is enabled, click the submit button
    if (profile.autoSubmit) {
      const submitBtn = form.querySelector(
        'button[type="submit"], input[type="submit"], .submit-app-btn'
      );
      if (submitBtn) {
        await humanDelay.beforeClick();
        submitBtn.click();
      }
    }

    // Log the application attempt
    this._logApplication(profile);
  },

  async _handleResumeUpload(form, profile) {
    if (!profile.resumeDataUrl) return;

    // Lever renders the file input inside a drag-drop wrapper; search form then
    // fall back to document-wide in case the widget is outside the <form>.
    const scopes = [form, document];
    let fileInput = null;
    for (const scope of scopes) {
      fileInput =
        scope.querySelector('input[type="file"][name*="resume"]') ||
        scope.querySelector('input[type="file"][name*="cv"]') ||
        scope.querySelector('input[type="file"][accept*="pdf"]') ||
        scope.querySelector('input[type="file"]');
      if (fileInput) break;
    }

    if (fileInput) {
      await formFiller.fillFileInput(fileInput, profile.resumeDataUrl, profile.resumeFileName);
      await humanDelay.betweenFields();
    }
  },

  _logApplication(profile) {
    const jobTitle = document.title.replace(" - Lever", "").trim();
    chrome.runtime.sendMessage({
      type: MSG.LOG_APPLICATION,
      payload: {
        site: "lever",
        company: window.location.pathname.split("/")[1] || "",
        role: jobTitle,
        url: window.location.href,
      },
    }).catch(() => {});
  },
};
