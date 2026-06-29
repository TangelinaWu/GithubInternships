// Form field scanner — collects metadata (label, type, options) from a container
// without filling anything. Run this before formFiller so the pristine form is captured.
//
// Depends on: formFiller (getLabelText, classifyElement, isVisible)

const formScanner = {

  // Scan all visible fields in `container`.
  // Returns an array of { label, type, required?, options? }.
  scan(container) {
    const fields = []
    const seenLabels  = new Set()
    const seenRadios  = new Set()

    for (const el of container.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), ' +
      'select, textarea, [role="combobox"]'
    )) {
      if (!formFiller.isVisible(el)) continue

      const type = formFiller.classifyElement(el)
      if (type === 'hidden' || type === 'button' || type === 'unknown') continue

      // Radio groups — deduplicate by name, collect all option labels
      if (type === 'radio') {
        const groupKey = el.name || formFiller.getLabelText(el)
        if (seenRadios.has(groupKey)) continue
        seenRadios.add(groupKey)

        const groupLabel = this._radioGroupLabel(el)
        if (!groupLabel) continue
        if (seenLabels.has(groupLabel)) continue
        seenLabels.add(groupLabel)

        const radios = el.name
          ? [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)]
          : [el]
        const options = radios
          .map(r => formFiller.getLabelText(r) || r.value)
          .filter(Boolean)

        fields.push({ label: groupLabel, type: 'radio', options })
        continue
      }

      const label = formFiller.getLabelText(el)
      if (!label) continue
      if (seenLabels.has(label)) continue
      seenLabels.add(label)

      const field = { label, type }

      if (el.required || el.getAttribute('aria-required') === 'true') {
        field.required = true
      }

      // Collect options for native <select>
      if (type === 'select') {
        field.options = [...el.options]
          .filter(o => o.value !== '' && o.text.trim() !== '')
          .map(o => o.text.trim())
      }

      fields.push(field)
    }

    return fields
  },

  // Send discovered fields to background → storage → control panel.
  report({ site, company, role, url, fields }) {
    if (!fields || fields.length === 0) return
    chrome.runtime.sendMessage({
      type: MSG.FORM_DISCOVERED,
      payload: { site, company, role, url, fields },
    }).catch(() => {})
  },

  // Get the group label for a radio button (fieldset legend or nearest label/heading).
  _radioGroupLabel(radioEl) {
    const fieldset = radioEl.closest('fieldset')
    if (fieldset) {
      const legend = fieldset.querySelector('legend')
      if (legend) return legend.textContent.trim()
    }
    // Fall back to the formFiller label lookup on the first radio in the group
    return formFiller.getLabelText(radioEl)
  },
}
