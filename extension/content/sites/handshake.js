// Handshake handler
// app.joinhandshake.com — React-based application form

window.__jaHandler = {
  detectionRules: {
    urlPatterns: [/joinhandshake\.com\/(jobs|postings)\/\d+\/apply/i],
    selectors: [
      ".application-form",
      "[data-component='ApplicationForm']",
      "form[action*='apply']",
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
      console.error("[JobApplier] Handshake error:", err);
      floatingButton.setState(floatingButton.STATES.ERROR);
      chrome.runtime.sendMessage({
        type: MSG.FILL_LOG,
        payload: { severity: 'warn', text: `⚠ Handshake error: ${err.message}` },
      }).catch(() => {});
    }
  },

  async _fillForm(profile, onUnknown) {
    const form =
      document.querySelector(".application-form") ||
      document.querySelector("form[action*='apply']") ||
      document.querySelector("form");

    if (!form) {
      floatingButton.setState(floatingButton.STATES.ERROR);
      chrome.runtime.sendMessage({
        type: MSG.FILL_LOG,
        payload: { severity: 'warn', text: '⚠ Handshake: application form not found on this page' },
      }).catch(() => {});
      return;
    }

    floatingButton.setProgress("Filling form…");

    // Scan form fields before filling
    formScanner.report({
      site: 'handshake',
      company: document.querySelector('.company-name, .employer-name')?.textContent.trim() || '',
      role: document.querySelector('h1, .job-title')?.textContent.trim() || document.title,
      url: window.location.href,
      fields: formScanner.scan(form),
    })

    // Handshake uses a previously-uploaded resume from the user's account.
    // The document picker shows a list of uploaded resumes.
    await this._selectResume();

    // Fill all standard text/select/radio fields
    await formFiller.fillContainer(form, profile, onUnknown);

    if (this._paused) {
      floatingButton.setState(floatingButton.STATES.PAUSED);
      return;
    }

    floatingButton.setState(floatingButton.STATES.DONE);
    floatingButton.setProgress("Review & submit");

    if (profile.autoSubmit) {
      await humanDelay.beforeClick();
      const submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.click();
    }

    this._logApplication();
  },

  async _selectResume() {
    // Handshake shows a list of the user's uploaded documents.
    // We click the first radio option for the resume section.
    const resumeSection = document.querySelector(
      "[data-component='DocumentSelector'], " +
      ".document-selection, " +
      "[class*='resume-select'], " +
      "[aria-label*='resume'], " +
      "[aria-label*='Resume']"
    );

    if (!resumeSection) return;

    // Select the first available resume option (radio or button)
    const firstOption =
      resumeSection.querySelector('input[type="radio"]') ||
      resumeSection.querySelector('button:first-child');

    if (firstOption) {
      firstOption.click();
      await humanDelay.short();
    }
  },

  _logApplication() {
    const role = document.querySelector("h1, .job-title")?.textContent.trim() || document.title;
    const company = document.querySelector(".company-name, .employer-name")?.textContent.trim() || "";
    chrome.runtime.sendMessage({
      type: MSG.LOG_APPLICATION,
      payload: {
        site: "handshake",
        company,
        role,
        url: window.location.href,
      },
    }).catch(() => {});
  },
};
