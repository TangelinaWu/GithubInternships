// Message type constants for GH Internships extension

const MSG = {
  // Content → Background: ask Claude to answer an unknown form field
  ASK_CLAUDE: 'ASK_CLAUDE',

  // Background → Content: Claude's response
  CLAUDE_RESPONSE: 'CLAUDE_RESPONSE',

  // Content → Background: fill status updates
  FILL_STATUS: 'FILL_STATUS',

  // Popup → Content: query current status
  GET_STATUS: 'GET_STATUS',

  // Content → Background: analyze fit between job description and user profile
  CHECK_FIT: 'CHECK_FIT',

  // Background → Control: fit check result is ready
  FIT_RESULT: 'FIT_RESULT',

  // Content → Background: log a completed application
  LOG_APPLICATION: 'LOG_APPLICATION',

  // Content → Background: show an unknown field question in the control window
  OVERLAY_QUESTION: 'OVERLAY_QUESTION',

  // Control window → Background → Content: user's answer to the overlay question
  OVERLAY_ANSWER: 'OVERLAY_ANSWER',

  // Content → Background: bring the sending tab into focus
  FOCUS_TAB: 'FOCUS_TAB',

  // Content → Background → Control: diagnostic fill log
  FILL_LOG: 'FILL_LOG',

  // Content → Background → Control: all fields discovered on an application form
  FORM_DISCOVERED: 'FORM_DISCOVERED',

  // Auto-apply pipeline
  AUTO_APPLY_STARTED:  'AUTO_APPLY_STARTED',
  AUTO_APPLY_FILLING:  'AUTO_APPLY_FILLING',
  AUTO_APPLY_COMPLETE: 'AUTO_APPLY_COMPLETE',
  // The apply-button click or form fill failed (as opposed to COMPLETE) —
  // control panel shows a Failed state with a manual "I Applied" fallback
  // instead of assuming success.
  AUTO_APPLY_FAILED:   'AUTO_APPLY_FAILED',

  // GitHub-specific: new job detected on ATS page, currently being assessed
  GH_ASSESSING: 'GH_ASSESSING',

  // Content → Background → Control: extraction never found a job description
  // or application form on this page (custom career sites and multi-step ATS
  // flows can hide both behind an intermediate click) — surfaced as a Failed
  // state instead of silently doing nothing.
  GH_ASSESS_FAILED: 'GH_ASSESS_FAILED',

  // Control → Content: user clicked Apply in control panel
  GH_DO_APPLY: 'GH_DO_APPLY',

  // Control → Content: user clicked Skip in control panel
  GH_DO_SKIP: 'GH_DO_SKIP',

  // GitHub README: mark a listing row as seen/applied for visual highlighting
  GH_MARK_SEEN: 'GH_MARK_SEEN',

  // Batch auto-apply queue (github.js → background → github.js)
  QUEUE_START:    'QUEUE_START',
  QUEUE_PROGRESS: 'QUEUE_PROGRESS',
  QUEUE_DONE:     'QUEUE_DONE',

  // Background → GitHub tab: open this job URL as a new tab. Routed through
  // the content script's own window.open/anchor-click instead of
  // chrome.tabs.create — the extension tabs API doesn't reliably create a
  // visible new window in the Electron shell, but window.open does (it's
  // wired straight into the app's native window-open handling).
  OPEN_JOB_URL: 'OPEN_JOB_URL',

  // GitHub tab → Background: this repo page is ready, with N pending-new jobs
  SOURCE_READY: 'SOURCE_READY',

  // Background → Control: the known set of source tabs changed
  SOURCES_UPDATED: 'SOURCES_UPDATED',

  // Control → Background: give me the current known sources (sendResponse)
  REQUEST_SOURCES: 'REQUEST_SOURCES',

  // Control → Background: user picked which source tab to auto-apply from
  PICK_SOURCE: 'PICK_SOURCE',

  // Background → Content (github.js): start this tab's auto-apply queue
  START_QUEUE: 'START_QUEUE',

  // Background → Content (claude.js): run this job-fit prompt in the
  // designated project — targets one specific claude.ai tab directly so
  // multiple open claude.ai tabs never race on the same request.
  RUN_CLAUDE_JOB_ANALYSIS: 'RUN_CLAUDE_JOB_ANALYSIS',

  // Content (main.js) → Background: scan the currently-filled-in form
  // values and ask Claude to turn them into reusable answers.json entries.
  SCAN_ANSWERS: 'SCAN_ANSWERS',

  // Background → Content (claude.js): run this answer-scan prompt, targeted
  // the same way as RUN_CLAUDE_JOB_ANALYSIS.
  RUN_CLAUDE_ANSWER_SCAN: 'RUN_CLAUDE_ANSWER_SCAN',
}

const FILL_STATUS = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  WAITING_USER: 'waiting_user',
  DONE: 'done',
  ERROR: 'error',
}
