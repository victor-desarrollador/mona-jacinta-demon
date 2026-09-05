# AGENTS.md

Mona Jacinta — sistema comercial multiusuario y multisucursal desarrollado como proyecto de tesis.

**This repository (`mona-jacinta-demon/`) is the clean Mona Jacinta Demo V2 target repository.**

The reference / legacy implementation lives in `../Tesis/` and is **READ-ONLY**. It must be treated as legacy/reference material only and never modified.

- References in this document to the **legacy `server/`**, **legacy `client/`**, and **legacy `admin/`** mean `../Tesis/server/`, `../Tesis/client/`, and `../Tesis/admin/` respectively.
- The **new** `client/`, `admin/`, and `api/` applications will live in **this** repository (`mona-jacinta-demon/`) and will be created later according to the approved implementation plan.
- Legacy code may only be selectively reused or ported into this repository **after inspection**.

The legacy e-commerce platform was historically identified as "Babymart" / "L&V tienda". Its source is no longer inside this repository; it is the read-only reference at `../Tesis/`.

Do not assume the current repository structure represents the final architecture.

This repository does **not yet** contain `client/`, `admin/`, or `api/`. Those applications will be created later.

---

## Apps

### Legacy reference application (`../Tesis/`, read-only)

These applications live in the read-only legacy repo `../Tesis/` and are reference material only. They do **not** run inside this repository.

| Dir          | Stack                                                 | Dev command   | Port |
| ------------ | ----------------------------------------------------- | ------------- | ---- |
| `server/`    | Node + Express 5 + Mongoose (ESM, `"type": "module"`) | `npm run dev` | 8000 |
| `client/`    | Next.js 16 App Router + React 19 + Tailwind 4         | `npm run dev` | 3000 |
| `admin/`     | React 19 + Vite 7 + TypeScript + Tailwind 4           | `npm run dev` | 5173 |
| `mobileapp/` | React Native 0.80 bare CLI                            | `npm start`   | —    |

MongoDB is required only for the legacy `server/` in `../Tesis/`.

### Target applications (`mona-jacinta-demon/`, to be created)

These will be created later in **this** repository according to the approved implementation plan.

| Dir       | Role                                                | Stack                                    |
| --------- | --------------------------------------------------- | ---------------------------------------- |
| `client/` | Operations application (SELLER / CASHIER)           | Next.js 16 App Router + React 19 + Tailwind 4 |
| `admin/`  | Backoffice (MANAGER / ADMIN)                        | React 19 + Vite 7 + TypeScript + Tailwind 4 |
| `api/`    | New source-of-truth backend                          | Express + TypeScript + PostgreSQL + Prisma |

Node 18+ required.

---

## Current Repository State

This repository (`mona-jacinta-demon/`) is the clean target for Mona Jacinta Demo V2. It does not yet contain the target `client/`, `admin/`, or `api/` applications; those will be created later.

The legacy e-commerce implementation lives in the read-only reference at `../Tesis/` and represents the starting point of the migration, not the final Mona Jacinta architecture.

### Legacy `../Tesis/server/`

Legacy Express + MongoDB/Mongoose backend (reference only).

Existing functionality includes concepts such as:

* authentication
* users
* products
* product variants
* orders
* payments
* categories
* brands
* analytics
* Cloudinary
* Mercado Pago
* Stripe
* Swagger
* validation
* rate limiting

Legacy behavior must only be replaced by an approved migration task that explicitly replaces a capability. Do not modify `../Tesis/`.

---

### Legacy `../Tesis/client/`

Legacy Next.js application inherited from the e-commerce implementation (reference only).

The **new** `client/` in this repository will take on the target responsibility:

**Mona Jacinta Operations Application**

Primary users:

* `SELLER`
* `CASHIER`

The ecommerce-oriented client UX is legacy behavior and does not define the final product.

---

### Legacy `../Tesis/admin/`

Legacy React + Vite + TypeScript administrative application (reference only).

The **new** `admin/` in this repository will take on the target responsibility:

**Mona Jacinta Backoffice**

Primary users:

* `MANAGER`
* `ADMIN`

Experimental POS/sales/stock code may currently exist inside the legacy `../Tesis/admin/`.

That existing placement does not define the target architecture.

Inspect that existing POS-related code before removing or replacing it because reusable UI, state-management, or interaction logic may exist (see `docs/architecture/mona-demo-v2.md` §2).

Final branch operational POS functionality belongs primarily in the new `client/`.

---

### Legacy `../Tesis/mobileapp/`

React Native application (reference only).

The mobile app is outside the current Demo V2 implementation scope.

Do not spend migration effort on it unless an approved plan explicitly changes the scope.

---

## Verified Gotchas

The root README is stale in several places.

Prefer verified code/configuration over legacy README claims.

Known discrepancies include:

* server database environment variable is `MONGO_URI`;
* client uses Next.js 16 / React 19;
* mobile application is bare React Native, not Expo;
* historical names include "Babymart" and "L&V tienda";
* those historical names must not be assumed to be the final product identity.

---

## Environment and Secrets

`.env` files are currently committed in existing applications despite `.gitignore`.

This is a security issue that must be remediated during repository cleanup.

Rules:

* Never print secret values.
* Never expose secret values in chat, logs, plans, README files, commits, screenshots, examples, or tests.
* Never copy production or development secrets into documentation.
* Existing exposed credentials must be treated as compromised and rotated.
* Use `.env.example` containing variable names and safe placeholder values.
* Do not use `git add .` blindly while secret-bearing or generated files may exist.
* Before committing repository-cleanup changes, explicitly inspect staged files.

---

# Target Architecture

The migration target is Mona Jacinta, a centralized multiuser and multibranch commercial management system.

Conceptually:

```text
                    MONA JACINTO

                       Internet
                          │
          ┌───────────────┴───────────────┐
          │                               │
          ▼                               ▼
      client/                           admin/
 Operations Application               Backoffice
 SELLER / CASHIER                 MANAGER / ADMIN
          │                               │
          └───────────────┬───────────────┘
                          │
                     HTTPS / API
                          │
                          ▼
                        api/
               Express + TypeScript
                          │
                          ▼
                     PostgreSQL
```

PostgreSQL will become the source of truth for the new transactional domain.

The existing MongoDB backend is legacy during the migration.

---

# Target Responsibilities

## `client/` — Operations Application

`client/` will progressively become the application used by employees inside each Mona Jacinta branch.

Primary roles:

* `SELLER`
* `CASHIER`

Target features include:

### Seller

* employee login
* current branch identification
* product search
* product variant selection
* stock consultation
* new sale
* sale cart
* allowed discounts
* draft sale
* send sale to cashier
* own sales/status visibility

### Cashier

* employee login
* current branch identification
* pending sales
* open sale for payment
* split payments
* cash payment
* received amount
* change calculation
* card / transfer / QR payments
* sale payment status
* finalize sale
* cash session
* sales history
* branch stock consultation

The operational application should prioritize speed, clarity, and minimal interaction steps.

---

# `admin/` — Backoffice

`admin/` will progressively become the management application.

Primary roles:

* `MANAGER`
* `ADMIN`

Target features include:

* dashboard
* products
* product variants
* categories
* brands
* inventory
* branches
* users
* roles
* permissions
* sales monitoring
* cash monitoring
* stock movements
* audit history
* reports
* future transfers
* future purchases
* future suppliers
* future ARCA visibility

Managers may have branch-scoped permissions.

Admins may have global access.

Backend authorization remains authoritative regardless of frontend visibility.

---

# `server/` — Legacy Backend (reference, `../Tesis/`)

`server/` is the legacy Express + MongoDB/Mongoose backend. It lives in the read-only `../Tesis/` reference repository and is **not** part of this repository.

Treat it as legacy during migration.

Do not delete or destructively rewrite it at the beginning.

Before replacing existing functionality:

1. inspect the implementation;
2. identify useful business behavior;
3. identify reusable validation or service logic;
4. identify incompatible ecommerce assumptions;
5. document the migration decision;
6. build the replacement;
7. test the replacement;
8. remove legacy behavior only when it is safe.

Existing MongoDB models must not automatically be duplicated one-for-one in PostgreSQL.

The new database model must represent the Mona Jacinta business domain rather than reproducing legacy schema decisions.

---

# `api/` — New Backend

A new backend is planned under:

```text
api/
```

Target stack:

* Node.js
* Express
* TypeScript
* PostgreSQL
* Prisma
* Zod
* JWT
* bcrypt
* Socket.IO
* Vitest
* Supertest

Possible initial structure:

```text
api/
├── src/
│   ├── config/
│   ├── modules/
│   │   ├── auth/
│   │   ├── users/
│   │   ├── branches/
│   │   ├── products/
│   │   ├── inventory/
│   │   ├── sales/
│   │   ├── payments/
│   │   ├── cash/
│   │   └── audit/
│   ├── middleware/
│   ├── shared/
│   ├── app.ts
│   └── server.ts
├── prisma/
│   ├── schema.prisma
│   └── seed.ts
└── tests/
```

This structure is a target direction, not authorization to create everything before planning.

Do not create or restructure major architecture before the architecture document and implementation plan are approved.

---

# Immediate Goal — Demo V2

Do not attempt to implement the entire final Mona Jacinta platform at once.

The immediate milestone is a strong and reproducible Demo V2.

Demo V2 should demonstrate:

1. Employee authentication.
2. Roles:

   * `SELLER`
   * `CASHIER`
   * `MANAGER`
   * `ADMIN`
3. Branch assignment.
4. Products.
5. Product variants.
6. Inventory by branch/location.
7. Seller POS.
8. Draft sale creation.
9. Seller-to-cashier handoff.
10. Pending payment state.
11. Stock reservation where appropriate.
12. Cashier pending sales queue.
13. Split payments.
14. Cash received/change handling.
15. Paid sale state.
16. Transactional sale completion.
17. Inventory update.
18. Stock movements.
19. Audit log.
20. Realtime notifications.
21. Basic administrative visibility of completed operations.

---

# Demo V2 Main Scenario

The primary acceptance scenario is:

## Browser A — Seller

Login:

```text
Role: SELLER
Branch: Centro
```

Create sale:

```text
Remera Básica
Negro / M
Quantity: 2

Jean Slim
Azul / 42
Quantity: 1

TOTAL: ARS 165000
```

Seller presses:

```text
ENVIAR A CAJA
```

Sale transitions:

```text
DRAFT
↓
PENDING_PAYMENT
```

Stock should be protected/reserved according to the approved inventory design.

---

## Browser B — Cashier

Login:

```text
Role: CASHIER
Branch: Centro
```

The sale created by the seller must appear in the cashier pending queue without manually copying or recreating sale data.

Cashier opens the sale.

Registers:

```text
Transfer: ARS 100000
Cash:     ARS 65000
```

The total paid equals the sale total.

Sale transitions:

```text
PENDING_PAYMENT
↓
PAID
```

Cashier finalizes the sale.

Sale transitions:

```text
PAID
↓
COMPLETED
```

---

## Expected Persisted Result

After successful completion PostgreSQL must contain consistent state for:

* sale
* sale items
* seller
* branch
* payments
* inventory
* stock movements
* audit information

The inventory quantities must reflect the completed sale exactly once.

Browser A must be able to observe the updated state.

The admin/backoffice should be able to observe relevant completed-sale and inventory information.

---

# Domain Model Direction

The initial domain is expected to contain concepts such as:

```text
User
Branch
Role
Permission
UserBranchRole

Product
ProductVariant

Inventory
StockMovement
StockReservation

Sale
SaleItem
SalePayment

CashRegister
CashSession
CashMovement

AuditLog
```

Future phases may introduce:

```text
InventoryLocation
Warehouse

Transfer
TransferItem

Supplier
PurchaseOrder
PurchaseItem
GoodsReceipt

Customer

Reservation
ReservationItem

Exchange
ExchangeItem

MarketingLoan
MarketingLoanItem

FiscalInvoice

OutboxEvent
```

Do not implement future-phase entities merely because they are listed here.

---

# Product and Variant Rules

The new commercial domain must distinguish products from sellable variants.

Example:

```text
Product
Remera Básica
```

Variants:

```text
Negro / S
Negro / M
Negro / L

Blanco / S
Blanco / M
Blanco / L
```

A variant should support identifiers such as:

```text
SKU
barcode
color
size
```

where appropriate.

Inventory should reference the sellable `ProductVariant`.

Do not use legacy global `Product.stock` as the source of truth for the new inventory domain.

---

# Inventory Rules

Inventory must be scoped to a branch or inventory location.

Conceptually inventory may include:

```text
physical
reserved
inTransit
```

Available inventory must be calculated consistently from persisted stock state.

Typical concept:

```text
available = physical - reserved
```

Do not duplicate independently writable values if they can become inconsistent.

Important inventory operations must generate auditable `StockMovement` records.

Example:

```text
SALE
Remera Básica Negro M
-2
Branch: Centro
Sale: V-000154
User: cashier01
```

Critical inventory operations must be concurrency-safe.

---

# Stock Reservation

A sale being sent to cashier may need to reserve stock before payment.

Reason:

Two sellers must not be able to successfully sell the last physical unit simultaneously.

A suitable architecture should consider operations similar to:

```text
DRAFT
↓
SEND TO CASHIER
↓
validate availability
↓
reserve inventory
↓
PENDING_PAYMENT
```

Do not implement reservation logic before the plan defines:

* reservation lifecycle;
* expiration/cancellation behavior;
* locking/concurrency strategy;
* relationship with inventory.

---

# Sale Lifecycle

Initial sale lifecycle:

```text
DRAFT
↓
PENDING_PAYMENT
↓
PAID
↓
COMPLETED
```

Additional states must have explicit business justification.

Do not force the existing ecommerce `Order` model to serve as the new commercial `Sale` aggregate without analysis.

A dedicated `Sale` aggregate is expected for the new POS domain.

---

# Payments

A Mona Jacinta sale may contain multiple payments.

Do not model a POS sale with only:

```text
paymentMethod
```

Use a payment collection concept.

Example:

```text
Sale V-000154
Total: ARS 165000

Payments:

TRANSFER
ARS 100000

CASH
ARS 65000
```

A sale becomes paid according to the approved payment rules when accepted payments satisfy the total owed.

---

# Cash Payment Rules

Cash payments must distinguish:

```text
amount
receivedAmount
changeAmount
```

Example:

```text
Remaining: ARS 35000

Customer gives:
ARS 40000

amount:
ARS 35000

receivedAmount:
ARS 40000

changeAmount:
ARS 5000
```

Returned change is not additional revenue.

Financial accounting should reflect the actual sale payment amount, not the gross cash handed over before change.

---

# Money Rules

Do not use JavaScript floating-point arithmetic as the authoritative representation of monetary amounts.

The architecture plan must define a consistent money representation.

Preferred direction:

```text
integer minor units
```

or another explicit PostgreSQL-safe monetary representation.

Never mix monetary representations casually across database, API, frontend, and tests.

---

# Authentication

Employees must authenticate against the backend.

Authentication must produce sufficient identity context for authorization, including where appropriate:

* user id;
* role / permissions;
* assigned branch(es);
* session/token information.

Do not trust frontend-provided role or branch values.

---

# Authorization

Frontend visibility is not a security boundary.

Permissions must always be enforced by the backend.

Expected roles:

```text
SELLER
CASHIER
MANAGER
ADMIN
```

Representative authorization expectations:

| Action                  | SELLER | CASHIER | MANAGER     | ADMIN |
| ----------------------- | ------ | ------- | ----------- | ----- |
| Create sale             | Yes    | No      | Yes         | Yes   |
| Modify seller cart      | Yes    | No      | Yes         | Yes   |
| Send sale to cashier    | Yes    | No      | Yes         | Yes   |
| Charge sale             | No     | Yes     | Yes         | Yes   |
| Complete sale           | No     | Yes     | Yes         | Yes   |
| Open/close cash session | No     | Yes     | Yes         | Yes   |
| View branch stock       | Yes    | Yes     | Yes         | Yes   |
| Manage inventory        | No     | No      | Limited/Yes | Yes   |
| View global reports     | No     | No      | Limited     | Yes   |
| Manage users            | No     | No      | No/Limited  | Yes   |

The exact permission matrix must be finalized during architecture planning.

Avoid spreading authorization logic through the codebase as repeated checks such as:

```text
user.role === "admin"
```

Prefer explicit permission checks where practical.

Branch scope must also be enforced by the backend.

---

# Realtime Rules

Realtime communication is useful for the Seller → Cashier workflow.

Possible events:

```text
sale.pending_payment
sale.updated
sale.paid
sale.completed
inventory.updated
```

Socket.IO may be used.

However:

**PostgreSQL remains the source of truth.**

Realtime events are notifications, not persisted authoritative state.

Clients should refetch authoritative API state when appropriate after receiving an event.

The system must still function correctly if a realtime event is delayed, duplicated, or missed.

---

# Transaction Rules

Operations modifying multiple critical records must use PostgreSQL transactions where appropriate.

Sale completion is a critical transaction.

It must protect against:

* insufficient stock;
* duplicate completion;
* duplicated stock deductions;
* invalid payment state;
* inconsistent reservations;
* partially written stock movements;
* partially completed sales;
* concurrent completion attempts.

Conceptually:

```text
BEGIN

validate sale state
validate payment state
validate/resolution inventory reservation
lock required inventory
update inventory
create stock movements
create required financial/cash movements
update sale to COMPLETED
write audit data

COMMIT
```

If a critical operation fails:

```text
ROLLBACK
```

No partially completed business state should remain.

---

# External Services

Do not perform slow external network calls while holding an open PostgreSQL transaction.

Future ARCA/CAE integration must not be placed inside the core database transaction.

Preferred direction:

```text
Complete database transaction
↓
persist fiscal request / outbox event
↓
COMMIT
↓
worker/service
↓
ARCA
↓
store CAE/result
```

Transactional Outbox or an equivalent reliable pattern should be evaluated.

Production ARCA integration is outside Demo V2 scope.

---

# Cash Register Direction

Demo V2 may include minimum viable cash handling.

Concepts may include:

```text
CashRegister
CashSession
CashMovement
```

Potential lifecycle:

```text
CLOSED
↓
OPEN
↓
operations
↓
CLOSED
```

Cash movements must distinguish sale income from manual income/expenses where relevant.

Do not expand cash accounting beyond what Demo V2 needs without explicit scope approval.

---

# Audit Rules

Important commercial operations should be traceable.

Potential audit information:

* user
* role
* branch
* operation
* entity type
* entity id
* timestamp
* relevant before/after state when appropriate

Critical examples:

```text
sale created
sale sent to cashier
payment registered
sale completed
inventory changed
cash session opened
cash session closed
```

Do not store passwords, tokens, secrets, or unnecessary sensitive values in audit logs.

---

# Seed / Demo Data

Demo V2 should support deterministic seed data.

Expected example branches:

```text
Centro
Yerba Buena
Tafí Viejo
Banda
Concepción
Depósito Central
```

Example users:

```text
admin
ADMIN

manager01
MANAGER
Centro

seller01
SELLER
Centro

cashier01
CASHIER
Centro
```

Example products:

```text
Remera Básica
Jean Slim
Campera Jean
```

Seed credentials must be clearly demo-only and must not reuse real production secrets.

The demo should be reproducible from a known database state.

---

# Testing

The legacy `server/` currently does not have a formal automated test framework.

The new `api/` should introduce automated tests.

Preferred tools:

```text
Vitest
Supertest
```

Critical business behavior must be tested.

Important examples:

### Authorization

SELLER attempts cashier-only endpoint:

```text
403
```

CASHIER attempts admin-only endpoint:

```text
403
```

---

### Split Payment

```text
Sale total:
165000

Transfer:
100000

Cash:
65000

Expected:
PAID
```

Partial payment:

```text
100000 + 60000
```

must not mark the sale paid.

---

### Duplicate Completion

Two completion requests for the same sale must not deduct stock twice.

---

### Stock Concurrency

Example:

```text
available stock = 1

Seller A reserves 1
Seller B tries to reserve 1
```

Only one operation may succeed.

---

### Transaction Rollback

If finalization fails after beginning the critical operation, persisted business state must remain consistent.

---

# Existing Testing Commands

Legacy server:

```text
server/tests/
```

contains manual scripts.

Do not mistake these for the final automated test suite.

Admin:

```bash
npm run build
```

runs TypeScript build plus Vite and should remain a useful verification gate.

Client:

use the existing lint/build commands defined in its package manifest.

Mobile:

outside Demo V2 scope.

---

# Code Conventions

Existing conventions:

* code identifiers should generally remain English;
* user-facing UI strings should remain Spanish;
* comments may be Spanish or English but should be clear;
* existing server uses ESM imports;
* avoid introducing CommonJS into ESM modules without justification.

New backend:

* TypeScript
* explicit domain types
* Zod at input boundaries
* clear module ownership
* avoid large controllers containing business logic
* prefer services/use-cases for business operations
* isolate infrastructure concerns
* keep critical transactions explicit
* avoid hidden side effects

---

# Migration Strategy

Use incremental migration.

Do not perform a big-bang rewrite.

Preferred sequence:

```text
legacy system remains available
        ↓
new backend foundation
        ↓
new domain capabilities
        ↓
frontend migration by feature
        ↓
functional parity where required
        ↓
legacy removal when safe
```

Before replacing functionality:

1. inspect existing code;
2. understand current behavior;
3. identify reusable components/logic;
4. identify legacy assumptions;
5. define replacement behavior;
6. write tests/acceptance criteria;
7. implement;
8. verify;
9. remove obsolete code only when safe.

Do not delete working legacy functionality solely because new architecture exists.

---

# MongoDB → PostgreSQL Migration

Introducing PostgreSQL does not require migrating all existing MongoDB data immediately.

Demo V2 may start with deterministic PostgreSQL seed data.

Historical migration should be treated as a separate concern.

Possible future migration tooling:

```text
scripts/
└── migrate-mongo-to-postgres.ts
```

Existing concepts may map approximately as:

```text
Mongo Product
↓
Product
ProductVariant
Inventory
```

Existing users/orders must be analyzed independently.

Do not assume direct one-to-one schema migration.

---

# Repository Hygiene

The repository currently contains technical debt including generated files and committed environment files.

Repository cleanup is part of Phase 0.

Potential cleanup tasks include:

* remove tracked `.env` files after rotating credentials;
* add `.env.example`;
* improve `.gitignore`;
* remove tracked `.next` generated output;
* remove backup files;
* update README;
* improve commit hygiene;
* document architecture.

Never delete user-created source code without first inspecting whether it contains useful migration work.

---

# Git Rules

Current migration work must not happen directly on `main`.

Use a dedicated feature branch or worktree.

Current target migration branch:

```text
feat/mona-demo-v2
```

Rules:

* prefer small commits;
* use meaningful commit messages;
* do not stage secrets;
* do not stage generated build output;
* inspect `git diff --staged` before committing;
* do not force-push or rewrite history unless explicitly approved.

Preferred commit style:

```text
chore(repo): sanitize generated and environment files

feat(api): bootstrap typescript backend

feat(db): add initial postgres schema

feat(auth): implement employee authentication

feat(rbac): add branch-scoped permissions

feat(inventory): add branch inventory

feat(sales): implement seller draft flow

feat(sales): add seller-to-cashier handoff

feat(payments): support split payments

feat(sales): complete sale transaction

feat(realtime): notify pending and completed sales

test(sales): cover concurrent inventory reservations
```

---

# Demo V2 Scope Boundaries

Do not implement these during Demo V2 unless the approved plan explicitly changes scope:

* production ARCA integration
* full supplier management
* full purchasing module
* advanced transfers
* commercial reservations/señas
* exchanges/returns
* marketing loans
* mobile app
* advanced reporting
* public ecommerce storefront
* large monorepo/workspace restructuring
* microservices
* Kubernetes
* unnecessary infrastructure complexity

These can be designed as future phases.

---

# Future Architecture Direction

Long-term Mona Jacinta may contain:

```text
Authentication
RBAC
Branches
Products
Variants
Inventory
Sales
Payments
Cash
Transfers
Warehouse
Purchases
Suppliers
Reservations
Exchanges
Marketing Loans
ARCA
Reports
Audit
```

Demo V2 must establish a foundation that can evolve toward these modules without attempting to implement them all now.

---

# Planning Rules

Do not start implementing Mona Demo V2 immediately.

Before implementation:

1. inspect relevant existing code;
2. use architecture/design brainstorming;
3. identify unresolved business and technical decisions;
4. document the approved architecture under:

```text
docs/architecture/
```

5. create an implementation plan under:

```text
docs/plans/
```

6. review the plan;
7. verify security, concurrency, migrations, dependencies, testing, and scope;
8. only then begin implementation.

The implementation plan must be sufficiently detailed that execution does not require repeated major architectural decisions.

---

# Architecture Document Expectations

The Demo V2 architecture document should define at minimum:

* target application responsibilities;
* legacy vs target boundaries;
* database strategy;
* domain model;
* Product / ProductVariant strategy;
* inventory model;
* sale lifecycle;
* payment model;
* cash behavior;
* authentication;
* authorization;
* branch scoping;
* realtime behavior;
* transaction boundaries;
* error handling;
* audit strategy;
* seed/demo strategy;
* testing strategy;
* migration strategy;
* deployment assumptions;
* future ARCA boundary;
* explicit non-goals.

Do not leave material architectural questions hidden inside implementation tasks.

---

# Implementation Plan Expectations

The plan must contain small, verifiable tasks.

Each task should specify where appropriate:

* objective;
* files/modules affected;
* dependencies;
* implementation steps;
* tests;
* commands to run;
* expected behavior;
* acceptance criteria.

Prefer vertical slices over creating dozens of disconnected abstractions before producing working behavior.

---

# Preferred Implementation Order

The exact order must be validated during planning, but the expected direction is approximately:

```text
Phase 0
Repository/security cleanup

↓
Phase 1
PostgreSQL + Prisma + API foundation

↓
Phase 2
Branches + Users + Authentication + RBAC

↓
Phase 3
Products + ProductVariants

↓
Phase 4
Inventory

↓
Phase 5
Seller POS / Draft Sales

↓
Phase 6
Send to Cashier / Reservation

↓
Phase 7
Cashier Queue

↓
Phase 8
Split Payments

↓
Phase 9
Transactional Sale Completion

↓
Phase 10
Realtime

↓
Phase 11
Audit

↓
Phase 12
Admin visibility

↓
Phase 13
Demo seed and reset

↓
Phase 14
End-to-end Demo V2 verification
```

Do not treat this outline as a substitute for the implementation plan.

---

# Definition of Done — Demo V2

Demo V2 is not complete merely because screens render.

It is complete when the primary business scenario works against persisted PostgreSQL state.

Minimum criteria:

* SELLER can authenticate.
* CASHIER can authenticate.
* MANAGER/ADMIN authentication works according to approved scope.
* users have branch-aware authorization.
* products/variants exist in PostgreSQL.
* inventory is branch/location scoped.
* SELLER can create a draft sale.
* SELLER can add variant quantities.
* SELLER can send the sale to cashier.
* stock cannot be oversold through the primary flow.
* CASHIER sees relevant pending sale.
* CASHIER can register split payments.
* cash change is calculated correctly.
* incomplete payments do not incorrectly mark sale as paid.
* completed payment transitions sale appropriately.
* sale can be completed exactly once.
* inventory is deducted exactly once.
* stock movements are persisted.
* audit information is persisted.
* seller can observe updated state.
* admin can observe relevant resulting information.
* critical automated tests pass.
* build/lint/type checks pass according to configured applications.
* demo seed/reset is reproducible.
* no production secrets are committed.

---

# Superpowers Workflow

Superpowers skills are available through OpenCode.

For Mona Jacinta migration, prefer:

```text
brainstorming
↓
architecture decision
↓
writing-plans
↓
plan review
↓
executing-plans
↓
tests
↓
code review
↓
verification-before-completion
```

Use `brainstorming` before making material architectural choices.

Use `writing-plans` only after architecture direction has been sufficiently resolved.

Use `executing-plans` against an approved plan.

Use `test-driven-development` for important domain and transactional behavior where practical.

Use `systematic-debugging` when failures occur instead of speculative fixes.

Use `requesting-code-review` / `receiving-code-review` for major milestones where appropriate.

Use `verification-before-completion` before claiming a phase or Demo V2 is complete.

---

# Agent Behavioral Rules

When working on this repository:

* inspect before modifying;
* distinguish legacy behavior from target architecture;
* do not assume current file placement is intentional target architecture;
* do not silently expand scope;
* do not silently change architecture;
* do not expose secrets;
* do not remove existing code without understanding it;
* do not claim tests passed unless they were actually run;
* do not claim builds pass unless they were actually run;
* do not claim migrations succeeded without verifying persisted state;
* state blockers clearly;
* prefer root-cause fixes over patches;
* prefer simple architecture suitable for the current business scale;
* avoid premature microservices or infrastructure complexity.

If a material implementation decision is not covered by the architecture or plan, stop that portion of implementation and surface the decision instead of inventing a new architecture silently.

---

# Conventions

* UI-facing language: Spanish.
* Code identifiers: English.
* Plans and architecture documentation may be Spanish or English but must remain internally consistent.
* Mona Jacinta is the target project identity.
* "Babymart" and "L&V tienda" are legacy names only.
* `docs/architecture/` stores architectural decisions/specifications.
* `docs/plans/` stores implementation plans.
* `.opencode/skills/` may contain project-specific reusable skills later.
* `.opencode/agents/` may contain project-specific specialized agents later.
* Do not create project-specific skills merely to duplicate Superpowers functionality.

---

# Current Priority

The current priority is not full system implementation.

The current priority is:

```text
understand current repository
↓
secure/configure repository
↓
design Demo V2 architecture
↓
write migration/implementation plan
↓
review plan
↓
execute incrementally
↓
produce a reliable multi-browser demonstration
```

The most important Demo V2 proof is:

```text
SELLER
creates sale
↓
sends to cashier
↓
CASHIER
receives same persisted sale
↓
registers split payment
↓
completes sale
↓
PostgreSQL
updates inventory and audit state
↓
SELLER / ADMIN
observe the result
```

That vertical flow has priority over implementing every future Mona Jacinta module.
