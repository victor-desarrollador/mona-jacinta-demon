# Mona Jacinta Production V1 — Estado y Próximos Pasos

Fecha de corte: 2026-10-07

## Current Checkpoint

- Branch operativo: `feat/production-v1`.
- Integration HEAD antes de este commit documental: `9a3243f912d8b0f929767978e97454d229acedda`.
- `origin/feat/production-v1`: verificado en `9a3243f912d8b0f929767978e97454d229acedda` después del fast-forward normal.
- La rama temporal `feat/production-v1-pricing-wholesale-t4` apunta al mismo commit y ya fue integrada a Production V1.
- El worktree limpio de T4 fue cambiado a `feat/production-v1`; el worktree viejo y sucio quedó intacto y preservado.

## Production V1 Actual

Production V1 contiene P0.2, A1-D, Task 4 LOCAL_TEST, Block 1 sale-scoped wholesale, R4 LOCAL_TEST proof tooling, hardening de lecturas por permiso y Pricing V2.

Pricing V2 está committed y pushed en Production V1. Incluye:

- `ProductVariant.cashPrice` como base CASH retail.
- `ProductVariant.wholesalePrice` como base CASH wholesale.
- configuración company-global de modos de precio.
- `Sale.priceMode` por venta, con repricing atómico antes de pagos.
- snapshots de precio inmutables en `SaleItem`.
- compatibilidad mínima de admin/client.
- tooling LOCAL_TEST/PILOT sincronizado con la migración revisada.

La migración de Pricing V2 fue aplicada y validada sólo en la base disposable `LOCAL_TEST`. No fue aplicada a DEV, TEST, DEMO ni PILOT.

## Verificación Registrada

- LOCAL_TEST focused real-DB: **439/439 PASS**, con retorno a `EXACT_BASELINE`.
- DB-free/API/static: 8 archivos / 465 tests PASS; API `tsc`, ESLint y `git diff --check` PASS.
- Node script tests: `pilot-migrate` 39/39, `local-test-prepare` 182/182, `local-test-backup` 34/34 y suites relacionadas PASS.
- Admin frontend: lint PASS, `tsc -b && vite build` PASS.
- Client frontend: lint PASS, Vitest 5 archivos / 44 tests PASS, `next build` PASS.
- No se reclama validación browser/E2E.
- No se corrió owner full suite para Pricing V2.

## Preservación

El worktree viejo en `mona-jacinta-demon/` conserva cambios locales antiguos y no fue limpiado ni reseteado. Fue preservado en almacenamiento durable fuera del repositorio:

`~/.local/share/mona-jacinta/preservation/old-worktree-20261007`

Ese artefacto es backup de preservación, no fuente de verdad. La fuente de verdad para trabajo actual es `feat/production-v1`.

## Estado PILOT

- `pilot` sigue separado en `4fab1ab22e6acc09e6b0b5d4f8355d1e3728a949`.
- Production V1 no fue mergeado a `pilot`.
- La DB PILOT no fue migrada.
- No se importaron datos reales de clientes.
- No se ejecutó smoke/client validation contra PILOT.

## Known Pre-PILOT Work

1. Corregir `removeItem` concurrency / stale-cart behavior, según el hallazgo verificado por auditoría previa.
2. Resolver rate-limit / `trust proxy` para el hosting real; el impacto debe verificarse en despliegue, no inferirse sólo desde configuración local.
3. Ejecutar la verificación Production V1 que corresponda después de esos fixes y antes de tocar PILOT.

## Deferred / Not Blocking Pilot

- Mixed proportional payment pricing sigue requerido para el producto final, pero está fuera del piloto actual.
- AC-211 restore proof permanece **NOT RUN / deferred**.
- Admin test suite dedicada sigue diferida; admin tiene lint/typecheck/build verificados.
- Refactor amplio de `client/src/app/page.tsx` sigue diferido.
- OpenCode P0.2 LOW L-1...L-5 / DEBT-023 permanecen deuda aceptada.
- TEST-H3 permanece diferido.

## Next Actions

1. Implementar los fixes pre-PILOT aprobados (`removeItem`, rate-limit / `trust proxy`).
2. Verificar Production V1 después de esos fixes.
3. Hacer limpieza de ramas/worktrees sólo después de una nueva prueba de alcance y reachability; no borrar aún el worktree viejo ni T4.
4. Hacer merge normal Production V1 -> `pilot` bajo autorización separada.
5. Ejecutar migración PILOT sólo bajo autorización explícita de DB.
6. Importar datos reales con procedimiento controlado y reversible.
7. Ejecutar smoke/client validation contra el entorno PILOT.

## Operational Guardrails

- `docs/production-v1/*` sigue frozen. Sus modelos de precio históricos se resuelven mediante supersessions fechadas en `AGENTS.md`, no editando esos archivos.
- Ningún agente debe contactar DEV, TEST, DEMO, PILOT o producción sin autorización explícita para esa fase.
- No usar `git add .` ni `git add -A`; staging siempre por archivos exactos.
- No borrar ramas, refs, stashes ni worktrees hasta la fase de cleanup autorizada.
