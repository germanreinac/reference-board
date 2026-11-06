// Undo and redo.
//
// Every change you make is recorded as a small "step" that knows how to undo
// itself and redo itself. Ctrl/⌘+Z walks back through the steps,
// Ctrl/⌘+Shift+Z (or Ctrl+Y) walks forward again.

const LIMIT = 200;  // how many steps are remembered

export class History {
  constructor(onChange = () => {}) {
    this.done = [];
    this.undone = [];
    this.onChange = onChange;
    this.busy = false;
  }

  // Record a step that has just happened: { undo(), redo() }. Both may be async.
  push(step) {
    this.done.push(step);
    if (this.done.length > LIMIT) this.done.shift();
    this.undone = [];
  }

  async undo() {
    if (this.busy || !this.done.length) return;
    this.busy = true;
    const step = this.done.pop();
    try { await step.undo(); this.undone.push(step); } finally { this.busy = false; }
    this.onChange();
  }

  async redo() {
    if (this.busy || !this.undone.length) return;
    this.busy = true;
    const step = this.undone.pop();
    try { await step.redo(); this.done.push(step); } finally { this.busy = false; }
    this.onChange();
  }

  clear() {
    this.done = [];
    this.undone = [];
  }
}
