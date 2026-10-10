// A very small stand-in for the browser, enough to run public/app.js in Node without a DOM library.
// It is strict on purpose: setting innerHTML throws, so a page that tried to inject HTML would fail its test.

type Listener = (event: unknown) => unknown;

export class FakeElement {
  children: FakeElement[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  disabled = false;
  hidden = false;
  value = "";
  focused = false;
  #text = "";

  constructor(public tag: string) {}

  get textContent(): string {
    return this.#text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    this.#text = String(value);
    this.children = [];
  }
  get innerHTML(): string {
    throw new Error("innerHTML must never be used");
  }
  set innerHTML(_value: string) {
    throw new Error("innerHTML must never be used");
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  appendChild(child: FakeElement) {
    this.children.push(child);
    return child;
  }
  replaceChildren(...children: FakeElement[]) {
    this.children = children;
    this.#text = "";
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  focus() {
    this.focused = true;
  }
  /** Runs the listeners and waits for async ones to finish. */
  async fire(type: string, event: unknown = {}) {
    await Promise.all((this.listeners.get(type) ?? []).map((fn) => fn(event)));
  }
}

export class FakeDocument {
  byId = new Map<string, FakeElement>();
  created: FakeElement[] = [];
  #listeners = new Map<string, Listener[]>();

  getElementById(id: string) {
    let element = this.byId.get(id);
    if (!element) {
      element = new FakeElement("div");
      this.byId.set(id, element);
    }
    return element;
  }
  createElement(tag: string) {
    const element = new FakeElement(tag);
    this.created.push(element);
    return element;
  }
  addEventListener(type: string, listener: Listener) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  async fire(type: string, event: unknown = {}) {
    await Promise.all((this.#listeners.get(type) ?? []).map((fn) => fn(event)));
  }
}

/** Every element below `root`, depth first. */
export function descendants(root: FakeElement): FakeElement[] {
  return root.children.flatMap((c) => [c, ...descendants(c)]);
}

export function buttons(root: FakeElement, label?: string | RegExp): FakeElement[] {
  return descendants(root).filter((e) => e.tag === "button" && (label === undefined || (typeof label === "string" ? e.textContent === label : label.test(e.textContent))));
}
