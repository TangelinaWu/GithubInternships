// Content script for claude.ai
// Two modes:
//   pendingClaudePrompt      — manual Check Fit: just send the message, user reads it
//   pendingClaudeJobAnalysis — auto-matcher: send, wait for response, parse, write claudeJobResult
//
// All job-analysis prompts are routed through the designated project so Claude
// has the project's instructions and memory context.

const CLAUDE_PROJECT_URL = 'https://claude.ai/project/019ead72-f6d6-74aa-84ee-5c652fd866d0'

const EDITOR_SELECTORS = [
  'div[contenteditable="true"]',
  '.ProseMirror',
  '[data-testid="chat-input"]',
]
const SEND_BTN_SELECTORS = [
  'button[aria-label="Send message"]',
  'button[aria-label="Send Message"]',
  'button[aria-label*="send" i]',
  'button[data-testid="send-button"]',
]

function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

function isOnProject() {
  return window.location.href.includes('019ead72-f6d6-74aa-84ee-5c652fd866d0')
}

async function waitForEditor(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const sel of EDITOR_SELECTORS) {
      const el = document.querySelector(sel)
      if (el && el.offsetParent !== null) return el
    }
    await wait(200)
  }
  return null
}

function editorIsEmpty(editor) {
  return (editor.innerText || editor.textContent || '').trim().length === 0
}

// Try three insertion strategies in order of reliability, verifying the
// editor actually picked up the text before moving on. Claude's editor
// (Lexical/ProseMirror) often ignores a synthetic, untrusted
// ClipboardEvent('paste', ...) entirely since it's not a real browser paste —
// execCommand goes through the browser's actual editing pipeline (real input
// events), so it's tried first.
async function insertPromptText(editor, text) {
  editor.focus()
  await wait(150)

  document.execCommand('selectAll', false, null)
  document.execCommand('insertText', false, text)
  await wait(200)
  if (!editorIsEmpty(editor)) return true

  try {
    const dt = new DataTransfer()
    dt.setData('text/plain', text)
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  } catch {
    // fall through to the last-resort strategy below
  }
  await wait(300)
  if (!editorIsEmpty(editor)) return true

  editor.textContent = text
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: text, inputType: 'insertText' }))
  await wait(300)
  return !editorIsEmpty(editor)
}

async function sendPromptToClaude(text) {
  const editor = await waitForEditor()
  if (!editor) return false

  const inserted = await insertPromptText(editor, text)
  if (!inserted) return false

  await wait(400)

  for (const sel of SEND_BTN_SELECTORS) {
    const btn = document.querySelector(sel)
    if (btn && !btn.disabled) { btn.click(); return true }
  }
  // Last resort: Enter key
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }))
  return true
}

// ── Response detection ────────────────────────────────────────────────────────

async function waitForStructuredResponse() {
  // Poll on a 3 → 5 → 9 second cycle (repeating). Once the structured keywords
  // are all present, wait for text to stabilise across two consecutive checks
  // (handles still-streaming responses) then return.
  // Fallback: if a standalone YES/NO line appears and stabilises, return that
  // too — handles terse responses that skip the full structured format.
  const DELAYS    = [3000, 5000, 9000]
  const deadline  = Date.now() + 180000  // 3 min max
  let lastText    = ''
  let stableCount = 0
  let di = 0

  while (Date.now() < deadline) {
    await wait(DELAYS[di % DELAYS.length])
    di++

    const text      = document.body.innerText
    const textUpper = text.toUpperCase()

    // Primary: look for FIELD + DEGREE + REASON (case-insensitive)
    const lastField = textUpper.lastIndexOf('FIELD:')
    const hasStructure = lastField !== -1
      && textUpper.slice(lastField).includes('DEGREE:')
      && textUpper.slice(lastField).includes('REASON:')

    // Fallback: any line that is exactly YES or NO
    const hasVerdict = !hasStructure
      && textUpper.split('\n').some(l => /^\s*(YES|NO)[.!?]?\s*$/.test(l))

    if (hasStructure || hasVerdict) {
      if (text === lastText) {
        stableCount++
        if (stableCount >= 2) {
          if (hasStructure) return text.slice(Math.max(0, lastField - 400), lastField + 400)
          return text.slice(-1200)   // tail of page — contains the YES/NO answer
        }
      } else {
        stableCount = 0
        lastText = text
      }
    } else {
      lastText = text
      stableCount = 0
    }
  }

  return null
}

// Waits for a fenced ```json ... ``` block (or a trailing [...] array) to
// appear and stabilise — used by the answer-scan flow, which asks Claude to
// respond with a JSON array instead of the structured YES/NO format above.
async function waitForJsonResponse() {
  const DELAYS    = [3000, 5000, 8000]
  const deadline  = Date.now() + 120000  // 2 min max
  let lastText    = ''
  let stableCount = 0
  let di = 0

  while (Date.now() < deadline) {
    await wait(DELAYS[di % DELAYS.length])
    di++

    const text  = document.body.innerText
    const match = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/(\[[\s\S]*\])\s*$/)

    if (match) {
      if (text === lastText) {
        stableCount++
        if (stableCount >= 2) return match[1].trim()
      } else {
        stableCount = 0
        lastText = text
      }
    } else {
      lastText = text
      stableCount = 0
    }
  }

  return null
}

function parseJobAnalysis(text) {
  if (!text) return null

  const textUpper = text.toUpperCase()

  // ── Structured path ───────────────────────────────────────────────────────
  const fieldIdx = textUpper.lastIndexOf('FIELD:')
  if (fieldIdx !== -1) {
    const preField = text.slice(0, fieldIdx)
    const preLines = preField.split('\n').map(l => l.trim().toUpperCase())
    const verdict  = [...preLines].reverse().find(l => /^(YES|NO)[.!?]?$/.test(l))

    if (verdict) {
      const decision = verdict === 'YES' ? 'APPLY' : 'SKIP'
      const block = text.slice(fieldIdx)
      const fieldMatch      = block.match(/FIELD:\s*(YES|NO)/i)
      const degreeMatch     = block.match(/DEGREE:\s*(YES|NO)/i)
      const paidMatch       = block.match(/PAID:\s*(YES|NO)/i)
      const experienceMatch = block.match(/EXPERIENCE:\s*(YES|NO)/i)
      const reasonMatch     = block.match(/REASON:\s*([^\n]+)/i)
      return {
        decision,
        criteria: {
          field:      fieldMatch?.[1]?.toUpperCase(),
          degree:     degreeMatch?.[1]?.toUpperCase(),
          paid:       paidMatch?.[1]?.toUpperCase(),
          experience: experienceMatch?.[1]?.toUpperCase(),
        },
        reason: (reasonMatch?.[1] || '').trim().slice(0, 200),
      }
    }
  }

  // ── Fallback: plain YES / NO without structured keywords ─────────────────
  const lines = text.split('\n').map(l => l.trim().toUpperCase())
  const plain = lines.find(l => /^(YES|NO)[.!?]?$/.test(l))
  if (plain) {
    const reasonLine = text.split('\n').find(l => l.trim().length > 5 && !/^(YES|NO)[.!?]?$/i.test(l.trim()))
    return {
      decision: plain.startsWith('YES') ? 'APPLY' : 'SKIP',
      criteria: {},
      reason: (reasonLine || '').trim().slice(0, 200),
    }
  }

  return null
}

// ── Entry points ──────────────────────────────────────────────────────────────

let _processingAnalysis = false

// Route through the project so Claude has project-level context. If not
// already there, save the prompt (and which handler should run once we
// arrive) to a handoff key and navigate. On full-page reload the new load
// picks it up via storage.get; on SPA navigation the onChanged listener
// picks it up once the URL is the project. Returns true if it redirected
// (caller should stop — the handoff will resume the real work after landing).
async function redirectToProjectIfNeeded(promptText, kind) {
  if (isOnProject()) return false
  await new Promise(r => chrome.storage.local.set(
    { _pendingProjectAnalysis: promptText, _pendingProjectKind: kind }, r
  ))
  window.location.href = CLAUDE_PROJECT_URL
  return true
}

async function handleJobAnalysis(promptText) {
  if (_processingAnalysis) return
  _processingAnalysis = true
  try {
    if (await redirectToProjectIfNeeded(promptText, 'job')) return

    const sent = await sendPromptToClaude(promptText)
    if (!sent) {
      chrome.storage.local.set({ claudeJobResult: { error: 'editor_not_found', decision: 'SKIP' } })
      return
    }
    const responseText = await waitForStructuredResponse()
    const result = parseJobAnalysis(responseText)
    chrome.storage.local.set({ claudeJobResult: result || { error: 'parse_failed', decision: 'SKIP' } })
  } catch (e) {
    chrome.storage.local.set({ claudeJobResult: { error: String(e), decision: 'SKIP' } })
  } finally {
    _processingAnalysis = false
  }
}

// Scans-my-answers flow — asks Claude to turn manually-typed form values
// into reusable answers.json entries, returned as a JSON array.
async function handleAnswerScan(promptText) {
  if (_processingAnalysis) return
  _processingAnalysis = true
  try {
    if (await redirectToProjectIfNeeded(promptText, 'answers')) return

    const sent = await sendPromptToClaude(promptText)
    if (!sent) {
      chrome.storage.local.set({ claudeAnswerScanResult: { error: 'editor_not_found' } })
      return
    }
    const raw = await waitForJsonResponse()
    chrome.storage.local.set({ claudeAnswerScanResult: raw ? { json: raw } : { error: 'parse_failed' } })
  } catch (e) {
    chrome.storage.local.set({ claudeAnswerScanResult: { error: String(e) } })
  } finally {
    _processingAnalysis = false
  }
}

function handlePendingPrompt(text) {
  const go = () => setTimeout(() => sendPromptToClaude(text), 800)
  if (document.readyState === 'complete') go()
  else window.addEventListener('load', go, { once: true })
}

function runByKind(kind, text) {
  return kind === 'answers' ? handleAnswerScan(text) : handleJobAnalysis(text)
}

// On page load — check for queued work
chrome.storage.local.get(
  ['pendingClaudeJobAnalysis', 'pendingClaudePrompt', '_pendingProjectAnalysis', '_pendingProjectKind'],
  (data) => {
    if (data._pendingProjectAnalysis && isOnProject()) {
      // Handoff from a navigation — we're now on the project page
      chrome.storage.local.remove(['_pendingProjectAnalysis', '_pendingProjectKind'])
      setTimeout(() => runByKind(data._pendingProjectKind, data._pendingProjectAnalysis), 1000)
    } else if (data.pendingClaudeJobAnalysis) {
      chrome.storage.local.remove('pendingClaudeJobAnalysis')
      setTimeout(() => handleJobAnalysis(data.pendingClaudeJobAnalysis), 1000)
    } else if (data.pendingClaudePrompt) {
      chrome.storage.local.remove('pendingClaudePrompt')
      handlePendingPrompt(data.pendingClaudePrompt)
    }
  }
)

// Direct, targeted trigger — background sends these to exactly one claude.ai
// tab (chosen via chrome.tabs.query, a read-only/reliable call) instead of
// broadcasting to every open claude.ai tab, so only one tab ever redirects
// to and sends within the project.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === MSG.RUN_CLAUDE_JOB_ANALYSIS && !_processingAnalysis) {
    handleJobAnalysis(msg.payload?.prompt)
  }
  if (msg.type === MSG.RUN_CLAUDE_ANSWER_SCAN && !_processingAnalysis) {
    handleAnswerScan(msg.payload?.prompt)
  }
})

// While tab is already open — react to storage changes (fallback path, used
// when no claude.ai tab existed yet for the targeted messages above to reach).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return

  // Handoff key: set by redirectToProjectIfNeeded after navigating to
  // project; only process it once we're actually on the project page
  if (changes._pendingProjectAnalysis?.newValue && !_processingAnalysis && isOnProject()) {
    const text = changes._pendingProjectAnalysis.newValue
    chrome.storage.local.get('_pendingProjectKind', ({ _pendingProjectKind }) => {
      chrome.storage.local.remove(['_pendingProjectAnalysis', '_pendingProjectKind'])
      runByKind(_pendingProjectKind, text)
    })
  }

  if (changes.pendingClaudeJobAnalysis?.newValue && !_processingAnalysis) {
    const text = changes.pendingClaudeJobAnalysis.newValue
    chrome.storage.local.remove('pendingClaudeJobAnalysis')
    handleJobAnalysis(text)
  }

  if (changes.pendingClaudePrompt?.newValue) {
    const text = changes.pendingClaudePrompt.newValue
    chrome.storage.local.remove('pendingClaudePrompt')
    handlePendingPrompt(text)
  }
})
