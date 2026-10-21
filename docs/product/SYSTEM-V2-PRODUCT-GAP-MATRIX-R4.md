# SYSTEM V2 PRODUCT GAP MATRIX — R4

```
MATRIX_REVISION=R4
DATE=2026-10-21
BASE_BRANCH=integration/system-v2
BASE_HEAD=403efe9c1c14c0a04a2757d1206f6ed886116640
SOURCE_TECHNICAL=código en BASE_HEAD
SOURCE_FUNCTIONAL=matriz R1/R2/R3 (chat de trabajo) + decisiones OWNER R4 cerradas
```

Este documento es la versión canónica y completa de la matriz. Reemplaza al delta
informal de R4. Cada fila de la sección 4 es un dominio activo; los conteos de la sección 1
se calculan a partir de esas filas (verificación en la sección 2).

Alcance: documento de producto. No modifica `docs/production-v1/*`.

Convención de las filas: `ID · DOMAIN · STATUS · PRIORITY`, más CURRENT, TARGET, GAP,
BUSINESS_RISK, TECHNICAL_RISK, DEPENDENCIES, OPEN_SOURCE_PATTERN, DECISION,
ACCEPTANCE_CRITERIA y EVIDENCE. Las rutas son relativas a la raíz del repo. La evidencia de
filas sin cambio respecto de R3 proviene de la pasada de código sobre `403efe9` registrada en
R1/R2; el único punto re-verificado al armar R4 es el rechazo de QR (ver dominio 5).

---

## 1. Resumen y métricas

Se calculan desde las filas de la sección 4.

```
TOTAL_DOMAINS=54

COMPLETE_COUNT=9
PARTIAL_COUNT=23
MISSING_COUNT=20
BROKEN_COUNT=1
LEGACY_COUNT=1

P0_COUNT=9
P1_COUNT=30
P2_COUNT=15
```

Readiness (fórmula R1–R3: COMPLETE = 1, PARTIAL = 0,5, LEGACY = 0,25, MISSING/BROKEN = 0):

```
READINESS_RAW = (9 × 1) + (23 × 0,5) + (1 × 0,25) + (20 × 0) + (1 × 0)
              = 9 + 11,5 + 0,25
              = 20,75 puntos
READINESS_RATIO = 20,75 / 54 = 0,384259…
READINESS_SCORE = 38,43 → 38/100  (redondeo al entero más cercano)
```

Conciliación contra R3 (55 dominios, 10/22/21/1/1, 10 P0 / 29 P1 / 16 P2, score 38,6 → 39):

| Cambio | Efecto |
|---|---|
| 33b retirado (era MISSING · P0) | −1 dominio, −1 MISSING, −1 P0 |
| 7 Pago combinado: COMPLETE · P2 → PARTIAL · P1 | −1 COMPLETE, +1 PARTIAL, −1 P2, +1 P1 |
| Resultado | 54 dominios; 9/23/20/1/1; 9 P0 / 30 P1 / 15 P2 |

Justificación del cambio en 7: R3 lo dejó COMPLETE porque su TARGET era "lo mismo, más QR si el
negocio lo pide". R4 cierra la decisión de producto: QR **entra** en PROPORTIONAL_V1. El código
en `403efe9` lo rechaza, así que el estado actual no cumple el target. Sensibilidad: si se
mantuviera 7 como COMPLETE, el score sería 21,25 / 54 = 39,35 → 39. Se eligió la lectura
estricta porque una fila COMPLETE con un bloqueo de implementación declarado sería incoherente.

Lectura general: el núcleo de un local (venta, checkout proporcional, caja con conciliación,
ajuste de stock, scope) es maduro y está protegido por la DB. Falta la operación de 5 locales
+ depósito (transferencias, recepción), toda reversa posterior al cobro (anulación, cambios),
el dominio de empleados y la capacidad transversal de autorización por PIN.

---

## 2. Validación de conteos

```
PRIORITY: P0 + P1 + P2 = 9 + 30 + 15 = 54 = TOTAL_DOMAINS   → PRIORITY_COUNT_VALID=YES
STATUS:   COMPLETE + PARTIAL + MISSING + BROKEN + LEGACY
          = 9 + 23 + 20 + 1 + 1 = 54 = TOTAL_DOMAINS         → STATUS_COUNT_VALID=YES
```

Distribución por STATUS (IDs):

- COMPLETE (9): 8, 14, 15, 17, 25, 31, 43, 48, 49
- PARTIAL (23): 1, 2, 3, 4, 5, 6, 7, 9, 10, 16, 18, 23, 26, 28, 29, 30, 34, 40, 41, 42, 44, 45, 50
- MISSING (20): 11, 12, 13, 19, 20, 21, 22, 24, 32, 33a, 35, 36, 37, 38, 39, 46, 51, 52, 53, 54
- BROKEN (1): 47
- LEGACY (1): 27

Distribución por PRIORITY (IDs):

- P0 (9): 6, 11, 12, 16, 19, 24, 52, 53, 54
- P1 (30): 1, 2, 3, 4, 5, 7, 9, 10, 13, 18, 20, 23, 26, 27, 28, 29, 30, 32, 33a, 37, 38, 39, 40, 41, 42, 44, 45, 46, 47, 51
- P2 (15): 8, 14, 15, 17, 21, 22, 25, 31, 34, 35, 36, 43, 48, 49, 50

---

## 3. Decisiones OWNER aplicadas y capacidades transversales

### 3.1 Decisiones cerradas que gobiernan R4

- **QR**: habilitado; entra en PROPORTIONAL_V1; porcentaje configurable por ADMIN/OWNER
  (`qrAdjustmentBps`); sin porcentaje hardcodeado.
  `QR_PRODUCT_DECISION=CLOSED` · `QR_IMPLEMENTATION_BLOCKER=YES` (PROPORTIONAL_V1 lo rechaza hoy).
- **FIXED_TOTAL**: deprecado de forma progresiva. No se puede retirar mientras QR no esté
  soportado en PROPORTIONAL_V1.
- **Precio**: `cashPrice` es el precio base efectivo. Ajustes en bps por medio:
  `listAdjustmentBps`, `creditCardAdjustmentBps`, `debitCardAdjustmentBps`,
  `bankTransferAdjustmentBps`, `qrAdjustmentBps`. Solo ADMIN/OWNER los modifican y un cambio
  afecta solo operaciones futuras.
- **Cambio**: plazo inicial de 15 días (ADMIN/OWNER pueden modificar la cantidad de días, con
  auditoría; CASHIER/SELLER no); ticket obligatorio en flujo normal; sin ticket requiere PIN
  ADMIN/OWNER + motivo; siempre vinculado a la venta original; se permite entre sucursales;
  valor reconocido = importe efectivamente pagado por la línea original
  (`EXCHANGE_VALUE_SOURCE=ACTUAL_PAID_AMOUNT`). Nueva prenda más cara: se cobra la diferencia.
  Mismo valor: cambio directo. Más barata: no se devuelve la diferencia y no se crea StoreCredit.
- **Anulación post-cobro**: PIN ADMIN/OWNER + motivo; **sin devolución automática de efectivo**;
  la resolución comercial normal es el cambio de prenda (con cobro de diferencia si la nueva vale
  más); no hay vale general para venta normal.
- **Voucher**: solo Voucher de Seña (dominio 33a). El dominio de vale general 33b ya no tiene
  existencia funcional y se **retira** (ver 3.4).
- **Empleados**: P0; entidad separada de `User`; `employeeCode`; saldo vigente del sistema viejo
  cargado como `OPENING_BALANCE` con fecha de corte explícita, append-only; retiro a `cashPrice`;
  en cualquier sucursal; lo carga CASHIER; aviso a ADMIN/OWNER; pago de deuda CASH/TRANSFER,
  parcial o total; semana de liquidación lunes a sábado; la liquidación puede ser parcial y el
  saldo restante se arrastra; devolución permitida, vinculada al retiro original, repone stock,
  reduce/revierte deuda y no supera lo retirado; límite solo global (inicial $300.000 =
  `30000000n`, configurable por ADMIN/OWNER); sin límite individual por ahora.
- **Branch/Location**: un único modelo canónico, migración expand/contract.
- **Transferencias**: el depósito despacha directo; ADMIN autoriza el despacho; CASHIER de
  destino recibe por línea; las diferencias van a `PENDING_REVIEW`; lo resuelve ADMIN; la alerta
  se mantiene hasta la resolución; sin autocorrección de stock.
- **Seña**: REDESIGN / SELECTIVE PORT sobre System V2; precio/snapshot congelado al activarla;
  120 h exactas; mínimo configurable por ADMIN/OWNER; medios/QR según las reglas del checkout
  correspondiente; el vencimiento no devuelve dinero, no crea crédito ni CashMovement.
- **Compras/proveedores**: parte de la versión completa de System V2
  (Supplier → PurchaseOrder → Receipt/Remito → deuda → pago).
- **ARCA**: integración digital con fallback manual; al finalizar la venta se elige ticket no
  fiscal o factura ARCA.
- **Transferencia PENDING_REVIEW, descuentos, clientes mínimos, gastos caja vs. administración**:
  según R3, sin cambios.

**Decisiones OWNER posteriores a la primera publicación de R4** (sincronizadas en este
documento; en el PRD V2 son OR-006, OR-050 y OR-051):

- **Plazo de cambio:** 15 días como valor inicial; ADMIN/OWNER pueden modificar la cantidad de
  días mediante la configuración comercial, con auditoría; CASHIER y SELLER no pueden (dominios 12 y 40).
- **Caja chica:** detalle o motivo obligatorio; comprobante opcional (dominio 34).
- **Domingo en la cuenta de empleados:** la semana operativa sigue siendo lunes a sábado; un movimiento de cuenta realizado un domingo pertenece al ciclo que comienza el lunes siguiente (dominios 52 y 54).
- **Pago de deuda de empleado:** el importe de un pago o aplicación de deuda no puede superar el saldo pendiente; no se crea saldo acreedor ni crédito (dominio 52).
- **Cantidad reversible:** cantidad vendida − ya devuelta/cambiada − ya repuesta por reversas previas; sin doble reposición de stock ni doble reconocimiento de valor; con cantidad reversible cero se rechaza (dominios 11 y 12).
- **Ajustes grandes de stock:** un ajuste común usa el permiso operativo normal; un ajuste cuyo
  impacto supera el umbral configurado exige autorización supervisada ADMIN/OWNER, motivo y
  auditoría. El umbral lo configura ADMIN/OWNER y su valor inicial es **TBD** (no se inventa un
  importe); hasta que se defina e implemente, los ajustes operan como hoy (dominio 17).

### 3.2 Capacidad transversal: autorización por PIN ADMIN/OWNER

Es una capacidad compartida, no un dominio nuevo. Lo que la matriz exige de ella:

- La autorización la otorga un usuario ADMIN u OWNER, en la caja del local donde ocurre la operación.
- El autorizador queda **identificado** en el registro de la operación (no solo "se autorizó").
- Se exige **motivo** cuando la operación lo requiere (anulación, cambio sin ticket, descuento).
- Cada autorización genera **AuditLog** en la misma transacción que la operación.
- Cada autorización genera **notificación/visibilidad** en el sistema (bandeja de alertas ADMIN/OWNER, dominio 28).
- No se define aquí la criptografía, el almacenamiento ni el protocolo del PIN: son diseño del Blueprint.

Consumidores en esta matriz: 11 Anulación, 12 Cambios (sin ticket o fuera de plazo), 13 Descuentos, 17 Ajustes de stock sobre el umbral, 19
Transferencias (autorización de despacho), 32/33a Seña (voucher), 40 Configuración.
`AUTHORIZATION_MECHANISM=PIN_ADMIN_OWNER`.

### 3.3 Decisiones que se declaran descartadas

- StoreCredit / gift card / vale comercial general (antiguo 33b): descartado. No aplica a
  cambios (la diferencia a favor del cliente no se devuelve ni se acredita), ni a anulaciones
  (no hay reintegro automático), ni a gift cards. Reabrir solo por decisión OWNER futura.
- `GENERAL_SALE_VOUCHER_REQUIRED=NO`.
- Voucher de Seña usable para pagar otra Seña: no (solo venta normal), según R3.

### 3.4 Nota sobre 33b

El dominio R3 "33b Vale de anulación post-cobro" (MISSING · P0) existía porque R3 interpretó
que la anulación entregaba un vale. La decisión R4 elimina ese instrumento. No se deja una fila
fantasma: **33b no se cuenta como dominio activo**. La necesidad que cubría (resolver
comercialmente una anulación) pasa al dominio 11 (operación de cambio/reversa) y al 12.

---

## 4. Matriz de dominios

### Venta y precios

#### 1 · Catálogo · PARTIAL · P1
- CURRENT: Product/Category/Brand. Solo alta de producto (`POST /products`) y lecturas; sin edición ni baja de producto ni ABM de categoría/marca.
- TARGET: ABM completo con baja lógica, edición auditada y categorías/marcas gestionables desde el admin.
- GAP: editar y desactivar producto; ABM de categoría y marca; UI de admin.
- BUSINESS_RISK: catálogo congelado; los errores de carga requieren al equipo técnico.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: 29.
- OPEN_SOURCE_PATTERN: Odoo `product.template` (archivar en vez de borrar).
- DECISION: ADOPT (baja lógica).
- ACCEPTANCE_CRITERIA: editar y desactivar con auditoría; un producto inactivo no se puede vender.
- EVIDENCE: `api/src/modules/products/products.routes.ts`, `catalog-admin.service.ts`.

#### 2 · Variantes · PARTIAL · P1
- CURRENT: `sku` y `barcode` únicos; `color`/`size` son texto libre (`trim().max()`); solo alta y cambio de precio.
- TARGET: talle y color normalizados por atributo; unicidad (producto, color, talle); edición y baja de variante.
- GAP: normalización, índice único semántico, editar y desactivar.
- BUSINESS_RISK: variantes duplicadas ("Rojo" vs "rojo ") reparten stock y ensucian reportes.
- TECHNICAL_RISK: medio (la migración debe detectar duplicados existentes).
- DEPENDENCIES: 1; importador.
- OPEN_SOURCE_PATTERN: Odoo `product.attribute`/`attribute.value`, ERPNext Item Attribute.
- DECISION: ADAPT (dos atributos fijos, no un motor genérico).
- ACCEPTANCE_CRITERIA: no se pueden crear dos variantes con la misma terna normalizada; el importador rechaza duplicados.
- EVIDENCE: `api/prisma/schema.prisma` (ProductVariant), `api/src/modules/products/dto/variant.dto.ts`.

#### 3 · Pricing · PARTIAL · P1
- CURRENT: `cashPrice` es la base minorista (falla cerrado si es NULL); `price` es el LIST legacy transitorio; `wholesalePrice` es la base mayorista; `costPrice` se guarda sin uso; `CompanyPricingConfig` guarda los cinco `*AdjustmentBps` (incluido `qrAdjustmentBps`, default 0); `PATCH /api/v1/pricing/config` exige `PRICE_MANAGE` y audita `COMPANY_PRICING_CONFIG_CHANGED`; la venta guarda snapshot del ajuste.
- TARGET: `cashPrice` como base efectiva única + recargos en bps por medio, editables solo por ADMIN/OWNER, con efecto solo sobre operaciones futuras; retirar `price` legacy; el precio de retiro de empleado es `cashPrice`.
- GAP: retirar la columna `price`; uso de `costPrice` para margen; historial de precios consultable (hoy solo en AuditLog); incorporar futuros medios a la configuración.
- BUSINESS_RISK: dos columnas de precio pueden divergir.
- TECHNICAL_RISK: medio (expand/contract).
- DEPENDENCIES: 5, 30.
- OPEN_SOURCE_PATTERN: Odoo pricelists (solo como referencia).
- DECISION: ADOPT "un precio base + reglas por medio"; DISCARD de pricelists genéricas.
- ACCEPTANCE_CRITERIA: ninguna lectura de venta usa `price`; existe reporte de margen; cambiar un bps no altera ventas ya cerradas.
- EVIDENCE: `api/src/modules/pricing/pricing.ts`, `pricing.service.ts`; `api/prisma/schema.prisma:178-182`; `api/src/modules/sales/wholesale-authorization.service.ts:68-76`; `api/src/config/env.ts`.

#### 4 · Ciclo de vida de la venta · PARTIAL · P1
- CURRENT: DRAFT → PENDING_PAYMENT → PAID → COMPLETED; al completar se descuenta físico, se consume la reserva y se escribe StockMovement SALE con auditoría; hay cancelación antes del pago y corrección de venta pendiente.
- TARGET: estados/transiciones posteriores al cobro (anulada, con cambio asociado) con vínculo a la operación original; la venta original nunca se edita ni se borra.
- GAP: no existe ningún estado posterior a PAID/COMPLETED.
- BUSINESS_RISK: los errores posteriores al cobro se arreglan fuera del sistema.
- TECHNICAL_RISK: medio (CHECKs y triggers de pago existentes).
- DEPENDENCIES: 11, 12, 16.
- OPEN_SOURCE_PATTERN: Odoo `pos.order` (estado + refund).
- DECISION: ADAPT.
- ACCEPTANCE_CRITERIA: toda venta tiene un estado final trazable que incluye su reversa o cambio.
- EVIDENCE: `api/src/modules/sales/sales.service.ts`, `sale-finalization.ts:96-189`, `cancellation.service.ts:105-145`, `pending-correction.service.ts`.

#### 5 · Checkout · PARTIAL · P1
- CURRENT: conviven `FIXED_TOTAL` (`POST /sales/:id/payments`, legacy) y `PROPORTIONAL_V1` (quote → reserva de intento → cierre → recuperación de stock, ledger `CheckoutAttempt` con triggers F1-F5). El modelo se elige al crear la venta según `PROPORTIONAL_CHECKOUT_LOCATION_IDS` (env). **PROPORTIONAL_V1 rechaza QR** (`api/src/modules/payments/dto/checkout-fields.ts:44`: "accepts CASH, TRANSFER, CARD_DEBIT and CARD_CREDIT; QR is refused").
- TARGET: PROPORTIONAL_V1 en todos los locales, con QR soportado y `qrAdjustmentBps` configurable; FIXED_TOTAL deprecado de forma progresiva; Voucher de Seña como medio de pago de uso único (33a).
- GAP: soportar QR en proporcional; sacar la selección por local del env; plan de desactivación de FIXED_TOTAL por local, que **no puede ejecutarse antes de resolver QR**.
- BUSINESS_RISK: dos reglas de cobro según el local; sin QR en proporcional, retirar FIXED_TOTAL deja a QR sin camino de cobro.
- TECHNICAL_RISK: medio-alto (QR toca quote, snapshot, allocations y ExternalCollection).
- DEPENDENCIES: 6, 7, 3, 31, 33a, 40.
- OPEN_SOURCE_PATTERN: ninguno equivalente; el modelo propio es superior.
- DECISION: ADAPT (mantener el diseño propio y extenderlo).
- ACCEPTANCE_CRITERIA: un cobro QR en proporcional queda en ExternalCollection con referencia única y snapshot del bps vigente; ningún local nuevo usa FIXED_TOTAL; el porcentaje de QR no está hardcodeado.
- EVIDENCE: `api/src/modules/payments/checkout*.ts`, `payments.service.ts:95`, `sales.service.ts:181-183`, `api/src/modules/payments/dto/checkout-fields.ts:44`, `api/prisma/schema.prisma:182`.
- QR: `PRODUCT_DECISION=CLOSED` · `IMPLEMENTATION_BLOCKER=YES`.

#### 6 · Pagos · PARTIAL · P0
- CURRENT: en FIXED_TOTAL el DTO acepta `CASH|TRANSFER|CARD_DEBIT|CARD_CREDIT|QR` sin referencia, institución ni comprobante para los medios no efectivo; solo el efectivo genera CashMovement. El camino proporcional sí exige ExternalCollection con referencia única por sucursal.
- TARGET: todo cobro no efectivo deja referencia verificable y conciliable; el camino definitivo es PROPORTIONAL_V1 en todos los locales (incluido QR).
- GAP: mientras FIXED_TOTAL siga vivo, referencia obligatoria (o limitarlo a CASH); migrar todos los locales a proporcional.
- BUSINESS_RISK: se puede marcar PAID una venta con una transferencia o QR inexistente. Pérdida de dinero no detectable al cierre; es el único P0 que pierde plata hoy.
- TECHNICAL_RISK: bajo (DTO + guard).
- DEPENDENCIES: 5.
- OPEN_SOURCE_PATTERN: ERPNext Mode of Payment con referencia obligatoria.
- DECISION: ADOPT.
- ACCEPTANCE_CRITERIA: ninguna SalePayment no efectivo sin referencia; test que rechaza QR/TRANSFER sin referencia en FIXED_TOTAL.
- EVIDENCE: `api/src/modules/payments/dto/payment.dto.ts:13-45`, `payments.service.ts:120-170`.

#### 7 · Pago combinado · PARTIAL · P1
- CURRENT: 1 a 3 medios con roles FIXED/BALANCE, distribución exacta por línea (`SaleLineAllocation`), vuelto solo en efectivo. QR excluido a propósito.
- TARGET: lo mismo, con QR como medio soportado (decisión OWNER R4) bajo las reglas de checkout.
- GAP: QR dentro del pago combinado proporcional.
- BUSINESS_RISK: bajo, salvo por el bloqueo de FIXED_TOTAL (ver 5).
- TECHNICAL_RISK: medio (allocations por línea con un tender más).
- DEPENDENCIES: 5.
- OPEN_SOURCE_PATTERN: OSPOS split payments.
- DECISION: ADAPT (el actual es superior; solo se suma QR).
- ACCEPTANCE_CRITERIA: las suites PG del checkout siguen verdes; un combinado con QR distribuye exacto por línea.
- EVIDENCE: `api/src/modules/payments/dto/checkout.dto.ts:37-160`, schema `SaleLineAllocation`, `CheckoutAttemptTender`.

#### 13 · Descuentos · MISSING · P1
- CURRENT: `discountTotal` existe pero siempre vale `0n`.
- TARGET: CASHIER y SELLER no autorizan. Todo descuento manual requiere autorización ADMIN/OWNER por PIN y motivo, con AuditLog y visibilidad para el OWNER. Sin topes por rol (ningún rol operativo descuenta); sin motor de promociones.
- GAP: todo, incluida su interacción con el checkout proporcional y las allocations.
- BUSINESS_RISK: los descuentos informales en caja no quedan registrados.
- TECHNICAL_RISK: medio.
- DEPENDENCIES: 3, 5, 28, 29, autorización PIN (3.2).
- OPEN_SOURCE_PATTERN: Saleor/Medusa discount rules.
- DECISION: ADAPT (solo manual).
- ACCEPTANCE_CRITERIA: un descuento sin autorización ADMIN/OWNER y motivo es rechazado; todo descuento tiene autorizador identificado y AuditLog.
- EVIDENCE: `api/prisma/schema.prisma` (Sale.discountTotal); `sales.service.ts:79,188`; `pending-correction.service.ts:238`.

#### 46 · Clientes · MISSING · P1
- CURRENT: no hay modelo Customer.
- TARGET: cliente mínimo con nombre y apellido + teléfono obligatorios; DNI, email y CUIT opcionales.
- GAP: todo.
- BUSINESS_RISK: la Seña y el ticket/factura no tienen titular.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: —
- OPEN_SOURCE_PATTERN: OSPOS customers.
- DECISION: ADAPT (mínimo).
- ACCEPTANCE_CRITERIA: una Seña exige cliente.
- EVIDENCE: schema (ausencia).

#### 48 · Mayorista · COMPLETE · P2
- CURRENT: autorización con hash del código, confirmación del cajero, columnas congeladas por trigger tras el pago y CHECKs en DB.
- TARGET: lo mismo.
- GAP: —
- BUSINESS_RISK: bajo.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: —
- OPEN_SOURCE_PATTERN: —
- DECISION: DISCARD (mantener).
- ACCEPTANCE_CRITERIA: los tests existentes siguen verdes.
- EVIDENCE: `api/src/modules/sales/wholesale-authorization.service.ts`, migración `20261002120000` (triggers).

#### 49 · Corrección de venta pendiente · COMPLETE · P2
- CURRENT: `SALE_CORRECT_PENDING` reemplaza la lista de ítems de una venta PENDING_PAYMENT con reservas y auditoría.
- TARGET: lo mismo.
- GAP: —
- BUSINESS_RISK: bajo.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: —
- OPEN_SOURCE_PATTERN: —
- DECISION: DISCARD (mantener).
- ACCEPTANCE_CRITERIA: los tests existentes siguen verdes.
- EVIDENCE: `api/src/modules/sales/pending-correction.service.ts`.

### Reversas, cambios y Seña

#### 11 · Anulación post-cobro · MISSING · P0
- CURRENT: no existe. `cancellation.service.ts:127` devuelve 409 `PAYMENT_ALREADY_ACCEPTED` y `:129` solo acepta DRAFT y PENDING_PAYMENT.
- TARGET: una venta PAID/COMPLETED se anula solo con autorización ADMIN/OWNER por PIN y motivo obligatorio. Es una **reversa vinculada** a la venta original (nunca se edita ni se borra), que revierte el stock. Solo se revierte lo reversible: cantidad vendida − ya devuelta/cambiada − ya repuesta por reversas previas; nunca se repone stock dos veces y, si no queda cantidad reversible, se rechaza. **No hay devolución automática de efectivo** ni StoreCredit general. La resolución comercial normal es el cambio de prenda (dominio 12) y, si la nueva prenda vale más, se cobra la diferencia. Registra autorizador, AuditLog y notificación/visibilidad.
- GAP: todo.
- BUSINESS_RISK: errores de cobro corregidos fuera del sistema, con caja y stock que no cierran.
- TECHNICAL_RISK: alto (triggers de pago, ledger de checkout, conciliación de caja).
- DEPENDENCIES: 16, 12, 29, 28, autorización PIN (3.2).
- OPEN_SOURCE_PATTERN: Odoo POS refund (orden negativa vinculada); ERPNext Sales Return contra el original.
- DECISION: ADAPT (documento de reversa vinculado; descartar el reintegro automático y el vale).
- ACCEPTANCE_CRITERIA: la anulación es imposible sin autorización ADMIN/OWNER y motivo; stock y auditoría consistentes en una sola transacción; no se escribe CashMovement de reintegro automático; el autorizador queda identificado.
- EVIDENCE: `api/src/modules/sales/cancellation.service.ts:105-145`, `dto/*` (CANCELLATION_REASONS).

#### 12 · Cambios · MISSING · P0
- CURRENT: no existe. `EXCHANGE_MANAGE` está declarado y otorgado a CASHIER sin implementación (`api/src/modules/rbac/permissions.ts:44`, `role-permission-matrix.ts:47`).
- TARGET: cambio vinculado siempre a la venta original encontrada en el sistema. Plazo inicial de 15 días, modificable por ADMIN/OWNER (dominio 40). Con ticket lo procesa CASHIER; sin ticket exige PIN ADMIN/OWNER + motivo. Se permite en otra sucursal. Valor reconocido = importe efectivamente pagado por la línea original (`ACTUAL_PAID_AMOUNT`). Nueva prenda más cara: se cobra la diferencia (checkout proporcional); igual valor: cambio directo; más barata: no se devuelve la diferencia y no se crea StoreCredit. Prenda nueva: `cashPrice` es la base y el precio final lo calcula PROPORTIONAL_V1 según los medios usados para pagar la diferencia (no siempre `cashPrice`). El valor reconocido es un aporte interno no monetario: sin CashMovement, sin crédito reutilizable y sin retiro como efectivo.
- GAP: todo.
- BUSINESS_RISK: en ropa los cambios son diarios; hoy obligan a ajustes manuales y caja informal.
- TECHNICAL_RISK: alto (valor pagado por línea con pago mixto, stock de dos líneas, cobro de diferencia, multi-sucursal).
- DEPENDENCIES: 11, 16, 5, 38 (ticket identifica la venta), 27, 40 (plazo configurable), autorización PIN (3.2).
- OPEN_SOURCE_PATTERN: Medusa Exchange/Swap (vinculado a la orden original, con diferencia); Saleor returns.
- DECISION: ADAPT.
- ACCEPTANCE_CRITERIA: un cambio referencia venta y líneas originales; no se devuelve más de lo reversible (vendido − ya devuelto/cambiado − ya repuesto) ni se reconoce dos veces el valor de una línea; fuera del plazo vigente (inicialmente 15 días) o sin ticket exige autorización; el cambio de plazo solo lo hace ADMIN/OWNER y queda auditado; la diferencia a favor del local se cobra con medio trazable; no se genera crédito ni reintegro por diferencia a favor del cliente.
- EVIDENCE: `api/src/modules/rbac/permissions.ts:44`, `role-permission-matrix.ts:47`.

#### 32 · Seña · MISSING · P1
- CURRENT CANONICAL: solo permisos `SENA_CREATE/MANAGE/SETTLE`; ningún modelo, ruta ni servicio. El WIP histórico (`feat/sena-five-day-expiry`, sin commitear, sobre `3d7318e`) **no cuenta como implementación**; su migración `20261021130000_sena_deposit` choca en timestamp con `20261021130000_warehouse_stock_adjustment`.
- TARGET: **REDESIGN / SELECTIVE PORT** sobre System V2. 120 h exactas desde la activación; ACTIVE bloquea stock; liberación única e idempotente al vencer; precio/snapshot congelado al activarla; monto mínimo configurable por ADMIN/OWNER; medios y QR según las reglas del checkout correspondiente; el vencimiento no devuelve dinero, no genera crédito ni CashMovement; la cancelación manual no reintegra; la venta normal sigue sin TTL. Cierre exitoso: con la Seña ACTIVE y dentro de las 120 h, el cliente aplica el anticipo exclusivamente a esa operación (no es crédito general, ni voucher, ni reutilizable) y paga el saldo calculado por PROPORTIONAL_V1 según los medios elegidos; si el total final supera el anticipo, paga la diferencia (sin devolución de efectivo); se consume el stock reservado y la Seña queda COMPLETED.
- GAP: todo el dominio canónico; la migración del WIP desaparece con el rediseño.
- BUSINESS_RISK: señas en papel; riesgo de doble liberación o reintegros informales.
- TECHNICAL_RISK: medio (vencimiento concurrente; bloqueo de stock separado de las reservas de venta).
- DEPENDENCIES: 16, 15, 47, 29, 46, 33a, 40, 5.
- OPEN_SOURCE_PATTERN: OSPOS layaway.
- DECISION: ADAPT (REDESIGN / SELECTIVE PORT; las reglas OWNER mandan).
- ACCEPTANCE_CRITERIA: liberación única al vencer, probada en PG con concurrencia; el snapshot de precio no cambia si cambia el catálogo; el vencimiento no escribe CashMovement ni crédito; el mínimo es configuración auditada.
- EVIDENCE: `api/src/modules/rbac/permissions.ts:17,47-48`; ausencia en el schema canónico; `git status` del worktree card-credit (WIP).

#### 33a · Voucher de Seña · MISSING · P1
- CURRENT: no existe.
- TARGET: único vale existente. No se genera automáticamente: requiere operación separada con autorización ADMIN. Monto = total aceptado de los SenaPayment. Un voucher por Seña (unicidad en DB). Misma sucursal. Uso completo en una sola compra, sin vuelto. La compra debe ser ≥ al valor del vale; si es mayor, se paga la diferencia con medio trazable. **Solo sirve para una venta normal, no para otra Seña.** Sin vencimiento. Emitirlo o usarlo no genera CashMovement. Solo se emite a partir de una Seña cancelada manualmente y con autorización de ADMIN; el vencimiento de la Seña no habilita un Voucher.
- GAP: todo; integrarlo en el checkout como tender de uso único.
- BUSINESS_RISK: vales en papel; doble uso.
- TECHNICAL_RISK: medio (medio de pago nuevo en proporcional y en la conciliación de caja, que debe excluir su valor).
- DEPENDENCIES: 32, 5, 9, 10, 29, 46.
- OPEN_SOURCE_PATTERN: gift cards de Saleor/OSPOS solo como referencia de "medio de pago de uso único".
- DECISION: ADAPT parcial; DISCARD de reglas genéricas (saldo parcial, vencimiento, recarga).
- ACCEPTANCE_CRITERIA: un segundo voucher para la misma Seña es rechazado por la DB; uso en otra sucursal, uso parcial, compra menor al vale o uso para pagar una Seña son rechazados; la caja concilia sin movimiento por el vale.
- EVIDENCE: ausencia.

### Caja

#### 8 · Caja / CashSession · COMPLETE · P2
- CURRENT: apertura/cierre, una sola sesión abierta por caja (índice parcial), lock de sesión compartido con el cobro en efectivo, historial.
- TARGET: lo mismo; reapertura supervisada es opcional.
- GAP: reapertura supervisada (no existe).
- BUSINESS_RISK: bajo.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: —
- OPEN_SOURCE_PATTERN: Odoo POS session.
- DECISION: DISCARD (mantener).
- ACCEPTANCE_CRITERIA: las suites de caja siguen verdes.
- EVIDENCE: `api/src/modules/cash/cash.service.ts:262-370`, `cash.routes.ts`.

#### 9 · CashMovement · PARTIAL · P1
- CURRENT: retiros (solo supervisor), gastos y sus reversas, idempotentes, auditados y validados contra el efectivo proyectado. `MANUAL` existe en el enum desde `init`; nadie puede crearlo por API, pero **no hay CHECK en DB que lo prohíba** y una fila MANUAL bloquea el cierre (409 `CASH_RECONCILIATION_INCONSISTENT`) sin salida en el sistema.
- TARGET: prohibir MANUAL en DB con camino de remediación supervisado; ingreso manual auditado (refuerzo de cambio); tipo nuevo para el pago directo CASH de deuda de empleado (52), aceptado por la conciliación.
- GAP: CHECK que prohíba MANUAL; tipo de ingreso; tipo de pago de empleado; remediación. Sube a P0 si PILOT tiene filas MANUAL (consulta de solo lectura pendiente, no realizada).
- BUSINESS_RISK: una sesión puede quedar bloqueada para siempre.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: 8, 51.
- OPEN_SOURCE_PATTERN: Odoo cash in/out.
- DECISION: ADOPT.
- ACCEPTANCE_CRITERIA: insertar MANUAL falla en DB; existe un ingreso auditado; la conciliación acepta el tipo de pago de empleado.
- EVIDENCE: `api/src/modules/cash/cash.service.ts:86,100-162,174-204,426-473`, `cash.dto.ts:12`, `api/tests/cash/cash-close-reconciliation.behavior.test.ts` (A09/A05b), `api/tests/cash/cash-movement.pg.test.ts` (PG-CM-17).

#### 10 · Cierre / arqueo · PARTIAL · P1
- CURRENT: `expectedCash`, `countedCash` y `difference` materializados al cerrar, con conciliación 1:1 entre pagos en efectivo y SALE_INCOME.
- TARGET: totales por medio de pago no efectivo (incluido QR), reporte de cierre imprimible, aprobación de diferencias grandes, arqueo por denominación opcional.
- GAP: conciliación de medios no efectivo, reporte de cierre, umbral de diferencia.
- BUSINESS_RISK: las diferencias de tarjeta, transferencia o QR no se detectan al cierre.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: 6, 38.
- OPEN_SOURCE_PATTERN: ERPNext POS Closing Entry.
- DECISION: ADOPT.
- ACCEPTANCE_CRITERIA: el cierre muestra esperado vs. declarado por medio.
- EVIDENCE: `api/src/modules/cash/cash.service.ts:326-369`, schema CashSession.

#### 34 · Gastos · PARTIAL · P2
- CURRENT: EXPENSE solo en efectivo, con motivo libre.
- TARGET: `EXPENSE` en caja es caja chica con detalle obligatorio; los gastos administrativos (alquiler, proveedores, servicios, generales) van fuera de CashSession salvo que el dinero salga realmente de esa caja.
- GAP: categorías, comprobante, separación caja chica / administrativos.
- BUSINESS_RISK: análisis de gastos pobre.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: 9.
- OPEN_SOURCE_PATTERN: Akaunting expense categories.
- DECISION: ADAPT.
- ACCEPTANCE_CRITERIA: todo gasto tiene categoría y detalle.
- EVIDENCE: `api/src/modules/cash/cash.service.ts:386-473`.

#### 35 · Tesorería · MISSING · P2
- CURRENT: un retiro saca efectivo de la caja pero no registra el destino.
- TARGET: destino de los retiros (caja fuerte o banco) y conciliación de depósitos.
- GAP: todo.
- BUSINESS_RISK: el dinero que sale de la caja pierde trazabilidad.
- TECHNICAL_RISK: medio.
- DEPENDENCIES: 9.
- OPEN_SOURCE_PATTERN: Akaunting accounts/transfers.
- DECISION: ADAPT.
- ACCEPTANCE_CRITERIA: todo retiro tiene destino.
- EVIDENCE: schema CashMovement.

#### 36 · Contabilidad operativa · MISSING · P2
- CURRENT: no hay asientos ni exportación; los movimientos financieros están repartidos entre CashMovement, SalePayment y ExternalCollection.
- TARGET: capa administrativo-financiera operativa, sin ser un ERP contable: export unificado por período y sucursal de los ledgers (caja, gastos, compras/proveedores, cuenta corriente de empleados, liquidaciones), sin doble partida.
- GAP: definir y construir el export unificado.
- BUSINESS_RISK: el contador recibe información incompleta (la deuda de empleados no aparece en ningún lado).
- TECHNICAL_RISK: bajo/medio.
- DEPENDENCIES: 30, 34, 35, 52, 54, 47, 21, 22.
- OPEN_SOURCE_PATTERN: Akaunting; "party ledger" de ERPNext.
- DECISION: ADAPT ideas de ledger por contraparte + export; DISCARD plan de cuentas y doble partida.
- ACCEPTANCE_CRITERIA: el export de un período cuadra con los cierres de caja y con los saldos derivados de las cuentas de empleados.
- EVIDENCE: schema (CashMovement, SalePayment, ExternalCollection; ausencia del resto).

### Stock y depósito

#### 14 · Inventario · COMPLETE · P2
- CURRENT: `Inventory(physical, reserved)` por variante y sucursal; disponible = físico − reservado; carga inicial por import.
- TARGET: lo mismo; conteo cíclico más adelante.
- GAP: conteo físico periódico.
- BUSINESS_RISK: bajo.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: 16.
- OPEN_SOURCE_PATTERN: InvenTree stocktake.
- DECISION: ADAPT (más adelante).
- ACCEPTANCE_CRITERIA: los tests existentes siguen verdes.
- EVIDENCE: `api/src/modules/inventory/inventory.service.ts`, `initial-stock.service.ts`.

#### 15 · Reservas · COMPLETE · P2
- CURRENT: hold al enviar a caja, consumido al completar, liberado al cancelar. `NORMAL_SALE_HOLD_EXPIRES_BY_CLOCK=false`; sweeper y `release-expired` quedan dormidos (lógica de vencimiento LEGACY).
- TARGET: lo mismo, con el código dormido eliminado; la Seña usa su propio bloqueo.
- GAP: limpieza de deuda.
- BUSINESS_RISK: bajo.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: 32.
- OPEN_SOURCE_PATTERN: —
- DECISION: DISCARD.
- ACCEPTANCE_CRITERIA: no queda código muerto de vencimiento.
- EVIDENCE: `api/src/modules/sales/reservation-holds.ts`, `reservation-sweeper.ts`, `cancellation.service.ts:161-205`.

#### 16 · StockMovement · PARTIAL · P0
- CURRENT: tipos `SALE | INITIAL_STOCK | ADJUSTMENT`; idempotencia `(userId, idempotencyKey)`; sin triggers que lo hagan append-only.
- TARGET: ledger inmutable con tipos para retiro y devolución de empleado (`EMPLOYEE_WITHDRAWAL`/`EMPLOYEE_RETURN`), reversa por anulación, cambio, `TRANSFER_OUT/IN`, recepción y compras; cada movimiento referencia su documento de origen.
- GAP: tipos nuevos y trigger de inmutabilidad.
- BUSINESS_RISK: sin estos tipos, reversas, transferencias y retiros no se registran con trazabilidad.
- TECHNICAL_RISK: medio (enum más CHECKs).
- DEPENDENCIES: 51.
- OPEN_SOURCE_PATTERN: Odoo `stock.move`; ERPNext Stock Ledger Entry.
- DECISION: ADOPT.
- ACCEPTANCE_CRITERIA: UPDATE/DELETE de StockMovement falla en DB; cada movimiento referencia su documento.
- EVIDENCE: schema (StockMovementType); lista de triggers de migraciones (ninguno en StockMovement).

#### 17 · Ajustes manuales · COMPLETE · P2
- CURRENT: motivo (`StockAdjustmentReason`), nota, idempotencia, `INVENTORY_MANAGE` en el local, AuditLog y suite PG.
- TARGET: ajuste común → permiso operativo correspondiente. Ajuste cuyo impacto supera el umbral configurado → autorización supervisada ADMIN/OWNER obligatoria, motivo obligatorio y auditoría obligatoria. El umbral es configurable por ADMIN/OWNER y su valor inicial es TBD (no se inventa un importe). La funcionalidad existente sigue operando como hoy hasta que el parámetro se defina e implemente.
- GAP: parámetro de umbral (dominio 40) y regla de autorización supervisada para ajustes sobre el umbral; hoy todo ajuste de quien tiene permiso se aplica sin supervisor.
- BUSINESS_RISK: los ajustes pueden tapar robos; sin umbral, un ajuste grande no exige supervisión.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: 16, 29, 40 (umbral configurable), autorización PIN (3.2).
- OPEN_SOURCE_PATTERN: InvenTree adjustments.
- DECISION: ADAPT.
- ACCEPTANCE_CRITERIA: un ajuste común no exige autorización adicional; un ajuste sobre el umbral es imposible sin autorización ADMIN/OWNER y motivo, y su auditoría registra al autorizador; el umbral solo lo modifican ADMIN/OWNER, con auditoría; mientras el umbral no esté definido, los ajustes se comportan como hoy.
- EVIDENCE: `api/src/modules/inventory/inventory-adjustment.service.ts`, `api/tests/inventory/inventory-adjustment.pg.test.ts`.

#### 18 · Warehouse · PARTIAL · P1
- CURRENT: Depósito Workspace (listado de stock y ajustes). CENTRAL_WAREHOUSE se deduce del código `'DEP'`.
- TARGET: el depósito como origen de transferencias y despacho directo.
- GAP: ver 19 y 20.
- BUSINESS_RISK: el depósito no puede abastecer a los locales dentro del sistema.
- TECHNICAL_RISK: medio.
- DEPENDENCIES: 16, 27.
- OPEN_SOURCE_PATTERN: GreaterWMS, Odoo warehouse.
- DECISION: ADAPT (sin ubicaciones internas tipo bin).
- ACCEPTANCE_CRITERIA: flujo depósito → local trazable.
- EVIDENCE: `client/src/app/WarehouseWorkspace.tsx`, `api/src/modules/organization/organization.service.ts:10-18`, `inventory.routes.ts:58-75`.

#### 19 · Transferencias · MISSING · P0
- CURRENT: seis permisos `TRANSFER_*` declarados y otorgados, sin modelo ni rutas.
- TARGET: el depósito despacha directo; ADMIN autoriza el despacho; el stock sale del origen y queda en tránsito; el CASHIER de destino recibe por línea; si lo despachado difiere de lo recibido, la transferencia pasa a `PENDING_REVIEW`; lo resuelve ADMIN; la alerta se mantiene hasta la resolución; no hay corrección automática de stock.
- GAP: todo.
- BUSINESS_RISK: con 5 locales y 1 depósito mover mercadería es diario; hoy solo con ajustes negativo/positivo sin tránsito ni responsable.
- TECHNICAL_RISK: alto.
- DEPENDENCIES: 16, 27, 28, 29, 18, autorización ADMIN.
- OPEN_SOURCE_PATTERN: Odoo `stock.picking` (estados + ubicación de tránsito); ERPNext Stock Entry "Material Transfer".
- DECISION: ADOPT.
- ACCEPTANCE_CRITERIA: el stock en tránsito no está disponible en ningún local; una recepción con diferencia queda en `PENDING_REVIEW` con alerta persistente hasta que ADMIN la resuelve; ningún stock se corrige solo.
- EVIDENCE: `api/src/modules/rbac/permissions.ts:38-43`; uso = 0.

#### 20 · Recepción / remitos · MISSING · P1
- CURRENT: solo carga inicial por import. `GOODS_RECEIPT_MANAGE` sin uso.
- TARGET: recepción contra remito de proveedor (cadena de compras, 21) con control de cantidades. La recepción de transferencias se absorbe en el dominio 19.
- GAP: todo.
- BUSINESS_RISK: el ingreso de mercadería no se controla.
- TECHNICAL_RISK: medio.
- DEPENDENCIES: 16, 22, 21.
- OPEN_SOURCE_PATTERN: ERPNext Purchase Receipt; GreaterWMS ASN.
- DECISION: ADAPT.
- ACCEPTANCE_CRITERIA: un remito recibido genera movimientos de recepción.
- EVIDENCE: `GOODS_RECEIPT_MANAGE` sin uso (permisos).

#### 21 · Compras · MISSING · P2
- CURRENT: no existe.
- TARGET: parte de la versión completa de System V2: Supplier → PurchaseOrder → Receipt/Remito → deuda con el proveedor → pago al proveedor.
- GAP: todo.
- BUSINESS_RISK: medio (sin deuda ni pagos a proveedor controlados).
- TECHNICAL_RISK: medio.
- DEPENDENCIES: 22, 20, 16, 36.
- OPEN_SOURCE_PATTERN: ERPNext Purchase Order / Purchase Invoice / Payment Entry.
- DECISION: ADAPT.
- ACCEPTANCE_CRITERIA: una orden de compra se recibe parcial o totalmente; la recepción genera deuda con el proveedor; el pago la reduce; todo queda auditado.
- EVIDENCE: ausencia.
- NOTA: prioridad P2 = fase posterior al núcleo operativo, **dentro del alcance de la versión completa** (`PURCHASES_IN_FULL_V2=YES`); no es decisión abierta.

#### 22 · Proveedores · MISSING · P2
- CURRENT: no existe. `SUPPLIER_MANAGE` sin uso.
- TARGET: ABM de proveedores y cuenta del proveedor (parte de la cadena de 21).
- GAP: todo.
- BUSINESS_RISK: bajo.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: 29.
- OPEN_SOURCE_PATTERN: ERPNext Supplier.
- DECISION: ADAPT.
- ACCEPTANCE_CRITERIA: ABM auditado.
- EVIDENCE: ausencia.

#### 39 · Etiquetas · MISSING · P1
- CURRENT: no existe. `LABEL_PRINT` sin uso.
- TARGET: impresión de etiquetas con código de barras por variante y en lote al recibir mercadería.
- GAP: todo.
- BUSINESS_RISK: sin etiqueta no hay escaneo confiable en caja.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: 2, 20.
- OPEN_SOURCE_PATTERN: OSPOS barcode labels.
- DECISION: ADOPT.
- ACCEPTANCE_CRITERIA: la etiqueta escaneada resuelve la variante correcta.
- EVIDENCE: ausencia.

### Empleados

#### 24 · Empleados · MISSING · P0
- CURRENT: no existe ninguna entidad empleado; `User` es solo la credencial de login (no hay `Employee` en el schema). El sistema viejo ya los maneja, por lo que su ausencia es una regresión.
- TARGET: `Employee` separado de `User`, con id interno, `employeeCode` único visible para la operación, nombre, `userId` opcional (único si está presente), local de pertenencia opcional y `active`. Puede existir sin login. Búsqueda por `employeeCode` desde caja y depósito. ABM auditado en el admin.
- GAP: modelo, ABM auditado y búsqueda.
- BUSINESS_RISK: sin esta entidad no se imputan retiros ni liquidaciones a una persona.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: 27, 29, 23.
- OPEN_SOURCE_PATTERN: ERPNext Employee (separado de User, con `user_id` opcional).
- DECISION: ADOPT la separación empleado/usuario; DISCARD del módulo de RRHH.
- ACCEPTANCE_CRITERIA: `employeeCode` único en DB; se puede crear un empleado sin usuario; un empleado inactivo es rechazado por todo flujo; alta, baja y edición con AuditLog.
- EVIDENCE: `api/prisma/schema.prisma` (ausencia de Employee; User solo como credencial).

#### 52 · EmployeeAccount (cuenta corriente de empleados) · MISSING · P0
- CURRENT: no existe.
- TARGET: `EmployeeAccount` por empleado **sin campo de saldo**; `EmployeeAccountMovement` append-only en BigInt centavos con signo fijo (deuda positiva) y CHECK por tipo. Tipos: `OPENING_BALANCE`, `MERCHANDISE_WITHDRAWAL`, `RETURN`, `PAYMENT`, `PAYROLL_DEDUCTION`, `REVERSAL`, `ADJUSTMENT`. **`OPENING_BALANCE`**: saldo vigente del sistema viejo, con fecha de corte explícita, append-only, sin reescribir historia previa inexistente en V2. Saldo = suma de movimientos. **Límite global** configurable (inicial `30000000n` = $300.000; dominio 40); sin límite individual. **Pago directo CASH/TRANSFER**, parcial o total: CASH genera un CashMovement de tipo nuevo en la sesión del local; TRANSFER deja referencia verificable (patrón ExternalCollection); ambos generan `PAYMENT`. `REVERSAL` referencia un único original y es único por original. `ADJUSTMENT` exige autorización ADMIN/OWNER y motivo. Un pago o aplicación de deuda no puede superar el saldo pendiente: no existe saldo acreedor del empleado.
- GAP: todo.
- BUSINESS_RISK: deudas de empleados no controladas o perdidas.
- TECHNICAL_RISK: medio (inmutabilidad y signos).
- DEPENDENCIES: 24, 29, 51, 47, 9, 40.
- OPEN_SOURCE_PATTERN: ledger de contraparte de ERPNext; patrón de reversa de CashMovement del propio repo.
- DECISION: ADAPT.
- ACCEPTANCE_CRITERIA: UPDATE/DELETE rechazado en DB; saldo = Σ movimientos en cualquier fecha; una reversa doble es rechazada; todo movimiento tiene origen, autor y motivo; existe exactamente un `OPENING_BALANCE` por empleado con su fecha de corte.
- EVIDENCE: ausencia; patrón de referencia en `api/src/modules/cash/cash.service.ts:486-580` y migración `20261018180000_cash_movement_reversals`.

#### 53 · EmployeeWithdrawal (retiro y devolución de ropa por empleado) · MISSING · P0
- CURRENT: no existe; la única forma de sacar mercadería sin venta es un ajuste manual, que no deja deuda.
- TARGET: operación atómica: identificar empleado activo por `employeeCode` → congelar precio por línea a `cashPrice` (snapshot) → lock de Inventory en orden determinista, exigir disponible (físico − reservado) ≥ cantidad, nunca stock negativo → descontar físico y escribir StockMovement `EMPLOYEE_WITHDRAWAL` → `EmployeeAccountMovement` `MERCHANDISE_WITHDRAWAL` por el total congelado → AuditLog. Puede retirarse en cualquier sucursal. Lo carga CASHIER sin preautorización y se **notifica a ADMIN/OWNER**. Se rechaza si el saldo resultante supera el límite global. Una sola transacción Serializable e idempotente. **Devolución**: permitida, vinculada al retiro original, repone stock (`EMPLOYEE_RETURN`), reduce/revierte la deuda y no puede superar lo originalmente retirado.
- GAP: todo.
- BUSINESS_RISK: mercadería que sale sin registro; deuda sin respaldo de stock.
- TECHNICAL_RISK: alto (stock y dinero en la misma transacción).
- DEPENDENCIES: 16, 24, 52, 3, 29, 27, 28, 40.
- OPEN_SOURCE_PATTERN: picking a contraparte interna de Odoo como idea de "consumo interno"; implementación propia.
- DECISION: ADAPT.
- ACCEPTANCE_CRITERIA: test PG de dos retiros concurrentes sobre el último disponible (gana uno); un replay con la misma clave no duplica; no existe deuda sin StockMovement (verificado en DB); el precio queda congelado aunque cambie el catálogo; una devolución no supera lo retirado; el retiro que excede el límite global es rechazado.
- EVIDENCE: ausencia; patrones en `api/src/modules/inventory/inventory-adjustment.service.ts` (Serializable + idempotencia + auditoría) y `sale-finalization.ts` (lock de inventario y StockMovement).

#### 54 · EmployeeSettlement (liquidación semanal) · MISSING · P0
- CURRENT: no existe.
- TARGET: concepto separado de la cuenta corriente. Semana **lunes a sábado** en zona America/Argentina/Buenos_Aires; un movimiento realizado un domingo pertenece al ciclo que comienza el lunes siguiente. Administración registra el importe a aplicar, que puede ser **parcial** y no superior al saldo pendiente; el resto se arrastra solo porque el saldo es derivado. Cada liquidación guarda empleado, semana, importe, autor, fecha y nota, y genera exactamente un `PAYROLL_DEDUCTION` (negativo) vinculado de forma única. Nunca borra ni sobrescribe movimientos; una corrección es una reversa. No es payroll ni calcula sueldo. Reconstruible: saldo antes, lo descontado, semana, quién, saldo después.
- GAP: todo.
- BUSINESS_RISK: descuentos de sueldo sin trazabilidad; disputas con empleados.
- TECHNICAL_RISK: medio (unicidad por semana y concurrencia con retiros).
- DEPENDENCIES: 52, 24, 47, 29.
- OPEN_SOURCE_PATTERN: deducción contra adelantos en ERPNext (Salary Slip / Employee Advance), solo como idea.
- DECISION: ADAPT la idea; DISCARD nómina y payroll.
- ACCEPTANCE_CRITERIA: un settlement equivale a un `PAYROLL_DEDUCTION`; el historial semanal es reconstruible; corregir genera reversa, no edición; una liquidación parcial deja el resto como saldo arrastrado.
- EVIDENCE: ausencia.

### Usuarios, scope y organización

#### 23 · Usuarios · PARTIAL · P1
- CURRENT: login, `/me` y listado (`/backoffice/users`). No hay alta, baja, reseteo ni edición por API ni admin; los usuarios se crean con seed o scripts.
- TARGET: ABM de usuarios desde el admin con baja lógica y reseteo; vínculo opcional con Employee.
- GAP: todo el ABM.
- BUSINESS_RISK: dar de alta un cajero requiere al equipo técnico.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: 26, 24.
- OPEN_SOURCE_PATTERN: —
- DECISION: ADAPT.
- ACCEPTANCE_CRITERIA: alta y baja auditadas; un usuario inactivo no puede loguear.
- EVIDENCE: `api/src/modules/auth/auth.routes.ts`, `backoffice.routes.ts:43`, `admin/src/lib/api.ts:353-418`.

#### 25 · RBAC · COMPLETE · P2
- CURRENT: 5 roles, 36 permisos, política centralizada, permisos que exigen COMPANY. 14 permisos están declarados y otorgados sin feature (p. ej. CASHIER ya tiene `EXCHANGE_MANAGE`).
- TARGET: que cada permiso otorgado tenga una implementación real; los nuevos (PIN ADMIN/OWNER, retiro de empleado, etc.) entran con su feature.
- GAP: no otorgar permisos fantasma hasta que exista su feature.
- BUSINESS_RISK: la feature se habilitaría sin decisión explícita el día que se implemente.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: —
- OPEN_SOURCE_PATTERN: Casbin.
- DECISION: DISCARD (la política en código es auditable y está testeada; Casbin sería una reescritura).
- ACCEPTANCE_CRITERIA: un test falla si se otorga un permiso sin consumidor.
- EVIDENCE: `api/src/modules/rbac/permissions.ts`, `role-permission-matrix.ts`.

#### 26 · Scope por sucursal · PARTIAL · P1
- CURRENT: backend completo (`UserRoleScope` autoritativo, FOR NO KEY UPDATE, auditoría, regresión PG `79f4db9`). El admin solo lo muestra; no llama a assign/revoke. El scope de Socket.IO se toma al conectar.
- TARGET: UI de asignación en el admin y scope realtime vigente.
- GAP: UI; refresco del scope de socket.
- BUSINESS_RISK: asignar o revocar requiere al equipo técnico; un socket revocado sigue viendo eventos.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: 23.
- OPEN_SOURCE_PATTERN: Casbin "RBAC with domains" (conceptual; ya implementado).
- DECISION: ADAPT solo conceptualmente.
- ACCEPTANCE_CRITERIA: asignar y revocar desde el admin; el socket se desconecta al revocar.
- EVIDENCE: `api/src/modules/backoffice/scope-assignment.service.ts:85`, `api/src/modules/rbac/effective-branch-ids.ts`, `admin/src/pages/Users.tsx`, `api/tests/backoffice/scope-assignment-lock.pg.test.ts`.

#### 27 · Branch / Location · LEGACY · P1
- CURRENT: `Branch` (Demo V2) es el modelo al que apuntan Sale, Inventory, StockMovement, CashRegister, AuditLog, SaleNumberCounter, SaleCheckout y ExternalCollection. `Location` (Production) lo usan UserRoleScope, el tipo de local e `isActive`. La invariante es `Location.id == Branch.id` por convención, **sin FK entre tablas**. Nombre, código, dirección y punto de venta están duplicados. CENTRAL_WAREHOUSE se deduce del código `'DEP'`. No hay API para crear/editar locales.
- TARGET: **modelo canónico único** (sucursal + depósito central) al que apunten todos; migración expand/contract. Las tablas nuevas nacen apuntando al canónico.
- GAP: consolidación expand/contract; toda tabla nueva (Employee, transferencias, movimientos) nace sobre el canónico.
- BUSINESS_RISK: si las dos tablas divergen, la autorización (Location) y los datos (Branch) apuntan a cosas distintas; un local inactivo sigue operando en flujos que no lo verifican.
- TECHNICAL_RISK: alto (toca todas las FKs).
- DEPENDENCIES: requisito de 19, 18, 24, 12.
- OPEN_SOURCE_PATTERN: Odoo `stock.location` / `stock.warehouse` (un solo modelo).
- DECISION: ADOPT (un único modelo).
- ACCEPTANCE_CRITERIA: la DB impide un Branch sin su Location y viceversa durante expand; un local inactivo es rechazado en todos los flujos; el contract elimina la duplicación.
- EVIDENCE: schema (Branch, Location), `api/prisma/migrations/20260907015311_init/migration.sql:415-505`, `api/src/modules/organization/organization.service.ts`, `api/src/modules/inventory/inventory-adjustment.service.ts:146-154`.

#### 28 · Admin · PARTIAL · P1
- CURRENT: dashboard, historial de ventas, alta de producto y variante, precios, configuración de recargos, inventario con carga inicial, cobros externos con refund, sucursales y usuarios (estos dos solo lectura).
- TARGET: consola de administración para catálogo, usuarios y scope, locales, auditoría, reportes y cierres, más una capacidad transversal: **bandeja de alertas y visibilidad ADMIN/OWNER** (transferencias en `PENDING_REVIEW`, retiros de empleados, descuentos, anulaciones, cambios sin ticket, autorizaciones por PIN).
- GAP: edición, usuarios/scope, auditoría, reportes de caja, bandeja de alertas.
- BUSINESS_RISK: la operación diaria depende del equipo técnico.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: 1, 23, 26, 29, 30.
- OPEN_SOURCE_PATTERN: —
- DECISION: ADAPT.
- ACCEPTANCE_CRITERIA: cada API de gestión tiene su UI; una alerta persiste hasta su resolución.
- EVIDENCE: `admin/src/App.tsx:53-64`, `admin/src/lib/api.ts`.

### Auditoría, reportes y comprobantes

#### 29 · AuditLog · PARTIAL · P1
- CURRENT: escritura transaccional en todas las mutaciones relevantes (unas 30 acciones). `GET /audit` con `AUDIT_VIEW`. Sin UI y sin trigger append-only.
- TARGET: inmutable en DB y consultable desde el admin; registra al autorizador de cada operación con PIN.
- GAP: trigger y UI.
- BUSINESS_RISK: la auditoría se puede alterar con acceso a la DB.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: —
- OPEN_SOURCE_PATTERN: —
- DECISION: ADAPT.
- ACCEPTANCE_CRITERIA: UPDATE/DELETE de AuditLog falla en DB.
- EVIDENCE: `api/src/shared/audit.ts`, `api/src/modules/audit/audit.routes.ts`, lista de triggers de migraciones.

#### 30 · Reportes · PARTIAL · P1
- CURRENT: dashboard con 4 KPIs (ventas de hoy, pendientes, facturación de hoy, stock bajo ≤3), listado de ventas e inventario.
- TARGET: ventas por local, medio de pago y vendedor; cierres de caja; margen; valorización de stock; rotación; deuda de empleados.
- GAP: casi todo, más el bug de zona horaria (47).
- BUSINESS_RISK: decisiones a ciegas.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: 47, 3.
- OPEN_SOURCE_PATTERN: ERPNext standard reports.
- DECISION: ADAPT.
- ACCEPTANCE_CRITERIA: reporte diario por local y medio que cuadre con los cierres.
- EVIDENCE: `api/src/modules/backoffice/backoffice.service.ts`.

#### 31 · ExternalCollection · COMPLETE · P2
- CURRENT: transferencia o débito recibido fuera del POS, referencia única por sucursal, flujo APPLIED/UNAPPLIED/REFUNDED con trigger guard y página en el admin; medios externos activos con `PROPORTIONAL_EXTERNAL_METHODS_ENABLED`.
- TARGET: lo mismo; es el patrón de referencia para QR y para el pago de deuda de empleados por transferencia.
- GAP: —
- BUSINESS_RISK: bajo.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: 5.
- OPEN_SOURCE_PATTERN: —
- DECISION: DISCARD (mantener).
- ACCEPTANCE_CRITERIA: las suites PG siguen verdes.
- EVIDENCE: `api/src/modules/payments/external-collections.service.ts`, migración `20261016130000`, `admin/src/pages/ExternalCollections.tsx`.

#### 37 · ARCA / fiscal · MISSING · P1
- CURRENT: `saleNumber` es explícitamente no fiscal.
- TARGET: integración digital con ARCA y, si no está disponible, fallback operativo/manual. Al finalizar la venta el cajero elige ticket no fiscal o factura ARCA. WSFE no se diseña todavía.
- GAP: todo.
- BUSINESS_RISK: cumplimiento legal.
- TECHNICAL_RISK: alto.
- DEPENDENCIES: 46, 38.
- OPEN_SOURCE_PATTERN: módulos AFIP de Odoo y ERPNext (localización AR).
- DECISION: ADAPT (proveedor externo preferido).
- ACCEPTANCE_CRITERIA: cada venta fiscal tiene CAE; existe un camino manual cuando ARCA no está disponible.
- EVIDENCE: schema (comentario en `Sale.saleNumber`).

#### 38 · Tickets / impresión · MISSING · P1
- CURRENT: no hay ticket, comprobante ni impresión.
- TARGET: ticket de venta (identifica la venta para los cambios del 12), de cierre de caja y de cambio, en impresora térmica; opción al finalizar la venta junto con ARCA (37).
- GAP: todo.
- BUSINESS_RISK: el cliente se va sin comprobante y los cambios no tienen respaldo (el ticket es obligatorio en el flujo normal de cambio).
- TECHNICAL_RISK: medio.
- DEPENDENCIES: 37.
- OPEN_SOURCE_PATTERN: OSPOS receipts.
- DECISION: ADOPT.
- ACCEPTANCE_CRITERIA: toda venta completada puede reimprimirse y el ticket permite ubicar la venta original.
- EVIDENCE: búsqueda de print/ticket/recibo sin resultados en `client/src` y `admin/src`.

#### 47 · Día operativo / zona horaria · BROKEN · P1
- CURRENT: `todayBounds()` usa `setHours(0,0,0,0)` con la zona del servidor; no hay referencia a America/Argentina en el código.
- TARGET: día operativo en America/Argentina/Buenos_Aires; base de la semana lunes-sábado de la liquidación.
- GAP: arreglar los límites del día y centralizarlos.
- BUSINESS_RISK: "Hoy" corrido unas 3 horas si el servidor corre en UTC; las ventas de la noche caen en otro día.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: —
- OPEN_SOURCE_PATTERN: —
- DECISION: ADOPT (zona fija del negocio).
- ACCEPTANCE_CRITERIA: test con una venta a las 22:30 ART que cae en el día correcto.
- EVIDENCE: `api/src/modules/backoffice/backoffice.service.ts:38-44`.

#### 51 · Inmutabilidad de los ledgers · MISSING · P1
- CURRENT: los triggers protegen solo SalePayment, CheckoutAttempt (y sus tenders y declaraciones) y ExternalCollection. Nada protege StockMovement, CashMovement ni AuditLog.
- TARGET: los tres append-only, y el patrón se reutiliza en `EmployeeAccountMovement`.
- GAP: triggers BEFORE UPDATE/DELETE.
- BUSINESS_RISK: se puede editar la historia de stock, caja o auditoría con acceso a la DB.
- TECHNICAL_RISK: bajo/medio (verificar que ningún flujo haga update).
- DEPENDENCIES: 16, 29, 9.
- OPEN_SOURCE_PATTERN: el ledger de Odoo/ERPNext no se edita, se cancela con un movimiento inverso.
- DECISION: ADOPT.
- ACCEPTANCE_CRITERIA: test PG de UPDATE/DELETE rechazado.
- EVIDENCE: lista de `CREATE TRIGGER` en `api/prisma/migrations/*`.

### Plataforma

#### 40 · Configuración · PARTIAL · P1
- CURRENT: en la DB solo `CompanyPricingConfig` (incluye `qrAdjustmentBps`). Lo demás está en el env: locales con checkout proporcional, medios externos, hash del código mayorista y sweeper.
- TARGET: configuración operativa en DB, auditada, editable solo por ADMIN/OWNER: bps de cada medio (incluido QR), **límite global de deuda de empleado** (BigInt centavos, inicial `30000000n`), **monto mínimo de Seña**, **plazo de cambios** (inicialmente 15 días, modificable por ADMIN/OWNER), **umbral de ajuste de stock** que exige autorización (valor TBD), **umbral de diferencia de caja** (valor TBD), locales/medios del checkout. CASHIER y SELLER no modifican ninguno de estos parámetros.
- GAP: pasar locales proporcionales y medios a DB; agregar límite de empleado, mínimo de Seña, plazo de cambio y los umbrales de ajuste de stock y de diferencia de caja.
- BUSINESS_RISK: cambiar un local de modo requiere redeploy; los valores de negocio no pueden quedar hardcodeados.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: 27, 29, 12, 17.
- OPEN_SOURCE_PATTERN: —
- DECISION: ADAPT.
- ACCEPTANCE_CRITERIA: cada cambio de configuración queda auditado con autor; ningún valor de negocio listado está hardcodeado.
- EVIDENCE: `api/src/config/env.ts:75-114`; `api/prisma/schema.prisma:178-182`.

#### 41 · Seguridad · PARTIAL · P1
- CURRENT: helmet, CORS, límite global de requests y de intentos de login; JWT con contexto de autorización recargado por request; bcrypt; semgrep en CI; `npm audit` del admin en 0 (`403efe9`).
- TARGET: lo mismo, más los puntos del GAP.
- GAP: `npm audit` de api y client sin verificar; scope de Socket.IO al conectar; sin rotación/revocación de JWT más allá del TTL; sin MFA para OWNER/ADMIN. El diseño del PIN transversal (3.2) cae acá en el Blueprint.
- BUSINESS_RISK: medio.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: —
- OPEN_SOURCE_PATTERN: —
- DECISION: ADAPT.
- ACCEPTANCE_CRITERIA: audit 0 en api, client y admin; el socket respeta las revocaciones.
- EVIDENCE: `api/src/app.ts:36-58`, `.github/workflows/ci.yml:88-145`.

#### 42 · Migraciones · PARTIAL · P1
- CURRENT: 13 migraciones pineadas (G13) con gate estricto. `pilot` (`e9661ec`) está en G11 (faltan m12 `r3_card_credit` y m13 `warehouse_stock_adjustment`). La migración del WIP de Seña choca en timestamp con m13.
- TARGET: PILOT en el mismo G que System V2, timestamps sin colisión; el expand/contract de Branch/Location se gobierna por este proceso.
- GAP: plan G11 → G13 para PILOT (con backup, dry-run y aprobación OWNER); el choque de Seña desaparece con el rediseño.
- BUSINESS_RISK: no se puede desplegar System V2 sin migrar PILOT.
- TECHNICAL_RISK: medio.
- DEPENDENCIES: 45.
- OPEN_SOURCE_PATTERN: —
- DECISION: DISCARD (mantener el proceso actual).
- ACCEPTANCE_CRITERIA: el readiness pasa contra PILOT migrado.
- EVIDENCE: `git ls-tree e9661ec api/prisma/migrations`, `api/src/modules/payments/checkout-readiness.ts:9-94`.

#### 43 · Readiness · COMPLETE · P2
- CURRENT: gate de arranque estricto (`assertR3Ready`) que verifica columnas, CHECKs, triggers y pins hasta G13.
- TARGET: lo mismo, extendido a cada migración nueva.
- GAP: —
- BUSINESS_RISK: bajo.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: 42.
- OPEN_SOURCE_PATTERN: —
- DECISION: DISCARD (mantener).
- ACCEPTANCE_CRITERIA: cada migración nueva actualiza los pins.
- EVIDENCE: `api/src/server.ts:10-12`, `checkout-readiness.ts`.

#### 44 · Testing · PARTIAL · P1
- CURRENT: 153 archivos de test en la API, 15 suites PG o local-test opt-in, 21 archivos en client/admin. El CI corre lint y typecheck de la API, la suite de integración contra Postgres local y los tests del client.
- TARGET: CI que cubra lo que hoy queda afuera.
- GAP: el CI no corre los tests del admin; las suites PG opt-in (concurrencia de caja, checkout, scope, warehouse) no corren en CI.
- BUSINESS_RISK: regresiones en flujos críticos sin detectar.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: —
- OPEN_SOURCE_PATTERN: —
- DECISION: ADAPT.
- ACCEPTANCE_CRITERIA: un job de CI corre admin test y las suites PG con sus flags en un cluster descartable.
- EVIDENCE: `.github/workflows/ci.yml:55-76,147-300`.

#### 45 · Deploy · PARTIAL · P1
- CURRENT: Railway manual con runbooks (G11 cutover y rollback); sin deploy desde CI. `pilot` está muy atrás de `integration/system-v2`.
- TARGET: promoción reproducible System V2 → PILOT con gate de readiness y rollback.
- GAP: pipeline, plan de promoción y migración G13.
- BUSINESS_RISK: un deploy manual con dinero real tiene riesgo alto.
- TECHNICAL_RISK: medio.
- DEPENDENCIES: 42.
- OPEN_SOURCE_PATTERN: —
- DECISION: ADAPT.
- ACCEPTANCE_CRITERIA: runbook G13 ensayado en LOCAL_TEST.
- EVIDENCE: `docs/pilot-v1.1/*`, `.github/workflows/ci.yml` (sin job de deploy).

#### 50 · Realtime · PARTIAL · P2
- CURRENT: Socket.IO con scope tomado al conectar.
- TARGET: scope revalidado.
- GAP: reconexión forzada al cambiar el scope.
- BUSINESS_RISK: bajo.
- TECHNICAL_RISK: bajo.
- DEPENDENCIES: 26.
- OPEN_SOURCE_PATTERN: —
- DECISION: ADAPT.
- ACCEPTANCE_CRITERIA: revocar el scope corta los eventos.
- EVIDENCE: `CLAUDE.md` (deuda conocida), `api/src/realtime/*`.

---

## 5. Orden de implementación (P0/P1 con dependencias)

Cada paso lista los dominios y lo que lo habilita. Los pasos 1-3 son cimientos que reutilizan
todos los siguientes.

| # | Paso | Dominios | Depende de | Habilita |
|---|---|---|---|---|
| 1 | Pagos + Checkout (QR en PROPORTIONAL_V1, guard de referencia en FIXED_TOTAL) + día operativo en zona Argentina | 6, 5, 7, 47 | — | Retiro de FIXED_TOTAL; semana lunes-sábado |
| 2 | Ledgers inmutables + guard MANUAL | 51, 16 (inmutabilidad), 9, 29 | — | Ledger de empleados, reversas, Seña |
| 3 | Branch/Location, fase expand | 27 | — | Employee, movimientos y transferencias sobre el modelo canónico |
| 4 | Capacidad transversal de autorización por PIN ADMIN/OWNER + bandeja de alertas | (3.2), 28, 29, 41 | 2 | 11, 12, 13, 19, 32/33a |
| 5 | Tipos nuevos de StockMovement | 16 | 2, 3 | 53, 11, 12, 19 |
| 6 | Employee + EmployeeAccount + OPENING_BALANCE + límite global | 24, 52, 40 | 2, 3, 5 | 53, 54 |
| 7 | Retiro/devolución + liquidación + pago directo | 53, 54, 52 | 6, 5, 4, 47, 9 | Cierra la regresión respecto del sistema viejo |
| 8 | Anulación post-cobro + Cambios entre sucursales | 11, 12 (con 38 parcial) | 1, 4, 5, 3 | Operación diaria de cambios |
| 9 | Transferencias + alertas + remitos | 19, 18, 28, 20 | 3, 4, 5 | Abastecimiento de locales |
| 10 | Descuentos + Clientes + Ticket/ARCA | 13, 46, 38, 37 | 1, 4 | Comprobantes y Seña |

Después del núcleo: Seña rediseñada + Voucher (32, 33a; dependen de 1, 2, 4, 46, 40), usuarios
y scope desde el admin (23, 26), etiquetas y variantes (39, 2), catálogo (1), ARCA (37),
compras/proveedores (21, 22), gastos administrativos (34), tesorería (35), contabilidad
operativa (36), reportes (30).

**Pista paralela (no bloquea el orden):** CI (44), migraciones (42, incluido el plan G11 → G13
de PILOT y el contract de Branch/Location), readiness (43) y deploy (45).

---

## 6. Decisiones abiertas y datos requeridos

```
OWNER_MODEL_DECISIONS_STILL_OPEN=0
```

No queda ninguna decisión OWNER de modelo abierta. Las decisiones A–I de R3 están cerradas
(secciones 3.1 y 3.3).

### DEPLOYMENT_DATA_REQUIRED (datos de configuración/migración, no decisiones estructurales)

1. Fecha de corte y saldos reales de empleados del sistema viejo (para `OPENING_BALANCE`).
2. Valor inicial de `qrAdjustmentBps`.
3. Monto mínimo inicial de Seña.
4. Resultado de la consulta de solo lectura a PILOT sobre filas `CashMovement.MANUAL`
   (hecho, no decisión; define si 9 sube a P0). No se ejecutó en este bloque.
5. Umbral de ajuste de stock que exige autorización ADMIN/OWNER: **TBD**.
6. Umbral de diferencia de caja que exige aprobación: **TBD**.

### Puntos de diseño para el Blueprint (derivables; no son decisiones OWNER)

- Cómo se calcula el "importe pagado por la línea" con pago mixto (la base existe en `SaleLineAllocation`).
- Cómo se arrastra el valor pagado de una venta anulada sin reintegro hacia la operación de cambio, sin crear un instrumento de saldo.
- Protocolo, almacenamiento y bloqueo del PIN ADMIN/OWNER.
- Origen del cómputo del plazo de cambio (fecha de la venta original, hora local Argentina).
- Cambio sobre una línea que ya fue cambiada (encadenamiento).

---

## 7. Veredicto de preparación

```
QR_PRODUCT_DECISION_CLOSED=YES
QR_IMPLEMENTATION_BLOCKER=YES
QR_BLOCKER_FOR_FIXED_TOTAL_REMOVAL=YES
GENERAL_SALE_VOUCHER_REQUIRED=NO
EXCHANGE_VALUE_SOURCE=ACTUAL_PAID_AMOUNT
CROSS_BRANCH_EXCHANGE=YES
AUTHORIZATION_MECHANISM=PIN_ADMIN_OWNER
EMPLOYEE_OPENING_BALANCE=YES
EMPLOYEE_WEEK=MONDAY_TO_SATURDAY
EMPLOYEE_RETURN_ALLOWED=YES
EMPLOYEE_LIMIT_SCOPE=GLOBAL_ONLY
PURCHASES_IN_FULL_V2=YES

PRD_V2_READY=YES
BLUEPRINT_V2_READY=YES
```

No quedan bloqueos funcionales de modelo. Lo pendiente es implementación (QR en proporcional),
datos de despliegue (sección 6) y diseño técnico del Blueprint.
