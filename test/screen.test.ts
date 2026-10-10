import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { buildApp } from "../src/app.js";
import { policySummary } from "../src/policy.js";
import { CONTENT_SECURITY_POLICY } from "../src/screen.js";
import { createApp } from "../public/app.js";
import { buttons, descendants, FakeDocument, type FakeElement } from "./helpers/fakeDom.js";

const read = (name: string) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
const stripped = (name: string) => read(name).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("the screen is served safely", () => {
  const app = buildApp();

  test("GET / is the page, with a strict Content-Security-Policy and no sniffing", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /^text\/html/);
    assert.equal(res.headers["content-security-policy"], CONTENT_SECURITY_POLICY);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["referrer-policy"], "no-referrer");
    assert.match(res.body, /<title>Refund desk<\/title>/);
  });

  test("the policy allows only our own origin: no inline script, no framing, no outside requests", () => {
    for (const part of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]) {
      assert.ok(CONTENT_SECURITY_POLICY.includes(part), part);
    }
    assert.ok(!/unsafe|\*|https?:/.test(CONTENT_SECURITY_POLICY), CONTENT_SECURITY_POLICY);
  });

  test("the scripts and the style are served with their own types", async () => {
    for (const [url, type] of [["/app.js", /^text\/javascript/], ["/view.js", /^text\/javascript/], ["/app.css", /^text\/css/]] as const) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 200, url);
      assert.match(String(res.headers["content-type"]), type, url);
      assert.equal(res.headers["content-security-policy"], CONTENT_SECURITY_POLICY, url);
    }
  });

  test("every answer says nosniff, the JSON ones too, and unknown paths are 404", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/health" })).headers["x-content-type-options"], "nosniff");
    assert.equal((await app.inject({ method: "GET", url: "/nope" })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/public/app.js" })).statusCode, 404);
  });
});

describe("what the page's own files contain", () => {
  test("the HTML has one external module script and nothing inline", () => {
    const html = read("index.html");
    const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
    assert.deepEqual(scripts, ['<script type="module" src="/app.js">']);
    assert.ok(!/\son[a-z]+\s*=/i.test(html), "an inline event handler");
    assert.ok(!/\sstyle\s*=/i.test(html), "an inline style");
    assert.ok(!/<(iframe|object|embed|base)\b/i.test(html));
  });

  test("the login form is made for password managers and never submits to a address", () => {
    const html = read("index.html");
    assert.match(html, /<form id="login-form">/);
    assert.ok(!/<form[^>]*\saction\s*=/i.test(html), "the form must not have an action");
    assert.match(html, /autocomplete="current-password"/);
    assert.match(html, /autocomplete="username"/);
    assert.match(html, /<input id="token" name="password" type="password"/);
  });

  test("the scripts never build HTML, never evaluate text, never touch storage or cookies", () => {
    for (const file of ["app.js", "view.js"]) {
      const code = stripped(file);
      for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "localStorage", "sessionStorage", "indexedDB", "document.cookie"]) {
        assert.ok(!code.includes(forbidden), `${file} uses ${forbidden}`);
      }
      assert.ok(!/https?:\/\//.test(code), `${file} names an outside address`);
    }
  });

  test("the page never builds an Authorization header and never writes the token anywhere but the login body", () => {
    const code = stripped("app.js");
    assert.ok(!/authorization/i.test(code), "the page must not send an Authorization header: the cookie does that job");
    assert.ok(!/\bBearer\b/.test(code));
    // the only place the typed token is used is the body of POST /login, and the field is emptied first
    assert.equal((code.match(/tokenInput\.value/g) ?? []).length, 2, "the field is read once and emptied once");
    assert.match(code, /const token = tokenInput\.value;\s*\n\s*tokenInput\.value = ""/);
  });

  test("view.js is pure: no document, no fetch, no window", () => {
    // comments and the text of sentences are not code: "the delivery window" is wording, window. is a global
    const code = read("view.js").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
    for (const pattern of [/\bdocument\b/, /\bfetch\b/, /\bwindow\b/, /\bXMLHttpRequest\b/, /\bglobalThis\b/, /\blocalStorage\b/]) {
      assert.ok(!pattern.test(code), String(pattern));
    }
  });

  test("app.js imports only the local view.js", () => {
    const imports = [...read("app.js").matchAll(/^import .* from "(.*)";/gm)].map((m) => m[1]);
    assert.deepEqual(imports, ["./view.js"]);
  });
});

// ---- the page's behaviour, with a fake browser and a fake service ----

const RIGHT_TOKEN = "the-right-token";
type Answer = { status: number; body: unknown; hold?: Promise<void> };
const ORDER = { status: "delivered", currency: "EUR", total_minor: 6000, refunded_minor: 0 };
const queued = (over: Record<string, unknown> = {}) => ({
  order_id: "O-1122",
  currency: "EUR",
  amount_minor: 3500,
  decision: "queued",
  reason_code: "OVER_THRESHOLD",
  decided_by: "none",
  reason: "damaged",
  note: null,
  ...over,
});
const QUEUE = {
  orders: { "O-1122": ORDER, "O-1111": { status: "delivered", currency: "USD", total_minor: 6500, refunded_minor: 0 } },
  refunds: {
    "R-0086": queued(),
    "R-0087": queued(),
    "R-0075": queued({ order_id: "O-1111", amount_minor: 1200, note: "currency_mismatch" }),
  },
};

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }

/** The page against a fake service: signed out until /login is given the right token, like the real one. */
async function start(options: { signedIn?: boolean; queue?: unknown; answers?: Record<string, Answer> } = {}) {
  const doc = new FakeDocument();
  const calls: Call[] = [];
  let signedIn = options.signedIn ?? false;
  const answers = options.answers ?? {};
  const reply = (status: number, body?: unknown) => ({ status, json: async () => body });

  const fetchFn = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    if (url === "/policy") return reply(200, policySummary());
    if (url === "/queue") return signedIn ? reply(200, options.queue ?? QUEUE) : reply(401, { error: "unauthorized" });
    if (url === "/login") {
      if (init.body !== undefined && JSON.parse(init.body).token === RIGHT_TOKEN) {
        signedIn = true;
        return { status: 204, json: async () => { throw new Error("no body"); } };
      }
      return reply(401, { error: "unauthorized" });
    }
    if (url === "/logout") {
      signedIn = false;
      return { status: 204, json: async () => { throw new Error("no body"); } };
    }
    if (!signedIn) return reply(401, { error: "unauthorized" });
    const answer = answers[url];
    if (!answer) throw new Error(`no answer prepared for ${url}`); // like a network error
    if (answer.hold) await answer.hold;
    return reply(answer.status, answer.body);
  };

  const app = createApp(doc as never, fetchFn as never);
  await app.load();
  const el = (id: string) => doc.getElementById(id);
  return {
    doc,
    calls,
    el,
    queue: el("queue"),
    status: () => el("status").textContent,
    posts: () => calls.filter((c) => c.method === "POST"),
    signIn: async (token = RIGHT_TOKEN) => {
      el("token").value = token;
      await el("login-form").fire("submit", { preventDefault() {} });
    },
    expireSession: () => { signedIn = false; },
  };
}

/** The card of one refund. The page rebuilds its cards after every change, so ask again each time. */
function row(queue: FakeElement, refundId: string): FakeElement {
  const card = descendants(queue).find((e) => e.tag === "article" && e.children[0]?.textContent === refundId);
  assert.ok(card, `no row for ${refundId}`);
  return card;
}

describe("signing in", () => {
  test("not signed in: the login form is shown, the queue is not, and nothing but the policy and the queue was asked", async () => {
    const { el, calls } = await start();
    assert.equal(el("login").hidden, false);
    assert.equal(el("work").hidden, true);
    assert.equal(el("queue").children.length, 0);
    assert.deepEqual(calls.map((c) => c.url), ["/policy", "/queue"]);
  });

  test("the token goes in the body of one POST /login, the field is emptied, and then the queue is shown", async () => {
    const { el, calls, signIn, posts } = await start();
    await signIn();
    assert.equal(posts().length, 1);
    const login = posts()[0]!;
    assert.equal(login.url, "/login");
    assert.deepEqual(JSON.parse(login.body!), { token: RIGHT_TOKEN });
    assert.deepEqual(Object.keys(login.headers).map((k) => k.toLowerCase()).sort(), ["content-type"], "no Authorization header, nothing else");
    assert.equal(el("token").value, "", "the field is emptied");
    assert.equal(el("login").hidden, true);
    assert.equal(el("work").hidden, false);
    assert.equal(el("count").textContent, "3 refunds waiting for a human");
    assert.equal(calls.filter((c) => c.url === "/queue").length, 2);
  });

  test("a wrong token: one short sentence, the field is emptied, the queue stays hidden", async () => {
    const { el, signIn, status } = await start();
    await signIn("a-wrong-token");
    assert.equal(status(), "The token was not accepted.");
    assert.equal(el("token").value, "");
    assert.equal(el("login").hidden, false);
    assert.equal(el("work").hidden, true);
    assert.equal(el("token").focused, true);
  });

  test("an empty field gets the same sentence and sends nothing", async () => {
    const { signIn, status, posts } = await start();
    await signIn("");
    assert.equal(status(), "The token was not accepted.");
    assert.equal(posts().length, 0);
  });

  test("any characters are fine: the token travels in a JSON body, not a header", async () => {
    const { signIn, posts } = await start();
    await signIn("with space ​ and é");
    assert.deepEqual(JSON.parse(posts()[0]!.body!), { token: "with space ​ and é" });
  });

  test("a service that cannot be reached is said as such", async () => {
    const doc = new FakeDocument();
    const fetchFn = async (url: string) => {
      if (url === "/policy") return { status: 200, json: async () => policySummary() };
      if (url === "/queue") return { status: 401, json: async () => ({}) };
      throw new TypeError("Failed to fetch");
    };
    const app = createApp(doc as never, fetchFn as never);
    await app.load();
    doc.getElementById("token").value = "x";
    await doc.getElementById("login-form").fire("submit", { preventDefault() {} });
    assert.match(doc.getElementById("status").textContent, /^Could not reach the service/);
  });

  test("an unexpected answer to the login is not blamed on the token", async () => {
    const doc = new FakeDocument();
    const fetchFn = async (url: string) => {
      if (url === "/policy") return { status: 200, json: async () => policySummary() };
      if (url === "/queue") return { status: 401, json: async () => ({}) };
      return { status: 500, json: async () => ({}) };
    };
    await createApp(doc as never, fetchFn as never).load();
    doc.getElementById("token").value = "x";
    await doc.getElementById("login-form").fire("submit", { preventDefault() {} });
    assert.match(doc.getElementById("status").textContent, /Could not sign in right now/);
  });
});

describe("the queue", () => {
  test("lists what a human has to rule on, with amounts, reasons, and what is refundable", async () => {
    const { el, queue } = await start({ signedIn: true });
    assert.equal(el("count").textContent, "3 refunds waiting for a human");
    const text = queue.textContent;
    for (const expected of ["Order O-1122", "R-0086", "R-0087", "35.00 EUR", "still refundable 60.00 EUR", "The amount is over the 20.00 EUR automatic limit."]) {
      assert.ok(text.includes(expected), expected);
    }
    assert.ok(text.includes("The refund is in a different currency than the order"), "explanation of R-0075");
    assert.ok(text.includes("The refund is in EUR but the order is in USD"), "warning on R-0075");
    assert.equal(buttons(queue, "Approve").length, 3);
    assert.equal(buttons(queue, "Reject").length, 3);
  });

  test("an empty queue says so", async () => {
    const { el, queue } = await start({ signedIn: true, queue: { orders: {}, refunds: {} } });
    assert.equal(el("count").textContent, "Nothing is waiting for a human.");
    assert.equal(queue.children.length, 0);
  });

  test("hostile text is shown as text and never becomes an element", async () => {
    const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const hostile = { orders: { ...QUEUE.orders, [evil]: ORDER }, refunds: { "R-EVIL": queued({ order_id: evil, reason: evil, note: evil }) } };
    const { doc, queue } = await start({ signedIn: true, queue: hostile });
    assert.ok(queue.textContent.includes(evil), "the text is there");
    const tags = new Set(doc.created.map((e) => e.tag));
    for (const forbidden of ["img", "script", "iframe", "a", "style"]) assert.ok(!tags.has(forbidden), `an element <${forbidden}> was created`);
  });
});

describe("deciding", () => {
  const ok = (action: string) => ({
    status: 200,
    body: { refund: { refund_id: "R-0086", order_id: "O-1122", amount_minor: 3500, currency: "EUR", decision: action }, order: { remaining_minor: 2500 } },
  });

  test("Approve needs a second click, and nothing is sent before it", async () => {
    const { queue, posts } = await start({ signedIn: true });
    await buttons(row(queue, "R-0086"), "Approve")[0]!.fire("click");
    assert.equal(posts().length, 0);
    assert.equal(buttons(row(queue, "R-0086"), "Confirm approve 35.00 EUR?").length, 1);
    assert.equal(buttons(row(queue, "R-0086"), "Cancel").length, 1);
    assert.equal(buttons(row(queue, "R-0087"), /^Confirm/).length, 0, "only the clicked row asks");
    await buttons(row(queue, "R-0086"), "Cancel")[0]!.fire("click");
    assert.equal(buttons(queue, /^Confirm/).length, 0);
    assert.equal(posts().length, 0);
  });

  test("Escape cancels the confirmation", async () => {
    const { doc, queue } = await start({ signedIn: true });
    await buttons(row(queue, "R-0086"), "Approve")[0]!.fire("click");
    assert.equal(buttons(queue, /^Confirm/).length, 1);
    await doc.fire("keydown", { key: "Escape" });
    assert.equal(buttons(queue, /^Confirm/).length, 0);
  });

  test("the second click sends one POST: no token, no body, only the same-origin header; then the queue is read again", async () => {
    const { el, queue, status, posts, calls } = await start({ signedIn: true, answers: { "/refunds/R-0086/approve": ok("approved") } });
    await buttons(row(queue, "R-0086"), "Approve")[0]!.fire("click");
    await buttons(row(queue, "R-0086"), /^Confirm approve/)[0]!.fire("click");
    assert.equal(posts().length, 1);
    assert.deepEqual(posts()[0], { url: "/refunds/R-0086/approve", method: "POST", headers: { "x-requested-with": "refund-desk" }, body: undefined });
    assert.equal(calls.filter((c) => c.url === "/queue").length, 2, "the queue was loaded again");
    assert.equal(status(), "Approved R-0086: 35.00 EUR. 25.00 EUR of order O-1122 is still refundable.");
    assert.equal(el("log").children.length, 1);
  });

  test("Reject is one click", async () => {
    const { queue, status, posts } = await start({ signedIn: true, answers: { "/refunds/R-0086/reject": ok("rejected") } });
    await buttons(row(queue, "R-0086"), "Reject")[0]!.fire("click");
    assert.equal(posts().length, 1);
    assert.equal(posts()[0]!.url, "/refunds/R-0086/reject");
    assert.equal(status(), "Rejected R-0086: 35.00 EUR. Nothing was paid.");
  });

  test("409 exceeds_balance: said in words, and the queue is read again", async () => {
    const answer = { status: 409, body: { error: "exceeds_balance", remaining_minor: 2500 } };
    const { queue, status, posts, calls } = await start({ signedIn: true, answers: { "/refunds/R-0087/approve": answer } });
    await buttons(row(queue, "R-0087"), "Approve")[0]!.fire("click");
    await buttons(row(queue, "R-0087"), /^Confirm/)[0]!.fire("click");
    assert.equal(posts().length, 1);
    assert.equal(status(), "No longer fits: only 25.00 EUR of this order is still refundable. The refund stays queued.");
    assert.equal(calls.filter((c) => c.url === "/queue").length, 2);
  });

  test("a session that ended: back to the login with 'Sign in again.', and the queue is gone from the screen", async () => {
    const { el, queue, status, posts, expireSession } = await start({ signedIn: true });
    expireSession();
    await buttons(row(queue, "R-0086"), "Reject")[0]!.fire("click");
    assert.equal(posts().length, 1);
    assert.equal(status(), "Sign in again.");
    assert.equal(el("login").hidden, false);
    assert.equal(el("work").hidden, true);
    assert.equal(el("queue").children.length, 0);
    assert.equal(el("token").focused, true);
  });

  test("while a request is pending the row is disabled and a second click sends nothing", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const answer: Answer = { ...ok("rejected"), hold };
    const { queue, posts } = await start({ signedIn: true, answers: { "/refunds/R-0086/reject": answer } });
    const first = buttons(row(queue, "R-0086"), "Reject")[0]!;
    const pending = first.fire("click");
    await Promise.resolve();
    assert.ok(buttons(row(queue, "R-0086")).every((b) => b.disabled), "buttons of the row are disabled");
    assert.ok(buttons(row(queue, "R-0087")).every((b) => !b.disabled), "other rows are not");
    await first.fire("click"); // the old button, clicked again
    assert.equal(posts().length, 1);
    release();
    await pending;
    assert.equal(posts().length, 1);
  });

  test("when the service cannot be reached it says so, and only then", async () => {
    const { queue, status } = await start({ signedIn: true }); // no prepared answer: the fake fetch throws, like a network error
    await buttons(row(queue, "R-0086"), "Reject")[0]!.fire("click");
    assert.match(status(), /^Could not reach the service/);
  });

  test("an answer the page cannot use is not blamed on the network", async () => {
    const { queue, status, posts } = await start({ signedIn: true, answers: { "/refunds/R-0086/reject": { status: 200, body: {} } } });
    await buttons(row(queue, "R-0086"), "Reject")[0]!.fire("click");
    assert.equal(posts().length, 1);
    assert.equal(status(), "Rejected.");
  });
});

describe("signing out", () => {
  test("asks the service to clear the cookie, empties the screen and forgets the session's decisions", async () => {
    const answer = { status: 200, body: { refund: { refund_id: "R-0086", order_id: "O-1122", amount_minor: 3500, currency: "EUR" }, order: { remaining_minor: 6000 } } };
    const { el, queue, status, posts } = await start({ signedIn: true, answers: { "/refunds/R-0086/reject": answer } });
    await buttons(row(queue, "R-0086"), "Reject")[0]!.fire("click");
    assert.equal(el("log").children.length, 1);

    await el("signout").fire("click");
    const logout = posts().at(-1)!;
    assert.deepEqual([logout.url, logout.headers], ["/logout", { "x-requested-with": "refund-desk" }]);
    assert.equal(el("login").hidden, false);
    assert.equal(el("work").hidden, true);
    assert.equal(el("queue").children.length, 0);
    assert.equal(el("log").children.length, 0);
    assert.equal(status(), "Signed out.");
  });
});
