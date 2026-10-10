// The approval screen. All text from the service goes in through textContent, never as HTML.
//
// Signing in: the person types the approver token once; it is sent in the body of POST /login and the field is
// cleared at once. After that the browser holds only an HttpOnly session cookie, which this script cannot read.
// The token is never stored, never put in a header and never kept in a variable of this page.
import { buildQueue, confirmLabel, describeRefusal, describeSuccess, formatMoney } from "./view.js";

// A cookie-authenticated request carries this header. A page on another site cannot add it without CORS,
// which the service never allows, so it cannot make this browser act (together with SameSite=Strict).
const SAME_ORIGIN = { "x-requested-with": "refund-desk" };

/**
 * @param doc a Document (or a test double with the same few methods)
 * @param fetchFn fetch (or a test double)
 */
export function createApp(doc, fetchFn) {
  // `notes`: what the service said about one refund, kept on its own card so it is seen where the click was.
  const state = { queue: null, policy: null, busy: new Set(), confirming: null, log: [], notes: new Map() };

  const statusLine = doc.getElementById("status");
  const loginSection = doc.getElementById("login");
  const loginForm = doc.getElementById("login-form");
  const tokenInput = doc.getElementById("token");
  const work = doc.getElementById("work");
  const refreshButton = doc.getElementById("refresh");
  const signOutButton = doc.getElementById("signout");
  const countHeading = doc.getElementById("count");
  const queue = doc.getElementById("queue");
  const logList = doc.getElementById("log");

  function el(tag, props = {}, children = []) {
    const node = doc.createElement(tag);
    if (props.class) node.setAttribute("class", props.class);
    if (props.type) node.setAttribute("type", props.type);
    if (props.text !== undefined) node.textContent = props.text;
    for (const child of children) node.appendChild(child);
    return node;
  }

  function say(message, kind) {
    statusLine.textContent = message;
    statusLine.setAttribute("class", kind === "error" ? "status error" : kind === "ok" ? "status ok" : "status");
  }

  /** Shows the login form or the queue. Leaving the queue forgets everything that was on it. */
  function show(signedIn) {
    loginSection.hidden = signedIn;
    work.hidden = !signedIn;
    if (!signedIn) {
      state.queue = null;
      state.confirming = null;
      state.busy.clear();
      state.notes.clear();
      state.log = [];
      queue.replaceChildren();
      logList.replaceChildren();
    }
  }

  function renderLog() {
    logList.replaceChildren(...state.log.map((line) => el("li", { text: line })));
  }

  function refundCard(r) {
    const busy = state.busy.has(r.id);
    const confirming = state.confirming === r.id;

    const approve = el("button", { type: "button", class: "approve", text: confirming ? confirmLabel(r, state.policy) : "Approve" });
    approve.disabled = busy;
    approve.addEventListener("click", () => onApprove(r));

    const reject = el("button", { type: "button", class: "reject", text: "Reject" });
    reject.disabled = busy;
    reject.addEventListener("click", () => act("reject", r));

    const actions = el("div", { class: "actions" }, [approve, reject]);
    if (confirming) {
      const cancel = el("button", { type: "button", class: "cancel", text: "Cancel" });
      cancel.addEventListener("click", () => {
        state.confirming = null;
        render();
      });
      actions.appendChild(cancel);
    }

    const factRows = [
      el("dt", { text: "Amount" }),
      el("dd", { class: "amount", text: formatMoney(r.amount_minor, r.currency, state.policy) }),
    ];
    for (const [label, value] of r.lines) factRows.push(el("dt", { text: label }), el("dd", { text: value }));
    factRows.push(
      el("dt", { text: "Customer's reason" }),
      el("dd", { text: r.reason }),
      el("dt", { text: "Why a person decides" }),
      el("dd", { text: r.explanation }),
    );

    const card = el("article", { class: busy ? "refund busy" : "refund" }, [el("h4", { text: r.id }), el("dl", { class: "facts" }, factRows)]);
    for (const n of r.notices) card.appendChild(el("p", { class: "notice", text: n }));
    for (const w of r.warnings) card.appendChild(el("p", { class: "warning", text: w }));
    const note = state.notes.get(r.id);
    if (note) card.appendChild(el("p", { class: note.kind === "error" ? "row-note error" : "row-note ok", text: note.text }));
    card.appendChild(actions);
    return card;
  }

  function orderBlock(group) {
    return el("section", { class: "order" }, [
      el("h3", { text: `Order ${group.orderId}` }),
      el("p", { class: "order-summary", text: group.summary }),
      ...group.refunds.map(refundCard),
    ]);
  }

  function render() {
    if (!state.queue) return;
    const view = buildQueue(state.queue, state.policy);
    // a note belongs to a refund that is still in the queue; once it is decided or gone, the note goes too
    const present = new Set(view.groups.flatMap((g) => g.refunds.map((r) => r.id)));
    for (const id of [...state.notes.keys()]) if (!present.has(id)) state.notes.delete(id);
    countHeading.textContent = view.count === 0 ? "Nothing is waiting for a human." : `${view.count} ${view.count === 1 ? "refund" : "refunds"} waiting for a human`;
    queue.replaceChildren(...view.groups.map(orderBlock));
  }

  /** The numbers of the policy and the decimals of each currency. The page still works without them. */
  async function loadPolicy() {
    try {
      const res = await fetchFn("/policy", { headers: { accept: "application/json" } });
      if (res.status === 200) state.policy = await res.json();
    } catch {
      /* wording falls back to the less specific form */
    }
  }

  /** Reads the private queue. A 401 means "not signed in": the login form is shown. */
  async function load() {
    if (!state.policy) await loadPolicy();
    let res;
    try {
      res = await fetchFn("/queue", { headers: { accept: "application/json", ...SAME_ORIGIN } });
    } catch {
      say("Could not reach the service. Check that it is running, then press Refresh.", "error");
      return false;
    }
    if (res.status === 401) {
      show(false);
      tokenInput.focus();
      return false;
    }
    try {
      if (res.status !== 200) throw new Error(`the queue answered ${res.status}`);
      state.queue = await res.json();
    } catch {
      say("Could not load the queue. Try Refresh.", "error");
      return false;
    }
    show(true);
    render();
    return true;
  }

  async function signIn(event) {
    if (event && event.preventDefault) event.preventDefault();
    const token = tokenInput.value;
    tokenInput.value = ""; // never kept: not in the field, not in a variable of this page
    if (!token) {
      say("The token was not accepted.", "error");
      return;
    }
    try {
      const res = await fetchFn("/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (res.status === 204) {
        say("", "");
        await load();
      } else if (res.status === 401) {
        say("The token was not accepted.", "error");
        tokenInput.focus();
      } else {
        say("Could not sign in right now. Try again in a moment.", "error");
      }
    } catch {
      say("Could not reach the service. Check that it is running, then try again.", "error");
    }
  }

  async function signOut() {
    try {
      await fetchFn("/logout", { method: "POST", headers: SAME_ORIGIN });
    } catch {
      /* the cookie is cleared by the service; if it cannot be reached the session simply runs out */
    }
    show(false);
    say("Signed out.", "ok");
  }

  function onApprove(refund) {
    if (state.confirming !== refund.id) {
      // first click: ask once more, because money moves. A new attempt starts: the last answer is no longer news.
      state.confirming = refund.id;
      state.notes.delete(refund.id);
      render();
      return;
    }
    return act("approve", refund);
  }

  /** Says it in the status line AND on the refund's own card: the status line may be far above the click. */
  function sayAbout(refund, message, kind) {
    say(message, kind);
    state.notes.set(refund.id, { text: message, kind });
  }

  async function act(action, refund) {
    if (state.busy.has(refund.id)) return;
    state.confirming = null;
    state.notes.delete(refund.id);
    state.busy.add(refund.id);
    render();
    try {
      let res;
      try {
        res = await fetchFn(`/refunds/${encodeURIComponent(refund.id)}/${action}`, { method: "POST", headers: SAME_ORIGIN });
      } catch (err) {
        console.error(err);
        sayAbout(refund, "Could not reach the service. Check that it is running, then press Refresh.", "error");
        return;
      }
      let body = {};
      try {
        body = await res.json();
      } catch {
        /* an answer without a body is handled by the status */
      }
      if (res.status === 401) {
        // the session ended (or was never there): back to the login, nothing was changed
        show(false);
        say(describeRefusal(401, body, refund.currency, state.policy), "error");
        tokenInput.focus();
        return;
      }
      if (res.status === 200) {
        const message = describeSuccess(action, body, state.policy);
        say(message, "ok");
        state.log = [message, ...state.log].slice(0, 20);
        renderLog();
        await load();
      } else {
        sayAbout(refund, describeRefusal(res.status, body, refund.currency, state.policy), "error");
        // The state changed under us (or the refund is gone): show the real queue.
        if (res.status === 409 || res.status === 404) await load();
      }
    } catch (err) {
      // The service did answer, and this page failed while showing the answer. Do not blame the network.
      console.error(err);
      sayAbout(refund, "The service answered, but this page could not show the result. Press Refresh to see the queue.", "error");
    } finally {
      state.busy.delete(refund.id);
      render();
    }
  }

  loginForm.addEventListener("submit", signIn);
  refreshButton.addEventListener("click", async () => {
    state.confirming = null;
    if (await load()) say("Queue refreshed.", "ok");
  });
  signOutButton.addEventListener("click", signOut);
  doc.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.confirming !== null) {
      state.confirming = null;
      render();
    }
  });

  return { load };
}

// In the browser: start. In tests there is no global document, and createApp is called with a double.
if (typeof document !== "undefined" && document.getElementById("queue")) {
  createApp(document, (...args) => fetch(...args)).load();
}
