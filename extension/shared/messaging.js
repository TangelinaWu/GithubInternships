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

  // GitHub-specific: new job detected on ATS page, currently being assessed
  GH_ASSESSING: 'GH_ASSESSING',

  // Control → Content: user clicked Apply in control panel
  GH_DO_APPLY: 'GH_DO_APPLY',

  // Control → Content: user clicked Skip in control panel
  GH_DO_SKIP: 'GH_DO_SKIP',

  // GitHub README: mark a listing row as seen/applied for visual highlighting
  GH_MARK_SEEN: 'GH_MARK_SEEN',
}

const FILL_STATUS = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  WAITING_USER: 'waiting_user',
  DONE: 'done',
  ERROR: 'error',
}
