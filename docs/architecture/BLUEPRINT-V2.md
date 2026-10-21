# Blueprint V2 — Mona Jacinta

```
DOCUMENTO=Blueprint V2 (contrato técnico)
BASE_BRANCH=integration/system-v2
BASE_HEAD=2117a879672f4bba770436f3f3314dc6db81e8ba
CONTRATOS_DE_ENTRADA=docs/product/PRD-V2.md · docs/product/SYSTEM-V2-PRODUCT-GAP-MATRIX-R4.md
TRAZABILIDAD=docs/product/PRD-V2-TRACEABILITY.md
```

Este documento define **cómo** se implementa cada requisito del PRD V2 **sin cambiar sus reglas
de negocio**. Cada subsección lleva un ancla estable `BP-<sección>.<n>` a la que apunta la
trazabilidad. El CURRENT se verifica contra el código en `BASE_HEAD`; las rutas de código
citadas son evidencia del estado actual, no diseño nuevo.

**Convención de lectura.** `NEW` = entidad nueva · `EXTEND` = columnas, valores o restricciones
nuevas sobre una entidad existente · `REPLACE` = reemplazo de un modelo legado · `NO_MODEL` =
no requiere modelo. Los nombres de entidades son propuestas de diseño; los nombres finales se
fijan al escribir el schema.

# Parte A — Arquitectura global

## 1. Propósito del Blueprint y fuentes de verdad

#### BP-1.1 · Jerarquía de fuentes
- **Código actual** = evidencia del CURRENT. **Matrix R4** = brechas y prioridad. **PRD V2** = contrato funcional. **Blueprint V2** = contrato técnico.
- El Blueprint NO puede redefinir una decisión OWNER ni una regla del PRD. Si una regla del PRD resulta técnicamente inviable, se registra como pregunta abierta (ver cada sección y el Apéndice F), nunca se reinterpreta.
- Los documentos de `docs/production-v1/*` están congelados y no se modifican.

#### BP-1.2 · Alcance
- Cubre los 264 requisitos del PRD (235 FR + 29 NFR) y los 54 dominios de la Matrix R4 (mapeo completo en el Apéndice A).
- Fuera de alcance: el diseño del código fuente módulo por módulo, la UI visual y los textos de pantalla.

#### BP-1.3 · Reglas OWNER recientes ya canónicas en el PRD
Dos decisiones OWNER posteriores a la primera versión del PRD se incorporaron al PRD como reglas
canónicas y este Blueprint las implementa sin redefinirlas:

- **OR-052 · Finalización exitosa de la Seña** (`FR-SENA-011..014`). Con la Seña ACTIVE y dentro de las 120 h, el cliente aplica el anticipo exclusivamente a esa operación, paga el saldo que calcula PROPORTIONAL_V1 según los medios elegidos (si el total final supera el anticipo, paga la diferencia), se consume el stock reservado y la Seña queda COMPLETED. El anticipo no es crédito general, no es voucher, no es reutilizable y no se aplica a otra operación. Sin devolución de efectivo. Secciones 12 y 28.
- **OR-053 · Valuación de la mercadería en el cambio** (`FR-EXCH-014..015`). Prenda devuelta: valor reconocido = importe efectivamente pagado por esa línea. Mercadería nueva: `cashPrice` es la base y el precio final lo calcula PROPORTIONAL_V1 según los medios usados para pagar la diferencia. El valor reconocido es un aporte interno no monetario: sin CashMovement, sin crédito reutilizable y sin retiro como efectivo. Secciones 12 y 16.
- **`FR-VOUCH-012`:** el Voucher de Seña solo se emite desde una Seña cancelada manualmente, con autorización de ADMIN; el vencimiento de la Seña no lo habilita. Sección 29.
- **OR-054 · Domingo** (`FR-EMPSET-012`): sección 4.3 y 26. **OR-055 · Pago de deuda ≤ saldo** (`FR-EMPSET-013`): secciones 24 y 26. **OR-056 · Cantidad reversible** (`FR-CANCEL-009`, `FR-EXCH-016`): secciones 15 y 16.

## 2. Principios de arquitectura

#### BP-2.1 · Stack
- Monolito modular. Node.js + TypeScript con módulos ESM. Express. Prisma sobre PostgreSQL/Supabase (adapter `pg`). Vitest. Socket.IO.
- El esquema es la última línea de defensa: las invariantes monetarias y de stock se refuerzan con restricciones y triggers de la base, además de la lógica de aplicación.

#### BP-2.2 · Regla transversal de la UI
**Ninguna UI modifica directamente dinero, stock, saldos, estados comerciales o totales.** Toda
modificación pasa por una operación de dominio explícita en el backend, que calcula, valida
permisos, abre la transacción, escribe el ledger y la auditoría. Las apps `client` y `admin`
solo envían intenciones (comandos) y leen proyecciones. Los totales y estados que muestran las
apps provienen del backend.

#### BP-2.3 · Dinero
- Todo importe es `BigInt` en centavos; nunca `Number`, `float` ni `Decimal`. Los porcentajes son enteros en bps (`Int`).
- La API serializa BigInt como string decimal; el cliente nunca parsea a punto flotante para operar.
- Las divisiones usan las primitivas de la sección 4.5 (redondeo determinista, distribución exacta).

#### BP-2.4 · Operaciones críticas: lista de verificación
Toda operación de dominio que combine dinero, stock o saldo DEBE cumplir, y su sección del
Blueprint DEBE declarar:
1. **Atomicidad**: una sola transacción de base de datos.
2. **Concurrencia**: nivel de aislamiento y orden de locks (sección 44).
3. **Idempotencia**: clave de operación y comportamiento ante reintento (sección 43).
4. **AuditLog** escrito dentro de la misma transacción.
5. **RBAC por ubicación**: permiso verificado en la ruta y re-verificado en el servicio.
6. **Sin stock negativo** y sin consumo de stock reservado.
7. **Arqueo consistente**: cada efectivo tiene su CashMovement; los tenders internos no tienen ninguno.

## 3. Límites de módulos

#### BP-3.1 · Mapa de módulos
Módulos existentes en `api/src/modules`: `audit`, `auth`, `backoffice`, `cash`, `inventory`,
`organization`, `payments`, `pricing`, `products`, `rbac`, `sales`. V2 agrega módulos nuevos sin
romper estos límites:

| Módulo | Estado | Responsabilidad |
|---|---|---|
| `organization` | extiende | Location canónica, tipos, estado |
| `approvals` | nuevo | Autorización supervisada (SupervisorApproval, PIN) |
| `alerts` | nuevo | Alertas y bandeja ADMIN/OWNER |
| `config` | nuevo | Configuración operativa (CompanyOperationalConfig) |
| `reversals` | nuevo | SaleCancellation y Exchange |
| `employees` | nuevo | Employee, cuenta, retiro, pagos, liquidación |
| `transfers` | nuevo | Transferencias entre depósito y locales |
| `customers` | nuevo | Customer |
| `sena` | nuevo | Seña, SenaPayment, expiración, voucher |
| `procurement` | nuevo | Supplier, PurchaseOrder, GoodsReceipt, deuda |
| `finance` | nuevo | Gastos administrativos, tesorería, export |
| `payments` | extiende | Motor de checkout: QR y tender interno |
| `inventory` | extiende | Tipos de movimiento y bloqueos |

#### BP-3.2 · Reglas de dependencia entre módulos
- Un módulo escribe solo en sus propias tablas. Para efectos cruzados (por ejemplo, stock desde un retiro) llama a una **función de dominio exportada** del módulo dueño dentro de la misma transacción (`tx` compartido), nunca a sus tablas directamente.
- Las únicas escrituras de stock salen de `inventory`; las únicas de CashMovement salen de `cash`; las únicas de AuditLog usan `shared/audit`.
- `payments` no importa de `reversals`, `sena` ni `employees`: expone un **hook de liquidación** (BP-12.3) que esos módulos implementan.

#### BP-3.3 · Capa API y UI
- Rutas bajo `/api/v1`, privadas por defecto (`createRequireAuth`). Validación de entrada con esquemas estrictos (zod `.strict()`), BigInt como string.
- Las apps `client` (caja, depósito) y `admin` consumen solo estos contratos. Ninguna lógica monetaria vive en las apps.

## 4. Convenciones transversales

#### BP-4.1 · Errores
Los errores de dominio usan `AppError(status, code, mensaje)`. El código es estable y testeable;
el mensaje es para humanos. Los conflictos de unicidad se traducen con el adaptador existente
(`prisma-unique-violation`). Un error de autorización nunca revela si el usuario existe.

#### BP-4.2 · IDs y tiempos
UUID como string para entidades; `Timestamptz(3)` para tiempos; todas las comparaciones de plazo
se hacen en UTC con el instante guardado; la presentación convierte a la zona del negocio.

#### BP-4.3 · Día operativo y zona horaria
- Zona fija `America/Argentina/Buenos_Aires`. Un único módulo `time` expone `operationalDay(instant)`, `operationalWeekMondayToSaturday(instant)` y `addHours`; ningún otro código usa `setHours(0,0,0,0)` ni la zona del servidor.
- Corrige el defecto de `todayBounds()` (`backoffice.service.ts`) usando este módulo.
- La semana de liquidación va de lunes a sábado (`operationalWeekMondayToSaturday`). Regla cerrada **OR-054 / `FR-EMPSET-012`** (`SUNDAY_MOVEMENT_WEEK = NEXT_MONDAY_CYCLE`): un instante del domingo pertenece al ciclo que comienza el lunes siguiente. `operationalWeekStart(instant)` devuelve el lunes de la semana en curso para lunes a sábado y el lunes inmediato posterior para el domingo; es una función pura derivada de `effectiveAt` (no se guarda como campo editable).

#### BP-4.4 · Numeración de venta
`saleNumber` es no fiscal y único por ubicación (`@@unique([branchId, saleNumber])` hoy; pasa a la Location canónica). El contador `SaleNumberCounter` se re-apunta a Location (sección 6).

#### BP-4.5 · Primitivas de dinero compartidas
Un módulo puro `money` (sin I/O) ofrece, y todo cálculo derivado DEBE usarlas:
- `roundPeso(n, d)`: redondeo half-up a peso entero en centavos (ya existe en `proportional-checkout.ts`).
- `allocate(total, weights)`: distribución exacta por el método Hamilton (resto al mayor residuo, desempate por id ascendente). Ya existe como `allocate` en el motor.
- `cumulativeShare(paid, qtyAfter, qty)`: `floor(paid × qtyAfter / qty)`. El valor de una devolución parcial es `cumulativeShare(qtyAfter) − cumulativeShare(qtyBefore)`; la devolución de la última unidad recibe el resto, de modo que la suma de todas las devoluciones de una línea es exactamente lo pagado.
- Propiedades de prueba: la suma de una distribución es exactamente el total; el resultado no depende del orden de entrada.

# Parte B — Organización y gobierno

## 5. Company y Location canónica

#### BP-5.1 · Modelo
- **CURRENT:** `Location` (con `companyId`, `type`, `code` único, `pointOfSaleNumber` único, `isActive`) lo usa solo `UserRoleScope`. `Branch` es el modelo operativo (Sale, Inventory, StockMovement, StockReservation, CashRegister, AuditLog, SaleNumberCounter, SaleCheckout, ExternalCollection, UserBranchRole). Invariante por convención `Location.id == Branch.id`, sin FK.
- **TARGET:** `Location` es el único modelo de sucursal y depósito. Todas las tablas nuevas de V2 nacen con FK a `Location`. `Branch` queda como legado a retirar (secciones 6 y 46).
- Una sola `Company` raíz (ya existe); la Location nunca se borra físicamente.

#### BP-5.2 · Tipo depósito explícito
`LocationType` ya distingue `RETAIL_BRANCH` y `CENTRAL_WAREHOUSE`. Hoy el depósito se **deduce del código `'DEP'`** (`organization.service.ts`). V2 usa el atributo `type` como única fuente; el código deja de tener significado.

#### BP-5.3 · Gestión de ubicaciones
Operaciones de administración (alta, edición de nombre, dirección, punto de venta, estado) para ADMIN/OWNER con AuditLog. El punto de venta sigue siendo único. No existe borrado.

#### BP-5.4 · Ubicación inactiva
Una verificación única `assertLocationActive(tx, locationId)` en `organization` se llama desde toda operación de dominio (venta, stock, caja, transferencia, retiro). Una ubicación inactiva rechaza la operación en todos los flujos.

## 6. Estrategia Branch → Location

#### BP-6.1 · Opciones evaluadas
| | A · Location canónica | B · Branch canónica |
|---|---|---|
| Atributos | Ya tiene companyId, tipo, estado, punto de venta único | Habría que agregarlos a Branch |
| RBAC | `UserRoleScope` ya apunta a Location | Hay que reescribir el RBAC probado y el lock de scope |
| Cambios | Re-apuntar FKs de ~10 tablas (mismo id) | Mover tipos y scope; reescribir autorización |
| Riesgo | Medio, mecánico y por tablas | Alto, toca seguridad |

#### BP-6.2 · Decisión
**Opción A.** `Location` es canónica y `Branch` se retira gradualmente. Como `Location.id == Branch.id`, la migración **re-apunta las claves foráneas sin copiar ni mover datos**.

#### BP-6.3 · Fases expand/contract
1. **Expand-1:** agregar la FK `Branch.id → Location.id` y `Location.id → Branch.id` (verifica la convención y la hace exigible). Toda tabla nueva de V2 nace con FK a `Location`.
2. **Expand-2:** por tabla, agregar la FK a `Location` junto a la existente a `Branch` (misma columna), validar y mantener ambas.
3. **Migrate:** el código lee y escribe vía Location; la columna puede conservar el nombre `branchId` con `@map`.
4. **Contract:** eliminar las FK a `Branch`, luego `UserBranchRole`, luego `Branch`.
Las claves únicas compuestas (por ejemplo `Sale_id_branchId_key`) se re-crean sobre la misma columna.

#### BP-6.4 · Riesgos
FKs compuestas del checkout (`SaleCheckout`, `ExternalCollection`, `CheckoutAttempt*`) dependen de `branchId`; se re-apuntan en la misma migración que su tabla. Cada fase tiene una prueba PG que verifica que `id` coincide y que no se pierde ninguna fila. Detalle del plan en la sección 46.

## 7. Roles, permisos y scopes

#### BP-7.1 · Roles
OWNER, ADMIN, CASHIER, SELLER, WAREHOUSE (ya existen). Los permisos viven en la política centralizada (`rbac/role-permission-matrix.ts`), verificada por pruebas. OWNER posee todas las facultades de ADMIN.

#### BP-7.2 · Permisos nuevos
Se agregan solo junto con la funcionalidad que los consume (regla `FR-RBAC-003`). Lista y matriz en el Apéndice C. Los permisos declarados sin consumidor actual (`EXCHANGE_MANAGE`, `TRANSFER_*`, `GOODS_RECEIPT_MANAGE`, `SUPPLIER_MANAGE`, `LABEL_PRINT`, `SENA_*`) se conservan y se vinculan a su funcionalidad cuando exista.

#### BP-7.3 · Scope y lock
`UserRoleScope` es la autoridad (LOCATION o COMPANY). La asignación de scope mantiene el lock `FOR NO KEY UPDATE` sobre el usuario objetivo **sin cambios** (regresión PG `scope-assignment-lock.pg.test.ts`). Revocar el scope corta los eventos de tiempo real (sección 37).

#### BP-7.4 · Usuarios
ABM de usuarios y reseteo de contraseña con AuditLog; baja lógica; un usuario inactivo no inicia sesión. Vínculo opcional a Employee por `Employee.userId`.

## 8. Autorización supervisada

#### BP-8.1 · Modelo SupervisorApproval (NEW, reusable)
Una aprobación es un registro por operación autorizada:

| Campo | Significado |
|---|---|
| `id` | UUID |
| `operationType` | enum cerrado (BP-8.5) |
| `locationId` | ubicación donde ocurre la operación |
| `requestedById` | usuario que solicita (p. ej. CASHIER) |
| `authorizedById` | ADMIN u OWNER identificado inequívocamente |
| `reason` | motivo (obligatorio según el tipo) |
| `intentHash` | SHA-256 del payload canónico de la operación pedida |
| `entityType`, `entityId` | entidad destino cuando ya existe (opcional) |
| `grantedAt`, `expiresAt` | emisión y caducidad corta |
| `consumedAt`, `consumedByType`, `consumedById` | consumo único por la operación |

Reglas: la aprobación se emite una vez, se consume una vez (`UPDATE … SET consumedAt WHERE consumedAt IS NULL`) y no se reutiliza ni siquiera para la misma operación repetida. Un trigger permite solo la transición `consumedAt NULL → valor` y `consumedBy* NULL → valor`; todo lo demás es inmutable. `UNIQUE(consumedByType, consumedById)` garantiza una aprobación por documento.

#### BP-8.2 · Flujo en dos pasos
1. **Emisión** (`POST /approvals`): el solicitante envía `operationType`, `locationId`, `reason` y el `intentHash` de lo que va a hacer; el autorizador ingresa su identificador y su PIN en la caja. El servidor verifica el PIN **antes** de abrir la transacción de dominio (bcrypt es lento y no debe ocupar locks de stock o caja), crea la aprobación, escribe AuditLog (`APPROVAL_GRANTED`) y emite la alerta.
2. **Consumo:** la operación de dominio (anulación, cambio, descuento, etc.) recibe `approvalId`, verifica en la misma transacción que la aprobación existe, pertenece a la misma ubicación y `operationType`, no caducó, el `intentHash` coincide con el payload real, y la consume. Un cambio de payload entre pasos invalida la aprobación.

#### BP-8.3 · PIN: almacenamiento, hash, límite y bloqueo
Sigue los patrones de seguridad del repo (`bcryptjs` cost 12 en `auth/password.ts`; validación de 72 bytes y caracteres de control del código mayorista; limitadores de intentos fallidos en `middleware/rateLimit.ts`).

- **Identificación:** el autorizador se identifica con su identificador de usuario **más** el PIN. Un PIN solo, sin identificador, obligaría a probar todos los hashes y no daría identidad inequívoca; se descarta.
- **Almacenamiento:** tabla propia `SupervisorPin` (NEW) 1:1 con `User`: `userId` único, `pinHash`, `setAt`, `failedAttempts`, `lockedUntil`, `lastFailedAt`. El hash no está en `User` y ninguna consulta de usuario lo selecciona.
- **Hash:** `bcryptjs` cost 12 (igual que la contraseña). Longitud máxima 72 bytes y sin caracteres de control (misma regla que el código mayorista).
- **Longitud y formato (`PIN_LENGTH`):** *default técnico pendiente de revisión en la implementación.* Propuesta inicial: solo dígitos, entre 6 y 8, sin secuencias ni repeticiones triviales. No es regla OWNER ni requisito del PRD y puede ajustarse sin cambiar el modelo.
- **Alta y cambio:** solo el propio usuario ADMIN/OWNER, autenticado y re-verificando su contraseña. Propuesta técnica (a confirmar): un OWNER puede reiniciar el PIN de un ADMIN, que queda sin PIN hasta que el ADMIN fije uno. Ambos casos generan AuditLog.
- **Limitación de intentos:** (a) limitador de intentos fallidos por IP y por solicitante (reusa `createFailedAttemptLimiter`); (b) contador **persistente por autorizador** en `SupervisorPin`: 5 fallos consecutivos → bloqueo de 15 minutos, y bloqueos reiterados crecen. Un éxito reinicia el contador. El contador se actualiza bajo `SELECT … FOR UPDATE` de la fila del PIN para evitar carreras.
- **Anti-enumeración:** si el identificador no existe o el usuario no tiene PIN, se compara contra un hash ficticio para igualar el tiempo y se devuelve el mismo error genérico que un PIN incorrecto.

#### BP-8.4 · No exposición del PIN
El PIN solo vive en memoria durante la verificación. NO DEBE aparecer en logs (el logger de requests solo registra estado y request id; se agrega una redacción explícita de campos `pin`), en AuditLog (`before/after`), en respuestas, en mensajes de error ni en analítica. Los endpoints de aprobación no registran el cuerpo.

#### BP-8.5 · Tipos de operación
`SALE_CANCELLATION`, `EXCHANGE_NO_TICKET`, `EXCHANGE_OUT_OF_WINDOW`, `DISCOUNT`, `EMPLOYEE_ACCOUNT_ADJUSTMENT`, `STOCK_ADJUSTMENT_OVER_THRESHOLD`, `CASH_DIFFERENCE`, `TRANSFER_DISPATCH`, `VOUCHER_ISSUE`. Un cambio que sea a la vez sin ticket y fuera de plazo usa una aprobación por tipo. Agregar un caso futuro = agregar un valor del enum y una entrada de política (rol autorizador, motivo obligatorio sí/no). Todos los tipos exigen autorizador ADMIN u OWNER con el permiso `SUPERVISOR_APPROVE` sobre la ubicación.

#### BP-8.6 · AuditLog y alerta
Cada emisión y cada consumo generan AuditLog (acciones `APPROVAL_GRANTED` y `APPROVAL_CONSUMED`, esta última dentro de la transacción de la operación, con autorizador y motivo en el registro de la operación). Cada consumo genera una alerta `SUPERVISED_ACTION` para ADMIN/OWNER (sección 37). Un intento fallido genera AuditLog `APPROVAL_DENIED` sin datos del PIN.

#### BP-8.7 · Preguntas abiertas
- Texto exacto del identificador del autorizador en pantalla (email vs. nombre de usuario).
- Caducidad exacta de la aprobación (propuesta: 5 minutos) y si un cierre de caja con diferencia grande requiere una aprobación por cierre.

# Parte C — Comercial

## 9. Catálogo, variantes y etiquetas

#### BP-9.1 · Catálogo (EXTEND)
Edición y baja lógica de `Product`, `Category`, `Brand` (campo `isActive`), con AuditLog. Un producto o variante inactivo es rechazado al agregar ítems a una venta (verificación en el servicio de venta). ABM en la app `admin`.

#### BP-9.2 · Variantes (EXTEND)
Se normaliza `color` y `size` (trim, colapso de espacios, casefold) en una columna normalizada y se agrega `UNIQUE(productId, normalizedColor, normalizedSize)`. La migración detecta duplicados existentes antes de crear el índice y falla con informe si los hay (limpieza previa). `sku` y `barcode` ya son únicos. Edición y baja lógica auditadas.

#### BP-9.3 · Etiquetas (NEW función, sin modelo)
`LABEL_PRINT`: generación de etiquetas con código de barras por variante, individual y en lote desde la recepción de mercadería. Es generación de documento; no requiere tabla nueva.

## 10. Pricing y configuración comercial

#### BP-10.1 · cashPrice y bps
`ProductVariant.cashPrice` es la base efectiva; los cinco ajustes (`list`, `creditCard`, `debitCard`, `bankTransfer`, `qr` + `AdjustmentBps`) ya existen en `CompanyPricingConfig`. Solo se modifican con `PRICE_MANAGE` (ADMIN con scope COMPANY, OWNER), auditado como `COMPANY_PRICING_CONFIG_CHANGED`. Cada operación guarda el snapshot del bps usado, por lo que un cambio solo afecta operaciones futuras.

#### BP-10.2 · QR
`qrAdjustmentBps` (default 0, sin porcentaje hardcodeado) se usa por el motor proporcional (sección 12). Su valor inicial es un dato de despliegue (PRD Apéndice D).

#### BP-10.3 · Historial y costo
El historial de precios se consulta desde AuditLog filtrado por `entityType` de precio. `costPrice` alimenta el reporte de margen (sección 38).

#### BP-10.4 · Retiro del precio LIST
Se retira `ProductVariant.price` por expand/contract: primero ningún lector lo usa (prueba que lo verifica), luego la columna se elimina en una migración de contract. Ningún flujo de V2 lo lee.

## 11. Venta

#### BP-11.1 · Sale y SaleItem
- **CURRENT:** `Sale` (`status`, `pricingModel`, `subtotal`, `discountTotal`, `total`, `saleNumber`) y `SaleItem` con snapshot inmutable (`baseUnitPrice`, `priceAdjustmentBps`, `unitPrice`, `subtotal`).
- **TARGET (EXTEND):** `Sale.origin` (`REGULAR`, `SENA_SETTLEMENT`, `EXCHANGE`) y vínculo opcional a la Seña o el Cambio de origen (BP-11.4). `discountTotal` deja de ser siempre 0 (sección 17).

#### BP-11.2 · Ciclo de vida
`DRAFT → PENDING_PAYMENT → PAID → COMPLETED`; `CANCELLED` solo desde `DRAFT` o `PENDING_PAYMENT`. Al completar: descuento del físico, consumo de la reserva y StockMovement `SALE`, en una sola transacción.

#### BP-11.3 · Corrección de venta pendiente
Se conserva `pending-correction.service` (reemplaza ítems de una venta `PENDING_PAYMENT`, ajusta reservas, audita). Las ventas de origen `SENA_SETTLEMENT` o `EXCHANGE` no admiten corrección de ítems.

#### BP-11.4 · Origen de la venta
`Sale.origin` y las FK opcionales `senaId` / `exchangeId` (XOR por CHECK) identifican las ventas generadas por el cierre de una Seña o por un cambio. Las ventas de origen especial solo pueden crearse por la operación de dominio correspondiente, nunca por la ruta genérica de ventas.

#### BP-11.5 · Estado posterior al cobro
**No se modifica `Sale.status` por una anulación o cambio.** El estado posterior al cobro se **deriva** de la existencia de `SaleCancellation` y de `ExchangeReturnLine` asociadas, y lo expone una proyección de lectura `saleLifecycle`. Así la venta original no se edita, y `FR-SALE-004` se cumple.

## 12. Checkout y pagos

#### BP-12.1 · Motor PROPORTIONAL_V1
- **CURRENT:** motor puro `computeProportionalQuote` (`pricing/proportional-checkout.ts`), flujo quote → reserva de intento → cierre → recuperación de stock, ledger `CheckoutAttempt` con triggers F1–F5, `SaleLineAllocation` por línea y medio.
- **Principio:** el algoritmo probado no se reescribe. Se extiende por **adición**: nuevos valores de entrada (QR, tenders internos, cero balance) detrás de las mismas funciones puras, con las suites existentes como compuerta de regresión.

#### BP-12.2 · QR en el motor
Se agrega `QR` a `PROPORTIONAL_METHODS` con su `qrAdjustmentBps` y columnas de snapshot (`fullPriceQr`, `qrAdjustmentBps`) en `SaleCheckout` y el plan del intento. Un cobro QR es no efectivo: exige referencia vía ExternalCollection (patrón de transferencia/débito) y se concilia en el cierre por medio. Quitar el rechazo de QR de `checkout-fields.ts` es el último paso, después de que las pruebas de QR pasen.

#### BP-12.3 · Tender interno (separado de PaymentMethod)
Para el anticipo de Seña (OR-052), el Voucher de Seña (`FR-VOUCH-011`) y el valor reconocido de un cambio (OR-053) se introduce el **tender interno**: una forma de aplicar valor que **no es un medio de pago**.

- **`PaymentMethod` no cambia.** Sigue reservado a medios externos y reales: `CASH`, `TRANSFER`, `CARD_DEBIT`, `CARD_CREDIT`, `QR`. No se agrega ningún valor interno a ese enum.
- **Modelo separado:** `InternalTenderType` (enum NEW): `SENA_ADVANCE`, `EXCHANGE_RECOGNITION`, `SENA_VOUCHER`. `SaleInternalTender` (NEW): `saleId`, `checkoutId`, `type`, `amount` (BigInt centavos), documento de origen **obligatorio** (exactamente una FK entre `senaId`, `exchangeId` y `senaVoucherId`, determinada por `type` mediante CHECK), `createdById`, `createdAt`. `SaleInternalTenderAllocation` (NEW): reparto por línea (`saleItemId`, `amount`) con la misma FK compuesta `(saleItemId, saleId)` que `SaleLineAllocation`.
- **Uso único:** `UNIQUE(senaId)`, `UNIQUE(exchangeId)` y `UNIQUE(senaVoucherId)` sobre `SaleInternalTender`. Un anticipo, un cambio o un voucher no puede aplicarse dos veces ni a otra operación. El tipo debe coincidir con el origen y con el `Sale.origin`: `SENA_ADVANCE` solo en `SENA_SETTLEMENT`, `EXCHANGE_RECOGNITION` solo en `EXCHANGE`, `SENA_VOUCHER` solo en `REGULAR` (CHECK/trigger).
- **No es dinero ni saldo:** un tender interno NO genera CashMovement, NO es ExternalCollection, NO crea saldo reutilizable y no puede retirarse como efectivo. No existe `SalePayment` ni `CashMovement` para él; por construcción (otra tabla, sin FK a `CashSession` ni a `ExternalCollection`) no puede confundirse contablemente con un cobro. Es append-only (trigger de inmutabilidad) y queda auditado: el cierre escribe AuditLog con los tenders internos aplicados y el documento de origen.
- **El motor los consume por separado:** `computeProportionalQuote` recibe dos listas, `tenders` (externos, con método) e `internalTenders` (tipo + monto). Un tender interno se valúa a escala **efectivo** (0 bps): cubre `amount / fullPriceCash` del total, y el saldo lo paga el medio externo elegido con su recargo, de modo que **el precio final lo calcula PROPORTIONAL_V1 según los medios usados para pagar la diferencia** (OR-052 y OR-053). La salida mantiene ambas asignaciones por línea separadas.
- **Identidad contable:** por cada línea, `precio final de la línea = Σ SaleLineAllocation.amount (externos) + Σ SaleInternalTenderAllocation.amount (internos)`. La conciliación de caja y los reportes de cobros leen solo `SalePayment`; los reportes de valor aplicado muestran los internos en columnas aparte.
- **Constraints a adaptar (aditivos):** los CHECKs y triggers F1–F5 que hoy exigen que los pagos igualen el total deben sumar también los tenders internos. Riesgo alto, con las suites del checkout como compuerta (BP-12.4).
- **Hook de liquidación:** al cerrar el checkout (misma transacción), el motor invoca el hook del módulo de origen (`sena`, `reversals`) para consumir el origen, restaurar el stock de las devoluciones y completar el documento. `payments` solo conoce la interfaz del hook.

#### BP-12.4 · Cero balance
Un cambio de igual o menor valor, o una Seña cuyo anticipo cubre el total a escala efectivo, deja **saldo cero**. Hoy el plan exige 1 a 3 tenders externos con un método de balance positivo (`chk_attempt_plan`). V2 agrega un plan `INTERNAL_ONLY`: permitido solo cuando **no hay tenders externos** y la suma de los internos iguala el total a escala efectivo; `balanceMethod` y el balance quedan nulos, y no se crea ningún `SalePayment`. Se implementa con un `ALTER` aditivo de las restricciones y de los triggers F1–F5, validado con las suites del checkout. **Riesgo alto** (toca triggers de integridad de pago): requiere prueba PG de regresión completa antes de integrarse.
- *Alternativa de contingencia:* exigir saldo positivo mínimo y registrar el resto como no cobrable. Se descarta porque rompe `FR-EXCH-009` (cambio directo sin cobro).

#### BP-12.5 · Pago combinado y vuelto
Se mantiene: 1 a 3 medios externos, distribución exacta por línea (Hamilton), vuelto solo en efectivo. Los tenders internos **no cuentan** en el límite de 3 medios: `SENA_ADVANCE` ≤ 1 y `EXCHANGE_RECOGNITION` ≤ 1 por venta; para `SENA_VOUCHER` el PRD no impone un máximo por venta, por lo que no se fija uno (cada voucher se usa completo).

#### BP-12.6 · FIXED_TOTAL: deprecación
FIXED_TOTAL pasa a **legado de solo lectura progresiva**: se conservan sus datos y su lectura; se deja de escribir con él en cada local a medida que el local opera en PROPORTIONAL_V1 con QR. Hasta entonces, el guard `FR-PAY-006` (referencia obligatoria para no efectivo) corre sobre el camino FIXED_TOTAL. Plan completo en la sección 48.

#### BP-12.7 · Importe pagado por línea
- **PROPORTIONAL_V1:** `paid(saleItem) = Σ SaleLineAllocation.amount + Σ SaleInternalTenderAllocation.amount`. Incluye la porción interna, por lo que un cambio sobre una línea que a su vez se pagó con valor reconocido reconoce exactamente lo que esa línea pagó (BP-16.8).
- **FIXED_TOTAL histórico (compatibilidad legacy):** no hay asignaciones. Reconstrucción determinista marcada `valueSource = LEGACY_RECONSTRUCTED`: se toma el total efectivamente cobrado (suma de pagos aceptados menos vuelto) y se distribuye entre las líneas con `allocate`, usando `SaleItem.subtotal` como peso y el id de ítem ascendente como desempate. Siempre reproducible y de suma exacta. Es una ruta de compatibilidad que desaparece cuando ya no haya ventas FIXED_TOTAL reversibles.
- Una proyección `paidAmountBySaleItem` expone el valor y su `valueSource`.

## 13. ExternalCollection

#### BP-13.1 · Se mantiene
`ExternalCollection` (transferencia o débito recibido fuera del POS; `APPLIED`/`UNAPPLIED`/`REFUNDED`; referencia única por sucursal; trigger guard) no cambia. Se extiende su uso a `QR` (método ya presente en `PaymentMethod`).

#### BP-13.2 · Referencia
El pago de deuda de empleado por transferencia y los pagos de Seña no efectivos **no** reutilizan ExternalCollection (está acoplada a `appliedSaleId` y `SalePayment`); cada uno guarda su propia referencia verificable con unicidad por ubicación (secciones 26 y 28). Los pagos de Seña no efectivos sí cumplen la misma regla de referencia.

## 14. Mayorista

#### BP-14.1 · Se mantiene
La autorización mayorista (hash bcrypt del código fuera de banda, confirmación del cajero, columnas congeladas por trigger tras el pago, CHECKs) no cambia. `wholesalePrice ≤ cashPrice` ya se valida. Las ventas de origen `SENA_SETTLEMENT` o `EXCHANGE` no admiten modo mayorista.

# Parte D — Post-venta

## 15. Anulación

#### BP-15.1 · Modelo
`SaleCancellation` (NEW), única por venta: `saleId` (UNIQUE), `locationId`, `requestedById`, `approvalId` (UNIQUE), `reason` (obligatorio), `createdAt`, más `SaleCancellationItem` (`saleItemId`, `restoredQty`). La venta original no se edita (BP-11.5).

#### BP-15.2 · Operación
`cancelPaidSale(saleId, reason, approvalId)`. Precondiciones: venta `PAID` o `COMPLETED`; aprobación `SALE_CANCELLATION` válida y consumida en la misma transacción; permiso del solicitante en la ubicación. Registra la cancelación y AuditLog con autorizador y motivo; genera la alerta.

#### BP-15.3 · Stock y cantidad reversible
Repone el stock en la ubicación de la venta original con StockMovement `SALE_CANCELLATION_RETURN`, referenciando la cancelación. Solo repone lo que **todavía es reversible** por ítem:
`stockReversibleQty = soldQty − restoredQty`, donde `restoredQty` = Σ `SaleCancellationItem.restoredQty` + Σ `ExchangeReturnLine.returnedQty` con `stockRestored = true` (incluye cambios aún abiertos, que ya reclamaron esas unidades). Un cambio parcial previo reduce lo reversible; nunca se repone dos veces la misma unidad. Si `stockReversibleQty = 0` para todos los ítems, la operación se **rechaza**.

#### BP-15.4 · Sin dinero
La anulación **no** escribe CashMovement de reintegro, **no** crea saldo, vale ni crédito. El dinero cobrado queda como está; el valor pagado de la venta queda **disponible para reconocerse en un cambio** (sección 16). Los CashMovement `SALE_INCOME` originales no se tocan, por lo que la conciliación de caja no cambia.

#### BP-15.5 · Invariantes y anulación después de un cambio parcial
- `UNIQUE(saleId)`; `restoredQty` ≥ 0 por fila.
- **Regla de cantidad reversible** (OR-056, `FR-CANCEL-009` y `FR-EXCH-016`): `reversibleQty = vendida − ya devuelta/cambiada − ya repuesta por otras reversas`, y equivalente para el valor (BP-16.7). Una anulación posterior a un cambio parcial aplica **solo a lo que queda**: repone el remanente de unidades y no toca el valor ya consumido, que sigue disponible para cambios sobre la venta anulada solo hasta agotar `valor pagado − valor reconocido`.
- **Rechazo:** si no queda cantidad reversible, la operación falla; si queda solo valor (no unidades), no hay anulación posible pero sí cambios.
- Enforcement: lock de los `SaleItem` en orden de id + trigger diferido sobre `SaleCancellationItem` y `ExchangeReturnLine` que recomputa los invariantes de BP-16.7 para los ítems afectados.
- Fuera de alcance del PRD: anular un cambio ya completado.

## 16. Cambio

#### BP-16.1 · Modelo
- `Exchange` (NEW): `originalSaleId`, `locationId` (donde ocurre), `replacementSaleId` (UNIQUE), `requestedById`, `hasTicket`, `outOfWindow`, las aprobaciones consumidas (tipos `EXCHANGE_NO_TICKET` y/o `EXCHANGE_OUT_OF_WINDOW`) quedan enlazadas desde `SupervisorApproval.consumedBy*`, `status` (OPEN → COMPLETED / ABANDONED), `recognizedTotal`, `forfeitedAmount`, timestamps.
- `ExchangeReturnLine` (NEW): `exchangeId`, `saleItemId`, `returnedQty`, `recognizedAmount` (congelado), `valueSource` (`ALLOCATION` | `LEGACY_RECONSTRUCTED`), `stockRestored` (bool).
- Las líneas entregadas son los ítems de la **venta de reemplazo** (`NO_MODEL`): se reutilizan Sale/SaleItem y el checkout.
- Separación técnica: **SaleCancellation** (reversión de la operación) · **Exchange** (operación comercial) · **ExchangeReturnLine / SaleCancellationItem** (devoluciones físicas y de valor). Ninguna toca la venta original.

#### BP-16.2 · Valor reconocido
`recognizedAmount` de una línea devuelta = valor pagado de la línea (BP-12.7) aplicado con `cumulativeShare` para devoluciones parciales. Se **congela al crear el cambio**. Para ventas PROPORTIONAL_V1 sale de `SaleLineAllocation`; para FIXED_TOTAL, de la reconstrucción legacy marcada. Invariante: Σ `recognizedAmount` por `saleItem` (todos los cambios no abandonados) ≤ pagado de la línea.

#### BP-16.3 · Plazo, ticket y aprobaciones
- Plazo: `CompanyOperationalConfig.exchangeWindowDays` (inicial 15, modificable por ADMIN/OWNER con auditoría; CASHIER/SELLER no). Se compara `now()` con la fecha de la venta original, en UTC.
- Con ticket y dentro de plazo: lo procesa CASHIER (permiso `EXCHANGE_MANAGE`), sin aprobación.
- Sin ticket → aprobación `EXCHANGE_NO_TICKET`. Fuera de plazo → aprobación `EXCHANGE_OUT_OF_WINDOW`. Ambos casos exigen motivo y quedan visibles para ADMIN/OWNER (alerta).
- "Con ticket" es una declaración del cajero verificada por el número de venta impreso en el ticket (`saleNumber`): el cambio se inicia siempre buscando la venta original por número; sin número = sin ticket.

#### BP-16.4 · Flujo
1. **Cotización** (solo lectura): venta original, líneas devueltas, líneas nuevas → valor reconocido por línea, total de la prenda nueva a escala efectivo, aprobaciones requeridas.
2. **Creación** (transacción): bloquea las filas de `SaleItem` originales en orden de id, valida límites (BP-16.7), consume aprobaciones, crea `Exchange(OPEN)`, `ExchangeReturnLine` y la **venta de reemplazo** `PENDING_PAYMENT` (origen `EXCHANGE`) con reserva de stock de las líneas nuevas.
3. **Cobro**: checkout PROPORTIONAL_V1 de la venta de reemplazo con un tender interno de tipo `EXCHANGE_RECOGNITION` (`SaleInternalTender`, BP-12.3) por el valor reconocido, más el medio elegido para el saldo si lo hay.
4. **Finalización** (hook, misma transacción que el cierre): consume el tender, repone el stock de las devoluciones, completa la venta de reemplazo y el `Exchange`.
Si el cliente abandona, el `Exchange` pasa a `ABANDONED`, libera el reclamo de valor y la reserva.

#### BP-16.5 · Valuación (OR-053)
- Prenda devuelta: valor reconocido = importe efectivamente pagado por esa línea (BP-16.2).
- Mercadería nueva: `cashPrice` es la base y el precio final lo calcula PROPORTIONAL_V1 según los medios usados para pagar la diferencia; **no** se usa siempre `cashPrice` como precio final.
- El valor reconocido entra como `SaleInternalTender` de tipo `EXCHANGE_RECOGNITION`, a escala efectivo, limitado al total de la prenda nueva a escala efectivo. Si lo supera, `Exchange.forfeitedAmount` registra el excedente (no se devuelve ni se acredita). Si lo iguala: cambio directo (plan `INTERNAL_ONLY`, BP-12.4). Si es menor: el saldo lo paga el cliente con el medio elegido y su recargo.
- Aporte interno no monetario: sin CashMovement, sin ExternalCollection, no reutilizable, no retirable como efectivo.

#### BP-16.6 · Cross-branch
El cambio ocurre en `Exchange.locationId`: allí se repone el stock devuelto, se descuenta el de la prenda nueva y se usa la sesión de caja abierta. No hay stock ni dinero que cruzar entre sucursales. Se requiere una sesión de caja abierta en esa ubicación.

#### BP-16.7 · Doble reposición de stock y doble consumo de valor
Por cada `SaleItem` se mantienen tres contadores **derivados de las filas** (nunca de un campo editable):
- `restoredQty` = Σ `SaleCancellationItem.restoredQty` + Σ `ExchangeReturnLine.returnedQty` con `stockRestored = true` (cambios no abandonados).
- `valueReturnedQty` = Σ `ExchangeReturnLine.returnedQty` (cambios no abandonados).
- `valueConsumed` = Σ `ExchangeReturnLine.recognizedAmount` (cambios no abandonados).

Invariantes: **(I1)** `restoredQty ≤ soldQty`; **(I2)** `valueReturnedQty ≤ soldQty`; **(I3)** `valueConsumed ≤ paid(saleItem)`, calculando `recognizedAmount` con `cumulativeShare` sobre `valueReturnedQty` (exacto cuando se devuelve la última unidad).

Reglas derivadas: un cambio sobre una venta **ya anulada** crea líneas con `stockRestored = false` (el stock ya volvió) y consume solo valor; un cambio sobre una venta **no anulada** crea líneas con `stockRestored = true` y consume valor y unidades; una anulación posterior repone solo `soldQty − restoredQty`. Un cambio `OPEN` ya reclama sus unidades, de modo que una anulación concurrente no las repone y el cierre del cambio no las repone dos veces. Cuando un cambio pasa a `ABANDONED`, sus líneas dejan de contar.
Enforcement: (1) lock de los `SaleItem` originales en orden de id; (2) trigger diferido sobre `ExchangeReturnLine` y `SaleCancellationItem` que recomputa I1–I3; (3) `ExchangeReturnLine.returnedQty > 0` y `recognizedAmount ≥ 0` por CHECK; (4) la transición `OPEN → ABANDONED` es unidireccional (trigger). Si no hay cantidad ni valor reversible, la operación se rechaza.

#### BP-16.8 · Cambio encadenado
Como el valor reconocido entra a la venta de reemplazo como tender interno asignado por línea, el "pagado por línea" de esa venta ya incluye la porción interna. Un segundo cambio sobre esa línea reconoce exactamente lo que la línea realmente pagó, sin lógica especial.

## 17. Descuento

#### BP-17.1 · Descuento manual
Solo con aprobación `DISCOUNT` (ADMIN/OWNER, motivo obligatorio). `Sale.discountTotal` deja de ser 0; el descuento se aplica al subtotal de referencia **antes** de la cotización proporcional y se distribuye por línea con `allocate`. Se registra el descuento con autorizador y motivo (columnas en `Sale` o tabla `SaleDiscount`, decisión al escribir el schema) y es visible al OWNER (alerta y reporte). Sin topes por rol ni promociones. CASHIER y SELLER no pueden aplicarlo sin aprobación. Pregunta abierta: si el descuento puede aplicarse sobre una venta ya en `PENDING_PAYMENT` (propuesta: sí, antes de reservar el intento de cobro).

# Parte E — Stock

## 18. Inventario y reservas

#### BP-18.1 · Inventario
`Inventory(variant, location, physical, reserved)`; disponible = físico − reservado. Se re-apunta a Location (sección 6). Las operaciones de V2 que consumen stock exigen disponible ≥ cantidad y no tocan `reserved`.

#### BP-18.2 · Reservas
`StockReservation` se extiende con un dueño alternativo: `saleId` XOR `senaId` (CHECK). La venta normal no tiene vencimiento por reloj (`NORMAL_SALE_HOLD_EXPIRES_BY_CLOCK=false`); el sweeper y `release-expired` de venta permanecen dormidos y se retiran en un contract posterior. Las reservas de Seña tienen su propio vencimiento (sección 28). El campo `expiresAt` queda sin uso para ventas.

## 19. Ledger de StockMovement

#### BP-19.1 · Tipos
`StockMovementType` hoy: `SALE`, `INITIAL_STOCK`, `ADJUSTMENT`. V2 agrega: `EMPLOYEE_WITHDRAWAL`, `EMPLOYEE_RETURN`, `SALE_CANCELLATION_RETURN`, `EXCHANGE_RETURN`, `TRANSFER_OUT`, `TRANSFER_IN`, `GOODS_RECEIPT`, `TRANSFER_RESOLUTION`. Los valores de enum se agregan con `ALTER TYPE … ADD VALUE` en migración propia (no transaccional en PG); cada tipo se usa recién en una migración posterior.

#### BP-19.2 · Documento de origen tipado
Cada movimiento referencia su documento con **FK tipadas** (`saleId`, `cancellationId`, `exchangeId`, `employeeWithdrawalId`, `employeeReturnId`, `transferId`, `goodsReceiptId`, `adjustmentId`…) y un CHECK que exige **exactamente una** FK no nula según el `type`. Se descarta un par polimórfico `sourceType/sourceId` (no se puede validar con FK).

#### BP-19.3 · Inmutabilidad
Trigger `BEFORE UPDATE OR DELETE` que rechaza toda modificación (sección 42). Un error se corrige con un movimiento inverso.

## 20. Ajustes manuales

#### BP-20.1 · Ajuste
Se conserva `adjustStock`: `physical = previo + delta`, `reserved` no cambia, un StockMovement `ADJUSTMENT` y AuditLog atómicos bajo Serializable y lock de inventario, idempotente por `(userId, idempotencyKey)`, permiso `INVENTORY_MANAGE` en la ubicación.

#### BP-20.2 · Tope duro legado vs. umbral de autorización
Son dos conceptos distintos y no se mezclan:
- **`LEGACY_HARD_CAP = 100n`** (hoy `ADJUSTMENT_MAX_ABS_DELTA` en `inventory-adjustment.service.ts`): comportamiento **legado a revisar o reemplazar** cuando se implemente este dominio. No es una decisión OWNER ni una regla del PRD, y no se convierte en una.
- **`SUPERVISOR_THRESHOLD`** = `CompanyOperationalConfig.stockAdjustmentApprovalThreshold`: configurable por ADMIN/OWNER, nulo = regla inactiva, valor inicial **TBD** (no se inventa). Si un ajuste supera el umbral → aprobación `STOCK_ADJUSTMENT_OVER_THRESHOLD`, motivo obligatorio y AuditLog con autorizador. Un ajuste común usa el permiso operativo normal.
Mientras el umbral no esté definido, el sistema se comporta como hoy (incluido el tope legado). Al implementar, se decide técnicamente si el tope se retira, se sube o se reemplaza por el umbral, y cuál es la unidad del "impacto" (unidades o valor a costo); ninguna de esas elecciones modifica una regla OWNER.

## 21. Transferencias

#### BP-21.1 · Modelo
`Transfer` (NEW): origen, destino, estado, `dispatchApprovalId` (UNIQUE), `dispatchedById`, `dispatchedAt`; `TransferItem`: variante, `dispatchedQty`; `TransferReceipt` + `TransferReceiptItem`: `receivedQty` por línea, `receivedById` (CASHIER de destino); `TransferResolution` (NEW, ver BP-21.6). Todas con FK a Location.

#### BP-21.2 · Máquina de estados
`PENDING_DISPATCH` (borrador del depósito) → `IN_TRANSIT` (despachada, autorizada por ADMIN) → `RECEIVED` (recibida sin diferencias) | `PENDING_REVIEW` (hay diferencias) → `RESOLVED` (resuelta por ADMIN). Estados derivados del flujo del PRD; no se agregan otros.

#### BP-21.3 · Operaciones
- **Despacho** (depósito, con aprobación `TRANSFER_DISPATCH`): transacción Serializable, lock de Inventory del origen en orden determinista, descuenta el físico y escribe `TRANSFER_OUT`.
- **Recepción** (CASHIER de destino, por línea): registra `receivedQty` ≤ `dispatchedQty` (CHECK + FK compuesta); si todo coincide, escribe `TRANSFER_IN` y pasa a `RECEIVED`; si hay diferencia, escribe `TRANSFER_IN` por lo recibido y pasa a `PENDING_REVIEW`.
- **Resolución** (solo ADMIN, con motivo): ver BP-21.6.
- La recepción de proveedor es un flujo distinto (sección 22).

#### BP-21.4 · Tránsito: estado documental + ledger
No existe una Location `TRANSIT`. La cantidad en tránsito es **derivada**: Σ despachado − Σ recibido − Σ resuelto, por transferencia y línea. La mercadería en tránsito no figura como disponible en origen ni en destino, pero es trazable por el documento. Se descartó la Location TRANSIT: contaminaría el modelo de ubicaciones reales que exige `FR-ORG-001`, complicaría scope y listados, y con un único TRANSIT global se pierde la atribución por transferencia. Si los reportes de stock en tránsito resultan inmanejables, se reevalúa.

#### BP-21.5 · PENDING_REVIEW y alerta
Al entrar en `PENDING_REVIEW` se crea una alerta `TRANSFER_PENDING_REVIEW` para ADMIN que **persiste hasta la resolución** (sección 37). No hay corrección automática de stock.

#### BP-21.6 · TransferResolution y diferencias
`TransferResolution` (NEW): `transferId` (UNIQUE), `resolvedById` (ADMIN/OWNER con permiso sobre la ubicación), `reason` (obligatorio), `reasonCode` (referencia a una lista de motivos **extensible**, no un enum de PostgreSQL), `resolvedAt`.
- La resolución puede causar **cero o más** movimientos explícitos de stock: cada uno es un `StockMovement` de tipo `TRANSFER_RESOLUTION` con FK a la resolución (CHECK de FK-por-tipo) y pasa por el lock de Inventory y la idempotencia habituales.
- **Ninguna diferencia se corrige con UPDATE directo de `Inventory`.** Toda variación de `physical` nace de un StockMovement; se evalúa un trigger diferido que verifique `physical = Σ quantityDelta` por inventario.
- La taxonomía detallada de motivos puede evolucionar (nuevas filas en la lista) sin cambiar la máquina de estados: `PENDING_REVIEW → RESOLVED` siempre exige una `TransferResolution`.
- Alerta de revisión: se cierra en la misma transacción que la resolución (BP-37.1).

## 22. Recepción de proveedor

#### BP-22.1 · GoodsReceipt
`GoodsReceipt` (NEW) con `GoodsReceiptItem`: contra un remito de proveedor y, si existe, su `PurchaseOrder`. Control de cantidades (recibido vs esperado), movimientos `GOODS_RECEIPT` al depósito, una recepción por remito, idempotente por clave. Alimenta la deuda con el proveedor (sección 33).

# Parte F — Empleados

## 23. Employee y EmployeeAccount

#### BP-23.1 · Employee (NEW)
`Employee`: `id`, `employeeCode` (UNIQUE, visible), `name`, `userId` (UNIQUE nullable, FK a `User`), `homeLocationId` (nullable), `isActive`. Independiente de `User`. ABM auditado (`EMPLOYEE_MANAGE`, ADMIN/OWNER). Búsqueda por código en caja y depósito. Un empleado inactivo es rechazado por todo flujo.

#### BP-23.2 · EmployeeAccount (NEW, fila de anclaje)
`EmployeeAccount`: 1:1 con `Employee` (`employeeId` UNIQUE), **sin campo de saldo**. Existe para ser el objetivo del lock que serializa los movimientos de un empleado (límite global, concurrencia de retiros y pagos) y la FK de todos sus movimientos.

#### BP-23.3 · Límite global
`CompanyOperationalConfig.employeeDebtLimit` (BigInt, inicial `30000000`, editable por ADMIN/OWNER, auditado). El retiro calcula el saldo resultante **dentro de la transacción, bajo el lock de la cuenta**, y se rechaza si lo supera. No existe límite por empleado.

## 24. Ledger de cuenta de empleado

#### BP-24.1 · EmployeeAccountMovement (NEW)
Append-only. Tipos: `OPENING_BALANCE`, `MERCHANDISE_WITHDRAWAL`, `RETURN`, `PAYMENT`, `PAYROLL_DEDUCTION`, `REVERSAL`, `ADJUSTMENT`. Campos: `accountId`, `type`, `amount` (BigInt centavos, convención de signo fija: deuda positiva), `locationId`, FK tipada a su documento (`withdrawalId`, `returnId`, `paymentId`, `settlementId`, `reversesMovementId`), `createdById`, `reason`, `createdAt`, `idempotencyKey`. CHECK de signo y de FK-por-tipo.

#### BP-24.2 · Saldo derivado
`balance(accountId, asOf) = Σ amount de los movimientos hasta asOf`. Nunca se almacena. Una vista de solo lectura (opcionalmente materializada) sirve para listados; la verdad es el ledger. Reconstruible a cualquier fecha (`NFR-MONEY-003`).
**Invariante de deuda (OR-055, `FR-EMPSET-013`):** el saldo de una cuenta es `≥ 0`: no existe saldo acreedor del empleado. Todo movimiento que reduce la deuda (`PAYMENT`, `PAYROLL_DEDUCTION`, `RETURN`, `REVERSAL` de un cargo) se rechaza con un `AppError` (código a fijar en la implementación) si dejaría el saldo por debajo de cero; la verificación ocurre dentro de la transacción, bajo el lock de la cuenta. `OPENING_BALANCE` y `ADJUSTMENT` autorizado tienen semántica explícita; si alguno dejara un saldo negativo, **no se convierte en crédito general**: no se puede usar para nada, se señala como anomalía con una alerta y se corrige por un ajuste.

#### BP-24.3 · OPENING_BALANCE
Un solo `OPENING_BALANCE` por cuenta (índice único parcial `WHERE type = 'OPENING_BALANCE'`), con la **fecha de corte** en el movimiento (`effectiveAt`). Ningún movimiento puede tener `effectiveAt` anterior al corte de su cuenta. No se reconstruye historia anterior. Importación en la sección 47.

#### BP-24.4 · Reversa
`REVERSAL` referencia un único original (`reversesMovementId` UNIQUE); misma cuenta (FK compuesta `(id, accountId)`); signo opuesto y monto igual; no se puede revertir un `OPENING_BALANCE` salvo mediante `ADJUSTMENT` autorizado. `ADJUSTMENT` exige aprobación `EMPLOYEE_ACCOUNT_ADJUSTMENT` y motivo. Trigger de inmutabilidad (sección 42).

## 25. Retiro y devolución de mercadería

#### BP-25.1 · Decisión: documento propio
`EmployeeWithdrawal` es un **documento propio**, no una venta especial. Una `Sale` arrastraría las invariantes de cobro (checkout, `SalePayment`, caja, asignaciones por línea) que un retiro no cumple, obligando a excepcionar triggers que hoy protegen el dinero. El documento propio escribe stock, deuda y auditoría atómicamente y comparte con la venta solo el patrón de inventario.

#### BP-25.2 · Modelo y operación
`EmployeeWithdrawal` (NEW: `employeeId`, `locationId`, `createdById` = CASHIER, `idempotencyKey`, `total`) y `EmployeeWithdrawalItem` (`variantId`, `quantity`, `unitPriceFrozen` = `cashPrice` al momento, `subtotal`). Transacción Serializable: (1) lock de la cuenta del empleado; (2) lock de Inventory en orden determinista (variante, ubicación); (3) valida activo, disponible ≥ cantidad, saldo resultante ≤ límite; (4) escribe `StockMovement(EMPLOYEE_WITHDRAWAL)`, `EmployeeAccountMovement(MERCHANDISE_WITHDRAWAL)` y `AuditLog`. Idempotente por `(createdById, idempotencyKey)`, con 409 si el payload difiere. Un trigger diferido garantiza que **no existe cargo sin movimiento de stock y viceversa**. Se puede retirar en cualquier sucursal; lo carga CASHIER sin preautorización.

#### BP-25.3 · Devolución
`EmployeeWithdrawalReturn` + `EmployeeWithdrawalReturnItem` (NEW): vinculados a un `EmployeeWithdrawalItem`. Invariante: Σ devuelto por ítem ≤ retirado (trigger diferido con lock del ítem). Repone stock (`EMPLOYEE_RETURN`) y escribe `EmployeeAccountMovement(RETURN)` por el valor congelado (con `cumulativeShare` en parciales). Misma transacción y mismos locks que el retiro.

#### BP-25.4 · Aviso
Cada retiro genera la alerta `EMPLOYEE_WITHDRAWAL` para ADMIN/OWNER (empleado, ubicación, importe).

## 26. Liquidación semanal y pagos de deuda

#### BP-26.1 · Pago en efectivo
`EmployeePayment` (NEW: `employeeId`, `method`, `amount`, `locationId`, `cashSessionId`, `reference` nullable, `idempotencyKey`). Para `CASH`: en una transacción, bajo el lock de la sesión de caja y el de la cuenta, escribe `EmployeePayment`, `EmployeeAccountMovement(PAYMENT)` negativo y `CashMovement` de tipo nuevo `EMPLOYEE_PAYMENT_INCOME` (único por `employeePaymentId`). La conciliación del cierre acepta ese tipo y su efectivo.

#### BP-26.2 · Pago por transferencia y tope de pago
Para `TRANSFER`: `EmployeePayment` con `reference` e institución obligatorias y **unicidad por ubicación** (mismo patrón que ExternalCollection, pero propio). Genera el `EmployeeAccountMovement(PAYMENT)` sin CashMovement.
**Pago ≤ deuda pendiente** (OR-055, `FR-EMPSET-013`; válido para efectivo y transferencia): `amount ≤ saldo vigente` calculado dentro de la transacción y bajo el lock de la cuenta; un pago mayor se rechaza con `AppError`. No se crea saldo acreedor. Un pago parcial o total reduce el saldo.

#### BP-26.3 · Liquidación
`EmployeeSettlement` (NEW): `employeeId`, `weekStart` (lunes, día operativo), `amountApplied` (puede ser parcial), `createdById` (ADMIN/OWNER), `note`. Genera exactamente un `EmployeeAccountMovement(PAYROLL_DEDUCTION)` negativo (`UNIQUE(settlementId)` en el movimiento y viceversa). El saldo restante se arrastra solo porque el saldo es derivado. Corregir una liquidación = reversa. No calcula sueldos. Reconstruible: saldo previo, aplicado, semana, autor, saldo posterior.

#### BP-26.4 · Semana
La semana va de lunes a sábado en `America/Argentina/Buenos_Aires` (BP-4.3). `UNIQUE(employeeId, weekStart)` solo si una sola liquidación por semana es suficiente; **decisión técnica:** el PRD permite liquidaciones parciales, por lo que puede haber más de una por semana y no se impone unicidad. La liquidación respeta también el invariante de deuda `≥ 0` (BP-24.2). Un movimiento de domingo cae en el ciclo que comienza el lunes siguiente (`operationalWeekStart`, BP-4.3; OR-054 / `FR-EMPSET-012`): una liquidación de la semana W incluye en su saldo previo los movimientos hasta el sábado de W y los del domingo siguiente forman parte del ciclo de W+1.

# Parte G — Clientes y Seña

## 27. Customer

#### BP-27.1 · Modelo
`Customer` (NEW): `firstName`, `lastName`, `phone` obligatorios; `documentNumber`, `email`, `taxId` opcionales. Una Seña exige cliente. Búsqueda por teléfono y nombre. Sin unicidad forzada por teléfono (pregunta abierta: duplicados).

## 28. Seña

#### BP-28.1 · Modelo (NEW, conjunto de migraciones S12)
- `Sena`: `locationId`, `customerId`, `status`, `activatedAt`, `expiresAt` (= `activatedAt + 120 h`, guardado y no recalculado), `snapshotCashTotal`, `minimumAtActivation`, `createdById`.
- `SenaItem`: variante, cantidad, `baseUnitPriceSnapshot` (= `cashPrice` al activar, congelado).
- `SenaPayment`: separado de `SalePayment`; ver BP-28.4.
- Reutiliza `StockReservation` con dueño Seña (BP-18.2).

#### BP-28.2 · Máquina de estados
`ACTIVE` → `SETTLING` (se inició el cierre dentro de las 120 h) → `COMPLETED`; `ACTIVE` → `EXPIRED` (venció); `ACTIVE` → `CANCELLED` (cancelación manual). `SETTLING` vuelve a `ACTIVE` si la venta de cierre se cancela antes de cobrar y aún no pasaron las 120 h, o pasa a `EXPIRED` si ya pasaron. `SETTLING` es un estado técnico del Blueprint que modela OR-052; no altera ninguna regla. Estados terminales: `COMPLETED`, `EXPIRED`, `CANCELLED`.

#### BP-28.3 · Activación
Operación atómica: valida cliente, mínimo (`CompanyOperationalConfig.senaMinimumAmount`; nulo = sin mínimo hasta definirlo, valor inicial **TBD**), bloquea el stock disponible (suma `reserved` del Inventory con lock ordenado), congela el snapshot de precios, registra el primer `SenaPayment` y fija `expiresAt`. Una Seña activa no puede dejar disponible negativo. Medios y QR según las reglas del checkout.

#### BP-28.4 · SenaPayment
`SenaPayment` (NEW): `senaId`, `method`, `amount`, `cashSessionId`, `reference` (obligatoria para medios no efectivo, única por ubicación), `idempotencyKey`, `acceptedAt`. Append-only. El efectivo genera `CashMovement(SENA_INCOME)` único por `senaPaymentId`. Invariante: Σ `SenaPayment.amount` ≤ `snapshotCashTotal`. **No se reutiliza `SalePayment`**: sus FKs compuestas al checkout y a las asignaciones por línea no aplican y se violarían.

#### BP-28.5 · Stock bloqueado
Se incrementa `Inventory.reserved` mediante `StockReservation(senaId)`; así `NFR-STOCK-003` (reservado no consumible) vale sin cambios. Prohibido al activar si no hay disponible.

#### BP-28.6 · Expiración idempotente
Un sweeper propio (`sena-sweeper`) ejecuta `UPDATE Sena SET status='EXPIRED' WHERE id = $1 AND status = 'ACTIVE' AND expiresAt <= now() RETURNING …`; solo si el `UPDATE` afecta una fila se liberan las reservas, en la misma transacción y con el lock de Inventory en orden. Reejecutar o ejecutar en paralelo no libera dos veces. No genera CashMovement, saldo ni crédito.

#### BP-28.7 · Cierre exitoso (OR-052)
Operación `settleSena(senaId)`:
1. **Inicio** (transacción): verifica `status = ACTIVE` y `now() ≤ expiresAt`; pasa a `SETTLING`; crea la venta de cierre (`origin = SENA_SETTLEMENT`, `senaId`) en `PENDING_PAYMENT` con los ítems de la Seña y `baseUnitPrice` = el **snapshot de la Seña** (no el catálogo actual); **traspasa** la propiedad de las reservas de la Seña a la venta (`senaId → saleId`), de modo que el vencimiento deja de aplicar.
2. **Cobro:** checkout PROPORTIONAL_V1 con un tender interno de tipo `SENA_ADVANCE` (`SaleInternalTender`, BP-12.3) por el total aceptado de los `SenaPayment` (escala efectivo) y el medio externo elegido para el saldo. El precio final lo calcula el motor según los medios (OR-052). Si el total final supera el anticipo, el cliente paga la diferencia. Sin devolución de efectivo.
3. **Finalización** (hook, misma transacción que el cierre): consume el stock reservado (la venta completa normalmente) y pasa la Seña a `COMPLETED`.
El anticipo es de **uso único y exclusivo de esta operación**: `UNIQUE(senaId)` en `SaleInternalTender`; no es voucher, ni crédito, ni se aplica a otra venta. Los pagos ya aceptados nunca se reembolsan.
- **Cero balance:** si el anticipo cubre el total a escala efectivo se usa el plan `INTERNAL_ONLY` (BP-12.4).
- Con el invariante Σ `SenaPayment` ≤ `snapshotCashTotal` (BP-28.4) el anticipo nunca supera el total; el tender se limita siempre al total.

#### BP-28.8 · Cancelación manual
`ACTIVE → CANCELLED` con autorización según la política; libera las reservas una sola vez; no reintegra ni acredita nada. El anticipo queda disponible únicamente para la emisión de un Voucher (sección 29).

## 29. Voucher de Seña

#### BP-29.1 · Modelo y reglas
`SenaVoucher` (NEW): `senaId` (UNIQUE), `locationId` (la sucursal de la Seña), `amount` (= Σ `SenaPayment` aceptados, fijado al emitir), `issuedById`, `approvalId` (UNIQUE, tipo `VOUCHER_ISSUE`), `status` (`ISSUED` → `USED`), sin fecha de vencimiento.
- **Origen (`FR-VOUCH-012`):** solo una Seña **cancelada manualmente** (`CANCELLED`) y con autorización de ADMIN. Una Seña `EXPIRED` **no** habilita Voucher: el vencimiento libera el stock, no devuelve dinero, no genera crédito ni Voucher automático. Tampoco `ACTIVE`, `SETTLING` ni `COMPLETED`. Se garantiza con un trigger sobre el estado de la Seña al insertar el voucher.
- Se emite por una operación separada; cancelar o vencer una Seña **no** lo emite.
- **Uso:** tender interno de tipo `SENA_VOUCHER` (`SaleInternalTender`, BP-12.3), uso completo, misma sucursal, sin vuelto, compra ≥ valor (a escala efectivo), solo en una venta de origen `REGULAR` (nunca para pagar una Seña), sin CashMovement. `UNIQUE(senaVoucherId)` en `SaleInternalTender`.
- **Exclusión mutua:** el anticipo se consume **o** por cierre (`COMPLETED`) **o** por voucher, nunca ambos (trigger sobre estados de `Sena`).

# Parte H — Caja y finanzas

## 30. Caja

#### BP-30.1 · CashRegister / CashSession
Se conservan: una sesión abierta por caja (índice parcial), lock de sesión compartido con el cobro en efectivo, `expectedCash`/`countedCash`/`difference` materializados al cerrar, transacción Serializable con reintento acotado. Se re-apuntan a Location (sección 6).

#### BP-30.2 · CashMovement
Ledger append-only. Existen: `OPENING`, `SALE_INCOME`, `CLOSING`, `WITHDRAWAL`, `EXPENSE`, `WITHDRAWAL_REVERSAL`, `EXPENSE_REVERSAL` (reversa única por original y de la misma sesión, FK compuesta). `MANUAL` existe en el enum pero no hay API que lo cree y **no hay CHECK que lo prohíba**: una fila `MANUAL` bloquea el cierre. V2: CHECK que prohíba `MANUAL`, más un camino supervisado de remediación para filas existentes (resultado de la consulta a PILOT: PRD Apéndice D).

#### BP-30.3 · Tipos nuevos
`EMPLOYEE_PAYMENT_INCOME` (sección 26), `SENA_INCOME` (sección 28) y, si se implementa, un ingreso manual de efectivo auditado distinto de `MANUAL`. Cada uno tiene su FK única al documento de origen y su regla de signo. Los tenders internos (`InternalTenderType`: `SENA_ADVANCE`, `EXCHANGE_RECOGNITION`, `SENA_VOUCHER`) **no tienen CashMovement**.

## 31. Conciliación y cierre

#### BP-31.1 · Conciliación
`reconcileCashSession` compara 1:1 pagos en efectivo con sus `SALE_INCOME`, y suma los nuevos tipos (`EMPLOYEE_PAYMENT_INCOME`, `SENA_INCOME`). Los tenders internos no son `SalePayment` ni tienen CashMovement, por lo que no entran en la conciliación; cualquier movimiento no permitido bloquea el cierre (409). Prueba de regresión: un cambio directo (solo tender interno) no altera el efectivo esperado.

#### BP-31.2 · Cierre por medio
El cierre muestra esperado vs. declarado para cada medio no efectivo (transferencia, débito, crédito, QR) usando `SalePayment`, `ExternalCollection` y `SenaPayment`.

#### BP-31.3 · Diferencia grande
`CompanyOperationalConfig.cashDifferenceApprovalThreshold` (nulo = regla inactiva; **TBD**). Si `|difference|` lo supera, el cierre exige aprobación `CASH_DIFFERENCE`. Hasta definir el valor, el cierre se comporta como hoy.

## 32. Gastos y tesorería

#### BP-32.1 · Gastos
`EXPENSE` de caja = caja chica con detalle obligatorio (ya existe, con reversa). Los gastos administrativos van a una tabla propia `Expense` (NEW) + `ExpenseCategory`, **fuera de `CashSession`**, salvo cuando el dinero realmente sale de la caja (entonces se registra como `EXPENSE` de caja). Categoría obligatoria; comprobante opcional; admite medios no efectivo.

#### BP-32.2 · Tesorería
Todo `WITHDRAWAL` de caja registra su destino (`TreasuryDestination` NEW: caja fuerte, banco); depósitos bancarios conciliables contra retiros.

#### BP-32.3 · Exportación administrativa
Reporte de solo lectura por período y sucursal, por ledger y contraparte (caja, gastos, compras y proveedores, cuenta de empleados, liquidaciones), sin doble partida. Debe cuadrar con los cierres de caja y los saldos derivados.

## 33. Compras

#### BP-33.1 · Supplier
`Supplier` (NEW): ABM auditado con `SUPPLIER_MANAGE`; cuenta de proveedor derivada del ledger.

#### BP-33.2 · PurchaseOrder
`PurchaseOrder` + `PurchaseOrderItem` (NEW): proveedor, ítems, cantidades pedidas; estados `OPEN` → `PARTIALLY_RECEIVED` → `RECEIVED` (derivados de las recepciones).

#### BP-33.3 · Recepción y deuda
Una recepción (`GoodsReceipt`, sección 22) genera `SupplierAccountMovement` (NEW, append-only, deuda positiva) por el valor recibido, en la misma transacción que los movimientos de stock.

#### BP-33.4 · Pago a proveedor
`SupplierPayment` (NEW) reduce la deuda con un `SupplierAccountMovement` negativo; medio, referencia, autor y fecha. Reversas explícitas, saldo derivado, sin UPDATE/DELETE. Mismo patrón que el ledger de empleados.

# Parte I — Comprobantes

## 34. Ticket no fiscal

#### BP-34.1 · Ticket
Documento de venta (y de cierre de caja y de cambio) generado por el backend y reimprimible; identifica la venta original por `saleNumber`. Impresión térmica desde la app de caja. Sin modelo propio: se renderiza desde `Sale`, `Exchange` y `CashSession`.

## 35. ARCA

#### BP-35.1 · Integración con fallback
Integración digital con ARCA mediante un proveedor o servicio externo detrás de una interfaz `FiscalProvider` (no se diseña WSFE); al finalizar la venta el cajero elige ticket no fiscal o factura ARCA. Tabla `FiscalDocument` (NEW, P1): `saleId`, estado, CAE, errores. Si ARCA no está disponible, la venta se completa y el comprobante queda en estado `MANUAL_PENDING` para regularizarse por el camino manual.

# Parte J — Transversales

## 36. AuditLog

#### BP-36.1 · Escritura y consulta
`createAuditLog(tx, …)` en la misma transacción de toda mutación relevante. `GET /audit` con `AUDIT_VIEW`. Se agrega el trigger de inmutabilidad (sección 42) y, para operaciones autorizadas, el id de `SupervisorApproval`. Los campos `before/after` pasan por `toJsonSafe` y nunca contienen secretos ni PIN.

## 37. Alertas y tiempo real

#### BP-37.1 · Alert (NEW)
`Alert`: `type`, `severity`, `locationId`, `entityType/entityId`, `payload` (sin datos sensibles), `createdAt`, `resolvedAt` (nullable), `resolvedById`. Tipos: `TRANSFER_PENDING_REVIEW`, `EMPLOYEE_WITHDRAWAL`, `DISCOUNT`, `SALE_CANCELLATION`, `EXCHANGE_NO_TICKET`, `SUPERVISED_ACTION`. Se crea en la misma transacción de la operación. Las alertas de revisión de transferencias **se cierran solo por la resolución**, no por lectura; las demás pueden marcarse leídas (tabla `AlertRead`).

#### BP-37.2 · Tiempo real
Socket.IO con scope tomado al conectar (deuda conocida). V2 agrega la reconexión forzada al cambiar o revocar el scope para cumplir `NFR-SEC-002`. Eventos emitidos después del commit.

## 38. Reportes

#### BP-38.1 · Reportes
Consultas de solo lectura: ventas por local, medio y vendedor; cierres de caja; margen; valorización y rotación de stock; deuda de empleados (suma de saldos derivados); indicadores "de hoy" sobre el día operativo de Argentina. Cada reporte diario debe cuadrar con los cierres de caja.

## 39. Configuración

#### BP-39.1 · CompanyOperationalConfig (NEW)
Una fila por empresa: `employeeDebtLimit` (BigInt, inicial 30000000), `exchangeWindowDays` (Int, inicial 15), `senaMinimumAmount` (BigInt, nulo = sin mínimo, **TBD**), `stockAdjustmentApprovalThreshold` (nulo, **TBD**), `cashDifferenceApprovalThreshold` (nulo, **TBD**), `updatedAt`, `updatedById`. Los bps de precio permanecen en `CompanyPricingConfig`. Los locales y medios del checkout pasan del entorno a esta configuración (o a una tabla relacionada), auditados.

#### BP-39.2 · Permisos y auditoría
Cambio solo con `CONFIG_MANAGE` (ADMIN con scope COMPANY, OWNER); CASHIER y SELLER no pueden. Cada cambio escribe AuditLog (`before/after`). Un valor nulo significa "regla inactiva hasta que el OWNER defina el valor", exactamente como pide el PRD (Apéndice D).

#### BP-39.3 · Sin valores fijos en el código
Los valores de `FR-CONF-002` se leen siempre de la configuración; una prueba falla si aparece una constante de negocio equivalente en el código.

# Parte K — Datos e invariantes

## 40. Máquinas de estado

#### BP-40.1 · Catálogo
El Apéndice B contiene el catálogo completo (estados, transiciones, quién las dispara, restricciones de la base que las protegen). Todas las máquinas se derivan del PRD; los estados técnicos que el Blueprint agrega (`SETTLING`, `OPEN`/`ABANDONED` del cambio) están marcados como tales y no alteran reglas.

## 41. Invariantes monetarias y de stock

#### BP-41.1 · Monetarias
- Importes enteros en centavos (`NFR-MONEY-001`); suma de una distribución = total exacto.
- Saldos derivados y reconstruibles (`NFR-MONEY-003`).
- Valores congelados al ejecutar (precio, bps, valor reconocido, precio de retiro, snapshot de Seña).
- Ningún tender interno genera dinero ni se retira como efectivo.
- Reversas únicas y vinculadas a un solo original.

#### BP-41.2 · Stock
- Disponible ≥ 0 y `reserved ≤ physical` (CHECK).
- Toda variación de `physical` tiene un StockMovement con su documento.
- Σ unidades repuestas ≤ unidades vendidas por línea.
- Una unidad no puede estar a la vez reservada por dos dueños (suma de reservas = `reserved`).

## 42. Inmutabilidad de ledgers

#### BP-42.1 · Mecanismos por ledger
| Ledger | Estado hoy | V2 |
|---|---|---|
| StockMovement | Sin protección | Trigger `BEFORE UPDATE OR DELETE`; CHECK de FK-por-tipo |
| CashMovement | Reversa única con FK compuesta | + trigger; + CHECK sin `MANUAL` |
| AuditLog | Sin protección | Trigger `BEFORE UPDATE OR DELETE` |
| EmployeeAccountMovement | NEW | Trigger desde el origen; CHECK de signo/FK-por-tipo; UNIQUE de reversa y OPENING |
| SupplierAccountMovement | NEW | Ídem |
| ExternalCollection / SalePayment / CheckoutAttempt | Triggers F1–F5 | Sin cambios |
Antes de cada trigger se verifica que ningún flujo existente haga UPDATE/DELETE sobre la tabla.

## 43. Idempotencia

#### BP-43.1 · Estrategia
Toda operación crítica lleva una clave de idempotencia (`(userId, idempotencyKey)` único, ya en StockMovement, CashMovement y SalePayment; `operationKey` del checkout). Reintentar con la misma clave y el mismo payload devuelve el resultado original; con payload distinto, 409. La clave se escribe en la misma transacción que el efecto. Para aprobaciones, el consumo único (BP-8.1) cumple el mismo rol.

## 44. Concurrencia, locking y reintentos

#### BP-44.1 · Aislamiento
Serializable para operaciones que combinan stock y dinero (caja, ajustes, reserva y recuperación de checkout, retiros, transferencias, activación y expiración de Seña); ReadCommitted con locks de fila donde el patrón actual lo usa (cierre de checkout); RepeatableRead para lecturas consistentes (cotización).

#### BP-44.2 · Orden de locks
Orden global para evitar interbloqueos: (1) sesión de caja; (2) filas de venta/documento; (3) cuenta de empleado; (4) Inventory por `(variantId, locationId)` ascendente; (5) filas de `SaleItem` originales por id ascendente. Siempre el mismo orden entre operaciones.

#### BP-44.3 · Reintento acotado
Ante `40001`/`40P01` el servicio reintenta un número fijo de veces con backoff corto y luego devuelve un error de concurrencia (patrón de `cash.service.ts`). Los reintentos reutilizan la misma clave de idempotencia.

#### BP-44.4 · Por recurso
| Recurso | Estrategia |
|---|---|
| Stock | Serializable + lock de Inventory ordenado |
| Sesión de caja | Lock de sesión + Serializable |
| Venta | Lock de la venta + `operationKey` del checkout |
| Cuenta de empleado | Lock de `EmployeeAccount`; saldo derivado dentro de la transacción |
| Transferencia | Lock del documento + Inventory ordenado |
| Expiración de Seña | `UPDATE … WHERE status='ACTIVE' …` + lock de Inventory |
| Scope de usuario | `FOR NO KEY UPDATE` sobre el usuario objetivo (sin cambios) |
| Reclamo de valor de cambio | Lock de `SaleItem` originales en orden de id |

# Parte L — Migración

## 45. Evolución de esquema

#### BP-45.1 · Reglas
- **No se modifica ninguna migración aplicada.** Toda evolución es aditiva (nuevas migraciones).
- Cambios destructivos solo por expand/contract en migraciones separadas.
- `ALTER TYPE … ADD VALUE` va en migración propia y los valores nuevos se usan recién en migraciones posteriores.
- Cada migración se valida en un cluster descartable (suites PG) antes de pasar a PILOT.

#### BP-45.2 · Numeración
Las migraciones usan timestamp UTC `YYYYMMDDHHMMSS_nombre`, estrictamente crecientes y únicos (hoy la última es `20261021130000_warehouse_stock_adjustment`, m13). Antes de la Seña hay varias migraciones P0/P1 (QR, ledgers, Location, aprobaciones, empleados, tender interno, cambios, transferencias, clientes). Por eso la Seña **no** se llama "la próxima migración": se designa **migration set S12** (Apéndice D) y recibirá su gate y timestamp reales cuando llegue su implementación. El WIP descartado (`20261021130000_sena_deposit`) no se usa ni se reutiliza.

#### BP-45.3 · Pins de readiness
`checkout-readiness.ts` fija columnas, CHECKs y triggers hasta G13. Cada conjunto de migraciones de V2 sube el pin a G14, G15…, y el chequeo de arranque falla si el esquema no coincide. El Apéndice D lista cada conjunto con su pin.

#### BP-45.4 · Conjuntos de migraciones
Orden y contenido en el Apéndice D (S1 a S15). Los timestamps allí son **indicativos**; se fijan al crear cada migración.

## 46. Branch/Location expand/contract

#### BP-46.1 · Plan
Pasos de BP-6.3 convertidos en migraciones: S3 (FK de seguridad + tablas nuevas con Location), S3b (re-apuntar FKs por tabla), S15 (contract). Para cada tabla: agregar FK a Location, backfill innecesario (mismo id), cambiar lecturas/escrituras, verificar con prueba PG que ninguna fila tiene `branchId` huérfano, y recién entonces quitar la FK a Branch. Las FKs compuestas del checkout se re-crean en el mismo paso que su tabla.

## 47. Saldos iniciales de empleados

#### BP-47.1 · Importación
Herramienta de importación (script de administración, no ruta pública) que lee una lista origen (empleado, saldo) y una **fecha de corte** (datos de despliegue, PRD Apéndice D), crea los `Employee` faltantes y un `OPENING_BALANCE` por empleado. Es idempotente por empleado (el índice único parcial rechaza el segundo), tiene modo **simulación** y emite un informe que compara lo importado con el origen. Corre solo con aprobación del OWNER; no se ejecuta en este bloque.

## 48. FIXED_TOTAL → PROPORTIONAL_V1

#### BP-48.1 · Plan
1. Guard `FR-PAY-006` sobre el camino FIXED_TOTAL (referencia obligatoria no efectivo).
2. Soportar QR en el motor (BP-12.2).
3. Mover la activación por local del entorno a configuración (BP-39.1).
4. Activar PROPORTIONAL_V1 local por local; verificar con el cierre de caja.
5. Desactivar la escritura FIXED_TOTAL en cada local migrado. Las ventas históricas FIXED_TOTAL quedan de solo lectura (y su "pagado por línea" por la reconstrucción legacy marcada).
6. Contract: retirar el código de escritura FIXED_TOTAL cuando ningún local lo use. Nunca se borran las filas históricas.

## 49. Seña (migration set S12)

#### BP-49.1 · Conjunto de migraciones de la Seña
Customer ya existe (S11), el tender interno ya existe (S8), la configuración ya existe (S4). El conjunto `S12` agrega `Sena`, `SenaItem`, `SenaPayment`, la extensión de `StockReservation`, `CashMovementType.SENA_INCOME` y los triggers de estado; `S13` agrega `SenaVoucher`. Diseñado desde el PRD, incluidas OR-052 y OR-053.

#### BP-49.2 · WIP histórico
`feat/sena-five-day-expiry` y su migración no son fuente de verdad. Pueden consultarse como ideas (sweeper, estructura de pruebas), pero nada se copia sin pasar por este diseño. Su plazo de 5 días queda reemplazado por 120 h exactas.

## 50. PILOT G11 → G actual

#### BP-50.1 · Plan
`pilot` está en G11; faltan m12 `r3_card_credit` y m13 `warehouse_stock_adjustment` y todo lo de V2. Pasos: (1) backup verificado; (2) dry-run en LOCAL_TEST; (3) aprobación del OWNER; (4) migración G11→G13; (5) migraciones V2 por conjuntos, cada una con su pin; (6) verificación de readiness. Se decide en bloques de despliegue aparte; **no se ejecuta aquí**.

# Parte M — Operabilidad

## 51. Readiness

#### BP-51.1 · Chequeo de arranque
`assertR3Ready` se extiende por conjunto de migraciones (columnas, CHECKs, triggers, pins); el servidor no arranca con un esquema desactualizado y reporta el motivo (`NFR-OPS-002`).

## 52. Estrategia de pruebas

#### BP-52.1 · Niveles
- **Unitarias puras:** motor de checkout, primitivas de dinero (propiedades: suma exacta, independencia del orden), cálculo de plazo y semana.
- **Integración con base descartable (opt-in `*.pg.test.ts`):** concurrencia de stock y caja, retiros simultáneos sobre la última unidad, expiración de Seña repetida, aprobación de uso único, reversa única, límites de devolución, doble reposición, conciliación con tenders internos, inmutabilidad (UPDATE/DELETE rechazados), transferencias con diferencias, regresión del lock de scope.
- **Regresión del checkout:** todas las suites existentes siguen verdes tras cada extensión del motor (QR, tender interno, cero balance).
- **Pruebas rojas:** las pruebas de concurrencia se verifican contra una mutación (por ejemplo, quitar un lock) para demostrar que fallan.
- Prueba de que ningún valor de negocio de `FR-CONF-002` está fijo en el código.

## 53. CI

#### BP-53.1 · Cobertura
El CI corre además los tests de `admin` y las suites PG con sus flags en un cluster descartable (`NFR-OPS-003`); análisis de secretos (semgrep) y `npm audit` de los tres componentes en cero.

## 54. Despliegue y retorno

#### BP-54.1 · Promoción
Promoción reproducible System V2 → PILOT con gate de readiness y camino de retorno ensayado en LOCAL_TEST (runbook por conjunto de migraciones). Nada se despliega sin respaldo verificado y aprobación del OWNER.

## 55. Seguridad

#### BP-55.1 · Controles
Se conservan helmet, CORS, límite global de requests, límite de intentos de login, JWT con contexto de autorización recargado por request, bcrypt, semgrep. V2 suma: autorización supervisada (sección 8), redacción de campos secretos en logs, revocación de scope en tiempo real y `npm audit` en cero. MFA y rotación/revocación de sesiones JWT **no** son requisitos del PRD y quedan diferidos (Apéndice F).

#### BP-55.2 · Observabilidad
El PRD no define requisitos de observabilidad. El Blueprint solo conserva los logs de request con id y la redacción de secretos; la observabilidad ampliada queda diferida (Apéndice F).

# Apéndices

## Apéndice A — PRD → Blueprint

**Tabla 1 — Dominios de la Matrix R4 → secciones del Blueprint**

| Dominio Matrix | Secciones del Blueprint |
|---|---|
| 1 | 9 |
| 2 | 9 |
| 3 | 10 |
| 4 | 11 |
| 5 | 12 |
| 6 | 12, 48 |
| 7 | 12 |
| 8 | 30 |
| 9 | 30 |
| 10 | 31 |
| 11 | 15 |
| 12 | 16 |
| 13 | 17 |
| 14 | 18 |
| 15 | 18 |
| 16 | 19, 42 |
| 17 | 20 |
| 18 | 5, 21 |
| 19 | 21 |
| 20 | 22 |
| 21 | 33 |
| 22 | 33 |
| 23 | 7 |
| 24 | 23 |
| 25 | 7 |
| 26 | 7 |
| 27 | 5, 6, 46 |
| 28 | 37 |
| 29 | 36 |
| 30 | 38 |
| 31 | 13 |
| 32 | 28 |
| 33a | 29 |
| 34 | 32 |
| 35 | 32 |
| 36 | 32 |
| 37 | 35 |
| 38 | 34 |
| 39 | 9 |
| 40 | 39 |
| 41 | 55 |
| 42 | 45, 50 |
| 43 | 51 |
| 44 | 52, 53 |
| 45 | 54 |
| 46 | 27 |
| 47 | 4 |
| 48 | 14 |
| 49 | 11 |
| 50 | 37 |
| 51 | 42 |
| 52 | 24 |
| 53 | 25 |
| 54 | 26 |

**Tabla 2 — Requisitos del PRD → anclas del Blueprint**

Cada requisito apunta a una o más anclas `BP-x.y`. La asignación detallada, requisito por
requisito, está en la columna "Blueprint Reference" de `docs/product/PRD-V2-TRACEABILITY.md`.

| Prefijo | Requisitos | Anclas por defecto |
|---|---|---|
| FR-ORG | 5 | BP-5.1, BP-5.2, BP-5.3, BP-5.4 |
| FR-CAT | 7 | BP-9.1, BP-9.2 |
| FR-PRICE | 9 | BP-10.1, BP-10.4 |
| FR-SALE | 6 | BP-11.1, BP-11.2, BP-11.5 |
| FR-WHOL | 2 | BP-14.1 |
| FR-PAY | 12 | BP-12.1, BP-12.2, BP-12.5, BP-12.6 |
| FR-CASH | 13 | BP-30.1, BP-30.2, BP-31.1 |
| FR-CANCEL | 9 | BP-15.1, BP-15.2 |
| FR-EXCH | 16 | BP-16.1, BP-16.4 |
| FR-DISC | 5 | BP-17.1 |
| FR-STOCK | 7 | BP-18.1, BP-18.2, BP-19.1 |
| FR-ADJ | 4 | BP-20.1, BP-20.2 |
| FR-TRANSFER | 8 | BP-21.1, BP-21.2, BP-21.3 |
| FR-RECV | 4 | BP-22.1 |
| FR-EMP | 7 | BP-23.1 |
| FR-EMPACC | 10 | BP-23.2, BP-24.1, BP-24.2 |
| FR-EMPWD | 10 | BP-25.1, BP-25.2, BP-25.3 |
| FR-EMPSET | 13 | BP-26.1, BP-26.3 |
| FR-CUST | 3 | BP-27.1 |
| FR-SENA | 14 | BP-28.1, BP-28.2 |
| FR-VOUCH | 12 | BP-29.1 |
| FR-SUPP | 2 | BP-33.1 |
| FR-PURCHASE | 3 | BP-33.2 |
| FR-SUPDEBT | 3 | BP-33.3, BP-33.4 |
| FR-EXP | 4 | BP-32.1 |
| FR-TREAS | 4 | BP-32.2, BP-32.3 |
| FR-USER | 5 | BP-7.4 |
| FR-RBAC | 4 | BP-7.1, BP-7.2 |
| FR-AUTH | 10 | BP-8.1, BP-8.2 |
| FR-ALERT | 4 | BP-37.1 |
| FR-AUDIT | 4 | BP-36.1 |
| FR-RPT | 5 | BP-38.1 |
| FR-TICKET | 3 | BP-34.1 |
| FR-ARCA | 3 | BP-35.1 |
| FR-CONF | 3 | BP-39.1, BP-39.2 |
| FR-MIG | 2 | BP-47.1 |
| NFR-SEC | 5 | BP-55.1, BP-7.3 |
| NFR-MONEY | 5 | BP-41.1, BP-42.1 |
| NFR-STOCK | 3 | BP-41.2, BP-42.1 |
| NFR-CONC | 3 | BP-44.1, BP-44.4 |
| NFR-IDEMP | 2 | BP-43.1 |
| NFR-AUDIT | 3 | BP-36.1, BP-8.6 |
| NFR-TIME | 2 | BP-4.3 |
| NFR-OPS | 6 | BP-45.1, BP-51.1, BP-53.1, BP-54.1 |

## Apéndice B — Catálogo de máquinas de estado

| Entidad | Estados | Transiciones | Quién | Protección |
|---|---|---|---|---|
| Sale | DRAFT, PENDING_PAYMENT, PAID, COMPLETED, CANCELLED | DRAFT→PENDING_PAYMENT→PAID→COMPLETED; DRAFT/PENDING→CANCELLED | Vendedor, cajero, motor de checkout | Triggers de pago y CHECKs existentes |
| Estado posterior al cobro | derivado | existencia de SaleCancellation / ExchangeReturnLine | — | UNIQUE(saleId), invariantes BP-16.7 |
| CheckoutAttempt | RESERVED, CONFIRMED, REJECTED, ABANDONED | según R3 | Cajero / motor | Triggers F1–F5 |
| CashSession | OPEN, CLOSED | OPEN→CLOSED | Cajero | Índice parcial, conciliación |
| Transfer | PENDING_DISPATCH, IN_TRANSIT, RECEIVED, PENDING_REVIEW, RESOLVED | PENDING_DISPATCH→IN_TRANSIT→RECEIVED \| PENDING_REVIEW→RESOLVED | Depósito (con ADMIN), CASHIER destino, ADMIN | CHECK recibido ≤ despachado, trigger de transición |
| Exchange | OPEN, COMPLETED, ABANDONED (técnicos) | OPEN→COMPLETED \| ABANDONED | Cajero, hook de cierre | UNIQUE(replacementSaleId), invariantes BP-16.7 |
| SaleCancellation | sin estados (operación única) | — | ADMIN/OWNER vía aprobación | UNIQUE(saleId) |
| Sena | ACTIVE, SETTLING (técnico), COMPLETED, EXPIRED, CANCELLED | ACTIVE→SETTLING→COMPLETED; ACTIVE→EXPIRED; ACTIVE→CANCELLED; SETTLING→ACTIVE \| EXPIRED | Cajero, sweeper | UPDATE condicional, trigger de estados |
| SenaVoucher | ISSUED, USED | ISSUED→USED; solo nace de Seña CANCELLED manual | ADMIN emite; motor al usar | UNIQUE(senaId), UNIQUE(senaVoucherId) en tender |
| EmployeeWithdrawal | REGISTERED | con devoluciones | CASHIER | Trigger diferido stock↔deuda |
| SupervisorApproval | GRANTED, CONSUMED | GRANTED→CONSUMED (una vez) | ADMIN/OWNER, operación de dominio | Trigger de transición única |
| PurchaseOrder | OPEN, PARTIALLY_RECEIVED, RECEIVED | derivado de recepciones | Compras | Derivado |
| GoodsReceipt | RECORDED | — | Depósito | UNIQUE por remito |

## Apéndice C — Matriz de permisos

| Permiso | OWNER | ADMIN | CASHIER | SELLER | WAREHOUSE | Consumidor |
|---|---|---|---|---|---|---|
| `SUPERVISOR_APPROVE` (nuevo) | ✓ | ✓ (COMPANY) | — | — | — | BP-8 |
| `SUPERVISOR_PIN_MANAGE` (nuevo, propio) | ✓ | ✓ | — | — | — | BP-8.3 |
| `CONFIG_MANAGE` (nuevo) | ✓ | ✓ (COMPANY) | — | — | — | BP-39 |
| `PRICE_MANAGE` (existe) | ✓ | ✓ (COMPANY) | — | — | — | BP-10 |
| `SALE_REVERSE_REQUEST` (nuevo) | ✓ | ✓ | ✓ | — | — | BP-15 |
| `EXCHANGE_MANAGE` (existe) | ✓ | ✓ | ✓ | — | — | BP-16 |
| `EMPLOYEE_MANAGE` (nuevo) | ✓ | ✓ | — | — | — | BP-23 |
| `EMPLOYEE_WITHDRAWAL_CREATE` (nuevo) | ✓ | ✓ | ✓ | — | — | BP-25 |
| `EMPLOYEE_PAYMENT_RECORD` (nuevo) | ✓ | ✓ | ✓ | — | — | BP-26 |
| `EMPLOYEE_SETTLEMENT_MANAGE` (nuevo) | ✓ | ✓ | — | — | — | BP-26 |
| `TRANSFER_*` (existen) | según etapa: dispatch con ADMIN; recepción CASHIER; resolución ADMIN | | | | depósito prepara | BP-21 |
| `INVENTORY_MANAGE` (existe) | ✓ | ✓ | según política actual | — | ✓ | BP-20 |
| `SENA_CREATE/MANAGE/SETTLE` (existen) | ✓ | ✓ | ✓ (create/settle) | — | — | BP-28 |
| `GOODS_RECEIPT_MANAGE`, `SUPPLIER_MANAGE` (existen) | ✓ | ✓ | — | — | recepción | BP-22, 33 |
| `AUDIT_VIEW` (existe) | ✓ | ✓ | — | — | — | BP-36 |

Los permisos nuevos se otorgan solo cuando existe su funcionalidad (`FR-RBAC-003`). La asignación a CASHIER de registrar pagos de empleado es una decisión técnica por defecto; el PRD no nombra al actor, y queda como pregunta abierta de confirmación.

## Apéndice D — Plan de migraciones

Los timestamps son **indicativos**; se fijan al crear la migración y deben ser distintos de
`20261021130000` y estrictamente crecientes. Ningún conjunto modifica migraciones aplicadas.

| Conjunto | Contenido (aditivo) | Pin | Depende de |
|---|---|---|---|
| S1 | QR en el motor: columnas de snapshot QR, CHECKs; guard FIXED_TOTAL | G14 | — |
| S2 | Triggers de inmutabilidad (StockMovement, CashMovement, AuditLog); CHECK sin MANUAL | G15 | — |
| S3 | Location: FK de seguridad Branch↔Location; tablas nuevas con Location | G16 | — |
| S4 | CompanyOperationalConfig; SupervisorPin; SupervisorApproval; Alert; permisos | G17 | S3 |
| S5 | Valores de enum de StockMovementType y FKs tipadas al documento | G18 | S2 |
| S6 | Employee, EmployeeAccount, EmployeeAccountMovement (+OPENING) | G19 | S3, S5 |
| S7 | Retiro/devolución, EmployeePayment, EmployeeSettlement, CashMovementType de pago | G20 | S6 |
| S8 | `InternalTenderType`, `SaleInternalTender`, `SaleInternalTenderAllocation`, plan INTERNAL_ONLY, `Sale.origin` (sin tocar `PaymentMethod`) | G21 | S1 |
| S9 | SaleCancellation, Exchange, ExchangeReturnLine, trigger de doble reposición | G22 | S4, S5, S8 |
| S10 | Transfer, TransferItem, TransferReceipt, TransferResolution | G23 | S3, S4, S5 |
| S11 | Customer; descuentos; ticket/fiscal | G24 | S4 |
| S12 | **Seña** (migration set S12): Sena, SenaItem, SenaPayment, StockReservation XOR, SENA_INCOME | gate/timestamp reales al implementar (propuesto G25) | S4, S5, S8, S11 |
| S13 | SenaVoucher | G26 | S12 |
| S14 | Compras: Supplier, PurchaseOrder, GoodsReceipt, SupplierAccountMovement, Expense, tesorería | G27 | S5 |
| S15 | Contract Branch→Location | G28 | S3 y migración completada |

El orden de entrega sigue la Matrix R4 (secciones 5 y 6 del orden de implementación); S8 se
adelanta a S9 porque Cambios y Seña dependen del tender interno.

## Apéndice E — Deuda técnica

- `createTestPrismaClient()` no expone el pool (no se puede cerrar).
- Aviso de `pg` por queries concurrentes en el mismo cliente en algunos tests.
- Scope de Socket.IO como snapshot de conexión (se resuelve en BP-37.2).
- `backoffice/users` con presentación legada derivada de `UserBranchRole`.
- Código dormido de vencimiento de reservas de venta.
- 76 errores base en `tsconfig.check.json` ya existentes.

## Apéndice F — Decisiones explícitamente diferidas

Reglas OWNER cerradas que ya no son preguntas: `SUNDAY_MOVEMENT_WEEK = NEXT_MONDAY_CYCLE` (OR-054), pago de deuda de empleado ≤ saldo pendiente (OR-055) y cantidad reversible (OR-056).

- **`PIN_LENGTH`:** default técnico pendiente de revisión en la implementación (no es regla OWNER).
- **Criptografía adicional del PIN** más allá de bcrypt cost 12 y bloqueo persistente: se reevalúa tras la primera revisión de seguridad.
- **MFA y rotación/revocación de sesiones JWT:** no son requisitos del PRD.
- **Observabilidad ampliada:** sin requisito.
- **Tope legado de 100 unidades por ajuste** (`LEGACY_HARD_CAP`): a revisar o reemplazar al implementar el dominio de ajustes (BP-20.2); unidad del umbral de autorización y su valor: TBD.
- **Valor del umbral de diferencia de caja y mínimo de Seña:** TBD (datos de despliegue).
- **Taxonomía detallada de motivos de resolución de `PENDING_REVIEW`:** evoluciona sin cambiar la máquina de estados (BP-21.6).
- **Códigos de error** de las restricciones (por ejemplo, pago excesivo de empleado, sin cantidad reversible): se fijan en la implementación.
- **Anulación de un cambio ya completado:** fuera del alcance del PRD.
- **Duplicados de cliente por teléfono:** no se impone unicidad hasta que el negocio lo pida.
