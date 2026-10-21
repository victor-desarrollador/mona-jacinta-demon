# PRD V2 — Mona Jacinta

```
DOCUMENTO=PRD V2
BASE_BRANCH=integration/system-v2
BASE_HEAD=16144ddbd7b2ace0068e2aec0934dfa73f8ccff3
CONTRATO_DE_ENTRADA=docs/product/SYSTEM-V2-PRODUCT-GAP-MATRIX-R4.md
TRAZABILIDAD=docs/product/PRD-V2-TRACEABILITY.md
```

Este PRD define **qué** debe hacer Mona Jacinta, **para quién**, **bajo qué reglas de
negocio** y **con qué criterios verificables**. Describe el producto objetivo completo.
La prioridad (P0/P1/P2) indica únicamente el **orden de entrega**; el estado de
implementación pertenece a la Matrix R4 y no se repite aquí.

Queda fuera de este documento (corresponde al Blueprint V2): modelos Prisma, migraciones,
claves foráneas, CHECKs, índices, triggers, estrategias de bloqueo y niveles de aislamiento,
módulos de código, rutas y endpoints exactos, algoritmos internos, protocolo del PIN
(almacenamiento, intentos, bloqueos, criptografía) y diseño de CI/deploy.

## Convenciones

- **ID:** `<FR|NFR>-<PREFIJO>-<NNN>`. Los IDs son inmutables: no se reutilizan ni se
  renumeran. Un requisito retirado queda como `DEPRECATED` con motivo.
- **Lenguaje normativo:** DEBE / NO DEBE / PUEDE. Una regla principal por requisito.
- **Campos:** obligatorios `Prioridad`, `Origen`, `Regla`, `Aceptación`; opcionales `Actor`,
  `Resultado esperado`, `Excepciones`, `Autorización/Auditoría`, `Dependencias`.
- **Origen:** dominio(s) de la Matrix R4 y regla(s) OWNER (`OR-nnn`, ver Apéndice B).
- **Prioridad:** hereda la del dominio de origen en la Matrix R4. Cuando difiere, se
  justifica en el requisito.
- **Administración:** los roles ADMIN y OWNER. El OWNER posee todas las facultades del ADMIN.
- **Montos:** pesos argentinos; los importes se tratan como enteros en centavos (ver NFR-MONEY).

# Parte A — Contexto

## 1. Propósito del producto

Mona Jacinta es el sistema de gestión de una tienda de ropa con **5 locales y 1 depósito
central**. Opera con dinero real y stock real. Su propósito es que cada venta, cobro, cambio,
movimiento de stock, retiro de empleado, seña y operación de abastecimiento quede registrado
de forma verificable, auditable y conciliable, sin depender de planillas, papel ni ajustes
manuales fuera del sistema.

El sistema reemplaza el sistema anterior y cubre la operación completa, no solamente el
piloto actual.

## 2. Alcance y fuera de alcance

**Dentro del alcance (versión completa de System V2):**

- Catálogo, variantes, etiquetas y precios con recargos por medio de pago.
- Venta, checkout proporcional, medios de pago (incluido QR), caja y arqueo.
- Anulaciones posteriores al cobro, cambios y descuentos con autorización supervisada.
- Inventario, ajustes, transferencias entre depósito y locales, y recepción de mercadería.
- Empleados, cuenta corriente, retiro de mercadería y liquidación semanal.
- Clientes, Señas y Voucher de Seña.
- Proveedores, compras y deuda con proveedores; gastos; tesorería y administración financiera operativa.
- Usuarios, roles, permisos, alertas, auditoría y reportes.
- Ticket no fiscal y facturación ARCA con fallback manual.
- Migración del saldo vigente de empleados desde el sistema anterior.

**Fuera de alcance:**

- Motor de promociones; pricelists genéricas.
- Contabilidad completa (plan de cuentas, doble partida); el producto cubre solo la capa
  administrativo-financiera operativa.
- Nómina o cálculo de sueldos; módulo de RRHH.
- StoreCredit o vale general; gift cards genéricas (ver Apéndice C).
- Límite de deuda individual por empleado (por ahora solo existe el límite global).
- Ubicaciones internas tipo bin dentro del depósito.
- Métricas o SLA de rendimiento: no hay umbrales de negocio verificables y no se inventan
  (no existe `NFR-PERF`; se agregará el prefijo cuando haya métricas reales).

## 3. Principios operativos

1. **El dinero y el stock nunca se editan: se compensan.** Toda corrección posterior es un
   movimiento nuevo que referencia al original.
2. **Toda operación sensible tiene responsable identificado y queda auditada.**
3. **Lo que autoriza el supervisor queda registrado quién autorizó, qué y por qué.**
4. **El stock nunca es negativo y nunca se consume stock reservado.**
5. **Un cobro no efectivo siempre deja una referencia verificable.**
6. **Los valores de negocio son configuración auditada, no constantes en el código.**
7. **Una operación crítica ocurre completa o no ocurre; un reintento no la duplica.**
8. **El producto objetivo es único; FIXED_TOTAL es solo un modelo de transición.**

## 4. Actores y roles

| Actor | Descripción | Alcance |
|---|---|---|
| OWNER | Propietario. Posee todas las facultades de ADMIN. | Empresa |
| ADMIN | Administración: configuración, autorizaciones supervisadas, resolución de diferencias, gestión de usuarios. | Empresa |
| CASHIER | Cajero: cobra, cierra caja, procesa cambios con ticket, carga retiros de empleados, recibe transferencias. No autoriza descuentos. | Local asignado |
| SELLER | Vendedor: prepara ventas. No autoriza descuentos. | Local asignado |
| WAREHOUSE | Depósito: opera stock y despacha desde el depósito central. | Ubicación asignada |
| Empleado | Persona que retira mercadería con cargo a su cuenta. Puede o no ser usuario del sistema. | — |
| Cliente | Comprador; titular de Señas y Vouchers de Seña. | — |
| Proveedor | Contraparte de compras. | — |
| Contador | Receptor de las exportaciones administrativas. No opera el sistema. | — |

Los permisos de cada rol se detallan en la sección 31. Alcance de empresa = opera sobre todas
las ubicaciones; alcance de local = opera solo sobre las ubicaciones que tiene asignadas.

## 5. Organización: empresa, sucursales y depósito

#### FR-ORG-001 · Modelo único de ubicación
- **Prioridad:** P1 · **Origen:** Matrix 27 · OR-020
- **Regla:** El sistema DEBE representar sucursales y depósito central con un único modelo canónico de ubicación, con migración gradual desde los dos modelos actuales (expand/contract).
- **Aceptación:** Toda entidad operativa nueva (empleado, transferencia, movimiento) referencia la ubicación canónica; no existe sucursal sin su ubicación ni a la inversa durante la transición; tras la migración no queda duplicación de datos de ubicación.

#### FR-ORG-002 · Ubicaciones inactivas
- **Prioridad:** P1 · **Origen:** Matrix 27 · OR-020
- **Regla:** El sistema NO DEBE permitir operar sobre una ubicación inactiva en ningún flujo.
- **Aceptación:** Una venta, un movimiento de stock o una transferencia sobre una ubicación inactiva es rechazada en todos los flujos.

#### FR-ORG-003 · Depósito central como ubicación de abastecimiento
- **Prioridad:** P1 · **Origen:** Matrix 18 · OR-021
- **Regla:** El depósito central DEBE ser una ubicación identificable como tal, origen de los despachos hacia los locales y destino de las recepciones de proveedor.
- **Aceptación:** El tipo depósito se determina por un atributo explícito de la ubicación, no por una convención de nombre o código.

#### FR-ORG-004 · Gestión de ubicaciones
- **Prioridad:** P1 · **Origen:** Matrix 27, 28
- **Regla:** ADMIN u OWNER DEBEN poder consultar y mantener las ubicaciones (nombre, código, dirección, punto de venta y estado) desde la administración.
- **Aceptación:** Un cambio de datos de una ubicación queda auditado y se refleja en todos los flujos que la usan.

#### FR-ORG-005 · Día operativo
- **Prioridad:** P1 · **Origen:** Matrix 47 · OR-047
- **Regla:** El día operativo del negocio DEBE definirse en la zona America/Argentina/Buenos_Aires (ver NFR-TIME-001).
- **Aceptación:** Una venta realizada a las 22:30 hora de Argentina se informa en el día operativo correcto en dashboards, reportes y cierres.

# Parte B — Catálogo y precios

## 6. Catálogo, variantes y etiquetas

#### FR-CAT-001 · Gestión de productos
- **Prioridad:** P1 · **Origen:** Matrix 1
- **Regla:** ADMIN u OWNER DEBEN poder crear, editar y desactivar productos, con baja lógica y edición auditada.
- **Aceptación:** Editar y desactivar un producto deja registro de auditoría con autor y valores previos y nuevos.

#### FR-CAT-002 · Producto inactivo no vendible
- **Prioridad:** P1 · **Origen:** Matrix 1
- **Regla:** El sistema NO DEBE permitir vender un producto o variante inactivo.
- **Aceptación:** Agregar un ítem inactivo a una venta es rechazado.

#### FR-CAT-003 · Categorías y marcas
- **Prioridad:** P1 · **Origen:** Matrix 1
- **Regla:** ADMIN u OWNER DEBEN poder gestionar categorías y marcas desde la administración.
- **Aceptación:** Alta, edición y baja lógica de categoría y marca desde el admin, con auditoría.

#### FR-CAT-004 · Unicidad semántica de variantes
- **Prioridad:** P1 · **Origen:** Matrix 2
- **Regla:** El sistema NO DEBE permitir dos variantes del mismo producto con el mismo color y talle una vez normalizados.
- **Aceptación:** Crear "Rojo" y "rojo " para el mismo producto y talle es rechazado; el importador rechaza duplicados.

#### FR-CAT-005 · Identificadores únicos de variante
- **Prioridad:** P1 · **Origen:** Matrix 2
- **Regla:** Cada variante DEBE tener un SKU y un código de barras únicos.
- **Aceptación:** Un SKU o código de barras repetido es rechazado.

#### FR-CAT-006 · Edición y baja de variantes
- **Prioridad:** P1 · **Origen:** Matrix 2
- **Regla:** ADMIN u OWNER DEBEN poder editar y desactivar variantes con auditoría.
- **Aceptación:** Una variante desactivada deja de ser vendible y conserva su historial.

#### FR-CAT-007 · Etiquetas con código de barras
- **Prioridad:** P1 · **Origen:** Matrix 39
- **Regla:** El sistema DEBE permitir imprimir etiquetas con código de barras por variante, incluida la impresión en lote al recibir mercadería.
- **Aceptación:** Escanear la etiqueta impresa en caja resuelve la variante correcta.

## 7. Pricing y configuración comercial

#### FR-PRICE-001 · cashPrice como precio base
- **Prioridad:** P1 · **Origen:** Matrix 3 · OR-004
- **Regla:** El precio base efectivo de cada variante DEBE ser `cashPrice`.
- **Aceptación:** Ninguna lectura de venta usa un precio base distinto de `cashPrice`; una variante sin `cashPrice` no se puede vender.

#### FR-PRICE-002 · Recargos por medio de pago
- **Prioridad:** P1 · **Origen:** Matrix 3 · OR-005
- **Regla:** El sistema DEBE aplicar sobre el precio base un recargo configurable, expresado en puntos básicos (bps), por cada medio: lista, tarjeta de crédito, tarjeta de débito, transferencia bancaria y QR.
- **Aceptación:** Existen cinco parámetros de recargo (`listAdjustmentBps`, `creditCardAdjustmentBps`, `debitCardAdjustmentBps`, `bankTransferAdjustmentBps`, `qrAdjustmentBps`); el precio de una venta refleja el recargo del medio usado.

#### FR-PRICE-003 · Quién modifica los recargos
- **Prioridad:** P1 · **Origen:** Matrix 3, 40 · OR-005
- **Regla:** Solo ADMIN u OWNER PUEDEN modificar los recargos por medio de pago.
- **Aceptación:** Cualquier otro rol que intente modificarlos es rechazado; cada cambio queda auditado con autor.

#### FR-PRICE-004 · Efecto de un cambio de recargo
- **Prioridad:** P1 · **Origen:** Matrix 3 · OR-005
- **Regla:** Un cambio de recargo DEBE afectar solo operaciones futuras y cada venta DEBE conservar el recargo vigente al momento del cobro.
- **Aceptación:** Cambiar un bps no altera el importe de ventas ya cobradas.

#### FR-PRICE-005 · Recargo de QR configurable
- **Prioridad:** P1 · **Origen:** Matrix 3, 5 · OR-003
- **Regla:** El porcentaje de recargo de QR (`qrAdjustmentBps`) DEBE ser configurable por ADMIN u OWNER y NO DEBE estar fijado en el código.
- **Aceptación:** Cambiar el valor desde la configuración cambia el recargo de las ventas QR posteriores sin despliegue.

#### FR-PRICE-006 · Retiro del precio de lista legacy
- **Prioridad:** P1 · **Origen:** Matrix 3
- **Regla:** El sistema DEBE retirar el precio de lista transitorio, de modo que exista una única base de precio (`cashPrice`) más recargos.
- **Aceptación:** Ninguna operación de venta lee el precio de lista transitorio.

#### FR-PRICE-007 · Precio mayorista
- **Prioridad:** P2 · **Origen:** Matrix 3, 48
- **Regla:** El precio mayorista de una variante NO DEBE superar su `cashPrice`.
- **Aceptación:** Registrar un precio mayorista mayor que `cashPrice` es rechazado.

#### FR-PRICE-008 · Historial de precios
- **Prioridad:** P1 · **Origen:** Matrix 3
- **Regla:** El sistema DEBE permitir consultar el historial de cambios de precio de una variante.
- **Aceptación:** Para una variante se listan cambios con fecha, autor y valores previos y nuevos.

#### FR-PRICE-009 · Costo y margen
- **Prioridad:** P1 · **Origen:** Matrix 3, 30
- **Regla:** El sistema DEBE usar el costo de la variante para calcular el margen en reportes.
- **Aceptación:** Existe un reporte de margen por período y local.

# Parte C — Venta y cobro

## 8. Venta

#### FR-SALE-001 · Ciclo de vida de la venta
- **Prioridad:** P1 · **Origen:** Matrix 4
- **Regla:** Una venta DEBE recorrer los estados borrador, pendiente de pago, pagada y completada, con transiciones trazables.
- **Aceptación:** Toda venta tiene un estado final trazable; ninguna transición omite un estado.

#### FR-SALE-002 · Cancelación antes del pago
- **Prioridad:** P1 · **Origen:** Matrix 4
- **Regla:** Una venta en borrador o pendiente de pago PUEDE cancelarse, liberando su stock reservado.
- **Aceptación:** Cancelar libera la reserva; una venta con pago aceptado no se cancela por esta vía sino por FR-CANCEL.

#### FR-SALE-003 · Corrección de una venta pendiente
- **Prioridad:** P2 · **Origen:** Matrix 49
- **Regla:** El sistema DEBE permitir reemplazar los ítems de una venta pendiente de pago, ajustando las reservas y auditando el cambio.
- **Aceptación:** Tras la corrección las reservas coinciden con los nuevos ítems y queda registro de auditoría.

#### FR-SALE-004 · Estados posteriores al cobro
- **Prioridad:** P1 · **Origen:** Matrix 4 · OR-014
- **Regla:** El sistema DEBE ofrecer estados posteriores al cobro vinculados a la operación original, y NO DEBE editar ni borrar nunca una venta pagada o completada.
- **Aceptación:** Una venta anulada o con cambio muestra el vínculo a la operación que la modificó; sus datos originales permanecen intactos.

#### FR-SALE-005 · Efecto al completar
- **Prioridad:** P1 · **Origen:** Matrix 4, 14
- **Regla:** Al completar una venta el sistema DEBE descontar el stock físico, consumir la reserva y registrar el movimiento de stock, en una única operación.
- **Aceptación:** Tras completar, el físico baja, la reserva se consume y existe el movimiento de stock asociado, o no ocurre nada.

#### FR-SALE-006 · Número de venta no fiscal
- **Prioridad:** P1 · **Origen:** Matrix 4, 37
- **Regla:** Cada venta DEBE tener un número de venta identificable que NO se presenta como comprobante fiscal.
- **Aceptación:** El número de venta aparece en el ticket no fiscal y permite ubicar la venta original en un cambio.

#### FR-WHOL-001 · Venta mayorista autorizada
- **Prioridad:** P2 · **Origen:** Matrix 48
- **Regla:** Una venta mayorista DEBE requerir una autorización previa y la confirmación del cajero.
- **Aceptación:** Sin autorización vigente y confirmación del cajero, la venta no puede tomar precio mayorista.

#### FR-WHOL-002 · Condiciones mayoristas congeladas
- **Prioridad:** P2 · **Origen:** Matrix 48
- **Regla:** Las condiciones mayoristas de una venta NO DEBEN modificarse una vez aceptado el pago.
- **Aceptación:** Un intento de alterar la autorización o el precio mayorista tras el pago es rechazado.

## 9. Checkout y medios de pago

#### FR-PAY-001 · PROPORTIONAL_V1 en todos los locales
- **Prioridad:** P1 · **Origen:** Matrix 5 · OR-001
- **Regla:** El sistema DEBE cobrar con el modelo PROPORTIONAL_V1 en todos los locales.
- **Aceptación:** Ningún local depende de una selección por entorno para usar PROPORTIONAL_V1; la activación por local es configuración auditada (FR-CONF-001).

#### FR-PAY-002 · FIXED_TOTAL deprecado progresivamente
- **Prioridad:** P1 · **Origen:** Matrix 5, 6 · OR-001
- **Regla:** El modelo FIXED_TOTAL DEBE deprecarse de forma progresiva, local por local, y NO DEBE usarse para locales nuevos.
- **Aceptación:** Existe un plan de desactivación por local; ningún local nuevo opera con FIXED_TOTAL.

#### FR-PAY-003 · Condición para retirar FIXED_TOTAL
- **Prioridad:** P1 · **Origen:** Matrix 5 · OR-001, OR-002
- **Regla:** El sistema NO DEBE desactivar FIXED_TOTAL en un local mientras ese local no pueda cobrar con todos sus medios (incluido QR) en PROPORTIONAL_V1.
- **Aceptación:** La desactivación de FIXED_TOTAL en un local con cobros QR solo es posible cuando QR está soportado en PROPORTIONAL_V1.

#### FR-PAY-004 · Medios de pago soportados
- **Prioridad:** P1 · **Origen:** Matrix 5, 7 · OR-002
- **Regla:** PROPORTIONAL_V1 DEBE soportar los medios efectivo, transferencia, tarjeta de débito, tarjeta de crédito y QR, además del Voucher de Seña (FR-VOUCH-011).
- **Aceptación:** Un cobro con cada uno de esos medios se completa en PROPORTIONAL_V1; QR deja de ser rechazado.

#### FR-PAY-005 · Recargo de QR aplicado
- **Prioridad:** P1 · **Origen:** Matrix 5 · OR-002, OR-003
- **Regla:** Un cobro QR DEBE aplicar el recargo `qrAdjustmentBps` vigente y conservar ese valor como parte de la venta.
- **Aceptación:** El snapshot de la venta muestra el bps de QR usado; cambiar el bps luego no altera la venta.

#### FR-PAY-006 · Pago no efectivo con referencia
- **Prioridad:** P0 · **Origen:** Matrix 6 · OR-001
- **Regla:** Todo cobro no efectivo DEBE registrar una referencia verificable y conciliable.
- **Aceptación:** No existe pago aceptado no efectivo sin referencia; mientras exista FIXED_TOTAL, un cobro de transferencia, tarjeta o QR sin referencia es rechazado.
- **Excepciones:** Ninguna. Una alternativa temporal válida es limitar FIXED_TOTAL a efectivo.

#### FR-PAY-007 · Referencia única por sucursal
- **Prioridad:** P2 · **Origen:** Matrix 31
- **Regla:** La referencia de un cobro externo DEBE ser única por sucursal.
- **Aceptación:** Registrar dos cobros externos con la misma referencia en la misma sucursal es rechazado.

#### FR-PAY-008 · Estados de un cobro externo
- **Prioridad:** P2 · **Origen:** Matrix 31
- **Regla:** Un cobro externo DEBE poder estar aplicado, no aplicado o reintegrado, con transiciones auditadas.
- **Aceptación:** Cada cambio de estado deja autor y fecha; un cobro reintegrado no se reutiliza.

#### FR-PAY-009 · Pago combinado
- **Prioridad:** P1 · **Origen:** Matrix 7
- **Regla:** El sistema DEBE permitir pagar una venta con de uno a tres medios, incluido QR.
- **Aceptación:** Una venta pagada con tres medios (uno de ellos QR) se registra y concilia por medio.

#### FR-PAY-010 · Distribución exacta por línea
- **Prioridad:** P1 · **Origen:** Matrix 7
- **Regla:** El importe pagado DEBE distribuirse exactamente entre las líneas de la venta, de modo que la suma por línea iguale el total cobrado.
- **Aceptación:** Para cualquier combinación de medios, la suma de importes por línea es igual al total, sin centavos perdidos.

#### FR-PAY-011 · Vuelto solo en efectivo
- **Prioridad:** P1 · **Origen:** Matrix 7
- **Regla:** El vuelto SOLO DEBE existir cuando se cobra en efectivo.
- **Aceptación:** Un excedente en un medio no efectivo es rechazado.

#### FR-PAY-012 · Importe pagado por línea disponible
- **Prioridad:** P0 · **Origen:** Matrix 12 · OR-011
- **Regla:** El sistema DEBE conservar, por cada línea de una venta cobrada, el importe efectivamente pagado por esa línea.
- **Aceptación:** Para toda línea de una venta cobrada se puede consultar su importe efectivamente pagado, incluso con pago mixto.
- **Dependencias:** FR-EXCH-007.

## 10. Caja, movimientos y arqueo

#### FR-CASH-001 · Sesión de caja
- **Prioridad:** P2 · **Origen:** Matrix 8
- **Regla:** Cada caja DEBE tener como máximo una sesión abierta a la vez, con apertura, cierre e historial.
- **Aceptación:** Abrir una segunda sesión en la misma caja es rechazado.

#### FR-CASH-002 · Cierre y conciliación de efectivo
- **Prioridad:** P1 · **Origen:** Matrix 8, 10
- **Regla:** Al cerrar la caja el sistema DEBE calcular el efectivo esperado, registrar el efectivo contado y la diferencia.
- **Aceptación:** El cierre muestra esperado, contado y diferencia, y concilia 1:1 los pagos en efectivo con sus ingresos de caja.

#### FR-CASH-003 · Cierre por medio de pago
- **Prioridad:** P1 · **Origen:** Matrix 10
- **Regla:** El cierre DEBE mostrar totales esperados contra declarados por cada medio de pago no efectivo.
- **Aceptación:** Una diferencia de tarjeta, transferencia o QR es visible en el cierre.

#### FR-CASH-004 · Retiros de caja
- **Prioridad:** P1 · **Origen:** Matrix 9
- **Regla:** Un retiro de efectivo de caja DEBE requerir un supervisor y quedar auditado, idempotente y validado contra el efectivo disponible.
- **Aceptación:** Un retiro mayor al efectivo proyectado es rechazado; reintentar con la misma clave no duplica.

#### FR-CASH-005 · Gastos de caja
- **Prioridad:** P1 · **Origen:** Matrix 9, 34
- **Regla:** Un gasto pagado desde la caja DEBE registrar un detalle obligatorio.
- **Aceptación:** Un gasto sin detalle es rechazado.

#### FR-CASH-006 · Ingreso manual de efectivo
- **Prioridad:** P1 · **Origen:** Matrix 9
- **Regla:** El sistema DEBE permitir registrar un ingreso manual auditado de efectivo (por ejemplo, refuerzo de cambio).
- **Aceptación:** El ingreso queda auditado y la conciliación lo acepta.

#### FR-CASH-007 · Movimiento manual genérico prohibido
- **Prioridad:** P1 · **Origen:** Matrix 9
- **Regla:** El sistema NO DEBE permitir movimientos de caja de tipo manual genérico, y DEBE ofrecer un camino supervisado de remediación si existieran.
- **Aceptación:** Registrar un movimiento manual genérico falla; una sesión con uno existente se puede remediar sin quedar bloqueada.
- **Dependencias:** Apéndice D (consulta read-only en PILOT).
- **Excepciones:** Si PILOT tiene filas de ese tipo, la prioridad de este requisito sube a P0 (Matrix 9).

#### FR-CASH-008 · Reversas únicas
- **Prioridad:** P1 · **Origen:** Matrix 9
- **Regla:** Un movimiento de caja DEBE poder revertirse una sola vez, con la reversa referenciando al original.
- **Aceptación:** Una segunda reversa del mismo movimiento es rechazada.

#### FR-CASH-009 · Pago de deuda de empleado en efectivo
- **Prioridad:** P0 · **Origen:** Matrix 9, 52 · OR-029
- **Regla:** Un pago de deuda de empleado en efectivo DEBE ingresar a la sesión de caja del local como un movimiento de tipo propio aceptado por la conciliación.
- **Aceptación:** El cierre concilia el efectivo recibido por pagos de empleados.

#### FR-CASH-010 · Voucher sin movimiento de caja
- **Prioridad:** P1 · **Origen:** Matrix 33a · OR-040
- **Regla:** Emitir o usar un Voucher de Seña NO DEBE generar un movimiento de caja por su valor.
- **Aceptación:** La caja concilia sin movimiento por el Voucher.

#### FR-CASH-011 · Aprobación de diferencias grandes
- **Prioridad:** P1 · **Origen:** Matrix 10
- **Regla:** El cierre con una diferencia superior a un umbral configurable DEBE requerir aprobación supervisada.
- **Aceptación:** Un cierre sobre el umbral no se confirma sin aprobación de ADMIN u OWNER.
- **Dependencias:** FR-AUTH-001, FR-CONF-002, Apéndice D (umbral TBD: hasta definirlo este requisito no se aplica).

#### FR-CASH-012 · Reporte de cierre
- **Prioridad:** P1 · **Origen:** Matrix 10, 38
- **Regla:** El sistema DEBE poder emitir un reporte de cierre de caja imprimible.
- **Aceptación:** Un cierre cerrado puede reimprimirse con los mismos totales.

#### FR-CASH-013 · Arqueo por denominación y reapertura
- **Prioridad:** P2 · **Origen:** Matrix 8, 10
- **Regla:** El sistema PUEDE ofrecer arqueo por denominación y reapertura supervisada de una sesión.
- **Aceptación:** Si se implementa, la reapertura requiere autorización supervisada y queda auditada.

# Parte D — Reversas

## 11. Anulaciones post-cobro

**Delimitación FR-CANCEL / FR-EXCH.** `FR-CANCEL` es la **reversión/anulación de la operación
original** (la venta cobrada). `FR-EXCH` es la **operación comercial** de devolución de una
prenda y entrega de otra. Son dominios distintos con efectos y auditoría distintos y no se
fusionan. Según las reglas OWNER: no hay devolución automática de efectivo; no existe
StoreCredit general; la resolución habitual para el cliente es el cambio de mercadería; si la
nueva prenda cuesta más, el cliente paga la diferencia.

#### FR-CANCEL-001 · Anulación autorizada
- **Prioridad:** P0 · **Origen:** Matrix 11 · OR-014
- **Regla:** Una venta pagada o completada SOLO DEBE anularse con autorización supervisada de ADMIN u OWNER.
- **Aceptación:** Sin autorización supervisada la anulación es imposible; con ella, la venta queda anulada.
- **Autorización/Auditoría:** FR-AUTH-001 a FR-AUTH-008.

#### FR-CANCEL-002 · Motivo obligatorio
- **Prioridad:** P0 · **Origen:** Matrix 11 · OR-014
- **Regla:** Toda anulación DEBE registrar un motivo obligatorio.
- **Aceptación:** Una anulación sin motivo es rechazada.

#### FR-CANCEL-003 · Reversa vinculada
- **Prioridad:** P0 · **Origen:** Matrix 11, 4 · OR-014
- **Regla:** La anulación DEBE registrarse como una operación de reversa vinculada a la venta original, sin editarla ni borrarla.
- **Aceptación:** La venta original conserva todos sus datos; la reversa referencia la venta y se puede consultar desde ambas.

#### FR-CANCEL-004 · Reversa de stock
- **Prioridad:** P0 · **Origen:** Matrix 11, 16
- **Regla:** La anulación DEBE revertir el stock de la venta mediante movimientos de stock que referencien la reversa.
- **Aceptación:** Tras anular, el stock de cada ítem vuelve a la ubicación correspondiente con su movimiento trazable, en la misma operación que la anulación.

#### FR-CANCEL-005 · Sin devolución automática de efectivo
- **Prioridad:** P0 · **Origen:** Matrix 11 · OR-015
- **Regla:** La anulación NO DEBE devolver efectivo automáticamente ni generar un egreso de caja por reintegro.
- **Aceptación:** Anular una venta pagada en efectivo no produce movimiento de caja de reintegro.

#### FR-CANCEL-006 · Sin crédito general
- **Prioridad:** P0 · **Origen:** Matrix 11 · OR-016
- **Regla:** La anulación NO DEBE crear saldo a favor, vale ni crédito general para el cliente.
- **Aceptación:** Tras una anulación no existe instrumento de saldo asociado a la venta anulada.

#### FR-CANCEL-007 · Resolución comercial mediante cambio
- **Prioridad:** P0 · **Origen:** Matrix 11, 12 · OR-016
- **Regla:** La resolución comercial normal de una venta anulada DEBE ser el cambio por otra prenda (FR-EXCH), cobrando la diferencia si la nueva vale más.
- **Aceptación:** Un cambio puede vincularse a una venta anulada reconociendo el importe efectivamente pagado de sus líneas.
- **Dependencias:** FR-EXCH-002, FR-EXCH-007.

#### FR-CANCEL-008 · Auditoría y visibilidad de anulaciones
- **Prioridad:** P0 · **Origen:** Matrix 11, 28 · OR-018
- **Regla:** Toda anulación DEBE registrarse en auditoría y quedar visible para ADMIN y OWNER en la bandeja de alertas.
- **Aceptación:** Una anulación genera registro de auditoría con autorizador y motivo, y una alerta visible.

## 12. Cambios

#### FR-EXCH-001 · Definición de cambio
- **Prioridad:** P0 · **Origen:** Matrix 12 · OR-016
- **Regla:** Un cambio DEBE ser una operación comercial que registra la devolución de una o más prendas de una venta original y la entrega de otras prendas.
- **Aceptación:** Un cambio registra líneas devueltas y líneas entregadas y mueve el stock de ambas.

#### FR-EXCH-002 · Venta original obligatoria
- **Prioridad:** P0 · **Origen:** Matrix 12 · OR-009
- **Regla:** Todo cambio DEBE estar vinculado a una venta original encontrada en el sistema.
- **Aceptación:** Un cambio sin venta original vinculada es rechazado.

#### FR-EXCH-003 · Plazo de cambio
- **Prioridad:** P0 · **Origen:** Matrix 12, 40 · OR-006
- **Regla:** El sistema DEBE usar inicialmente un plazo de 15 días para cambios, contados desde la venta original. ADMIN u OWNER PUEDEN modificar la cantidad de días del plazo mediante la configuración comercial; CASHIER y SELLER NO DEBEN poder modificarlo.
- **Aceptación:** Con la configuración inicial, un cambio dentro de los 15 días se procesa; fuera del plazo vigente exige autorización supervisada (FR-AUTH). Si ADMIN u OWNER modifican los días, el nuevo plazo se aplica a los cambios posteriores y la modificación queda auditada con autor y fecha; un CASHIER o SELLER que intente modificarlo es rechazado.
- **Dependencias:** FR-CONF-002.

#### FR-EXCH-004 · Ticket en el flujo normal
- **Prioridad:** P0 · **Origen:** Matrix 12, 38 · OR-007
- **Regla:** En el flujo normal, el cambio DEBE exigir el ticket de la venta original, y lo PUEDE procesar un CASHIER.
- **Aceptación:** Con ticket y dentro del plazo, el CASHIER completa el cambio sin autorización adicional.
- **Actor:** CASHIER.

#### FR-EXCH-005 · Cambio sin ticket
- **Prioridad:** P0 · **Origen:** Matrix 12 · OR-008
- **Regla:** Un cambio sin ticket DEBE requerir autorización supervisada (PIN de ADMIN u OWNER) y motivo.
- **Aceptación:** Sin ticket, el cambio es imposible sin autorización supervisada y motivo; el autorizador y el motivo quedan registrados.
- **Autorización/Auditoría:** FR-AUTH-001 a FR-AUTH-008; visible en la bandeja (FR-ALERT-002).

#### FR-EXCH-006 · Cambio entre sucursales
- **Prioridad:** P0 · **Origen:** Matrix 12 · OR-010
- **Regla:** El cambio PUEDE realizarse en una sucursal distinta de la de la venta original.
- **Aceptación:** Un cambio en otra sucursal mueve el stock en la sucursal donde ocurre la operación y mantiene el vínculo con la venta original.

#### FR-EXCH-007 · Valor reconocido
- **Prioridad:** P0 · **Origen:** Matrix 12 · OR-011
- **Regla:** El valor reconocido por cada prenda devuelta DEBE ser el importe efectivamente pagado por esa línea en la venta original.
- **Aceptación:** Para una línea pagada con recargo o con pago mixto, el valor reconocido es lo realmente pagado por esa línea, no el precio de lista ni el `cashPrice` histórico.
- **Dependencias:** FR-PAY-012.

#### FR-EXCH-008 · Nueva prenda de mayor valor
- **Prioridad:** P0 · **Origen:** Matrix 12 · OR-012
- **Regla:** Si la prenda nueva vale más que el valor reconocido, el cliente DEBE pagar la diferencia por un medio trazable en el checkout.
- **Aceptación:** La diferencia se cobra con referencia verificable cuando el medio no es efectivo.

#### FR-EXCH-009 · Nueva prenda de igual valor
- **Prioridad:** P0 · **Origen:** Matrix 12 · OR-012
- **Regla:** Si la prenda nueva vale lo mismo que el valor reconocido, el cambio DEBE ser directo, sin cobro ni devolución.
- **Aceptación:** No se genera cobro ni movimiento de caja.

#### FR-EXCH-010 · Nueva prenda de menor valor
- **Prioridad:** P0 · **Origen:** Matrix 12 · OR-013
- **Regla:** Si la prenda nueva vale menos que el valor reconocido, el sistema NO DEBE devolver la diferencia ni generar crédito a favor del cliente.
- **Aceptación:** Un cambio de menor valor no produce egreso de caja ni saldo a favor.

#### FR-EXCH-011 · Límite de lo devuelto
- **Prioridad:** P0 · **Origen:** Matrix 12
- **Regla:** El sistema NO DEBE permitir devolver más unidades de las vendidas en la línea original.
- **Aceptación:** Devolver más de lo vendido, sumando cambios previos sobre esa línea, es rechazado.

#### FR-EXCH-012 · Stock del cambio
- **Prioridad:** P0 · **Origen:** Matrix 12, 16
- **Regla:** El cambio DEBE reponer el stock de la prenda devuelta y descontar el de la entregada en una única operación.
- **Aceptación:** Ambos movimientos de stock existen y referencian el cambio, o ninguno.

#### FR-EXCH-013 · Visibilidad de cambios excepcionales
- **Prioridad:** P0 · **Origen:** Matrix 12, 28 · OR-018
- **Regla:** Todo cambio sin ticket o fuera de plazo DEBE quedar visible para ADMIN y OWNER.
- **Aceptación:** Un cambio excepcional genera una alerta en la bandeja y un registro de auditoría con autorizador.

## 13. Descuentos

#### FR-DISC-001 · Quién autoriza descuentos
- **Prioridad:** P1 · **Origen:** Matrix 13 · OR-019
- **Regla:** Solo ADMIN u OWNER DEBEN poder autorizar descuentos manuales; CASHIER y SELLER NO DEBEN autorizarlos.
- **Aceptación:** Un CASHIER o SELLER no puede aplicar un descuento sin autorización supervisada de ADMIN u OWNER.

#### FR-DISC-002 · Motivo y autorizador
- **Prioridad:** P1 · **Origen:** Matrix 13 · OR-019
- **Regla:** Todo descuento DEBE registrar motivo y autorizador.
- **Aceptación:** Un descuento sin motivo o sin autorizador es rechazado.
- **Autorización/Auditoría:** FR-AUTH-001 a FR-AUTH-008.

#### FR-DISC-003 · Auditoría y visibilidad de descuentos
- **Prioridad:** P1 · **Origen:** Matrix 13 · OR-019
- **Regla:** Todo descuento DEBE quedar auditado y visible para el OWNER.
- **Aceptación:** El OWNER puede listar los descuentos con autorizador, motivo y venta.

#### FR-DISC-004 · Sin topes por rol ni promociones
- **Prioridad:** P1 · **Origen:** Matrix 13 · OR-019
- **Regla:** El sistema NO DEBE definir topes de descuento por rol operativo ni incluir un motor de promociones.
- **Aceptación:** No existen reglas de promoción automática; el descuento es manual.

#### FR-DISC-005 · Descuento y checkout
- **Prioridad:** P1 · **Origen:** Matrix 13, 5
- **Regla:** Un descuento DEBE reflejarse en el importe de la venta y en la distribución por línea del checkout proporcional.
- **Aceptación:** La suma de importes por línea con descuento es igual al total cobrado.

# Parte E — Stock

## 14. Inventario y reservas

#### FR-STOCK-001 · Inventario por ubicación
- **Prioridad:** P2 · **Origen:** Matrix 14
- **Regla:** El sistema DEBE llevar el inventario de cada variante por ubicación, con cantidad física y reservada.
- **Aceptación:** Para cada variante y ubicación se consulta físico, reservado y disponible.

#### FR-STOCK-002 · Disponible
- **Prioridad:** P2 · **Origen:** Matrix 14
- **Regla:** El stock disponible DEBE ser el físico menos el reservado.
- **Aceptación:** Una venta, retiro o transferencia no puede consumir más que el disponible.

#### FR-STOCK-003 · Registro de todo movimiento de stock
- **Prioridad:** P0 · **Origen:** Matrix 16
- **Regla:** Todo cambio de stock físico DEBE registrarse como un movimiento con tipo y documento de origen.
- **Aceptación:** No existe variación de stock sin movimiento asociado que identifique su documento.

#### FR-STOCK-004 · Tipos de movimiento de stock
- **Prioridad:** P0 · **Origen:** Matrix 16
- **Regla:** El registro de stock DEBE distinguir como mínimo: venta, carga inicial, ajuste, retiro de empleado, devolución de empleado, reversa por anulación, cambio, transferencia de salida, transferencia de entrada, recepción y compra.
- **Aceptación:** Cada operación del producto que mueve stock usa su tipo propio.

#### FR-STOCK-005 · Reserva de stock
- **Prioridad:** P2 · **Origen:** Matrix 15
- **Regla:** El sistema DEBE reservar el stock al enviar la venta a caja, consumir la reserva al completar y liberarla al cancelar.
- **Aceptación:** Dos ventas no pueden reservar la misma unidad; cancelar libera la reserva.

#### FR-STOCK-006 · Venta normal sin vencimiento por reloj
- **Prioridad:** P2 · **Origen:** Matrix 15 · OR-041
- **Regla:** La reserva de una venta normal NO DEBE vencer por el paso del tiempo.
- **Aceptación:** Una venta normal pendiente conserva su reserva hasta ser completada o cancelada.

#### FR-STOCK-007 · Conteo cíclico
- **Prioridad:** P2 · **Origen:** Matrix 14
- **Regla:** El sistema PUEDE ofrecer un conteo físico periódico para conciliar el inventario.
- **Aceptación:** Si se implementa, las diferencias se registran como ajustes con motivo.

## 15. Ajustes de stock

#### FR-ADJ-001 · Ajuste con motivo
- **Prioridad:** P2 · **Origen:** Matrix 17
- **Regla:** Todo ajuste manual de stock DEBE registrar un motivo y una nota.
- **Aceptación:** Un ajuste sin motivo es rechazado.

#### FR-ADJ-002 · Permiso por ubicación
- **Prioridad:** P2 · **Origen:** Matrix 17
- **Regla:** Solo usuarios con permiso de inventario sobre la ubicación DEBEN poder ajustar su stock.
- **Aceptación:** Ajustar una ubicación sin permiso sobre ella es rechazado.

#### FR-ADJ-003 · Ajuste idempotente y auditado
- **Prioridad:** P2 · **Origen:** Matrix 17
- **Regla:** Todo ajuste DEBE ser idempotente y quedar auditado.
- **Aceptación:** Reintentar el mismo ajuste con la misma clave no lo duplica; queda registro con autor.

#### FR-ADJ-004 · Autorización de ajustes grandes
- **Prioridad:** P2 · **Origen:** Matrix 17 · OR-051
- **Regla:** Un ajuste de stock por encima de un umbral configurable DEBE requerir autorización supervisada de ADMIN u OWNER, motivo obligatorio y registro en AuditLog; los ajustes comunes, por debajo del umbral, se rigen por el permiso operativo normal (FR-ADJ-002).
- **Aceptación:** Un ajuste sobre el umbral no se aplica sin autorizador ADMIN/OWNER y motivo, y queda auditado con ambos; un ajuste común no exige autorización adicional.
- **Dependencias:** FR-AUTH-001, FR-CONF-002, Apéndice D (umbral TBD: hasta definirlo este requisito no se aplica y los ajustes siguen el permiso operativo normal).

## 16. Transferencias

#### FR-TRANSFER-001 · Flujo depósito a local
- **Prioridad:** P0 · **Origen:** Matrix 19 · OR-021
- **Regla:** El flujo de transferencia DEBE ser: el depósito despacha directamente a un local, ADMIN autoriza el despacho y el CASHIER del local de destino confirma la recepción.
- **Aceptación:** Una transferencia recorre despacho autorizado, tránsito y recepción confirmada, con responsable registrado en cada etapa.

#### FR-TRANSFER-002 · Autorización del despacho
- **Prioridad:** P0 · **Origen:** Matrix 19 · OR-021
- **Regla:** El despacho de una transferencia DEBE estar autorizado por ADMIN.
- **Aceptación:** Un despacho sin autorización de ADMIN es rechazado; el autorizador queda registrado.

#### FR-TRANSFER-003 · Stock en tránsito
- **Prioridad:** P0 · **Origen:** Matrix 19 · OR-021
- **Regla:** Al despachar, el stock DEBE salir del origen y quedar en tránsito, no disponible en ningún local.
- **Aceptación:** La mercadería en tránsito no aparece como disponible en origen ni destino.

#### FR-TRANSFER-004 · Recepción por línea
- **Prioridad:** P0 · **Origen:** Matrix 19 · OR-021
- **Regla:** El CASHIER de destino DEBE confirmar la recepción cantidad por cantidad de cada línea.
- **Aceptación:** La confirmación registra lo recibido por línea; al confirmar sin diferencias el stock pasa a disponible en destino.

#### FR-TRANSFER-005 · Diferencias en revisión
- **Prioridad:** P0 · **Origen:** Matrix 19 · OR-022
- **Regla:** Si lo recibido difiere de lo despachado, la transferencia DEBE pasar al estado `PENDING_REVIEW`.
- **Aceptación:** Una recepción con faltante o sobrante deja la transferencia en `PENDING_REVIEW`.

#### FR-TRANSFER-006 · Alerta hasta la resolución
- **Prioridad:** P0 · **Origen:** Matrix 19, 28 · OR-022
- **Regla:** Una transferencia en `PENDING_REVIEW` DEBE mantener una alerta para ADMIN hasta su resolución.
- **Aceptación:** La alerta persiste y no desaparece al ser leída; se cierra solo al resolverse la transferencia.

#### FR-TRANSFER-007 · Resolución por ADMIN
- **Prioridad:** P0 · **Origen:** Matrix 19 · OR-022
- **Regla:** Solo ADMIN DEBE poder resolver una transferencia en `PENDING_REVIEW`, registrando la resolución con motivo.
- **Aceptación:** La resolución queda auditada con autor y motivo.

#### FR-TRANSFER-008 · Sin corrección automática
- **Prioridad:** P0 · **Origen:** Matrix 19 · OR-022
- **Regla:** El sistema NO DEBE corregir automáticamente el stock por diferencias de una transferencia.
- **Aceptación:** El stock de una transferencia con diferencia solo cambia por la resolución registrada de ADMIN.

## 17. Recepción y remitos

#### FR-RECV-001 · Recepción contra remito
- **Prioridad:** P1 · **Origen:** Matrix 20 · OR-043
- **Regla:** El sistema DEBE registrar la recepción de mercadería de proveedor contra un remito.
- **Aceptación:** Cada recepción referencia su remito y su proveedor.

#### FR-RECV-002 · Control de cantidades
- **Prioridad:** P1 · **Origen:** Matrix 20
- **Regla:** La recepción DEBE controlar las cantidades recibidas contra las esperadas.
- **Aceptación:** Una diferencia de cantidad queda registrada en la recepción.

#### FR-RECV-003 · Movimientos de recepción
- **Prioridad:** P1 · **Origen:** Matrix 20, 16
- **Regla:** Una recepción DEBE generar los movimientos de stock de recepción correspondientes.
- **Aceptación:** Un remito recibido aumenta el stock del depósito con movimientos trazables.

#### FR-RECV-004 · Recepción de transferencias
- **Prioridad:** P0 · **Origen:** Matrix 20, 19
- **Regla:** La recepción de transferencias entre ubicaciones DEBE regirse por FR-TRANSFER y no por el remito de proveedor.
- **Aceptación:** El remito de proveedor y la recepción de transferencia son flujos distintos con auditoría distinta.

# Parte F — Empleados

## 18. Empleados

#### FR-EMP-001 · Empleado separado de usuario
- **Prioridad:** P0 · **Origen:** Matrix 24 · OR-023
- **Regla:** El empleado DEBE ser una entidad separada del usuario del sistema.
- **Aceptación:** Se puede crear un empleado sin usuario; existe un usuario sin empleado asociado.

#### FR-EMP-002 · employeeCode
- **Prioridad:** P0 · **Origen:** Matrix 24 · OR-023
- **Regla:** Cada empleado DEBE tener un `employeeCode` único y visible para la operación.
- **Aceptación:** Un `employeeCode` repetido es rechazado.

#### FR-EMP-003 · Vínculo opcional con usuario
- **Prioridad:** P0 · **Origen:** Matrix 24 · OR-023
- **Regla:** Un empleado PUEDE estar vinculado a un usuario; un usuario DEBE vincularse a lo sumo a un empleado.
- **Aceptación:** Vincular dos empleados al mismo usuario es rechazado.

#### FR-EMP-004 · Ubicación de pertenencia
- **Prioridad:** P0 · **Origen:** Matrix 24
- **Regla:** Un empleado PUEDE tener una ubicación de pertenencia.
- **Aceptación:** La ubicación de pertenencia no restringe en qué sucursal puede retirar (FR-EMPWD-002).

#### FR-EMP-005 · Estado del empleado
- **Prioridad:** P0 · **Origen:** Matrix 24
- **Regla:** Un empleado inactivo NO DEBE poder ser usado en ningún flujo.
- **Aceptación:** Un retiro, pago o liquidación sobre un empleado inactivo es rechazado.

#### FR-EMP-006 · Gestión auditada
- **Prioridad:** P0 · **Origen:** Matrix 24 · OR-023
- **Regla:** ADMIN u OWNER DEBEN poder dar de alta, editar y dar de baja empleados desde la administración, con auditoría.
- **Aceptación:** Alta, edición y baja dejan registro de auditoría con autor.

#### FR-EMP-007 · Búsqueda por código
- **Prioridad:** P0 · **Origen:** Matrix 24
- **Regla:** Caja y depósito DEBEN poder buscar un empleado por `employeeCode`.
- **Aceptación:** Ingresar un código válido en caja devuelve el empleado.

## 19. Cuenta corriente de empleados

#### FR-EMPACC-001 · Cuenta por empleado con saldo derivado
- **Prioridad:** P0 · **Origen:** Matrix 52 · OR-027
- **Regla:** Cada empleado DEBE tener una cuenta cuyo saldo se derive de la suma de sus movimientos y NO DEBE existir como valor editable.
- **Aceptación:** El saldo en cualquier fecha es reconstruible sumando los movimientos hasta esa fecha.

#### FR-EMPACC-002 · Movimientos append-only
- **Prioridad:** P0 · **Origen:** Matrix 52 · OR-027
- **Regla:** Los movimientos de la cuenta DEBEN ser inmodificables e inborrables; una corrección DEBE ser un movimiento nuevo.
- **Aceptación:** Editar o borrar un movimiento es rechazado.

#### FR-EMPACC-003 · Tipos de movimiento
- **Prioridad:** P0 · **Origen:** Matrix 52 · OR-027
- **Regla:** La cuenta DEBE distinguir los movimientos de saldo inicial (`OPENING_BALANCE`), retiro de mercadería, devolución, pago, deducción por liquidación, reversa y ajuste.
- **Aceptación:** Cada movimiento tiene exactamente un tipo.

#### FR-EMPACC-004 · Saldo inicial con fecha de corte
- **Prioridad:** P0 · **Origen:** Matrix 52 · OR-028
- **Regla:** El saldo vigente del sistema anterior DEBE cargarse como un movimiento `OPENING_BALANCE` con fecha de corte explícita.
- **Aceptación:** Cada empleado con deuda tiene un único `OPENING_BALANCE` que registra su fecha de corte.

#### FR-EMPACC-005 · Sin reescribir historia previa
- **Prioridad:** P0 · **Origen:** Matrix 52 · OR-028
- **Regla:** El sistema NO DEBE reconstruir ni inventar movimientos anteriores a la fecha de corte.
- **Aceptación:** Los movimientos de la cuenta comienzan en el `OPENING_BALANCE`.

#### FR-EMPACC-006 · Límite global de deuda
- **Prioridad:** P0 · **Origen:** Matrix 52, 40 · OR-026
- **Regla:** Existirá un límite global de deuda de empleado, inicialmente $300.000 (30000000 centavos), configurable por ADMIN u OWNER.
- **Aceptación:** El valor inicial es $300.000 y se modifica solo desde la configuración, con auditoría.
- **Dependencias:** FR-CONF-002.

#### FR-EMPACC-007 · Sin límite individual
- **Prioridad:** P0 · **Origen:** Matrix 52 · OR-026
- **Regla:** El sistema NO DEBE definir límites de deuda por empleado individual en esta versión.
- **Aceptación:** No existe parámetro de límite por empleado.

#### FR-EMPACC-008 · Reversa única
- **Prioridad:** P0 · **Origen:** Matrix 52 · OR-027
- **Regla:** Una reversa DEBE referenciar a un único movimiento original y ese movimiento solo PUEDE revertirse una vez.
- **Aceptación:** Una segunda reversa del mismo movimiento es rechazada.

#### FR-EMPACC-009 · Ajustes supervisados
- **Prioridad:** P0 · **Origen:** Matrix 52 · OR-027
- **Regla:** Un ajuste manual de la cuenta DEBE requerir autorización supervisada de ADMIN u OWNER y motivo.
- **Aceptación:** Un ajuste sin autorización o sin motivo es rechazado.
- **Autorización/Auditoría:** FR-AUTH-001 a FR-AUTH-008.

#### FR-EMPACC-010 · Origen, autor y motivo
- **Prioridad:** P0 · **Origen:** Matrix 52 · OR-027
- **Regla:** Todo movimiento de la cuenta DEBE registrar su operación de origen, su autor, su fecha y, cuando corresponda, su motivo.
- **Aceptación:** Ningún movimiento carece de origen y autor; cada uno queda auditado.

## 20. Retiro de mercadería por empleados

#### FR-EMPWD-001 · Precio de retiro
- **Prioridad:** P0 · **Origen:** Matrix 53, 3 · OR-024
- **Regla:** El retiro DEBE valuarse al `cashPrice` de cada variante, congelado al momento del retiro.
- **Aceptación:** El importe de una línea retirada no cambia aunque el precio cambie después.

#### FR-EMPWD-002 · Retiro en cualquier sucursal
- **Prioridad:** P0 · **Origen:** Matrix 53 · OR-025
- **Regla:** Un empleado PUEDE retirar mercadería en cualquier sucursal.
- **Aceptación:** Un retiro en una sucursal distinta de la de pertenencia es aceptado.

#### FR-EMPWD-003 · Carga por CASHIER sin preautorización
- **Prioridad:** P0 · **Origen:** Matrix 53 · OR-025
- **Regla:** El retiro DEBE ser cargado por un CASHIER, sin requerir preautorización.
- **Aceptación:** Un CASHIER registra el retiro sin intervención de ADMIN u OWNER.
- **Actor:** CASHIER.

#### FR-EMPWD-004 · Aviso a ADMIN/OWNER
- **Prioridad:** P0 · **Origen:** Matrix 53, 28 · OR-025
- **Regla:** Cada retiro DEBE generar un aviso visible para ADMIN y OWNER.
- **Aceptación:** Tras un retiro existe una alerta en la bandeja con empleado, sucursal e importe.

#### FR-EMPWD-005 · Rechazo por límite
- **Prioridad:** P0 · **Origen:** Matrix 53 · OR-026
- **Regla:** El sistema NO DEBE aceptar un retiro cuyo saldo resultante supere el límite global de deuda.
- **Aceptación:** Un retiro que deja el saldo por encima del límite es rechazado completo.

#### FR-EMPWD-006 · Stock del retiro
- **Prioridad:** P0 · **Origen:** Matrix 53, 16
- **Regla:** El retiro DEBE descontar el stock físico disponible y NO DEBE consumir stock reservado ni dejar stock negativo.
- **Aceptación:** Con una unidad disponible, solo uno de dos retiros simultáneos se acepta.

#### FR-EMPWD-007 · Deuda siempre respaldada por stock
- **Prioridad:** P0 · **Origen:** Matrix 53
- **Regla:** El sistema NO DEBE registrar deuda de retiro sin el movimiento de stock correspondiente.
- **Aceptación:** No existe cargo de retiro sin movimiento de stock asociado, ni a la inversa.

#### FR-EMPWD-008 · Devolución de un retiro
- **Prioridad:** P0 · **Origen:** Matrix 53 · OR-032
- **Regla:** El empleado PUEDE devolver mercadería retirada, y la devolución DEBE vincularse al retiro original.
- **Aceptación:** Una devolución referencia la línea del retiro original.

#### FR-EMPWD-009 · Efectos de la devolución
- **Prioridad:** P0 · **Origen:** Matrix 53 · OR-032
- **Regla:** La devolución DEBE reponer el stock y reducir o revertir la deuda del empleado.
- **Aceptación:** Tras la devolución, el stock aumenta y el saldo disminuye en el valor congelado de lo devuelto.

#### FR-EMPWD-010 · Tope de la devolución
- **Prioridad:** P0 · **Origen:** Matrix 53 · OR-032
- **Regla:** La devolución NO DEBE superar lo originalmente retirado.
- **Aceptación:** Devolver más unidades que las retiradas, sumando devoluciones previas, es rechazado.

## 21. Liquidación semanal y pagos de deuda

#### FR-EMPSET-001 · Semana de liquidación
- **Prioridad:** P0 · **Origen:** Matrix 54 · OR-030
- **Regla:** La semana de liquidación DEBE ir de lunes a sábado, en la zona del negocio.
- **Aceptación:** Un descuento se asigna a la semana lunes-sábado que corresponde a su fecha en Argentina.

#### FR-EMPSET-002 · Liquidación registrada por administración
- **Prioridad:** P0 · **Origen:** Matrix 54 · OR-031
- **Regla:** ADMIN u OWNER DEBEN registrar el importe a aplicar de cada liquidación, que PUEDE ser parcial.
- **Aceptación:** Una liquidación de 25.000 sobre una deuda de 40.000 es aceptada y deja 15.000 pendientes.

#### FR-EMPSET-003 · Saldo restante arrastrado
- **Prioridad:** P0 · **Origen:** Matrix 54 · OR-031
- **Regla:** El saldo no cubierto por una liquidación DEBE arrastrarse a la semana siguiente.
- **Aceptación:** El saldo posterior a la liquidación es el saldo anterior menos lo aplicado.

#### FR-EMPSET-004 · Una liquidación, una deducción
- **Prioridad:** P0 · **Origen:** Matrix 54 · OR-031
- **Regla:** Cada liquidación DEBE generar exactamente una deducción en la cuenta del empleado.
- **Aceptación:** Cada liquidación se vincula a un único movimiento de deducción y viceversa.

#### FR-EMPSET-005 · Corrección por reversa
- **Prioridad:** P0 · **Origen:** Matrix 54 · OR-031
- **Regla:** La corrección de una liquidación DEBE hacerse mediante una reversa y NO DEBE editar ni borrar movimientos.
- **Aceptación:** Corregir una liquidación genera una reversa y deja el historial intacto.

#### FR-EMPSET-006 · No es nómina
- **Prioridad:** P0 · **Origen:** Matrix 54 · OR-031
- **Regla:** La liquidación NO DEBE calcular sueldos; SOLO DEBE registrar el descuento aplicado contra la deuda.
- **Aceptación:** El sistema no almacena ni calcula remuneraciones.

#### FR-EMPSET-007 · Historial reconstruible
- **Prioridad:** P0 · **Origen:** Matrix 54 · OR-031
- **Regla:** Para cada liquidación el sistema DEBE permitir reconstruir el saldo previo, lo descontado, la semana, quién la registró y el saldo posterior.
- **Aceptación:** La consulta de una liquidación muestra esos cinco datos.

#### FR-EMPSET-008 · Pago directo de deuda
- **Prioridad:** P0 · **Origen:** Matrix 52 · OR-029
- **Regla:** El empleado PUEDE pagar su deuda en forma directa, parcial o total, con efectivo o transferencia.
- **Aceptación:** Un pago parcial reduce el saldo en el importe pagado.

#### FR-EMPSET-009 · Pago en efectivo ingresa a caja
- **Prioridad:** P0 · **Origen:** Matrix 52, 9 · OR-029
- **Regla:** Un pago directo en efectivo DEBE ingresar a la caja del local donde se recibe (FR-CASH-009).
- **Aceptación:** El efectivo recibido aparece en la conciliación de la sesión de caja.

#### FR-EMPSET-010 · Pago por transferencia con referencia
- **Prioridad:** P0 · **Origen:** Matrix 52 · OR-029
- **Regla:** Un pago directo por transferencia DEBE registrar una referencia verificable.
- **Aceptación:** Un pago por transferencia sin referencia es rechazado.

#### FR-EMPSET-011 · Pago registrado en la cuenta
- **Prioridad:** P0 · **Origen:** Matrix 52 · OR-029
- **Regla:** Todo pago directo DEBE generar un movimiento de pago en la cuenta del empleado.
- **Aceptación:** Cada pago, en efectivo o transferencia, aparece como movimiento de pago.

# Parte G — Clientes y Seña

## 22. Clientes

#### FR-CUST-001 · Datos obligatorios
- **Prioridad:** P1 · **Origen:** Matrix 46 · OR-044
- **Regla:** El cliente DEBE registrar obligatoriamente nombre, apellido y teléfono.
- **Aceptación:** Un cliente sin alguno de esos datos es rechazado.

#### FR-CUST-002 · Datos opcionales
- **Prioridad:** P1 · **Origen:** Matrix 46 · OR-044
- **Regla:** El cliente PUEDE registrar DNI, email y CUIT.
- **Aceptación:** Un cliente sin esos datos es aceptado.

#### FR-CUST-003 · Cliente titular de la Seña
- **Prioridad:** P1 · **Origen:** Matrix 46, 32
- **Regla:** Toda Seña DEBE tener un cliente titular.
- **Aceptación:** Activar una Seña sin cliente es rechazado.

## 23. Señas

#### FR-SENA-001 · Seña con cliente y monto
- **Prioridad:** P1 · **Origen:** Matrix 32 · OR-033
- **Regla:** Una Seña DEBE registrar el cliente, las prendas apartadas y los pagos recibidos.
- **Aceptación:** Una Seña activa muestra cliente, ítems, pagos y vencimiento.

#### FR-SENA-002 · Duración de 120 horas
- **Prioridad:** P1 · **Origen:** Matrix 32 · OR-033
- **Regla:** Una Seña DEBE durar exactamente 120 horas desde su activación.
- **Aceptación:** El vencimiento es la hora de activación más 120 horas, en la zona del negocio.

#### FR-SENA-003 · Bloqueo de stock
- **Prioridad:** P1 · **Origen:** Matrix 32 · OR-033
- **Regla:** Una Seña activa DEBE bloquear el stock de sus prendas.
- **Aceptación:** El stock bloqueado por una Seña no está disponible para otra venta.

#### FR-SENA-004 · Liberación única al vencer
- **Prioridad:** P1 · **Origen:** Matrix 32 · OR-033
- **Regla:** Al vencer, la Seña DEBE liberar su stock exactamente una vez.
- **Aceptación:** Con vencimientos concurrentes o repetidos, el stock se libera una sola vez.

#### FR-SENA-005 · Vencimiento sin devolución
- **Prioridad:** P1 · **Origen:** Matrix 32 · OR-034
- **Regla:** El vencimiento NO DEBE devolver dinero, generar crédito ni producir movimiento de caja.
- **Aceptación:** Al vencer una Seña no se escribe movimiento de caja ni saldo a favor.

#### FR-SENA-006 · Cancelación manual sin reintegro
- **Prioridad:** P1 · **Origen:** Matrix 32 · OR-034
- **Regla:** La cancelación manual de una Seña NO DEBE implicar reintegro automático.
- **Aceptación:** Cancelar no genera valor a favor salvo la emisión separada de un Voucher (FR-VOUCH-001).

#### FR-SENA-007 · Precio congelado
- **Prioridad:** P1 · **Origen:** Matrix 32 · OR-035
- **Regla:** El precio de la Seña DEBE congelarse al activarla.
- **Aceptación:** Cambiar el precio en el catálogo no altera una Seña ya activa.

#### FR-SENA-008 · Monto mínimo configurable
- **Prioridad:** P1 · **Origen:** Matrix 32, 40 · OR-036
- **Regla:** La Seña DEBE exigir un monto mínimo, configurable por ADMIN u OWNER.
- **Aceptación:** Activar una Seña bajo el mínimo es rechazado; el mínimo se modifica desde la configuración con auditoría.
- **Dependencias:** FR-CONF-002, Apéndice D.

#### FR-SENA-009 · Medios de pago de la Seña
- **Prioridad:** P1 · **Origen:** Matrix 32 · OR-037
- **Regla:** Los pagos de una Seña DEBEN seguir las reglas de medios del checkout correspondiente, incluido QR.
- **Aceptación:** Un pago de Seña con medio no efectivo exige referencia verificable.

#### FR-SENA-010 · Venta normal sin vencimiento
- **Prioridad:** P1 · **Origen:** Matrix 32 · OR-041
- **Regla:** La venta normal NO DEBE heredar el vencimiento de 120 horas de la Seña.
- **Aceptación:** Una venta normal no vence por reloj (FR-STOCK-006).

## 24. Voucher de Seña

#### FR-VOUCH-001 · Emisión autorizada
- **Prioridad:** P1 · **Origen:** Matrix 33a · OR-038
- **Regla:** Un Voucher de Seña NO DEBE emitirse automáticamente: DEBE requerir una operación separada con autorización de ADMIN.
- **Aceptación:** Cancelar o vencer una Seña no emite Voucher; la emisión exige autorización y queda registrada.

#### FR-VOUCH-002 · Monto del Voucher
- **Prioridad:** P1 · **Origen:** Matrix 33a · OR-038
- **Regla:** El monto del Voucher DEBE ser el total aceptado de los pagos de la Seña de origen.
- **Aceptación:** El Voucher coincide con la suma de pagos aceptados de su Seña.

#### FR-VOUCH-003 · Un Voucher por Seña
- **Prioridad:** P1 · **Origen:** Matrix 33a · OR-038
- **Regla:** Cada Seña DEBE tener como máximo un Voucher.
- **Aceptación:** Un segundo Voucher para la misma Seña es rechazado.

#### FR-VOUCH-004 · Misma sucursal
- **Prioridad:** P1 · **Origen:** Matrix 33a · OR-039
- **Regla:** El Voucher DEBE usarse en la misma sucursal de la Seña de origen.
- **Aceptación:** Usarlo en otra sucursal es rechazado.

#### FR-VOUCH-005 · Uso completo
- **Prioridad:** P1 · **Origen:** Matrix 33a · OR-039
- **Regla:** El Voucher DEBE usarse completo en una sola compra.
- **Aceptación:** El uso parcial es rechazado.

#### FR-VOUCH-006 · Sin vuelto
- **Prioridad:** P1 · **Origen:** Matrix 33a · OR-039
- **Regla:** El Voucher NO DEBE generar vuelto.
- **Aceptación:** Una compra no puede generar devolución por el valor del Voucher.

#### FR-VOUCH-007 · Compra igual o mayor
- **Prioridad:** P1 · **Origen:** Matrix 33a · OR-039
- **Regla:** La compra DEBE ser igual o mayor al valor del Voucher, y la diferencia se paga con un medio trazable.
- **Aceptación:** Una compra menor al Voucher es rechazada; una mayor cobra la diferencia con referencia verificable.

#### FR-VOUCH-008 · Solo venta normal
- **Prioridad:** P1 · **Origen:** Matrix 33a · OR-040
- **Regla:** El Voucher SOLO DEBE servir para pagar una venta normal y NO DEBE servir para pagar otra Seña.
- **Aceptación:** Usarlo para activar o pagar una Seña es rechazado.

#### FR-VOUCH-009 · Sin vencimiento
- **Prioridad:** P1 · **Origen:** Matrix 33a · OR-039
- **Regla:** El Voucher NO DEBE tener fecha de vencimiento.
- **Aceptación:** Un Voucher es utilizable independientemente de su antigüedad.

#### FR-VOUCH-010 · Único vale existente
- **Prioridad:** P1 · **Origen:** Matrix 33a, 11, 12 · OR-017
- **Regla:** El Voucher de Seña DEBE ser el único instrumento de vale del sistema; ninguna anulación ni cambio puede emitir vales.
- **Aceptación:** No existe otro tipo de vale ni instrumento de saldo a favor.

#### FR-VOUCH-011 · Voucher como medio de pago
- **Prioridad:** P1 · **Origen:** Matrix 33a, 5 · OR-040
- **Regla:** El Voucher DEBE integrarse como medio de pago del checkout proporcional, con uso único.
- **Aceptación:** Un Voucher usado no puede volver a usarse.

# Parte H — Abastecimiento y finanzas

## 25. Proveedores

#### FR-SUPP-001 · Gestión de proveedores
- **Prioridad:** P2 · **Origen:** Matrix 22 · OR-043
- **Regla:** ADMIN u OWNER DEBEN poder dar de alta, editar y dar de baja proveedores, con auditoría.
- **Aceptación:** Alta, edición y baja dejan registro de auditoría.

#### FR-SUPP-002 · Cuenta del proveedor
- **Prioridad:** P2 · **Origen:** Matrix 22, 21 · OR-043
- **Regla:** Cada proveedor DEBE tener una cuenta donde se vea su deuda y sus pagos.
- **Aceptación:** La cuenta muestra compras recibidas, pagos y saldo.

## 26. Compras

#### FR-PURCHASE-001 · Cadena de compras
- **Prioridad:** P2 · **Origen:** Matrix 21 · OR-043
- **Regla:** El sistema DEBE soportar la cadena proveedor → orden de compra → recepción/remito → deuda → pago.
- **Aceptación:** Una orden de compra recorre toda la cadena con trazabilidad entre cada eslabón.

#### FR-PURCHASE-002 · Orden de compra
- **Prioridad:** P2 · **Origen:** Matrix 21 · OR-043
- **Regla:** El sistema DEBE permitir crear una orden de compra a un proveedor con sus ítems y cantidades.
- **Aceptación:** La orden queda registrada con proveedor, ítems, cantidades y autor.

#### FR-PURCHASE-003 · Recepción parcial o total
- **Prioridad:** P2 · **Origen:** Matrix 21 · OR-043
- **Regla:** Una orden de compra DEBE poder recibirse parcial o totalmente.
- **Aceptación:** Tras una recepción parcial, la orden muestra lo recibido y lo pendiente.

## 27. Deuda y pagos a proveedores

#### FR-SUPDEBT-001 · Deuda por recepción
- **Prioridad:** P2 · **Origen:** Matrix 21, 22 · OR-043
- **Regla:** Una recepción de mercadería DEBE generar deuda con el proveedor.
- **Aceptación:** Recibir una orden aumenta el saldo del proveedor.

#### FR-SUPDEBT-002 · Pago al proveedor
- **Prioridad:** P2 · **Origen:** Matrix 21 · OR-043
- **Regla:** Un pago a proveedor DEBE reducir su deuda y quedar registrado.
- **Aceptación:** Un pago parcial reduce el saldo; queda autor, fecha y medio.

#### FR-SUPDEBT-003 · Auditoría de la deuda
- **Prioridad:** P2 · **Origen:** Matrix 21, 36 · OR-043
- **Regla:** Los movimientos de deuda con proveedores DEBEN ser auditados y entrar en la exportación administrativa.
- **Aceptación:** El export administrativo de un período incluye los movimientos de deuda y pago de proveedores.

## 28. Gastos

#### FR-EXP-001 · Caja chica
- **Prioridad:** P2 · **Origen:** Matrix 34 · OR-045, OR-050
- **Regla:** El gasto registrado en caja DEBE ser de caja chica y tener un detalle o motivo obligatorio.
- **Aceptación:** Un gasto de caja sin detalle es rechazado.

#### FR-EXP-002 · Gastos administrativos fuera de la caja
- **Prioridad:** P2 · **Origen:** Matrix 34 · OR-045
- **Regla:** Los gastos administrativos (alquiler, proveedores, servicios, generales) NO DEBEN registrarse dentro de la sesión de caja, salvo que el dinero salga realmente de esa caja.
- **Aceptación:** Un gasto administrativo pagado por banco no aparece en la conciliación de caja.

#### FR-EXP-003 · Categoría y comprobante opcional
- **Prioridad:** P2 · **Origen:** Matrix 34 · OR-050
- **Regla:** Todo gasto DEBE tener categoría. El comprobante es opcional: el sistema PUEDE permitir adjuntarlo y NO DEBE exigirlo.
- **Aceptación:** Un gasto sin categoría es rechazado; un gasto sin comprobante es aceptado.

#### FR-EXP-004 · Gastos no efectivo
- **Prioridad:** P2 · **Origen:** Matrix 34
- **Regla:** El sistema DEBE permitir registrar gastos pagados por medios no efectivo.
- **Aceptación:** Un gasto por transferencia se registra sin afectar el efectivo de caja.

## 29. Tesorería y administración financiera

#### FR-TREAS-001 · Destino de los retiros
- **Prioridad:** P2 · **Origen:** Matrix 35
- **Regla:** Todo retiro de efectivo de caja DEBE registrar su destino (caja fuerte o banco).
- **Aceptación:** Un retiro sin destino es rechazado.

#### FR-TREAS-002 · Conciliación de depósitos
- **Prioridad:** P2 · **Origen:** Matrix 35
- **Regla:** El sistema DEBE permitir conciliar los depósitos bancarios contra los retiros registrados.
- **Aceptación:** Un depósito se asocia a uno o más retiros y se informan las diferencias.

#### FR-TREAS-003 · Exportación administrativa unificada
- **Prioridad:** P2 · **Origen:** Matrix 36 · OR-046
- **Regla:** El sistema DEBE ofrecer una exportación unificada por período y sucursal de los movimientos de caja, gastos, compras y proveedores, cuenta de empleados y liquidaciones.
- **Aceptación:** El export de un período cuadra con los cierres de caja y con los saldos de las cuentas de empleados.

#### FR-TREAS-004 · Sin contabilidad completa
- **Prioridad:** P2 · **Origen:** Matrix 36 · OR-046
- **Regla:** El sistema NO DEBE implementar plan de cuentas ni doble partida.
- **Aceptación:** La exportación es por contraparte y ledger, no por asientos contables.

# Parte I — Gobierno

## 30. Usuarios y alcance por sucursal

#### FR-USER-001 · Gestión de usuarios
- **Prioridad:** P1 · **Origen:** Matrix 23
- **Regla:** ADMIN u OWNER DEBEN poder dar de alta, editar y dar de baja usuarios y resetear contraseñas desde la administración, con auditoría.
- **Aceptación:** Dar de alta un cajero no requiere intervención del equipo técnico.

#### FR-USER-002 · Usuario inactivo
- **Prioridad:** P1 · **Origen:** Matrix 23
- **Regla:** Un usuario inactivo NO DEBE poder iniciar sesión.
- **Aceptación:** El intento de login de un usuario dado de baja es rechazado.

#### FR-USER-003 · Asignación de alcance
- **Prioridad:** P1 · **Origen:** Matrix 26
- **Regla:** ADMIN u OWNER DEBEN poder asignar y revocar el alcance de ubicaciones de un usuario desde la administración, con auditoría.
- **Aceptación:** Asignar y revocar alcance se hace desde el admin y queda auditado.

#### FR-USER-004 · Alcance operativo
- **Prioridad:** P1 · **Origen:** Matrix 26, 25
- **Regla:** CASHIER, SELLER y WAREHOUSE DEBEN operar únicamente sobre las ubicaciones que tienen asignadas; OWNER y ADMIN, sobre toda la empresa.
- **Aceptación:** Un CASHIER no puede operar una ubicación que no tiene asignada.

#### FR-USER-005 · Vínculo con empleado
- **Prioridad:** P1 · **Origen:** Matrix 23, 24 · OR-023
- **Regla:** La gestión de usuarios PUEDE vincular un usuario a un empleado (FR-EMP-003).
- **Aceptación:** El vínculo es opcional y no es necesario para usar el sistema.

## 31. Roles, permisos y autorización supervisada

#### FR-RBAC-001 · Roles del sistema
- **Prioridad:** P2 · **Origen:** Matrix 25
- **Regla:** El sistema DEBE reconocer los roles OWNER, ADMIN, CASHIER, SELLER y WAREHOUSE.
- **Aceptación:** Cada usuario tiene al menos un rol con alcance definido.

#### FR-RBAC-002 · Política de permisos centralizada
- **Prioridad:** P2 · **Origen:** Matrix 25
- **Regla:** Los permisos de cada rol DEBEN definirse en una política centralizada y auditable.
- **Aceptación:** El conjunto de permisos de un rol se puede listar y se verifica por pruebas.

#### FR-RBAC-003 · Permisos con funcionalidad
- **Prioridad:** P2 · **Origen:** Matrix 25
- **Regla:** El sistema NO DEBE otorgar un permiso a un rol mientras no exista la funcionalidad que lo consume.
- **Aceptación:** Una prueba falla si se otorga un permiso sin consumidor.

#### FR-RBAC-004 · Permisos de gestión con alcance de empresa
- **Prioridad:** P2 · **Origen:** Matrix 25
- **Regla:** Los permisos de gestión (configuración, precios, usuarios) DEBEN exigir alcance de empresa.
- **Aceptación:** Un rol con alcance de local no puede ejecutar acciones de gestión de empresa.

**Autorización supervisada.** Concepto transversal: operación que un ADMIN u OWNER
autoriza explícitamente antes de que se ejecute. El mecanismo vigente definido por el OWNER es
el PIN de ADMIN/OWNER ingresado en la caja. El PRD exige los resultados de abajo; el diseño
del mecanismo (almacenamiento, intentos, bloqueos, criptografía, endpoints) corresponde al
Blueprint.

#### FR-AUTH-001 · Autorizador ADMIN u OWNER
- **Prioridad:** P0 · **Origen:** Matrix 11, 12, 13 · OR-018
- **Regla:** Una autorización supervisada SOLO DEBE otorgarla un usuario con rol ADMIN u OWNER.
- **Aceptación:** Un intento de autorizar con otro rol es rechazado y la operación no se ejecuta.
- **Dependencias:** Esta capacidad no tiene dominio propio en la Matrix R4: es transversal (ver su sección 3.2) y hereda P0 de sus consumidores FR-CANCEL y FR-EXCH.

#### FR-AUTH-002 · Mecanismo vigente
- **Prioridad:** P0 · **Origen:** Matrix 3.2 · OR-018
- **Regla:** El mecanismo vigente de autorización supervisada DEBE ser el PIN de ADMIN u OWNER ingresado en la caja donde ocurre la operación.
- **Aceptación:** La operación se autoriza con el PIN del autorizador en la caja, sin que el autorizador deba tomar la sesión del cajero.

#### FR-AUTH-003 · Identidad inequívoca del autorizador
- **Prioridad:** P0 · **Origen:** Matrix 3.2 · OR-018
- **Regla:** El sistema DEBE identificar de forma inequívoca a la persona que autorizó, y NO DEBE aceptar autorizaciones anónimas o compartidas.
- **Aceptación:** Cada autorización se asocia a un único usuario ADMIN u OWNER.

#### FR-AUTH-004 · Operación autorizada
- **Prioridad:** P0 · **Origen:** Matrix 3.2 · OR-018
- **Regla:** Cada autorización DEBE quedar asociada a la operación concreta que autorizó, y no ser reutilizable para otra.
- **Aceptación:** Una autorización de una operación no habilita otra distinta.

#### FR-AUTH-005 · Motivo
- **Prioridad:** P0 · **Origen:** Matrix 3.2 · OR-018
- **Regla:** Cuando la operación lo requiera, la autorización DEBE registrar un motivo obligatorio.
- **Aceptación:** Anulación, cambio sin ticket y descuento sin motivo son rechazados.

#### FR-AUTH-006 · Fecha y hora
- **Prioridad:** P0 · **Origen:** Matrix 3.2 · OR-018
- **Regla:** Cada autorización DEBE registrar fecha y hora.
- **Aceptación:** Toda autorización muestra su fecha y hora.

#### FR-AUTH-007 · AuditLog
- **Prioridad:** P0 · **Origen:** Matrix 3.2, 29 · OR-018
- **Regla:** Cada autorización DEBE generar un registro de auditoría, junto con la operación autorizada y en la misma operación.
- **Aceptación:** No existe operación autorizada sin registro de auditoría del autorizador, ni a la inversa.

#### FR-AUTH-008 · Visibilidad y notificación
- **Prioridad:** P0 · **Origen:** Matrix 3.2, 28 · OR-018
- **Regla:** Cada autorización DEBE ser visible para ADMIN y OWNER en el sistema, con notificación.
- **Aceptación:** Tras una autorización aparece una alerta en la bandeja de ADMIN y OWNER.

#### FR-AUTH-009 · Operaciones sujetas a autorización
- **Prioridad:** P0 · **Origen:** Matrix 3.2 · OR-018
- **Regla:** Requieren autorización supervisada: la anulación post-cobro, el cambio sin ticket o fuera de plazo, el descuento manual, el ajuste manual de la cuenta de empleado, el ajuste de stock sobre el umbral, la aprobación de diferencias grandes de caja, el despacho de transferencias y la emisión de un Voucher de Seña.
- **Aceptación:** Cada operación de la lista es imposible sin autorización supervisada.

#### FR-AUTH-010 · Sin autorización no hay operación
- **Prioridad:** P0 · **Origen:** Matrix 3.2 · OR-018
- **Regla:** El sistema NO DEBE ejecutar parcialmente una operación sujeta a autorización cuya autorización falle.
- **Aceptación:** Una autorización fallida no deja stock, caja ni estado modificados.

## 32. Alertas y notificaciones

#### FR-ALERT-001 · Bandeja de alertas
- **Prioridad:** P1 · **Origen:** Matrix 28 · OR-018
- **Regla:** El sistema DEBE ofrecer a ADMIN y OWNER una bandeja de alertas y visibilidad de operaciones relevantes.
- **Aceptación:** La bandeja lista alertas con tipo, fecha, ubicación y enlace a la operación.

#### FR-ALERT-002 · Eventos que alertan
- **Prioridad:** P1 · **Origen:** Matrix 28 · OR-018, OR-025
- **Regla:** La bandeja DEBE recibir: transferencias en `PENDING_REVIEW`, retiros de empleados, descuentos, anulaciones, cambios sin ticket y autorizaciones supervisadas.
- **Aceptación:** Cada uno de esos eventos genera una alerta.

#### FR-ALERT-003 · Persistencia de alertas pendientes
- **Prioridad:** P0 · **Origen:** Matrix 19, 28 · OR-022
- **Regla:** Una alerta de transferencia en `PENDING_REVIEW` DEBE persistir hasta que la transferencia se resuelva.
- **Aceptación:** Marcar la alerta como vista no la cierra; solo la cierra la resolución.
- **Excepciones:** La prioridad es P0 porque la alerta acompaña a FR-TRANSFER-006, aunque el dominio de origen (28) es P1.

#### FR-ALERT-004 · Visibilidad en tiempo real y alcance
- **Prioridad:** P2 · **Origen:** Matrix 50, 26
- **Regla:** Los eventos en tiempo real DEBEN respetar el alcance vigente del usuario.
- **Aceptación:** Revocar el alcance de un usuario corta su recepción de eventos de esa ubicación.

## 33. Auditoría

#### FR-AUDIT-001 · Auditoría de operaciones relevantes
- **Prioridad:** P1 · **Origen:** Matrix 29
- **Regla:** Toda operación relevante (dinero, stock, configuración, autorizaciones, usuarios y permisos) DEBE generar un registro de auditoría con autor, fecha y operación.
- **Aceptación:** Cada mutación relevante tiene registro de auditoría, y en la misma operación.

#### FR-AUDIT-002 · Consulta desde la administración
- **Prioridad:** P1 · **Origen:** Matrix 29, 28
- **Regla:** ADMIN y OWNER DEBEN poder consultar la auditoría desde la administración.
- **Aceptación:** La auditoría se puede filtrar por fecha, autor, tipo de operación y ubicación.

#### FR-AUDIT-003 · Registro inmutable
- **Prioridad:** P1 · **Origen:** Matrix 29, 51
- **Regla:** El registro de auditoría NO DEBE poder modificarse ni borrarse.
- **Aceptación:** Un intento de modificar o borrar un registro de auditoría es rechazado.

#### FR-AUDIT-004 · Autorizador en la auditoría
- **Prioridad:** P0 · **Origen:** Matrix 3.2 · OR-018
- **Regla:** El registro de auditoría de una operación autorizada DEBE incluir al autorizador y el motivo.
- **Aceptación:** Para una anulación, el registro muestra operador, autorizador y motivo.

## 34. Reportes

#### FR-RPT-001 · Ventas por local, medio y vendedor
- **Prioridad:** P1 · **Origen:** Matrix 30
- **Regla:** El sistema DEBE reportar ventas por local, por medio de pago y por vendedor.
- **Aceptación:** El reporte diario por local y medio cuadra con los cierres de caja.

#### FR-RPT-002 · Cierres de caja
- **Prioridad:** P1 · **Origen:** Matrix 30, 10
- **Regla:** El sistema DEBE reportar los cierres de caja por período y local.
- **Aceptación:** El reporte lista cierres con esperado, contado y diferencia.

#### FR-RPT-003 · Valorización y rotación de stock
- **Prioridad:** P1 · **Origen:** Matrix 30
- **Regla:** El sistema DEBE reportar la valorización y la rotación del stock.
- **Aceptación:** La valorización por ubicación se calcula con el costo vigente.

#### FR-RPT-004 · Deuda de empleados
- **Prioridad:** P1 · **Origen:** Matrix 30, 52
- **Regla:** El sistema DEBE reportar la deuda de empleados por empleado y total.
- **Aceptación:** La suma por empleado coincide con el total del reporte y con las cuentas.

#### FR-RPT-005 · Indicadores del día
- **Prioridad:** P1 · **Origen:** Matrix 30, 47
- **Regla:** Los indicadores "de hoy" DEBEN calcularse sobre el día operativo de Argentina.
- **Aceptación:** Las ventas de la noche aparecen en el día operativo correcto.

# Parte J — Comprobantes

## 35. Ticket no fiscal

#### FR-TICKET-001 · Ticket de venta
- **Prioridad:** P1 · **Origen:** Matrix 38 · OR-042
- **Regla:** El sistema DEBE emitir un ticket no fiscal de cada venta que permita identificar la venta original.
- **Aceptación:** Toda venta completada puede reimprimirse y el ticket permite ubicarla.

#### FR-TICKET-002 · Ticket de cierre y de cambio
- **Prioridad:** P1 · **Origen:** Matrix 38
- **Regla:** El sistema DEBE emitir ticket de cierre de caja y de cambio.
- **Aceptación:** Un cambio emite un ticket que referencia la venta original.

#### FR-TICKET-003 · Impresión térmica
- **Prioridad:** P1 · **Origen:** Matrix 38
- **Regla:** El ticket DEBE poder imprimirse en impresora térmica.
- **Aceptación:** Se imprime en una impresora térmica configurada en el local.

## 36. ARCA / facturación

#### FR-ARCA-001 · Integración digital
- **Prioridad:** P1 · **Origen:** Matrix 37 · OR-042
- **Regla:** El sistema DEBE integrarse digitalmente con ARCA para emitir factura electrónica.
- **Aceptación:** Cada venta fiscal obtiene su CAE.

#### FR-ARCA-002 · Fallback manual
- **Prioridad:** P1 · **Origen:** Matrix 37 · OR-042
- **Regla:** El sistema DEBE ofrecer un camino manual cuando ARCA no esté disponible.
- **Aceptación:** Con ARCA no disponible, la venta se completa y el comprobante se regulariza por el camino manual.

#### FR-ARCA-003 · Elección al finalizar la venta
- **Prioridad:** P1 · **Origen:** Matrix 37, 38 · OR-042
- **Regla:** Al finalizar la venta el cajero DEBE elegir entre ticket no fiscal y factura ARCA.
- **Aceptación:** La elección queda registrada en la venta.

# Parte K — Plataforma y requisitos no funcionales

## 37. Configuración

#### FR-CONF-001 · Configuración operativa en el sistema
- **Prioridad:** P1 · **Origen:** Matrix 40 · OR-001
- **Regla:** La configuración operativa (locales y medios del checkout) DEBE gestionarse desde el sistema y quedar auditada.
- **Aceptación:** Cambiar el modelo de cobro de un local no requiere un despliegue.

#### FR-CONF-002 · Parámetros de negocio configurables
- **Prioridad:** P1 · **Origen:** Matrix 40 · OR-003, OR-005, OR-006, OR-026, OR-036, OR-051
- **Regla:** Los siguientes parámetros DEBEN ser configurables por ADMIN u OWNER: recargos por medio (incluido QR), límite global de deuda de empleado, monto mínimo de Seña, plazo de cambios (inicialmente 15 días; FR-EXCH-003), umbral de diferencia de caja y umbral de ajuste de stock que exige autorización (FR-ADJ-004). CASHIER y SELLER NO DEBEN poder modificarlos.
- **Aceptación:** Cada parámetro se modifica desde la configuración, con autor y fecha auditados.

#### FR-CONF-003 · Sin valores de negocio fijos en el código
- **Prioridad:** P1 · **Origen:** Matrix 40
- **Regla:** Los valores de negocio listados en FR-CONF-002 NO DEBEN estar fijados en el código.
- **Aceptación:** Ninguno de esos valores requiere un cambio de código para modificarse.

## 38. Seguridad

#### NFR-SEC-001 · Autorización por solicitud
- **Prioridad:** P1 · **Origen:** Matrix 41
- **Regla:** Cada solicitud al sistema DEBE verificar la identidad y el alcance vigentes del usuario.
- **Aceptación:** Un usuario dado de baja o con alcance revocado pierde acceso de inmediato.

#### NFR-SEC-002 · Revocación de alcance en tiempo real
- **Prioridad:** P2 · **Origen:** Matrix 41, 50
- **Regla:** Revocar el alcance de un usuario DEBE cortar su recepción de eventos en tiempo real.
- **Aceptación:** Tras revocar, el usuario no recibe eventos de la ubicación revocada.

#### NFR-SEC-003 · Dependencias sin vulnerabilidades conocidas
- **Prioridad:** P1 · **Origen:** Matrix 41
- **Regla:** Las dependencias de los tres componentes (API, cliente y administración) NO DEBEN tener vulnerabilidades conocidas sin tratar.
- **Aceptación:** La auditoría de dependencias de cada componente informa cero vulnerabilidades.

#### NFR-SEC-004 · Protección contra abuso
- **Prioridad:** P1 · **Origen:** Matrix 41
- **Regla:** El sistema DEBE limitar la tasa de solicitudes y los intentos de inicio de sesión.
- **Aceptación:** Superado el límite, las solicitudes son rechazadas.

#### NFR-SEC-005 · Secretos fuera del repositorio
- **Prioridad:** P1 · **Origen:** Matrix 41
- **Regla:** El repositorio NO DEBE contener secretos ni credenciales.
- **Aceptación:** El análisis automático de secretos en integración continua no encuentra credenciales.

**Nota:** MFA para OWNER/ADMIN y rotación/revocación de sesiones aparecen como brechas
observadas en la Matrix R4 (dominio 41), pero no están definidas como objetivo por el OWNER;
no son requisitos de este PRD hasta que se decida.

## 39. Integridad monetaria y de stock

#### NFR-MONEY-001 · Importes enteros en centavos
- **Prioridad:** P0 · **Origen:** Matrix 51, 52
- **Regla:** Todo importe monetario DEBE tratarse como un entero en centavos, sin aritmética decimal que pierda precisión.
- **Aceptación:** La suma de cualquier conjunto de importes distribuidos es exacta, sin diferencias de centavos.

#### NFR-MONEY-002 · Historial financiero inmutable
- **Prioridad:** P1 · **Origen:** Matrix 51
- **Regla:** Los registros de caja, pagos, cuenta de empleados y auditoría NO DEBEN poder modificarse ni borrarse; una corrección DEBE ser un movimiento nuevo.
- **Aceptación:** Un intento de modificar o borrar uno de esos registros es rechazado.

#### NFR-MONEY-003 · Saldos reconstruibles
- **Prioridad:** P0 · **Origen:** Matrix 52
- **Regla:** Todo saldo (cuenta de empleado, cuenta de proveedor) DEBE ser reconstruible a cualquier fecha a partir de sus movimientos.
- **Aceptación:** El saldo a una fecha pasada coincide con la suma de movimientos hasta esa fecha.

#### NFR-MONEY-004 · Reversas únicas y vinculadas
- **Prioridad:** P1 · **Origen:** Matrix 9, 52
- **Regla:** Toda reversa DEBE referenciar a un único original y cada original solo PUEDE revertirse una vez.
- **Aceptación:** Una segunda reversa del mismo original es rechazada.

#### NFR-MONEY-005 · Valores congelados
- **Prioridad:** P1 · **Origen:** Matrix 3, 32, 53
- **Regla:** Los precios, recargos y valores aplicados a una operación DEBEN congelarse al ejecutarla.
- **Aceptación:** Cambios posteriores de catálogo o configuración no alteran operaciones ya registradas.

#### NFR-STOCK-001 · Stock nunca negativo
- **Prioridad:** P0 · **Origen:** Matrix 53, 16
- **Regla:** El stock NO DEBE quedar negativo en ninguna operación.
- **Aceptación:** Dos operaciones simultáneas sobre la última unidad disponible: solo una se acepta.

#### NFR-STOCK-002 · Movimientos de stock trazables e inmutables
- **Prioridad:** P0 · **Origen:** Matrix 16, 51
- **Regla:** Los movimientos de stock DEBEN referenciar su documento de origen y NO DEBEN poder modificarse ni borrarse.
- **Aceptación:** Modificar o borrar un movimiento de stock es rechazado.

#### NFR-STOCK-003 · Reservado no consumible
- **Prioridad:** P0 · **Origen:** Matrix 53
- **Regla:** Ninguna operación PUEDE consumir stock reservado por una venta o Seña.
- **Aceptación:** Un retiro o transferencia no puede tomar unidades reservadas.

## 40. Concurrencia e idempotencia

#### NFR-CONC-001 · Operaciones críticas atómicas
- **Prioridad:** P0 · **Origen:** Matrix 53, 11, 12
- **Regla:** Toda operación crítica que combine stock, dinero y auditoría DEBE ocurrir completa o no ocurrir.
- **Aceptación:** Ante una falla intermedia no queda ningún efecto parcial en stock, caja ni auditoría.

#### NFR-CONC-002 · Liberación y expiración sin duplicación
- **Prioridad:** P1 · **Origen:** Matrix 32
- **Regla:** Las liberaciones de stock por vencimiento NO DEBEN duplicarse bajo ejecución concurrente.
- **Aceptación:** Ejecuciones simultáneas del vencimiento liberan el stock una sola vez.

#### NFR-CONC-003 · Operaciones concurrentes sobre el mismo recurso
- **Prioridad:** P1 · **Origen:** Matrix 26, 53
- **Regla:** Operaciones concurrentes sobre el mismo recurso (inventario, caja, alcance de usuario) NO DEBEN producir estados inconsistentes ni bloqueos mutuos.
- **Aceptación:** Asignaciones cruzadas simultáneas de alcance se resuelven sin bloqueo permanente.

#### NFR-IDEMP-001 · Reintento sin duplicación
- **Prioridad:** P0 · **Origen:** Matrix 53, 17, 9
- **Regla:** Reintentar una operación con la misma clave NO DEBE duplicar sus efectos.
- **Aceptación:** Repetir el mismo retiro, ajuste o retiro de caja con la misma clave devuelve el resultado original sin duplicar.

#### NFR-IDEMP-002 · Clave repetida con datos distintos
- **Prioridad:** P1 · **Origen:** Matrix 53
- **Regla:** Reutilizar una clave de idempotencia con datos distintos DEBE ser rechazado.
- **Aceptación:** La segunda solicitud con payload distinto es rechazada como conflicto.

#### NFR-AUDIT-001 · Auditoría transversal
- **Prioridad:** P1 · **Origen:** Matrix 29
- **Regla:** Toda operación sensible DEBE registrar su autor.
- **Aceptación:** No existe operación sensible sin autor identificado.

#### NFR-AUDIT-002 · Autorizador siempre identificado
- **Prioridad:** P0 · **Origen:** Matrix 3.2 · OR-018
- **Regla:** Toda operación que requiera autorización supervisada DEBE registrar al autorizador en su auditoría.
- **Aceptación:** Ninguna operación autorizada carece de autorizador identificado.

#### NFR-AUDIT-003 · Auditoría en la misma operación
- **Prioridad:** P1 · **Origen:** Matrix 29
- **Regla:** El registro de auditoría DEBE formar parte de la misma operación que audita.
- **Aceptación:** Si la operación se revierte, no queda registro de auditoría huérfano, y a la inversa.

#### NFR-TIME-001 · Día operativo de Argentina
- **Prioridad:** P1 · **Origen:** Matrix 47 · OR-047
- **Regla:** El día operativo DEBE definirse en la zona America/Argentina/Buenos_Aires, independientemente de la zona del servidor.
- **Aceptación:** Una venta a las 22:30 hora de Argentina cae en el día operativo correcto, aun si el servidor opera en UTC.

#### NFR-TIME-002 · Semana lunes a sábado
- **Prioridad:** P0 · **Origen:** Matrix 54 · OR-030
- **Regla:** La semana de liquidación DEBE calcularse de lunes a sábado en la zona del negocio.
- **Aceptación:** Un descuento registrado un sábado a las 23:30 hora de Argentina pertenece a esa semana.

## 41. Disponibilidad, recuperación y operabilidad

No se fijan métricas de disponibilidad ni tiempos de respuesta: no hay umbrales de negocio
verificables.

#### NFR-OPS-001 · Esquema de PILOT alineado antes del despliegue
- **Prioridad:** P1 · **Origen:** Matrix 42
- **Regla:** El despliegue de System V2 en PILOT DEBE hacerse sobre una base migrada al mismo nivel de esquema que el producto, con respaldo previo, ensayo en seco y aprobación del OWNER.
- **Aceptación:** El chequeo de arranque pasa contra PILOT migrado; existe respaldo verificado previo a la migración.

#### NFR-OPS-002 · Verificación de preparación al arrancar
- **Prioridad:** P2 · **Origen:** Matrix 43
- **Regla:** El sistema DEBE verificar al arrancar que el esquema cumple lo exigido por la versión desplegada.
- **Aceptación:** Con un esquema desactualizado el sistema no arranca y informa el motivo.

#### NFR-OPS-003 · Cobertura de pruebas en integración continua
- **Prioridad:** P1 · **Origen:** Matrix 44
- **Regla:** La integración continua DEBE ejecutar las pruebas de la API, del cliente y de la administración, y las pruebas de concurrencia contra una base descartable.
- **Aceptación:** Un cambio que rompa las pruebas de administración o de concurrencia hace fallar la integración continua.

#### NFR-OPS-004 · Despliegue reproducible con retorno
- **Prioridad:** P1 · **Origen:** Matrix 45
- **Regla:** La promoción de System V2 a PILOT DEBE ser reproducible, con verificación de preparación y camino de retorno ensayado.
- **Aceptación:** El procedimiento de despliegue y retorno se ensaya en un entorno de prueba antes de aplicarse.

#### NFR-OPS-005 · Recuperación de datos
- **Prioridad:** P1 · **Origen:** Matrix 42, 45
- **Regla:** Los datos DEBEN poder restaurarse desde un respaldo verificado.
- **Aceptación:** Se verificó una restauración a partir de un respaldo reciente.

#### NFR-OPS-006 · Evolución de esquema sin interrupción lógica
- **Prioridad:** P1 · **Origen:** Matrix 27, 42 · OR-020
- **Regla:** La unificación de sucursales y ubicaciones DEBE hacerse de forma gradual (expand/contract) sin perder datos.
- **Aceptación:** En cada etapa de la migración los datos operativos permanecen consistentes y consultables.

# Parte L — Transición

## 42. Migración desde el sistema viejo

#### FR-MIG-001 · Importación del saldo de empleados
- **Prioridad:** P0 · **Origen:** Matrix 52 · OR-028
- **Regla:** El sistema DEBE importar el saldo vigente de empleados del sistema anterior como `OPENING_BALANCE`.
- **Aceptación:** Tras la importación, el saldo de cada empleado coincide con el saldo vigente informado por el sistema anterior a la fecha de corte.

#### FR-MIG-002 · Control de la importación
- **Prioridad:** P0 · **Origen:** Matrix 52 · OR-028
- **Regla:** La importación DEBE poder verificarse contra la lista de origen y NO DEBE ejecutarse dos veces para el mismo empleado.
- **Aceptación:** Existe un informe que compara lo importado con el origen; una segunda importación sobre un empleado ya cargado es rechazada.
- **Dependencias:** Apéndice D (fecha de corte y saldos reales).

Los demás datos del sistema anterior (catálogo, clientes, stock inicial) no tienen reglas
definidas en la Matrix R4 y no se inventan en este PRD; su tratamiento corresponde al plan de
migración del Blueprint.

## 43. Entrega por fases P0 / P1 / P2

La prioridad indica el **orden de entrega**. El PRD describe el producto completo; ninguna fase
quita requisitos del producto objetivo. La lista siguiente se genera desde los campos
`Prioridad` de cada requisito.

**P0 — primera entrega** (96 requisitos): FR-PAY-006, FR-PAY-012, FR-CASH-009, FR-CANCEL-001, FR-CANCEL-002, FR-CANCEL-003, FR-CANCEL-004, FR-CANCEL-005, FR-CANCEL-006, FR-CANCEL-007, FR-CANCEL-008, FR-EXCH-001, FR-EXCH-002, FR-EXCH-003, FR-EXCH-004, FR-EXCH-005, FR-EXCH-006, FR-EXCH-007, FR-EXCH-008, FR-EXCH-009, FR-EXCH-010, FR-EXCH-011, FR-EXCH-012, FR-EXCH-013, FR-STOCK-003, FR-STOCK-004, FR-TRANSFER-001, FR-TRANSFER-002, FR-TRANSFER-003, FR-TRANSFER-004, FR-TRANSFER-005, FR-TRANSFER-006, FR-TRANSFER-007, FR-TRANSFER-008, FR-RECV-004, FR-EMP-001, FR-EMP-002, FR-EMP-003, FR-EMP-004, FR-EMP-005, FR-EMP-006, FR-EMP-007, FR-EMPACC-001, FR-EMPACC-002, FR-EMPACC-003, FR-EMPACC-004, FR-EMPACC-005, FR-EMPACC-006, FR-EMPACC-007, FR-EMPACC-008, FR-EMPACC-009, FR-EMPACC-010, FR-EMPWD-001, FR-EMPWD-002, FR-EMPWD-003, FR-EMPWD-004, FR-EMPWD-005, FR-EMPWD-006, FR-EMPWD-007, FR-EMPWD-008, FR-EMPWD-009, FR-EMPWD-010, FR-EMPSET-001, FR-EMPSET-002, FR-EMPSET-003, FR-EMPSET-004, FR-EMPSET-005, FR-EMPSET-006, FR-EMPSET-007, FR-EMPSET-008, FR-EMPSET-009, FR-EMPSET-010, FR-EMPSET-011, FR-AUTH-001, FR-AUTH-002, FR-AUTH-003, FR-AUTH-004, FR-AUTH-005, FR-AUTH-006, FR-AUTH-007, FR-AUTH-008, FR-AUTH-009, FR-AUTH-010, FR-ALERT-003, FR-AUDIT-004, NFR-MONEY-001, NFR-MONEY-003, NFR-STOCK-001, NFR-STOCK-002, NFR-STOCK-003, NFR-CONC-001, NFR-IDEMP-001, NFR-AUDIT-002, NFR-TIME-002, FR-MIG-001, FR-MIG-002

**P1 — segunda entrega** (117 requisitos): FR-ORG-001, FR-ORG-002, FR-ORG-003, FR-ORG-004, FR-ORG-005, FR-CAT-001, FR-CAT-002, FR-CAT-003, FR-CAT-004, FR-CAT-005, FR-CAT-006, FR-CAT-007, FR-PRICE-001, FR-PRICE-002, FR-PRICE-003, FR-PRICE-004, FR-PRICE-005, FR-PRICE-006, FR-PRICE-008, FR-PRICE-009, FR-SALE-001, FR-SALE-002, FR-SALE-004, FR-SALE-005, FR-SALE-006, FR-PAY-001, FR-PAY-002, FR-PAY-003, FR-PAY-004, FR-PAY-005, FR-PAY-009, FR-PAY-010, FR-PAY-011, FR-CASH-002, FR-CASH-003, FR-CASH-004, FR-CASH-005, FR-CASH-006, FR-CASH-007, FR-CASH-008, FR-CASH-010, FR-CASH-011, FR-CASH-012, FR-DISC-001, FR-DISC-002, FR-DISC-003, FR-DISC-004, FR-DISC-005, FR-RECV-001, FR-RECV-002, FR-RECV-003, FR-CUST-001, FR-CUST-002, FR-CUST-003, FR-SENA-001, FR-SENA-002, FR-SENA-003, FR-SENA-004, FR-SENA-005, FR-SENA-006, FR-SENA-007, FR-SENA-008, FR-SENA-009, FR-SENA-010, FR-VOUCH-001, FR-VOUCH-002, FR-VOUCH-003, FR-VOUCH-004, FR-VOUCH-005, FR-VOUCH-006, FR-VOUCH-007, FR-VOUCH-008, FR-VOUCH-009, FR-VOUCH-010, FR-VOUCH-011, FR-USER-001, FR-USER-002, FR-USER-003, FR-USER-004, FR-USER-005, FR-ALERT-001, FR-ALERT-002, FR-AUDIT-001, FR-AUDIT-002, FR-AUDIT-003, FR-RPT-001, FR-RPT-002, FR-RPT-003, FR-RPT-004, FR-RPT-005, FR-TICKET-001, FR-TICKET-002, FR-TICKET-003, FR-ARCA-001, FR-ARCA-002, FR-ARCA-003, FR-CONF-001, FR-CONF-002, FR-CONF-003, NFR-SEC-001, NFR-SEC-003, NFR-SEC-004, NFR-SEC-005, NFR-MONEY-002, NFR-MONEY-004, NFR-MONEY-005, NFR-CONC-002, NFR-CONC-003, NFR-IDEMP-002, NFR-AUDIT-001, NFR-AUDIT-003, NFR-TIME-001, NFR-OPS-001, NFR-OPS-003, NFR-OPS-004, NFR-OPS-005, NFR-OPS-006

**P2 — tercera entrega** (40 requisitos): FR-PRICE-007, FR-SALE-003, FR-WHOL-001, FR-WHOL-002, FR-PAY-007, FR-PAY-008, FR-CASH-001, FR-CASH-013, FR-STOCK-001, FR-STOCK-002, FR-STOCK-005, FR-STOCK-006, FR-STOCK-007, FR-ADJ-001, FR-ADJ-002, FR-ADJ-003, FR-ADJ-004, FR-SUPP-001, FR-SUPP-002, FR-PURCHASE-001, FR-PURCHASE-002, FR-PURCHASE-003, FR-SUPDEBT-001, FR-SUPDEBT-002, FR-SUPDEBT-003, FR-EXP-001, FR-EXP-002, FR-EXP-003, FR-EXP-004, FR-TREAS-001, FR-TREAS-002, FR-TREAS-003, FR-TREAS-004, FR-RBAC-001, FR-RBAC-002, FR-RBAC-003, FR-RBAC-004, FR-ALERT-004, NFR-SEC-002, NFR-OPS-002

**Orden de implementación (heredado de la Matrix R4, sección 5):** (1) Pagos + Checkout con QR
+ día operativo; (2) Ledgers inmutables + guard de movimientos manuales; (3) Branch/Location
expand; (4) Autorización supervisada y bandeja de alertas; (5) Tipos nuevos de movimiento de
stock; (6) Employee + cuenta corriente + saldo inicial + límite; (7) Retiro/devolución,
liquidación y pago directo; (8) Anulación y Cambios; (9) Transferencias, alertas y remitos;
(10) Descuentos, Clientes, Ticket y ARCA. En paralelo: CI, migraciones, readiness y deploy.

## 44. Criterios globales de aceptación

1. Todo requisito P0 cumple su criterio de aceptación verificado por una prueba automatizada o por una verificación manual documentada.
2. Toda regla OWNER del Apéndice B con estado ACTIVE está cubierta por al menos un requisito aceptado.
3. Ningún flujo de dinero o stock puede dejar un efecto parcial (NFR-CONC-001).
4. El stock nunca es negativo en ningún escenario probado (NFR-STOCK-001).
5. Todo cobro no efectivo tiene referencia verificable (FR-PAY-006).
6. Toda operación sujeta a autorización supervisada registra al autorizador, el motivo, la fecha y la auditoría (FR-AUTH).
7. La caja concilia al cierre, incluidos QR, pagos de empleados y Vouchers (FR-CASH-002, FR-CASH-003, FR-CASH-009, FR-CASH-010).
8. El saldo de cada cuenta de empleado coincide con la suma de sus movimientos a cualquier fecha (FR-EMPACC-001, NFR-MONEY-003).
9. Ninguna operación referencia un instrumento de saldo a favor distinto del Voucher de Seña (FR-VOUCH-010).
10. Los valores de negocio de FR-CONF-002 se modifican sin cambio de código.

## 45. Glosario

| Término | Definición |
|---|---|
| Administración | Los roles ADMIN y OWNER. |
| Autorización supervisada | Autorización explícita de ADMIN u OWNER, previa a una operación; hoy mediante el PIN de ADMIN/OWNER en la caja. |
| bps | Puntos básicos; 100 bps = 1%. |
| cashPrice | Precio base efectivo de una variante. |
| Cambio | Operación comercial de devolución de prenda(s) y entrega de otra(s), vinculada a una venta original (FR-EXCH). |
| Anulación | Reversión de la operación original de venta ya cobrada (FR-CANCEL). |
| Día operativo | Día del negocio en la zona America/Argentina/Buenos_Aires. |
| employeeCode | Código único visible de un empleado. |
| FIXED_TOTAL | Modelo de cobro de transición, no objetivo. |
| OPENING_BALANCE | Movimiento de saldo inicial de la cuenta de un empleado con fecha de corte. |
| PENDING_REVIEW | Estado de una transferencia con diferencia pendiente de resolución por ADMIN. |
| PROPORTIONAL_V1 | Modelo de cobro objetivo para todos los locales. |
| Seña | Reserva de prendas con pago parcial y vencimiento de 120 horas. |
| Ticket no fiscal | Comprobante de venta que no es factura ARCA. |
| Valor reconocido | Importe efectivamente pagado por una línea de la venta original, base de un cambio. |
| Voucher de Seña | Único vale del sistema, ligado a una Seña cancelada y emitido con autorización de ADMIN. |

# Apéndices

## Apéndice A — Matrix R4 → PRD

| Dominio Matrix | Nombre | Sección PRD | Prefijo de requisitos | Requisitos |
|---|---|---|---|---|
| 1 | Catálogo | 6 | FR-CAT | 7 |
| 2 | Variantes | 6 | FR-CAT | 7 |
| 3 | Pricing | 7 | FR-PRICE | 9 |
| 4 | Ciclo de vida de la venta | 8 | FR-SALE | 6 |
| 5 | Checkout | 9 | FR-PAY | 12 |
| 6 | Pagos | 9 | FR-PAY | 12 |
| 7 | Pago combinado | 9 | FR-PAY | 12 |
| 8 | Caja / CashSession | 10 | FR-CASH | 13 |
| 9 | CashMovement | 10 | FR-CASH | 13 |
| 10 | Cierre / arqueo | 10 | FR-CASH | 13 |
| 11 | Anulación post-cobro | 11 | FR-CANCEL | 8 |
| 12 | Cambios | 12 | FR-EXCH | 13 |
| 13 | Descuentos | 13 | FR-DISC | 5 |
| 14 | Inventario | 14 | FR-STOCK | 7 |
| 15 | Reservas | 14 | FR-STOCK | 7 |
| 16 | StockMovement | 14 y 39 | FR-STOCK, NFR-STOCK | 10 |
| 17 | Ajustes manuales | 15 | FR-ADJ | 4 |
| 18 | Warehouse | 5 y 16 | FR-ORG, FR-TRANSFER | 13 |
| 19 | Transferencias | 16 | FR-TRANSFER | 8 |
| 20 | Recepción / remitos | 17 | FR-RECV | 4 |
| 21 | Compras | 26 | FR-PURCHASE | 3 |
| 22 | Proveedores | 25 | FR-SUPP | 2 |
| 23 | Usuarios | 30 | FR-USER | 5 |
| 24 | Empleados | 18 | FR-EMP | 7 |
| 25 | RBAC | 31 | FR-RBAC | 4 |
| 26 | Scope por sucursal | 30 | FR-USER | 5 |
| 27 | Branch / Location | 5 | FR-ORG | 5 |
| 28 | Admin | 32 y 30 | FR-ALERT, FR-USER | 9 |
| 29 | AuditLog | 33 | FR-AUDIT, NFR-AUDIT | 7 |
| 30 | Reportes | 34 | FR-RPT | 5 |
| 31 | ExternalCollection | 9 | FR-PAY | 12 |
| 32 | Seña | 23 | FR-SENA | 10 |
| 33a | Voucher de Seña | 24 | FR-VOUCH | 11 |
| 34 | Gastos | 28 | FR-EXP | 4 |
| 35 | Tesorería | 29 | FR-TREAS | 4 |
| 36 | Contabilidad operativa | 29 | FR-TREAS | 4 |
| 37 | ARCA / fiscal | 36 | FR-ARCA | 3 |
| 38 | Tickets / impresión | 35 | FR-TICKET | 3 |
| 39 | Etiquetas | 6 | FR-CAT | 7 |
| 40 | Configuración | 37 | FR-CONF | 3 |
| 41 | Seguridad | 38 | NFR-SEC | 5 |
| 42 | Migraciones | 41 y 42 | NFR-OPS, FR-MIG | 8 |
| 43 | Readiness | 41 | NFR-OPS | 6 |
| 44 | Testing | 41 | NFR-OPS | 6 |
| 45 | Deploy | 41 | NFR-OPS | 6 |
| 46 | Clientes | 22 | FR-CUST | 3 |
| 47 | Día operativo / zona horaria | 5 | FR-ORG, NFR-TIME | 7 |
| 48 | Mayorista | 8 | FR-WHOL | 2 |
| 49 | Corrección de venta pendiente | 8 | FR-SALE | 6 |
| 50 | Realtime | 32 y 38 | FR-ALERT, NFR-SEC | 9 |
| 51 | Inmutabilidad de los ledgers | 39 | NFR-MONEY, NFR-STOCK | 8 |
| 52 | EmployeeAccount | 19 | FR-EMPACC | 10 |
| 53 | EmployeeWithdrawal | 20 | FR-EMPWD | 10 |
| 54 | EmployeeSettlement | 21 | FR-EMPSET | 11 |

Cada dominio tiene al menos una sección PRD y un prefijo con requisitos. La columna "Requisitos" cuenta todos los requisitos del prefijo (varios dominios comparten prefijo). Capacidad transversal sin dominio propio en la Matrix: `FR-AUTH` (Matrix 3.2).

## Apéndice B — Registro de reglas OWNER

Cada regla tiene un ID estable `OR-nnn`. Una regla reemplazada no se borra: pasa a `SUPERSEDED`
y apunta a la que la reemplaza.

**Semántica de la fecha:** la columna "Fecha de registro" es la fecha de **consolidación y
registro** de la regla en la Matrix (revisiones R2 a R4, todas consolidadas el 2026-10-21). **No
es necesariamente la fecha histórica original en que el OWNER tomó la decisión**, que este
documento no pretende reconstruir.

Los requisitos relacionados se derivan del campo `Origen` de cada requisito.

| ID | Fecha de registro | Regla decidida | Requisitos relacionados | Estado |
|---|---|---|---|---|
| OR-001 | 2026-10-21 | PROPORTIONAL_V1 en todos los locales; FIXED_TOTAL se deprecia progresivamente. | FR-PAY-001, FR-PAY-002, FR-PAY-003, FR-PAY-006, FR-CONF-001 | ACTIVE |
| OR-002 | 2026-10-21 | QR está habilitado y debe soportarse en PROPORTIONAL_V1. | FR-PAY-003, FR-PAY-004, FR-PAY-005 | ACTIVE |
| OR-003 | 2026-10-21 | El porcentaje de QR (`qrAdjustmentBps`) lo configura ADMIN/OWNER; no se hardcodea. | FR-PRICE-005, FR-PAY-005, FR-CONF-002 | ACTIVE |
| OR-004 | 2026-10-21 | `cashPrice` es el precio base efectivo. | FR-PRICE-001 | ACTIVE |
| OR-005 | 2026-10-21 | Los recargos en bps por medio solo los modifican ADMIN/OWNER; un cambio afecta solo operaciones futuras. | FR-PRICE-002, FR-PRICE-003, FR-PRICE-004, FR-CONF-002 | ACTIVE |
| OR-006 | 2026-10-21 | Plazo de cambio: inicialmente 15 días; ADMIN/OWNER pueden modificar la cantidad de días (con auditoría); CASHIER/SELLER no. | FR-EXCH-003, FR-CONF-002 | ACTIVE |
| OR-007 | 2026-10-21 | Ticket obligatorio en el flujo normal de cambio. | FR-EXCH-004 | ACTIVE |
| OR-008 | 2026-10-21 | Cambio sin ticket: PIN ADMIN/OWNER + motivo. | FR-EXCH-005 | ACTIVE |
| OR-009 | 2026-10-21 | Todo cambio está siempre vinculado a la venta original. | FR-EXCH-002 | ACTIVE |
| OR-010 | 2026-10-21 | El cambio puede hacerse en otra sucursal. | FR-EXCH-006 | ACTIVE |
| OR-011 | 2026-10-21 | Valor reconocido = importe efectivamente pagado por la línea original. | FR-PAY-012, FR-EXCH-007 | ACTIVE |
| OR-012 | 2026-10-21 | Nueva prenda de mayor valor: paga la diferencia; de igual valor: cambio directo. | FR-EXCH-008, FR-EXCH-009 | ACTIVE |
| OR-013 | 2026-10-21 | Nueva prenda de menor valor: no se devuelve la diferencia y no hay StoreCredit por diferencia. | FR-EXCH-010 | ACTIVE |
| OR-014 | 2026-10-21 | Anulación post-cobro: autorización por PIN ADMIN/OWNER y motivo obligatorio. | FR-SALE-004, FR-CANCEL-001, FR-CANCEL-002, FR-CANCEL-003 | ACTIVE |
| OR-015 | 2026-10-21 | La anulación no devuelve efectivo automáticamente. | FR-CANCEL-005 | ACTIVE |
| OR-016 | 2026-10-21 | No existe vale general para venta normal; la resolución comercial es el cambio de prenda, cobrando la diferencia si la nueva vale más. | FR-CANCEL-006, FR-CANCEL-007, FR-EXCH-001 | ACTIVE |
| OR-017 | 2026-10-21 | El Voucher es específico de Seña, salvo decisión futura. | FR-VOUCH-010 | ACTIVE |
| OR-018 | 2026-10-21 | Autorización transversal por PIN ADMIN/OWNER en caja: se registra quién autorizó, AuditLog y notificación/visibilidad en el sistema. | FR-CANCEL-008, FR-EXCH-013, FR-AUTH-001, FR-AUTH-002, FR-AUTH-003, FR-AUTH-004, FR-AUTH-005, FR-AUTH-006, FR-AUTH-007, FR-AUTH-008, FR-AUTH-009, FR-AUTH-010, FR-ALERT-001, FR-ALERT-002, FR-AUDIT-004, NFR-AUDIT-002 | ACTIVE |
| OR-019 | 2026-10-21 | Descuentos: solo ADMIN/OWNER, con motivo, auditoría y visibilidad para el OWNER; sin topes por rol. | FR-DISC-001, FR-DISC-002, FR-DISC-003, FR-DISC-004 | ACTIVE |
| OR-020 | 2026-10-21 | Branch/Location: modelo único objetivo, con migración expand/contract. | FR-ORG-001, FR-ORG-002, NFR-OPS-006 | ACTIVE |
| OR-021 | 2026-10-21 | Transferencias: el depósito despacha directo, ADMIN autoriza, CASHIER de destino recibe. | FR-ORG-003, FR-TRANSFER-001, FR-TRANSFER-002, FR-TRANSFER-003, FR-TRANSFER-004 | ACTIVE |
| OR-022 | 2026-10-21 | Diferencias de transferencia: PENDING_REVIEW, lo resuelve ADMIN, alerta hasta la resolución, sin autocorrección. | FR-TRANSFER-005, FR-TRANSFER-006, FR-TRANSFER-007, FR-TRANSFER-008, FR-ALERT-003 | ACTIVE |
| OR-023 | 2026-10-21 | Employee es P0, separado de User, con `employeeCode` y ABM auditado. | FR-EMP-001, FR-EMP-002, FR-EMP-003, FR-EMP-006, FR-USER-005 | ACTIVE |
| OR-024 | 2026-10-21 | El retiro de empleado se valúa a `cashPrice`. | FR-EMPWD-001 | ACTIVE |
| OR-025 | 2026-10-21 | El empleado puede retirar en cualquier sucursal; lo carga CASHIER sin preautorización; se notifica a ADMIN/OWNER. | FR-EMPWD-002, FR-EMPWD-003, FR-EMPWD-004, FR-ALERT-002 | ACTIVE |
| OR-026 | 2026-10-21 | Límite de deuda de empleado: solo global, inicial $300.000 (30000000 centavos), configurable por ADMIN/OWNER; sin límite individual por ahora. | FR-EMPACC-006, FR-EMPACC-007, FR-EMPWD-005, FR-CONF-002 | ACTIVE |
| OR-027 | 2026-10-21 | La cuenta corriente del empleado es un ledger append-only con saldo derivado. | FR-EMPACC-001, FR-EMPACC-002, FR-EMPACC-003, FR-EMPACC-008, FR-EMPACC-009, FR-EMPACC-010 | ACTIVE |
| OR-028 | 2026-10-21 | El saldo vigente del sistema viejo se carga como `OPENING_BALANCE` con fecha de corte explícita, append-only, sin reescribir historia previa. | FR-EMPACC-004, FR-EMPACC-005, FR-MIG-001, FR-MIG-002 | ACTIVE |
| OR-029 | 2026-10-21 | El empleado paga su deuda por CASH o TRANSFER, parcial o total. | FR-CASH-009, FR-EMPSET-008, FR-EMPSET-009, FR-EMPSET-010, FR-EMPSET-011 | ACTIVE |
| OR-030 | 2026-10-21 | La semana de liquidación va de lunes a sábado. | FR-EMPSET-001, NFR-TIME-002 | ACTIVE |
| OR-031 | 2026-10-21 | La liquidación puede ser parcial; el saldo restante se arrastra; no es payroll. | FR-EMPSET-002, FR-EMPSET-003, FR-EMPSET-004, FR-EMPSET-005, FR-EMPSET-006, FR-EMPSET-007 | ACTIVE |
| OR-032 | 2026-10-21 | La devolución de un retiro está permitida, vinculada al retiro original, repone stock, reduce/revierte deuda y no supera lo retirado. | FR-EMPWD-008, FR-EMPWD-009, FR-EMPWD-010 | ACTIVE |
| OR-033 | 2026-10-21 | Seña: redesign/selective port; 120 horas exactas desde la activación; una Seña activa bloquea stock; liberación única al vencer. | FR-SENA-001, FR-SENA-002, FR-SENA-003, FR-SENA-004 | ACTIVE |
| OR-034 | 2026-10-21 | El vencimiento de la Seña no devuelve dinero, no genera crédito ni CashMovement; la cancelación manual tampoco reintegra. | FR-SENA-005, FR-SENA-006 | ACTIVE |
| OR-035 | 2026-10-21 | El precio/snapshot de la Seña se congela al activarla. | FR-SENA-007 | ACTIVE |
| OR-036 | 2026-10-21 | El monto mínimo de Seña es configurable por ADMIN/OWNER. | FR-SENA-008, FR-CONF-002 | ACTIVE |
| OR-037 | 2026-10-21 | Los medios (incluido QR) de la Seña siguen las reglas del checkout correspondiente. | FR-SENA-009 | ACTIVE |
| OR-038 | 2026-10-21 | Voucher de Seña: emisión manual con autorización ADMIN; monto = total aceptado de los pagos de la Seña; uno por Seña. | FR-VOUCH-001, FR-VOUCH-002, FR-VOUCH-003 | ACTIVE |
| OR-039 | 2026-10-21 | Voucher de Seña: misma sucursal, uso completo en una compra, sin vuelto, compra ≥ vale, sin vencimiento. | FR-VOUCH-004, FR-VOUCH-005, FR-VOUCH-006, FR-VOUCH-007, FR-VOUCH-009 | ACTIVE |
| OR-040 | 2026-10-21 | Voucher de Seña: solo paga venta normal (no otra Seña); emitirlo o usarlo no genera movimiento de caja. | FR-CASH-010, FR-VOUCH-008, FR-VOUCH-011 | ACTIVE |
| OR-041 | 2026-10-21 | La venta normal no tiene TTL. | FR-STOCK-006, FR-SENA-010 | ACTIVE |
| OR-042 | 2026-10-21 | ARCA: integración digital con fallback manual; al finalizar la venta se elige ticket no fiscal o factura ARCA. | FR-TICKET-001, FR-ARCA-001, FR-ARCA-002, FR-ARCA-003 | ACTIVE |
| OR-043 | 2026-10-21 | Compras y proveedores forman parte de la versión completa de System V2: Supplier → PurchaseOrder → Receipt/Remito → deuda → pago. | FR-RECV-001, FR-SUPP-001, FR-SUPP-002, FR-PURCHASE-001, FR-PURCHASE-002, FR-PURCHASE-003, FR-SUPDEBT-001, FR-SUPDEBT-002, FR-SUPDEBT-003 | ACTIVE |
| OR-044 | 2026-10-21 | Cliente mínimo: nombre, apellido y teléfono obligatorios; DNI, email y CUIT opcionales. | FR-CUST-001, FR-CUST-002 | ACTIVE |
| OR-045 | 2026-10-21 | Gastos: EXPENSE de caja es caja chica con detalle obligatorio; los gastos administrativos van fuera de CashSession salvo salida real de esa caja. | FR-EXP-001, FR-EXP-002 | ACTIVE |
| OR-046 | 2026-10-21 | Contabilidad operativa: export unificado de ledgers sin ERP contable ni doble partida. | FR-TREAS-003, FR-TREAS-004 | ACTIVE |
| OR-047 | 2026-10-21 | El día operativo se define en America/Argentina/Buenos_Aires. | FR-ORG-005, NFR-TIME-001 | ACTIVE |
| OR-048 | 2026-10-21 | La anulación post-cobro entrega un vale de anulación "cuando corresponda" (R3). | Reemplazada por OR-016 (FR-CANCEL-006, FR-CANCEL-007, FR-EXCH-001) | SUPERSEDED por OR-016 |
| OR-049 | 2026-10-21 | La anulación revierte pago y caja con egreso por reintegro (R2). | Reemplazada por OR-015 (FR-CANCEL-005) | SUPERSEDED por OR-015 |
| OR-050 | 2026-10-21 | Caja chica: detalle/motivo obligatorio; comprobante opcional. | FR-EXP-001, FR-EXP-003 | ACTIVE |
| OR-051 | 2026-10-21 | Ajustes de stock comunes con permiso operativo normal; por encima de un umbral configurable por ADMIN/OWNER requieren autorización ADMIN/OWNER, motivo y AuditLog; umbral TBD. | FR-ADJ-004, FR-CONF-002 | ACTIVE |

## Apéndice C — Decisiones descartadas

| Decisión | Motivo | Reabrir solo por |
|---|---|---|
| StoreCredit / vale general | No aplica a cambios, anulaciones ni gift cards; la diferencia a favor del cliente no se devuelve ni se acredita. | Decisión OWNER futura |
| Vale general de anulación post-cobro | Reemplazado por la resolución mediante cambio de mercadería (OR-016). | Decisión OWNER futura |
| Devolución automática de efectivo en anulación | Descartada por regla OWNER (OR-015). | Decisión OWNER futura |
| Diferencia a favor del cliente en un cambio | No se devuelve ni se acredita (OR-013). | Decisión OWNER futura |
| Límite de deuda individual por empleado | Por ahora solo existe el límite global (OR-026). | Decisión OWNER futura |
| FIXED_TOTAL como modelo futuro | Existe como **legado/transición**, no como objetivo; se deprecia progresivamente (OR-001). | — |
| Voucher de Seña para pagar otra Seña | Solo sirve para una venta normal (OR-040). | Decisión OWNER futura |
| Motor de promociones y topes de descuento por rol | Ningún rol operativo descuenta (OR-019). | Decisión OWNER futura |
| Nómina / sueldos | La liquidación solo descuenta contra la deuda (OR-031). | Decisión OWNER futura |
| Contabilidad con plan de cuentas y doble partida | Solo se cubre la capa operativa (OR-046). | Decisión OWNER futura |

## Apéndice D — Datos requeridos para el despliegue

Son datos de configuración o de migración, **no** decisiones de producto.

| # | Dato | Requerido por | Quién lo aporta |
|---|---|---|---|
| 1 | Fecha de corte de los saldos de empleados | FR-EMPACC-004, FR-MIG-001 | OWNER |
| 2 | Saldos iniciales reales de cada empleado | FR-EMPACC-004, FR-MIG-001 | OWNER / administración |
| 3 | Valor inicial de `qrAdjustmentBps` | FR-PRICE-005 | OWNER |
| 4 | Monto mínimo inicial de Seña | FR-SENA-008 | OWNER |
| 5 | Resultado de la consulta read-only de `CashMovement.MANUAL` en PILOT | FR-CASH-007 | OWNER (la consulta no se ejecutó en este bloque) |
| 6 | Umbral de diferencia de caja para exigir aprobación | FR-CASH-011 | OWNER — **TBD** |
| 7 | Umbral de ajuste de stock que exige autorización ADMIN/OWNER | FR-ADJ-004 | OWNER — **TBD** |

**Umbral de diferencia de caja: TBD.** El importe no está definido y este PRD no inventa uno. La
Matrix R4 (dominio 10) prevé la aprobación de diferencias grandes sin fijar el umbral. Hasta que
el OWNER lo defina, FR-CASH-011 no se aplica y el cierre de caja se comporta como hasta ahora:
este dato pendiente no bloquea ningún otro comportamiento.

**Umbral de ajuste de stock: TBD.** Tampoco se inventa. Hasta que el OWNER lo defina, FR-ADJ-004
no se aplica y los ajustes siguen el permiso operativo normal. Ambos umbrales se configuran
luego por ADMIN u OWNER (FR-CONF-002).
