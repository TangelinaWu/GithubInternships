// Floating "Auto Apply" button — fixed to bottom-right corner.
// Uses Shadow DOM for style isolation.
// The button is a state machine: IDLE → RUNNING ↔ PAUSED → DONE | ERROR

const BTN_STYLES = `
  :host { all: initial; }

  .pill {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 18px;
    border-radius: 99px;
    border: none;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 4px 16px rgba(0,0,0,0.18);
    transition: transform 0.1s, box-shadow 0.1s, background 0.2s;
    white-space: nowrap;
    line-height: 1;
    user-select: none;
  }

  .pill:hover { transform: scale(1.04); box-shadow: 0 6px 20px rgba(0,0,0,0.22); }
  .pill:active { transform: scale(0.97); }

  .pill.idle    { background: #4f46e5; color: #fff; }
  .pill.running { background: #f97316; color: #fff; }
  .pill.paused  { background: #f97316; color: #fff; }
  .pill.done    { background: #22c55e; color: #fff; }
  .pill.error   { background: #ef4444; color: #fff; }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: rgba(255,255,255,0.7);
    flex-shrink: 0;
  }

  .dot.pulse {
    animation: pulse 1.2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%       { opacity: 0.5; transform: scale(0.7); }
  }

  .progress {
    font-size: 11px;
    font-weight: 400;
    opacity: 0.85;
  }

  .row {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
  }

  .pill.scan {
    background: #0ea5e9;
    color: #fff;
    padding: 7px 14px;
    font-size: 12px;
  }
  .pill.scan:hover { transform: scale(1.04); }
  .pill.scan:disabled { opacity: 0.6; cursor: default; transform: none; }
`;

const floatingButton = (() => {
  const STATES = { IDLE: "idle", RUNNING: "running", PAUSED: "paused", DONE: "done", ERROR: "error" };

  let host = null;
  let shadow = null;
  let currentState = STATES.IDLE;
  let _isPaused = false;
  let onStartCb = null;
  let onPauseCb = null;
  let onScanCb = null;
  // Set only for the auto-apply pipeline — when present, the DONE state
  // means "filled, awaiting your confirmation" rather than "done": it stays
  // on screen indefinitely (no auto-hide) and clicking it logs Applied.
  let onConfirmCb = null;
  let idleLabel = null;
  let _scanBusy = false;
  let _scanLabel = "💾 Save my answers";
  const SCAN_LABEL_DEFAULT = "💾 Save my answers";

  function init() {
    if (host) return;
    host = document.createElement("div");
    host.id = "ja-btn-host";
    document.body.appendChild(host);
    shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = BTN_STYLES;
    shadow.appendChild(style);
  }

  function render(state, progressText) {
    if (!shadow) return;

    // Remove previous row if any
    const oldRow = shadow.getElementById("ja-row");
    if (oldRow) oldRow.remove();

    const row = document.createElement("div");
    row.id = "ja-row";
    row.className = "row";

    // Secondary button — scans whatever the user has manually filled in on
    // this page and asks Claude to turn it into reusable answers.json
    // entries. Only rendered when main.js provides an onScan callback.
    if (onScanCb) {
      const scanBtn = document.createElement("button");
      scanBtn.id = "ja-scan";
      scanBtn.className = "pill scan";
      scanBtn.textContent = _scanLabel;
      scanBtn.disabled = _scanBusy;
      scanBtn.addEventListener("click", handleScanClick);
      row.appendChild(scanBtn);
    }

    const btn = document.createElement("button");
    btn.id = "ja-pill";
    btn.className = `pill ${state}`;

    const dot = document.createElement("span");
    dot.className = "dot" + (state === STATES.RUNNING ? " pulse" : "");
    btn.appendChild(dot);

    const label = document.createElement("span");
    const labels = {
      [STATES.IDLE]:    idleLabel || "Auto Apply",
      [STATES.RUNNING]: "Pause",
      [STATES.PAUSED]:  "Resume",
      [STATES.DONE]:    onConfirmCb ? "✓ Confirm Applied" : "Applied!",
      [STATES.ERROR]:   "Error — retry?",
    };
    label.textContent = labels[state] || "Auto Apply";
    btn.appendChild(label);

    if (progressText) {
      const prog = document.createElement("span");
      prog.className = "progress";
      prog.textContent = progressText;
      btn.appendChild(prog);
    }

    btn.addEventListener("click", handleClick);
    row.appendChild(btn);
    shadow.appendChild(row);
  }

  async function handleScanClick() {
    if (_scanBusy || !onScanCb) return;
    _scanBusy = true;
    _scanLabel = "⏳ Scanning…";
    render(currentState);

    try {
      const result = await onScanCb();
      _scanLabel = result?.label || "✓ Saved";
    } catch (e) {
      _scanLabel = "⚠ Scan failed";
    }

    _scanBusy = false;
    render(currentState);
    setTimeout(() => {
      _scanLabel = SCAN_LABEL_DEFAULT;
      render(currentState);
    }, 4000);
  }

  function handleClick() {
    // Guard each transition on its callback existing — the auto-apply pipeline
    // only wires onPause/onConfirm (no onStart), so e.g. an ERROR-state click
    // there must not flip the label to "Pause" with nothing actually running.
    if ((currentState === STATES.IDLE || currentState === STATES.ERROR) && onStartCb) {
      setState(STATES.RUNNING);
      _isPaused = false;
      onStartCb();
    } else if (currentState === STATES.RUNNING && onPauseCb) {
      setState(STATES.PAUSED);
      _isPaused = true;
      onPauseCb();
    } else if (currentState === STATES.PAUSED && onStartCb) {
      setState(STATES.RUNNING);
      _isPaused = false;
      onStartCb(); // resume = restart from where we left off (handler manages state)
    } else if (currentState === STATES.DONE && onConfirmCb) {
      onConfirmCb();
      setState(STATES.IDLE);
    }
  }

  function setState(state, progressText) {
    currentState = state;
    render(state, progressText);

    // Plain manual-fill DONE is just a cosmetic flash — auto-hide it. The
    // auto-apply pipeline's "awaiting confirmation" DONE must stay clickable
    // until the user confirms, so skip the auto-hide when onConfirmCb is set.
    if (state === STATES.DONE && !onConfirmCb) {
      setTimeout(() => {
        setState(STATES.IDLE);
      }, 4000);
    }
  }

  function mount({ onStart, onPause, onScan, onConfirm, idleLabel: label }) {
    onStartCb = onStart;
    onPauseCb = onPause;
    onScanCb = onScan || null;
    onConfirmCb = onConfirm || null;
    idleLabel = label || null;
    init();
    render(STATES.IDLE);
  }

  function unmount() {
    if (host) host.remove();
    host = null;
    shadow = null;
    onScanCb = null;
    onConfirmCb = null;
    _scanBusy = false;
    _scanLabel = SCAN_LABEL_DEFAULT;
  }

  function setProgress(text) {
    render(currentState, text);
  }

  return {
    mount,
    unmount,
    setState,
    setProgress,
    STATES,
    isPaused() { return _isPaused; },
    getState() { return currentState; },
  };
})();
