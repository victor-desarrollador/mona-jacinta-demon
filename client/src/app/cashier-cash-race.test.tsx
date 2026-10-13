import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import OperationsPage from "./page";

// The register and the open session are location-bound: an answer that
// belongs to a previously selected branch (or to an older request of the same
// branch) must never replace the current branch's cash state.

const TOKEN_KEY = "mona-jacinta-token";

type Reply = { status: number; body: unknown };
type Kind = "register" | "current" | "open" | "close";
type Hold = { kind: Kind; branchId: string; nth: number; release: (override?: Reply) => void; gate: Promise<Reply | undefined> };

type ServerState = {
  sessions: Map<string, string | null>;
  counts: Map<string, number>;
  holds: Hold[];
  calls: Array<{ url: string; method: string; body?: string }>;
  nextSession: number;
};

const NAMES: Record<string, string> = { CEN: "Caja principal", DEP: "Caja depósito" };
const cashier = {
  id: "c1", name: "Cajero", email: "cashier@demo.local", roles: ["CASHIER"], branchIds: ["CEN", "DEP"],
  permissions: ["sale.charge", "cash.session.open", "cash.session.close"],
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function openSession(branchId: string, sessionId: string) {
  return {
    sessionId, registerId: `reg-${branchId}`, branchId, openedById: "c1", closedById: null,
    startingCash: "0", status: "OPEN", openedAt: "2030-01-02T09:00:00.000Z", closedAt: null,
  };
}

function hold(state: ServerState, kind: Kind, branchId: string, nth: number) {
  let release!: (override?: Reply) => void;
  const gate = new Promise<Reply | undefined>((done) => { release = done; });
  const entry = { kind, branchId, nth, release, gate };
  state.holds.push(entry);
  return entry;
}

function createRouter(state: ServerState) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    state.calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.includes("/auth/me")) return jsonResponse({ user: cashier });
    if (url.includes("/sales/pending")) return jsonResponse({ items: [] });
    if (url.includes("/cash/sessions?")) return jsonResponse([]);

    let kind: Kind;
    let branchId: string;
    let reply: Reply;
    if (url.includes("/cash/sessions/open") && method === "POST") {
      kind = "open";
      branchId = String(JSON.parse(String(init?.body)).registerId).replace("reg-", "");
      const sessionId = `cs-${branchId}-${++state.nextSession}`;
      state.sessions.set(branchId, sessionId);
      reply = { status: 201, body: openSession(branchId, sessionId) };
    } else if (url.includes("/cash/sessions/") && url.endsWith("/close") && method === "POST") {
      kind = "close";
      const sessionId = url.split("/cash/sessions/")[1].replace("/close", "");
      branchId = [...state.sessions.entries()].find(([, id]) => id === sessionId)?.[0] ?? "";
      state.sessions.set(branchId, null);
      reply = {
        status: 200,
        body: {
          ...openSession(branchId, sessionId), status: "CLOSED", closedById: "c1", closedAt: "2030-01-02T18:00:00.000Z",
          expectedCash: "200000", countedCash: "200000", difference: "0", closingCash: "200000",
        },
      };
    } else if (url.includes("/cash/current")) {
      kind = "current";
      branchId = new URL(url, "http://x").searchParams.get("branchId") ?? "";
      const sessionId = state.sessions.get(branchId);
      reply = { status: 200, body: sessionId ? openSession(branchId, sessionId) : null };
    } else if (url.includes("/cash/register")) {
      kind = "register";
      branchId = new URL(url, "http://x").searchParams.get("branchId") ?? "";
      reply = { status: 200, body: { id: `reg-${branchId}`, branchId, name: NAMES[branchId] } };
    } else {
      return jsonResponse({ items: [] });
    }

    const key = `${kind}:${branchId}`;
    const nth = (state.counts.get(key) ?? 0) + 1;
    state.counts.set(key, nth);
    const gated = state.holds.find((entry) => entry.kind === kind && entry.branchId === branchId && entry.nth === nth);
    if (gated) reply = (await gated.gate) ?? reply;
    return jsonResponse(reply.body, reply.status);
  });
}

function newState(sessions: Record<string, string | null>): ServerState {
  return { sessions: new Map(Object.entries(sessions)), counts: new Map(), holds: [], calls: [], nextSession: 1 };
}

async function renderPage(state: ServerState) {
  window.localStorage.setItem(TOKEN_KEY, "test-token");
  vi.stubGlobal("fetch", createRouter(state));
  const view = render(<OperationsPage />);
  await waitFor(() => expect(screen.queryByText(/Cargando sesión/i)).not.toBeInTheDocument());
  return view;
}

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const branchSelect = () => screen.getByRole("combobox", { name: /Sucursal autorizada/ });
const refreshButton = () => screen.getByRole("button", { name: "Actualizar" });
const errorBanner = (container: HTMLElement) => container.querySelector(".error-banner");
// The register state heading only (the close reconciliation has its own heading).
const heading = (name: "Caja abierta" | "Caja cerrada") => {
  const element = document.querySelector(".cash-session h2");
  return element?.textContent === name ? element : null;
};
const posts = (state: ServerState, fragment: string) =>
  state.calls.filter((call) => call.method === "POST" && call.url.includes(fragment));

async function waitLoaded(branchId: string, open: boolean) {
  expect(await screen.findByText(NAMES[branchId])).toBeInTheDocument();
  await waitFor(() => expect(heading(open ? "Caja abierta" : "Caja cerrada")).toBeInTheDocument());
  await waitFor(() => expect(refreshButton()).toBeEnabled());
}
async function switchWhenEnabled(branchId: string) {
  await waitFor(() => expect(branchSelect()).toBeEnabled());
  fireEvent.change(branchSelect(), { target: { value: branchId } });
}
// Defense in depth: the selector is disabled while loading, but a branch change
// can still land while an answer is in flight (e.g. a disabled control racing).
const forceSwitch = (branchId: string) => fireEvent.change(branchSelect(), { target: { value: branchId } });
function close(amount = "2000") {
  fireEvent.change(screen.getByRole("textbox", { name: /Cierre ARS/ }), { target: { value: amount } });
  fireEvent.click(screen.getByRole("button", { name: "Cerrar caja" }));
  // M2: the close is only sent after the explicit confirmation.
  fireEvent.click(screen.getByRole("button", { name: "Confirmar cierre" }));
}
function open(amount = "1000") {
  fireEvent.change(screen.getByRole("textbox", { name: /Inicial ARS/ }), { target: { value: amount } });
  fireEvent.click(screen.getByRole("button", { name: "Abrir caja" }));
}

describe("cash current-state answers never cross branches or overtake newer answers", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("R01 a late post-close refresh of the previous branch never overwrites the selected branch", async () => {
    const state = newState({ CEN: "cs-CEN-1", DEP: "cs-DEP-1" });
    const late = hold(state, "current", "CEN", 2);
    await renderPage(state);
    await waitLoaded("CEN", true);
    close();
    await waitFor(() => expect(state.counts.get("current:CEN")).toBe(2));
    await switchWhenEnabled("DEP");
    await waitLoaded("DEP", true);
    late.release();
    await settle();
    expect(screen.getByText("Caja depósito")).toBeInTheDocument();
    expect(screen.queryByText("Caja principal")).toBeNull();
    expect(heading("Caja abierta")).toBeInTheDocument();
    close();
    await waitFor(() => expect(posts(state, "/close")).toHaveLength(2));
    expect(posts(state, "/close")[1].url).toContain("/cash/sessions/cs-DEP-1/close");
  });

  it("R02 a late initial register answer of the previous branch is dropped", async () => {
    const state = newState({ CEN: "cs-CEN-1", DEP: "cs-DEP-1" });
    const late = hold(state, "register", "CEN", 1);
    await renderPage(state);
    await waitFor(() => expect(state.counts.get("register:CEN")).toBe(1));
    forceSwitch("DEP");
    await waitLoaded("DEP", true);
    late.release();
    await settle();
    expect(screen.getByText("Caja depósito")).toBeInTheDocument();
    expect(screen.queryByText("Caja principal")).toBeNull();
  });

  it("R03 returning to the branch, a stale answer never overtakes the fresh one", async () => {
    const state = newState({ CEN: "cs-CEN-1", DEP: "cs-DEP-1" });
    const late = hold(state, "current", "CEN", 2);
    await renderPage(state);
    await waitLoaded("CEN", true);
    close();
    await waitFor(() => expect(state.counts.get("current:CEN")).toBe(2));
    await switchWhenEnabled("DEP");
    await waitLoaded("DEP", true);
    await switchWhenEnabled("CEN");
    await waitLoaded("CEN", false);
    late.release({ status: 200, body: openSession("CEN", "cs-CEN-1") });
    await settle();
    expect(heading("Caja cerrada")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cerrar caja" })).toBeNull();
  });

  it("R04 a late open answer of the previous branch never opens the selected branch", async () => {
    const state = newState({ CEN: null, DEP: null });
    const late = hold(state, "open", "CEN", 1);
    await renderPage(state);
    await waitLoaded("CEN", false);
    open();
    await waitFor(() => expect(posts(state, "/cash/sessions/open")).toHaveLength(1));
    forceSwitch("DEP");
    await waitLoaded("DEP", false);
    late.release();
    await settle();
    expect(heading("Caja cerrada")).toBeInTheDocument();
    expect(screen.queryByText("Sesión de caja abierta.")).toBeNull();
    expect(screen.getByText("Caja depósito")).toBeInTheDocument();
  });

  it("R05 a late failure of the previous branch never shows an error on the selected branch", async () => {
    const state = newState({ CEN: "cs-CEN-1", DEP: "cs-DEP-1" });
    const late = hold(state, "current", "CEN", 1);
    const view = await renderPage(state);
    await waitFor(() => expect(state.counts.get("current:CEN")).toBe(1));
    forceSwitch("DEP");
    await waitLoaded("DEP", true);
    late.release({ status: 500, body: { message: "Caja anterior caída" } });
    await settle();
    expect(errorBanner(view.container)).toBeNull();
    expect(screen.queryByText("Caja anterior caída")).toBeNull();
  });

  it("R06 switching branch immediately hides the previous branch register and session", async () => {
    const state = newState({ CEN: "cs-CEN-1", DEP: "cs-DEP-1" });
    const pending = hold(state, "register", "DEP", 1);
    await renderPage(state);
    await waitLoaded("CEN", true);
    await switchWhenEnabled("DEP");
    expect(screen.queryByText("Caja principal")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cerrar caja" })).toBeNull();
    expect(screen.getByText("Buscando caja de la sucursal...")).toBeInTheDocument();
    pending.release();
    await waitLoaded("DEP", true);
  });

  it("R07 a stale refresh finishing never re-enables the controls while the selected branch still loads", async () => {
    const state = newState({ CEN: "cs-CEN-1", DEP: "cs-DEP-1" });
    const lateCen = hold(state, "current", "CEN", 1);
    const pendingDep = hold(state, "register", "DEP", 1);
    await renderPage(state);
    await waitFor(() => expect(state.counts.get("current:CEN")).toBe(1));
    forceSwitch("DEP");
    await waitFor(() => expect(state.counts.get("register:DEP")).toBe(1));
    lateCen.release();
    await settle();
    expect(refreshButton()).toBeDisabled();
    pendingDep.release();
    await waitLoaded("DEP", true);
  });

  it("R08 a stale post-close refresh never closes a session reopened on the same branch", async () => {
    const state = newState({ CEN: "cs-CEN-1", DEP: "cs-DEP-1" });
    const late = hold(state, "current", "CEN", 2);
    await renderPage(state);
    await waitLoaded("CEN", true);
    close();
    await waitFor(() => expect(heading("Caja cerrada")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Abrir caja" })).toBeEnabled());
    open();
    await waitFor(() => expect(heading("Caja abierta")).toBeInTheDocument());
    late.release();
    await settle();
    expect(heading("Caja abierta")).toBeInTheDocument();
  });

  it("R09 an older refresh of the same branch never overtakes a newer manual refresh", async () => {
    const state = newState({ CEN: "cs-CEN-1", DEP: "cs-DEP-1" });
    const late = hold(state, "current", "CEN", 2);
    await renderPage(state);
    await waitLoaded("CEN", true);
    close();
    await waitFor(() => expect(heading("Caja cerrada")).toBeInTheDocument());
    await waitFor(() => expect(refreshButton()).toBeEnabled());
    fireEvent.click(refreshButton());
    await waitFor(() => expect(state.counts.get("current:CEN")).toBe(3));
    await waitFor(() => expect(refreshButton()).toBeEnabled());
    late.release({ status: 200, body: openSession("CEN", "cs-CEN-1") });
    await settle();
    expect(heading("Caja cerrada")).toBeInTheDocument();
  });

  it("R10 close then open on the same branch still updates the register state", async () => {
    const state = newState({ CEN: "cs-CEN-1", DEP: "cs-DEP-1" });
    await renderPage(state);
    await waitLoaded("CEN", true);
    close();
    await waitFor(() => expect(heading("Caja cerrada")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Abrir caja" })).toBeEnabled());
    open();
    await waitFor(() => expect(heading("Caja abierta")).toBeInTheDocument());
    expect(JSON.parse(String(posts(state, "/cash/sessions/open")[0].body)).registerId).toBe("reg-CEN");
    expect(screen.getByText("Caja principal")).toBeInTheDocument();
  });

  it("R11 rapid switching with answers released out of order ends on the selected branch", async () => {
    const state = newState({ CEN: "cs-CEN-1", DEP: "cs-DEP-1" });
    const dep1 = hold(state, "register", "DEP", 1);
    const cen2 = hold(state, "register", "CEN", 2);
    const dep2 = hold(state, "register", "DEP", 2);
    await renderPage(state);
    await waitLoaded("CEN", true);
    forceSwitch("DEP");
    await waitFor(() => expect(state.counts.get("register:DEP")).toBe(1));
    forceSwitch("CEN");
    await waitFor(() => expect(state.counts.get("register:CEN")).toBe(2));
    forceSwitch("DEP");
    await waitFor(() => expect(state.counts.get("register:DEP")).toBe(2));
    dep2.release();
    await waitLoaded("DEP", true);
    dep1.release();
    cen2.release();
    await settle();
    expect(screen.getByText("Caja depósito")).toBeInTheDocument();
    expect(screen.queryByText("Caja principal")).toBeNull();
  });

  it("R13 a late open or close answer of the previous branch never re-enables the controls while the selected branch loads", async () => {
    for (const action of ["open", "close"] as const) {
      const state = newState({ CEN: action === "close" ? "cs-CEN-1" : null, DEP: "cs-DEP-1" });
      const late = hold(state, action, "CEN", 1);
      const pendingDep = hold(state, "register", "DEP", 1);
      await renderPage(state);
      await waitLoaded("CEN", action === "close");
      if (action === "open") open(); else close();
      await waitFor(() => expect(state.counts.get(`${action}:CEN`)).toBe(1));
      forceSwitch("DEP");
      await waitFor(() => expect(state.counts.get("register:DEP")).toBe(1));
      late.release();
      await settle();
      expect(refreshButton()).toBeDisabled();
      pendingDep.release();
      await waitLoaded("DEP", true);
      cleanup();
    }
  });

  it("R12 a failure of the selected branch is still reported", async () => {
    const state = newState({ CEN: "cs-CEN-1", DEP: "cs-DEP-1" });
    const failing = hold(state, "current", "DEP", 1);
    const view = await renderPage(state);
    await waitLoaded("CEN", true);
    await switchWhenEnabled("DEP");
    await waitFor(() => expect(state.counts.get("current:DEP")).toBe(1));
    failing.release({ status: 500, body: { message: "Caja actual caída" } });
    await waitFor(() => expect(errorBanner(view.container)).not.toBeNull());
    expect(screen.getByText("Caja actual caída")).toBeInTheDocument();
  });
});
