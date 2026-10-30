import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import OperationsPage from "./page";
import { ATTEMPT_KEY_PREFIX, exchangeDrafts, useExchangeDrafts } from "./exchange-draft-store";
import AUTH_ME from "./test-fixtures/auth-me.json";
import { makeLocks } from "./exchange-store-test-harness";

// How the Cambios draft store meets the session: an EXPLICIT logout ("Salir") forgets everything, while an automatic session expiry
// (a 401 mid-operation) must never destroy an exchange whose outcome is unknown. Also: the store outlives the tab being unmounted.

const TOKEN_KEY = "mona-jacinta-token";
const USER = "u1";
const SALE = randomUUID();
const OTHER_SALE = randomUUID();
const ITEM = randomUUID();
const VARIANT = randomUUID();

const json = (body: unknown, status = 200): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

type Behavior = { adjust401?: boolean; loginAs?: string; exchange?: () => Response };

function userFor(id: string) {
  return { id, name: `User ${id}`, email: `${id}@demo.local`, branchIds: ["branch-1"], ...AUTH_ME.WAREHOUSE };
}

function pageFetch(behavior: Behavior = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/auth/me")) return json({ user: userFor(USER) });
    if (url.includes("/auth/login")) return json({ accessToken: "token-after-login", user: userFor(behavior.loginAs ?? USER) });
    if (url.includes("/exchanges")) return behavior.exchange ? behavior.exchange() : json({ exchangeId: randomUUID(), replayed: true }, 200);
    if (url.includes("/inventory/adjustments") && behavior.adjust401) return json({ error: { code: "UNAUTHORIZED", message: "Token inválido" } }, 401);
    if (url.includes("/inventory/stock")) {
      return json({
        items: [{ variantId: "variant-1", productId: "p1", productName: "Remera 1", sku: "SKU-1", barcode: "1", color: "Negro", size: "M", physical: "10", reserved: "4", available: "6" }],
        pagination: { page: 1, limit: 50, total: 1 },
      });
    }
    void init;
    return json({ items: [] });
  });
}

// The body of GET /sales/exchangeable for a one-item sale: drafts are opened from it, never from caller-chosen lines.
const readFor = (saleId: string, saleNumber: string, itemId: string) => ({
  sale: { id: saleId, saleNumber, branchId: "branch-1", status: "COMPLETED" },
  exchangeable: true,
  lines: [{ saleItemId: itemId, variantId: randomUUID(), quantity: "5", exchangedQuantity: "0", remainingQuantity: "5" }],
});
const openFromRead = (saleId: string, saleNumber: string, itemId = randomUUID()) =>
  exchangeDrafts.openDraftFromFreshRead({ userId: USER, branchId: "branch-1", saleNumber, read: readFor(saleId, saleNumber, itemId) });

async function openFilledDraft() {
  expect((await openFromRead(SALE, "T-1", ITEM)).ok).toBe(true);
  exchangeDrafts.edit(USER, SALE, { type: "reason", value: "Cambio de talle" });
  exchangeDrafts.edit(USER, SALE, { type: "line", saleItemId: ITEM, replacementVariantId: VARIANT, replacementLabel: "Remera L", returnQuantity: "1" });
}

async function seedUncertainAndEditable() {
  vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: "INTERNAL", message: "boom" } }, 500)));
  await openFilledDraft();
  const outcome = await exchangeDrafts.send({ userId: USER, saleId: SALE, token: "t" });
  expect(outcome.kind).toBe("UNCERTAIN");
  await openFromRead(OTHER_SALE, "T-2");
}

async function renderPage(behavior: Behavior = {}) {
  window.localStorage.setItem(TOKEN_KEY, "test-token");
  const fetchMock = pageFetch(behavior);
  vi.stubGlobal("fetch", fetchMock);
  render(<OperationsPage />);
  await waitFor(() => expect(screen.queryByText(/Cargando sesión/i)).not.toBeInTheDocument());
  return fetchMock;
}

async function logout() {
  fireEvent.click(await screen.findByRole("button", { name: "Salir" }));
  await screen.findByLabelText("Correo");
}

async function loginAgain() {
  fireEvent.change(screen.getByLabelText("Correo"), { target: { value: "a@demo.local" } });
  fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: "x" } });
  fireEvent.click(screen.getByRole("button", { name: "Ingresar" }));
  await waitFor(() => expect(screen.queryByLabelText("Correo")).not.toBeInTheDocument());
}

// The durable attempts: one localStorage key per (user, sale). Returns them as one JSON array (or null when there are none).
const persisted = () => {
  const records: unknown[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index)!;
    if (key.startsWith(ATTEMPT_KEY_PREFIX)) records.push(JSON.parse(window.localStorage.getItem(key)!));
  }
  return records.length === 0 ? null : JSON.stringify(records);
};
const exchangeBodies = (fetchMock: ReturnType<typeof pageFetch>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes("/exchanges")).map(([, init]) => JSON.parse(String(init?.body)));

// jsdom has no Web Locks, and the store refuses to run Exchange without them (CONCURRENCY_GUARD_UNAVAILABLE): give the "browser" a lock manager.
const installLocks = () => Object.defineProperty(window.navigator, "locks", { value: makeLocks(), configurable: true });
const removeLocks = () => void Reflect.deleteProperty(window.navigator, "locks");

describe("exchange drafts and the session", () => {
  beforeEach(() => {
    installLocks();
    window.localStorage.clear();
    exchangeDrafts.clearAll();
  });
  afterEach(() => {
    cleanup();
    removeLocks();
    vi.unstubAllGlobals();
    exchangeDrafts.clearAll();
    window.localStorage.clear();
  });

  it("SX-01 an explicit logout keeps an UNCERTAIN attempt (memory and storage) and drops only the editable draft", async () => {
    await seedUncertainAndEditable();
    const key = exchangeDrafts.getDraft(USER, SALE)!.attempt!.idempotencyKey;
    await renderPage();
    await logout();
    expect(exchangeDrafts.getDraft(USER, SALE)!.attempt).toMatchObject({ status: "UNCERTAIN", idempotencyKey: key });
    expect(exchangeDrafts.getDraft(USER, OTHER_SALE)).toBeNull();
    expect(JSON.parse(persisted()!)).toHaveLength(1);
    expect(persisted()).not.toContain("test-token");
  });

  it("SX-02 an automatic session expiry (401 mid-operation) keeps the UNCERTAIN attempt and drops only the editable draft", async () => {
    await seedUncertainAndEditable();
    await renderPage({ adjust401: true });
    fireEvent.click(await screen.findByRole("button", { name: "Ajustar SKU-1" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Cantidad a ajustar/), { target: { value: "2" } });
    fireEvent.change(within(dialog).getByLabelText("Motivo"), { target: { value: "SURPLUS" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar ajuste" }));
    expect(await screen.findByText(/Tu sesión expiró/)).toBeInTheDocument();

    expect(exchangeDrafts.getDraft(USER, SALE)!.attempt!.status).toBe("UNCERTAIN");
    expect(exchangeDrafts.getDraft(USER, OTHER_SALE)).toBeNull();
    expect(JSON.parse(persisted()!)).toHaveLength(1);
  });

  it("SX-03 a logout while the exchange is SENDING keeps the attempt, and the late answer is still recorded", async () => {
    let release: (response: Response) => void = () => undefined;
    const pendingFetch = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal("fetch", pendingFetch);
    await openFilledDraft();
    const pending = exchangeDrafts.send({ userId: USER, saleId: SALE, token: "t" });
    await vi.waitFor(() => expect(pendingFetch).toHaveBeenCalledTimes(1)); // the request has left before the page re-stubs fetch
    await renderPage();
    await logout();
    expect(exchangeDrafts.getDraft(USER, SALE)!.attempt!.status).toBe("SENDING");
    expect(JSON.parse(persisted()!)[0].status).toBe("SENDING");
    release(json({ error: { code: "INTERNAL", message: "boom" } }, 500));
    expect((await pending).kind).toBe("UNCERTAIN");
    expect(JSON.parse(persisted()!)[0].status).toBe("UNCERTAIN");
  });

  it("SX-04 the same user logging in again recovers the attempt and retries with the SAME key and payload; CONFIRMED leaves the tombstone", async () => {
    await seedUncertainAndEditable();
    const original = exchangeDrafts.getDraft(USER, SALE)!.attempt!;
    const fetchMock = await renderPage();
    await logout();
    await loginAgain();
    expect(exchangeDrafts.getDraft(USER, SALE)!.attempt!.idempotencyKey).toBe(original.idempotencyKey);
    const outcome = await exchangeDrafts.send({ userId: USER, saleId: SALE, token: "token-after-login" });
    expect(outcome.kind).toBe("CONFIRMED");
    const [body] = exchangeBodies(fetchMock);
    expect(body).toMatchObject({ idempotencyKey: original.idempotencyKey, reason: original.payload.reason, lines: original.payload.lines });
    expect(JSON.parse(persisted()!)[0]).toMatchObject({ status: "CONFIRMED", idempotencyKey: original.idempotencyKey }); // the tombstone, until reconciled
  });

  it("SX-05 a different user logging in neither sees nor retries it, and the record stays the original user's", async () => {
    await seedUncertainAndEditable();
    const key = exchangeDrafts.getDraft(USER, SALE)!.attempt!.idempotencyKey;
    const fetchMock = await renderPage({ loginAs: "u2" });
    await logout();
    await loginAgain();
    expect(exchangeDrafts.getDrafts("u2")).toEqual([]);
    await expect(exchangeDrafts.send({ userId: "u2", saleId: SALE, token: "token-after-login" })).rejects.toThrow(/NOT_FOUND/);
    expect(exchangeBodies(fetchMock)).toHaveLength(0);
    expect(JSON.parse(persisted()!)[0]).toMatchObject({ userId: USER, idempotencyKey: key });
  });

  it("SX-06 after logging in again, a definitive rejection of the retry clears storage", async () => {
    await seedUncertainAndEditable();
    await renderPage({ exchange: () => json({ error: { code: "INSUFFICIENT_STOCK", message: "Sin stock" } }, 409) });
    await logout();
    await loginAgain();
    const outcome = await exchangeDrafts.send({ userId: USER, saleId: SALE, token: "token-after-login" });
    expect(outcome).toMatchObject({ kind: "REJECTED", code: "INSUFFICIENT_STOCK" });
    expect(persisted()).toBeNull();
  });
});

function Probe({ userId }: { userId: string }) {
  const drafts = useExchangeDrafts(userId);
  return <p data-testid="probe">{drafts.map((draft) => `${draft.saleNumber}:${draft.attempt?.status ?? "none"}`).join(",")}</p>;
}

describe("useExchangeDrafts", () => {
  beforeEach(() => {
    installLocks();
    exchangeDrafts.clearAll();
  });
  afterEach(() => {
    cleanup();
    removeLocks();
    exchangeDrafts.clearAll();
    window.localStorage.clear();
  });

  it("SX-03 the drafts survive the component being unmounted and mounted again, and another user sees none of them", async () => {
    await openFromRead(SALE, "T-1");
    const first = render(<Probe userId={USER} />);
    expect(screen.getByTestId("probe")).toHaveTextContent("T-1:none");
    first.unmount();
    render(<Probe userId={USER} />);
    expect(screen.getByTestId("probe")).toHaveTextContent("T-1:none");
    cleanup();
    render(<Probe userId="someone-else" />);
    expect(screen.getByTestId("probe")).toBeEmptyDOMElement();
  });

  it("SX-04 a change made outside React (a late answer) re-renders the subscribed component", async () => {
    await openFromRead(SALE, "T-1");
    render(<Probe userId={USER} />);
    exchangeDrafts.edit(USER, SALE, { type: "reason", value: "x" });
    await openFromRead(OTHER_SALE, "T-2");
    return waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("T-1:none,T-2:none"));
  });
});

describe("exchange drafts without Web Locks (insecure context)", () => {
  beforeEach(() => {
    removeLocks();
    window.localStorage.clear();
    exchangeDrafts.clearAll();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    exchangeDrafts.clearAll();
    window.localStorage.clear();
  });

  it("SX-07 the process-wide store reports the guard unavailable: it opens nothing, mints no key and sends nothing", async () => {
    const fetchMock = vi.fn(async () => json({ exchangeId: randomUUID(), replayed: false }, 201));
    vi.stubGlobal("fetch", fetchMock);
    installLocks();
    await openFilledDraft();
    removeLocks(); // the browser stops offering Web Locks
    expect(exchangeDrafts.getGuardStatus()).toBe("UNAVAILABLE");
    await expect(exchangeDrafts.send({ userId: USER, saleId: SALE, token: "t" })).rejects.toThrow(/CONCURRENCY_GUARD_UNAVAILABLE/);
    await expect(openFromRead(OTHER_SALE, "T-2")).rejects.toThrow(/CONCURRENCY_GUARD_UNAVAILABLE/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persisted()).toBeNull();
  });

  it("SX-08 the guard is judged at the moment of use: Web Locks that show up later are used", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ exchangeId: randomUUID(), replayed: false }, 201)));
    await expect(openFromRead(SALE, "T-1", ITEM)).rejects.toThrow(/CONCURRENCY_GUARD_UNAVAILABLE/);
    installLocks();
    expect(exchangeDrafts.getGuardStatus()).toBe("AVAILABLE");
    await openFilledDraft();
    expect((await exchangeDrafts.send({ userId: USER, saleId: SALE, token: "t" })).kind).toBe("CONFIRMED");
    removeLocks();
  });

  it("SX-09 the productive singleton has no way to open a draft with a baseline of its own", () => {
    expect("openDraft" in exchangeDrafts).toBe(false);
    expect("openDraftUnsafe" in exchangeDrafts).toBe(false);
  });
});
