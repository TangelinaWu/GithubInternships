// Routes unknown form field questions to the JobApplier control panel
// instead of showing a blocking modal on the application page.
// A small corner toast tells the user to look at the control panel.

const overlayManager = (() => {
  let toastHost = null;

  function showToast(question) {
    if (toastHost) return;
    toastHost = document.createElement('div');
    toastHost.id = 'ja-toast-host';
    const shadow = toastHost.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .toast {
          position: fixed;
          top: 16px;
          right: 16px;
          background: #4f46e5;
          color: #fff;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-size: 13px;
          padding: 10px 16px;
          border-radius: 10px;
          box-shadow: 0 4px 20px rgba(0,0,0,0.3);
          z-index: 2147483647;
          max-width: 260px;
          pointer-events: none;
          animation: slideIn 0.2s ease;
        }
        @keyframes slideIn {
          from { transform: translateX(20px); opacity: 0; }
          to   { transform: translateX(0);    opacity: 1; }
        }
        .title { font-weight: 700; margin-bottom: 3px; }
        .sub   { font-size: 11px; opacity: 0.85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .hint  { font-size: 11px; opacity: 0.6; margin-top: 4px; }
      </style>
      <div class="toast">
        <div class="title">&#x1F4AC; AI question</div>
        <div class="sub">${escapeHtml(question.slice(0, 55))}${question.length > 55 ? '…' : ''}</div>
        <div class="hint">Answer in the control panel</div>
      </div>
    `;
    document.body.appendChild(toastHost);
  }

  function hideToast() {
    if (toastHost) {
      toastHost.remove();
      toastHost = null;
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Show a non-blocking toast, route the question through the control window,
  // and resolve when the user accepts or skips in the control panel.
  async function ask(question, fieldContext) {
    return new Promise((resolve) => {
      const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      showToast(question);

      chrome.runtime.sendMessage({
        type: MSG.OVERLAY_QUESTION,
        payload: { requestId, question, fieldContext },
      });

      // Auto-skip after 2 minutes if the user doesn't respond in the control panel.
      // Must be long enough for Claude API to respond AND the user to review + click Use.
      const timeoutId = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(handler);
        hideToast();
        resolve({ accepted: false, value: '' });
      }, 120000);

      function handler(msg) {
        if (msg.type === MSG.OVERLAY_ANSWER && msg.payload?.requestId === requestId) {
          clearTimeout(timeoutId);
          chrome.runtime.onMessage.removeListener(handler);
          hideToast();
          resolve({ accepted: msg.payload.accepted, value: msg.payload.value || '' });
        }
      }
      chrome.runtime.onMessage.addListener(handler);
    });
  }

  return { ask };
})();
