// Detects whether the current page contains a job application form.
// Each site handler registers detection rules; this module evaluates them.

const detector = {
  // Evaluate detection rules against the current page.
  // rules: { urlPatterns?: RegExp[], selectors?: string[], any?: boolean }
  // Returns true if any rule matches (any=true) or all rules match (any=false, default).
  detect(rules) {
    if (!rules) return false;

    const checks = [];

    if (rules.urlPatterns && rules.urlPatterns.length > 0) {
      const urlMatch = rules.urlPatterns.some((re) => re.test(window.location.href));
      checks.push(urlMatch);
    }

    if (rules.selectors && rules.selectors.length > 0) {
      const selectorMatch = rules.selectors.some((sel) => !!document.querySelector(sel));
      checks.push(selectorMatch);
    }

    if (checks.length === 0) return false;

    return rules.any !== false
      ? checks.some(Boolean)
      : checks.every(Boolean);
  },

  // Watch for the form to appear in a SPA (e.g., LinkedIn) using MutationObserver.
  // Calls onDetected() when detection rules start matching.
  watchForForm(rules, onDetected) {
    let triggered = false;

    const observer = new MutationObserver(() => {
      if (!triggered && this.detect(rules)) {
        triggered = true;
        observer.disconnect();
        onDetected();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Stop watching after 60 seconds to avoid indefinite observation
    setTimeout(() => observer.disconnect(), 60000);

    return observer;
  },
};
