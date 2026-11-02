// USER-MGMT-01 U5 — forced password change in the POS client. The backend is the authority (403 PASSWORD_CHANGE_REQUIRED on every other route);
// this is the UX that follows: a dedicated screen instead of the POS, the NEW token replacing the old one, global handling of the session-state
// answers, and a reload that stays blocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import OperationsPage from "./page";

const TOKEN_KEY = "mona-jacinta-token";
const NEW = "una-contrasena-nueva-123";
const sellerUser = (patch: Record<string, unknown> = {}) => ({
  id: "u1", name: "Vera Vendedora", email: "vera@demo.local", roles: ["SELLER"], branchIds: ["CEN"], permissions: ["sale.create"],
  cashMovementLocationIds: [], cashSupervisorLocationIds: [], mustChangePassword: false, ...patch,
});

type Reply = { status?: number; body: unknown };
type Calls = Array<{ method: string; path: string; auth: string | null; body: unknown }>;
function installFetch(routes: Record<string, Reply | ((c: { auth: string | null; body: unknown }) => Reply)>, fallback: Reply = { body: { items: [] } }): Calls {
  const calls: Calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const method = init.method ?? "GET";
    const auth = new Headers(init.headers).get("Authorization");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, auth, body });
    const route = routes[`${method} ${path}`];
    const reply = typeof route === "function" ? route({ auth, body }) : (route ?? fallback);
    const status = reply.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => reply.body } as Response;
  }));
  return calls;
}
const pendingUser = sellerUser({ mustChangePassword: true });
const failure = (status: number, code: string, message: string): Reply => ({ status, body: { error: { code, message } } });

async function fill(current = "temporal-actual", next = NEW, again = NEW) {
  fireEvent.change(await screen.findByLabelText("Contraseña actual"), { target: { value: current } });
  fireEvent.change(screen.getByLabelText("Nueva contraseña"), { target: { value: next } });
  fireEvent.change(screen.getByLabelText("Repetir nueva contraseña"), { target: { value: again } });
}
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Cambiar contraseña" }));

beforeEach(() => window.localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("forced password change (CF-*)", () => {
  it("CF-01 a normal account (no pending change) reaches the POS", async () => {
    window.localStorage.setItem(TOKEN_KEY, "tok");
    installFetch({ "GET /auth/me": { body: { user: sellerUser() } } });
    render(<OperationsPage />);
    expect(await screen.findByText("Productos y variantes")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Cambiar contraseña" })).not.toBeInTheDocument();
  });

  it("CF-02 logging in with a temporary password shows ONLY the change screen — no POS, no tabs, no data requests", async () => {
    const calls = installFetch({ "POST /auth/login": { body: { accessToken: "temp-token", user: pendingUser } } });
    render(<OperationsPage />);
    fireEvent.change(await screen.findByLabelText("Correo"), { target: { value: "vera@demo.local" } });
    fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: "ABCD-efgh-JKLM-npqr" } });
    fireEvent.click(screen.getByRole("button", { name: "Ingresar" }));
    expect(await screen.findByRole("heading", { name: "Cambiar contraseña" })).toBeInTheDocument();
    expect(screen.getByText("Necesitás cambiar tu contraseña antes de continuar.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Venta" })).not.toBeInTheDocument();
    expect(screen.queryByText("Productos y variantes")).not.toBeInTheDocument();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /auth/login"]);
  });

  it("CF-03 a reload during the forced flow is still blocked (the stored token + /auth/me say so)", async () => {
    window.localStorage.setItem(TOKEN_KEY, "tok");
    installFetch({ "GET /auth/me": { body: { user: pendingUser } } });
    render(<OperationsPage />);
    expect(await screen.findByRole("heading", { name: "Cambiar contraseña" })).toBeInTheDocument();
    expect(screen.queryByText("Productos y variantes")).not.toBeInTheDocument();
  });

  it("CF-04 mismatching confirmation is refused in the browser, with no request", async () => {
    window.localStorage.setItem(TOKEN_KEY, "tok");
    const calls = installFetch({ "GET /auth/me": { body: { user: pendingUser } } });
    render(<OperationsPage />);
    await fill("temporal-actual", NEW, "otra-distinta-123");
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Las contraseñas nuevas no coinciden.");
    expect(calls.filter((c) => c.path === "/auth/change-password")).toHaveLength(0);
  });

  it("CF-05 the backend's INVALID_CURRENT_PASSWORD message is shown and the screen stays", async () => {
    window.localStorage.setItem(TOKEN_KEY, "tok");
    installFetch({
      "GET /auth/me": { body: { user: pendingUser } },
      "POST /auth/change-password": failure(400, "INVALID_CURRENT_PASSWORD", "La contraseña actual no es correcta."),
    });
    render(<OperationsPage />);
    await fill();
    submit();
    expect(await screen.findByText("La contraseña actual no es correcta.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Cambiar contraseña" })).toBeInTheDocument();
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe("tok");
  });

  it("CF-06 success: the OLD token is replaced by the new one, /auth/me is re-read WITH it, and the POS opens", async () => {
    window.localStorage.setItem(TOKEN_KEY, "old-token");
    const calls = installFetch({
      "GET /auth/me": ({ auth }) => ({ body: { user: auth === "Bearer new-token" ? sellerUser() : pendingUser } }),
      "POST /auth/change-password": { body: { accessToken: "new-token", user: sellerUser() } },
    });
    render(<OperationsPage />);
    await fill();
    submit();
    expect(await screen.findByText("Productos y variantes")).toBeInTheDocument();
    const change = calls.find((c) => c.path === "/auth/change-password")!;
    expect(change.auth).toBe("Bearer old-token");
    expect(change.body).toEqual({ currentPassword: "temporal-actual", newPassword: NEW });
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe("new-token");
    expect(calls.filter((c) => c.path === "/auth/me").at(-1)!.auth).toBe("Bearer new-token");
    expect(JSON.stringify(Object.entries(window.localStorage))).not.toMatch(/old-token|una-contrasena/);
  });

  it("CF-07 PASSWORD_CHANGE_REQUIRED from ANY request in a normal session switches to the change screen, once (no loop)", async () => {
    window.localStorage.setItem(TOKEN_KEY, "tok");
    const calls = installFetch({
      "GET /auth/me": { body: { user: sellerUser() } },
      "GET /variants": failure(403, "PASSWORD_CHANGE_REQUIRED", "Necesitás cambiar tu contraseña antes de continuar."),
    });
    render(<OperationsPage />);
    expect(await screen.findByRole("heading", { name: "Cambiar contraseña" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 150));
    expect(calls.filter((c) => c.path === "/variants")).toHaveLength(1);
    expect(screen.queryByText("Productos y variantes")).not.toBeInTheDocument();
  });

  it("CF-08 INACTIVE_USER from any request ends the session: token cleared, login screen, with the explanation", async () => {
    window.localStorage.setItem(TOKEN_KEY, "tok");
    installFetch({
      "GET /auth/me": { body: { user: sellerUser() } },
      "GET /variants": failure(403, "INACTIVE_USER", "El usuario está inactivo."),
    });
    render(<OperationsPage />);
    expect(await screen.findByRole("button", { name: "Ingresar" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Tu usuario fue desactivado. Consultá con un administrador.");
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(screen.queryByText("Productos y variantes")).not.toBeInTheDocument();
  });

  it("CF-09 INACTIVE_USER while restoring the session (/auth/me) clears it with the same explanation", async () => {
    window.localStorage.setItem(TOKEN_KEY, "tok");
    installFetch({ "GET /auth/me": failure(403, "INACTIVE_USER", "El usuario está inactivo.") });
    render(<OperationsPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Ingresar" })).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("Tu usuario fue desactivado. Consultá con un administrador.");
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("CF-10b two submits dispatched in the SAME tick (before the disabled button re-renders) still send ONE request", async () => {
    window.localStorage.setItem(TOKEN_KEY, "tok");
    let release!: (r: Reply) => void;
    const held = new Promise<Reply>((resolve) => { release = resolve; });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname.replace(/^\/api\/v1/, "");
      calls.push(`${init.method ?? "GET"} ${path}`);
      const reply: Reply = path === "/auth/me" ? { body: { user: pendingUser } } : path === "/auth/change-password" ? await held : { body: {} };
      const status = reply.status ?? 200;
      return { ok: status < 300, status, json: async () => reply.body } as Response;
    }));
    render(<OperationsPage />);
    await fill();
    const form = screen.getByRole("button", { name: "Cambiar contraseña" }).closest("form")!;
    act(() => { form.requestSubmit(); form.requestSubmit(); });
    expect(calls.filter((c) => c === "POST /auth/change-password")).toHaveLength(1);
    release({ status: 400, body: { error: { code: "X", message: "No." } } });
    await within(document.body).findByText("No.");
  });

  it("CF-10 a double click on Cambiar contraseña sends ONE request", async () => {
    window.localStorage.setItem(TOKEN_KEY, "tok");
    let release!: (r: Reply) => void;
    const held = new Promise<Reply>((resolve) => { release = resolve; });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname.replace(/^\/api\/v1/, "");
      calls.push(`${init.method ?? "GET"} ${path}`);
      const reply: Reply = path === "/auth/me" ? { body: { user: pendingUser } } : path === "/auth/change-password" ? await held : { body: {} };
      const status = reply.status ?? 200;
      return { ok: status < 300, status, json: async () => reply.body } as Response;
    }));
    render(<OperationsPage />);
    await fill();
    const button = screen.getByRole("button", { name: "Cambiar contraseña" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(calls.filter((c) => c === "POST /auth/change-password")).toHaveLength(1);
    expect(button).toBeDisabled();
    release({ status: 400, body: { error: { code: "X", message: "No." } } });
    await within(document.body).findByText("No.");
  });
});
