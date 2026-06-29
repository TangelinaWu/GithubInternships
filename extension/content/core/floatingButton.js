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
  .pill.done    { background: #22c55e; color: #fff; cursor: default; }
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
`;

const floatingButton = (() => {
  const STATES = { IDLE: "idle", RUNNING: "running", PAUSED: "paused", DONE: "done", ERROR: "error" };

  let host = null;
  let shadow = null;
  let currentState = STATES.IDLE;
  let _isPaused = false;
  let onStartCb = null;
  let onPauseCb = null;
  let idleLabel = null;

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

    // Remove previous button if any
    const old = shadow.getElementById("ja-pill");
    if (old) old.remove();

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
      [STATES.DONE]:    "Applied!",
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
    shadow.appendChild(btn);
  }

  function handleClick() {
    if (currentState === STATES.IDLE || currentState === STATES.ERROR) {
      setState(STATES.RUNNING);
      _isPaused = false;
      if (onStartCb) onStartCb();
    } else if (currentState === STATES.RUNNING) {
      setState(STATES.PAUSED);
      _isPaused = true;
      if (onPauseCb) onPauseCb();
    } else if (currentState === STATES.PAUSED) {
      setState(STATES.RUNNING);
      _isPaused = false;
      if (onStartCb) onStartCb(); // resume = restart from where we left off (handler manages state)
    }
  }

  function setState(state, progressText) {
    currentState = state;
    render(state, progressText);

    if (state === STATES.DONE) {
      setTimeout(() => {
        setState(STATES.IDLE);
      }, 4000);
    }
  }

  function mount({ onStart, onPause, idleLabel: label }) {
    onStartCb = onStart;
    onPauseCb = onPause;
    idleLabel = label || null;
    init();
    render(STATES.IDLE);
  }

  function unmount() {
    if (host) host.remove();
    host = null;
    shadow = null;
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
  };
})();
