// Generic ATS handler — fallback for any application form not covered by a
// dedicated site handler (Rippling ATS, iCIMS, Jobvite, SmartRecruiters,
// custom company career sites, etc.). The internship README lists link out
// to dozens of different platforms per company, so most job pages land here
// rather than on one of the named sites. Uses the same generic form-fill
// pipeline (formScanner/formFiller) the dedicated handlers use, just without
// site-specific selectors.

window.__jaHandler = {
  detectionRules: {
    urlPatterns: [/.*/],
    selectors: ['form input:not([type="hidden"])', 'form select', 'form textarea'],
  },

  _paused: false,

  pause() { this._paused = true },

  async run(profile, onUnknown) {
    this._paused = false
    floatingButton.setState(floatingButton.STATES.RUNNING)

    try {
      await this._fillForm(profile, onUnknown)
    } catch (err) {
      console.error('[JobApplier] Generic ATS error:', err)
      floatingButton.setState(floatingButton.STATES.ERROR)
      chrome.runtime.sendMessage({
        type: MSG.FILL_LOG,
        payload: { severity: 'warn', text: `⚠ Generic ATS error: ${err.message}` },
      }).catch(() => {})
    }
  },

  async _fillForm(profile, onUnknown) {
    const form = document.querySelector('form')
    if (!form) {
      floatingButton.setState(floatingButton.STATES.ERROR)
      chrome.runtime.sendMessage({
        type: MSG.FILL_LOG,
        payload: { severity: 'warn', text: '⚠ Generic ATS: application form not found on this page' },
      }).catch(() => {})
      return
    }

    floatingButton.setProgress('Uploading resume…')
    chrome.runtime.sendMessage({ type: MSG.FILL_LOG, payload: { label: 'Resume', status: 'uploading' } }).catch(() => {})
    await this._handleResumeUpload(form, profile)
    chrome.runtime.sendMessage({ type: MSG.FILL_LOG, payload: { label: 'Resume', status: 'uploaded' } }).catch(() => {})

    floatingButton.setProgress('Filling form…')
    formScanner.report({
      site:    'generic',
      company: this._companyFromPage(),
      role:    document.querySelector('h1')?.textContent.trim() || document.title,
      url:     window.location.href,
      fields:  formScanner.scan(form),
    })

    await formFiller.fillContainer(form, profile, onUnknown)

    if (this._paused) {
      floatingButton.setState(floatingButton.STATES.PAUSED)
      return
    }

    floatingButton.setState(floatingButton.STATES.DONE)
    floatingButton.setProgress('Review & submit')

    if (profile.autoSubmit) {
      await humanDelay.beforeClick()
      const submitBtn =
        form.querySelector('button[type="submit"]') ||
        form.querySelector('input[type="submit"]') ||
        [...form.querySelectorAll('button')].find(b => /submit|apply/i.test(b.textContent))
      if (submitBtn) submitBtn.click()
    }

    this._logApplication()
  },

  async _handleResumeUpload(form, profile) {
    if (!profile.resumeDataUrl) return

    const scopes = [form, document]
    let fileInput = null
    for (const scope of scopes) {
      fileInput =
        scope.querySelector('input[type="file"][name*="resume" i]') ||
        scope.querySelector('input[type="file"][name*="cv" i]') ||
        scope.querySelector('input[type="file"][accept*="pdf"]') ||
        scope.querySelector('input[type="file"]')
      if (fileInput) break
    }

    if (fileInput) {
      await formFiller.fillFileInput(fileInput, profile.resumeDataUrl, profile.resumeFileName)
      await humanDelay.betweenFields()
    }
  },

  _companyFromPage() {
    const t = document.title
    if (t.includes(' at ')) return t.split(' at ').slice(-1)[0].trim()
    if (t.includes(' - '))  return t.split(' - ')[0].trim()
    return location.hostname
  },

  _logApplication() {
    chrome.runtime.sendMessage({
      type: MSG.LOG_APPLICATION,
      payload: {
        site:    'generic',
        company: this._companyFromPage(),
        role:    document.querySelector('h1')?.textContent.trim() || document.title,
        url:     window.location.href,
      },
    }).catch(() => {})
  },
}
