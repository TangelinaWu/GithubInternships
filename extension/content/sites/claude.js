// Content script for claude.ai
// Two modes:
//   pendingClaudePrompt      — manual Check Fit: just send the message, user reads it
//   pendingClaudeJobAnalysis — auto-matcher: send, wait for response, parse, write claudeJobResult

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

async function sendPromptToClaude(text) {
  const editor = await waitForEditor()
  if (!editor) return false

  editor.focus()
  await wait(150)

  // ClipboardEvent paste — most reliable for Lexical/ProseMirror editors
  try {
    const dt = new DataTransfer()
    dt.setData('text/plain', text)
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  } catch {
    // Fallback: execCommand (deprecated but still works in Chromium)
    document.execCommand('selectAll', false, null)
    document.execCommand('delete', false, null)
    document.execCommand('insertText', false, text)
  }

  await wait(600)

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
  // Poll every 800ms. Once FIELD + DEGREE + REASON are all present, wait for
  // the content to stop changing for two consecutive checks (1.6s stable) before
  // returning — this handles slow or streaming responses without fixed waits.
  const deadline = Date.now() + 90000
  let lastText = ''
  let stableCount = 0

  while (Date.now() < deadline) {
    await wait(800)
    const text = document.body.innerText
    const lastField = text.lastIndexOf('FIELD:')

    if (lastField !== -1 && text.slice(lastField).includes('DEGREE:') && text.slice(lastField).includes('REASON:')) {
      if (text === lastText) {
        stableCount++
        if (stableCount >= 2) {
          return text.slice(Math.max(0, lastField - 400), lastField + 400)
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

function parseJobAnalysis(text) {
  if (!text) return null

  // Use lastIndexOf — the snippet may contain earlier FIELD: blocks from the prompt
  // template or previous job responses. We always want the LATEST one.
  const fieldIdx = text.lastIndexOf('FIELD:')
  if (fieldIdx === -1) return null

  // Find the last standalone YES or NO line before this FIELD: block
  const preField = text.slice(0, fieldIdx)
  const preLines = preField.split('\n').map(l => l.trim().toUpperCase())
  const verdict  = [...preLines].reverse().find(l => /^(YES|NO)[.!?]?$/.test(l))
  if (!verdict) return null

  const decision = verdict === 'YES' ? 'APPLY' : 'SKIP'

  // Scope all regex matches to AFTER fieldIdx so we read from the current response only
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

// ── Entry points ──────────────────────────────────────────────────────────────

let _processingAnalysis = false

async function handleJobAnalysis(promptText) {
  if (_processingAnalysis) return
  _processingAnalysis = true
  try {
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

function handlePendingPrompt(text) {
  const go = () => setTimeout(() => sendPromptToClaude(text), 800)
  if (document.readyState === 'complete') go()
  else window.addEventListener('load', go, { once: true })
}

// On page load — check for queued work
chrome.storage.local.get(['pendingClaudeJobAnalysis', 'pendingClaudePrompt'], (data) => {
  if (data.pendingClaudeJobAnalysis) {
    chrome.storage.local.remove('pendingClaudeJobAnalysis')
    setTimeout(() => handleJobAnalysis(data.pendingClaudeJobAnalysis), 1000)
  } else if (data.pendingClaudePrompt) {
    chrome.storage.local.remove('pendingClaudePrompt')
    handlePendingPrompt(data.pendingClaudePrompt)
  }
})

// While tab is already open — react to storage changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return

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
