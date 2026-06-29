// Human-like timing utilities.
// All delays use random ranges to avoid detectable regularity.

const humanDelay = {
  _rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  },

  // Between keystrokes when typing character-by-character
  keystroke() {
    return new Promise((r) => setTimeout(r, this._rand(20, 60)));
  },

  // After focusing a field, before filling it
  short() {
    return new Promise((r) => setTimeout(r, this._rand(80, 200)));
  },

  // Between filling one field and moving to the next
  betweenFields() {
    return new Promise((r) => setTimeout(r, this._rand(200, 500)));
  },

  // Before clicking a navigation button (Next, Submit)
  beforeClick() {
    return new Promise((r) => setTimeout(r, this._rand(300, 700)));
  },

  // After a page/section transition completes
  afterNavigation() {
    return new Promise((r) => setTimeout(r, this._rand(500, 1200)));
  },

  // Simulate typing one character at a time into an <input> or <textarea>.
  // Uses React-compatible native setter so the framework sees the change.
  async typeInto(element, text) {
    const isTextArea = element.tagName.toLowerCase() === "textarea";
    const nativeSetter = Object.getOwnPropertyDescriptor(
      isTextArea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value"
    ).set;

    element.focus();
    await this.short();

    for (const char of text) {
      nativeSetter.call(element, element.value + char);
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          data: char,
          inputType: "insertText",
        })
      );
      await this.keystroke();
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
  },
};
