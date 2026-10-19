import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { ApiError, api, type CatalogProduct } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { formatARS, formatVariant } from '../lib/utils';
import { type SheetPreview, deriveSheetPreview, loadAllProducts } from '../lib/labels/labelCatalog.ts';
import {
  type ExclusionReason,
  type LabelModel,
  buildLabels,
  canAccessLabels,
  summarizeExclusions,
} from '../lib/labels/labelData.ts';
import {
  DEFAULT_LAYOUT,
  HUMAN_TEXT_MAX_PT,
  LABEL_BORDER_MM,
  LABEL_PADDING_X_MM,
  MIN_MODULE_WIDTH_MM,
  QUIET_ZONE_MODULES,
  type LayoutConfig,
  computeLayout,
  parseDecimalField,
  parseQuantityField,
} from '../lib/labels/labelLayout.ts';

// ADM-15-A: select variants and preview label sheets. Read-only: the only
// request is GET /products. It does not print, persist, or change stock,
// prices or products. Printing and scanner validation belong to ADM-15-B.
//
// Access (provisional, visual only): the screen requires the same projected
// `report.view` string as the admin shell. That no equivale a LABEL_PRINT, which
// /auth/me does not project, and it is not an authorization: the server decides
// what GET /products returns (INVENTORY_VIEW).
//
// Registration is left to whoever integrates the module:
//   <Route path={labelsRoute} element={<Labels />} />
export const labelsRoute = 'etiquetas';

const MAX_ROWS = 300;
const MAX_SUMMARY_ITEMS = 20;

const REASON_TEXT: Record<ExclusionReason, string> = {
  NOT_FOUND: 'La variante ya no está en el catálogo cargado.',
  DUPLICATE_SELECTION: 'Variante seleccionada más de una vez.',
  INVALID_QUANTITY: 'Cantidad inválida (entero de 1 a 200).',
  INACTIVE: 'Variante inactiva.',
  MISSING_BARCODE: 'Sin código de barras.',
  BARCODE_EDGE_WHITESPACE: 'El código de barras tiene espacios al inicio o al final.',
  BARCODE_NOT_ENCODABLE: 'El código de barras no se puede representar en Code 128-B (solo ASCII imprimible, hasta 64 caracteres).',
  DUPLICATE_BARCODE: 'Código de barras duplicado con otra variante del catálogo cargado.',
  PRICE_MISSING: 'Falta el precio efectivo (cashPrice); no se genera la etiqueta con precio.',
};

// Messages for a preview that could not be generated (no sheets, no success text).
function previewErrorText(code: Extract<SheetPreview, { kind: 'ERROR' }>['code']): string {
  if (code === 'TOTAL_EXCEEDS_LIMIT') {
    return 'Se superó el máximo provisional de 1000 etiquetas por selección; reducí las cantidades. No se generó ningún plan de hojas.';
  }
  if (code === 'INVALID_QUANTITY') return 'Hay una cantidad inválida en la selección; no se generó ningún plan de hojas.';
  if (code === 'START_OUT_OF_RANGE') return 'La posición inicial debe ser un entero dentro de la hoja.';
  return 'No se pudo planificar las hojas; revisá la configuración de la hoja.';
}

type LayoutDraft = Record<keyof LayoutConfig, string>;

const toDraft = (config: Readonly<LayoutConfig>): LayoutDraft =>
  Object.fromEntries(Object.entries(config).map(([key, value]) => [key, String(value)])) as LayoutDraft;

const LAYOUT_FIELDS: { key: keyof LayoutConfig; label: string }[] = [
  { key: 'labelWidthMm', label: 'Ancho de etiqueta (mm)' },
  { key: 'labelHeightMm', label: 'Alto de etiqueta (mm)' },
  { key: 'marginTopMm', label: 'Margen superior (mm)' },
  { key: 'marginLeftMm', label: 'Margen lateral (mm)' },
  { key: 'gapHorizontalMm', label: 'Separación horizontal (mm)' },
  { key: 'gapVerticalMm', label: 'Separación vertical (mm)' },
];

const formatMm = (value: number) => value.toFixed(3).replace('.', ',');

function BarcodeSvg({ label }: { label: LabelModel }) {
  const { modules, width } = label.encoded;
  const bars: string[] = [];
  let index = 0;
  while (index < modules.length) {
    if (modules[index] === '1') {
      let end = index;
      while (end < modules.length && modules[end] === '1') end += 1;
      bars.push(`M${index + QUIET_ZONE_MODULES} 0h${end - index}v1h-${end - index}z`);
      index = end;
    } else {
      index += 1;
    }
  }
  return (
    <svg
      role="img"
      aria-label={`Código de barras ${label.barcode}`}
      viewBox={`0 0 ${width + 2 * QUIET_ZONE_MODULES} 1`}
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      style={{ width: '100%', height: '11mm', display: 'block' }}
    >
      <path d={bars.join('')} fill="#000" />
    </svg>
  );
}

function LabelPreview({ label, xMm, yMm, widthMm, heightMm }: {
  label: LabelModel;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        left: `${xMm}mm`,
        top: `${yMm}mm`,
        width: `${widthMm}mm`,
        height: `${heightMm}mm`,
        boxSizing: 'border-box',
        border: `${LABEL_BORDER_MM}mm solid #000`,
        padding: `1.2mm ${LABEL_PADDING_X_MM}mm`,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        color: '#000',
        background: '#fff',
        fontFamily: 'Arial, Helvetica, sans-serif',
        lineHeight: 1.15,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1mm', fontSize: '6.5pt', letterSpacing: '0.04em' }}>
        <strong style={{ whiteSpace: 'nowrap' }}>MONA JACINTA</strong>
        <span title={label.sku} style={{ minWidth: 0, whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label.skuShort}</span>
      </div>
      <div title={label.productName} style={{ fontSize: '8.5pt', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {label.productNameShort}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '1mm', fontSize: '8pt' }}>
        <span title={label.variantText} style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label.variantTextShort}</span>
        {label.priceText ? <strong style={{ fontSize: '10pt', whiteSpace: 'nowrap' }}>{label.priceText}</strong> : null}
      </div>
      <BarcodeSvg label={label} />
      <div style={{ textAlign: 'center', fontSize: `${label.humanText?.fontPt ?? HUMAN_TEXT_MAX_PT}pt`, fontFamily: 'monospace', overflow: 'hidden', whiteSpace: 'pre' }}>
        {label.barcode}
      </div>
    </div>
  );
}

export function Labels() {
  const { token, logout, user } = useAuth();
  const mayAccessLabels = canAccessLabels(user);
  const userId = user?.id ?? null;

  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [totalProducts, setTotalProducts] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [duplicatesDropped, setDuplicatesDropped] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState(false);

  const [search, setSearch] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [showPrice, setShowPrice] = useState(false);
  const [layoutDraft, setLayoutDraft] = useState<LayoutDraft>(() => toDraft(DEFAULT_LAYOUT));
  const [startSlot, setStartSlot] = useState('0');

  // A different user or session never inherits the previous selection.
  useEffect(() => {
    setQuantities({});
    setSearch('');
  }, [userId, token]);

  // The catalogue is reloaded (and the previous one dropped) whenever the
  // session or the user changes; a late response of a closed load is ignored.
  useEffect(() => {
    setProducts([]);
    setTotalProducts(0);
    setTruncated(false);
    setDuplicatesDropped(0);
    setError('');
    setBlocked(false);
    if (!token || !mayAccessLabels) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    loadAllProducts(
      (page, limit) => api.products(token, new URLSearchParams({ limit: String(limit), page: String(page) }), logout),
      {
        isCancelled: () => !active,
        isForbidden: (cause) => cause instanceof ApiError && cause.status === 403,
      },
    )
      .then((outcome) => {
        if (!active) return;
        if (outcome.ok) {
          setProducts(outcome.products);
          setTotalProducts(outcome.total);
          setTruncated(outcome.truncated);
          setDuplicatesDropped(outcome.duplicatesDropped);
        } else if (outcome.code === 'FORBIDDEN') {
          setBlocked(true);
        } else if (outcome.code === 'FAILED') {
          setError(errorMessage(outcome.cause, 'No se pudo cargar el catálogo.'));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [token, logout, mayAccessLabels, userId]);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return products.flatMap((product) =>
      product.variants
        .filter((variant) => {
          if (!needle) return true;
          return [product.name, variant.sku, variant.barcode, variant.color, variant.size]
            .filter((part): part is string => typeof part === 'string')
            .some((part) => part.toLowerCase().includes(needle));
        })
        .map((variant) => ({ product, variant })),
    );
  }, [products, search]);

  const variantCount = useMemo(() => products.reduce((sum, product) => sum + product.variants.length, 0), [products]);
  const skuById = useMemo(
    () => new Map(products.flatMap((product) => product.variants.map((variant) => [variant.id, variant.sku] as const))),
    [products],
  );

  const selection = useMemo(
    () =>
      Object.entries(quantities).map(([variantId, text]) => ({
        variantId,
        quantity: parseQuantityField(text),
      })),
    [quantities],
  );

  const layout = useMemo(() => {
    const parsed = Object.fromEntries(
      Object.entries(layoutDraft).map(([key, value]) => [key, parseDecimalField(value)]),
    );
    return computeLayout(parsed);
  }, [layoutDraft]);

  const labelWidthMm = layout.ok ? parseDecimalField(layoutDraft.labelWidthMm) : DEFAULT_LAYOUT.labelWidthMm;

  const result = useMemo(
    () => buildLabels(products, selection, { showPrice, formatMoney: formatARS, formatVariant, labelWidthMm }),
    [products, selection, showPrice, labelWidthMm],
  );
  const summary = useMemo(() => summarizeExclusions(result.excluded, products), [result.excluded, products]);
  const startSlotNumber = parseDecimalField(startSlot);
  const sheetPreview = useMemo(
    () => deriveSheetPreview(result.labels, layout, startSlotNumber),
    [result.labels, layout, startSlotNumber],
  );

  const reasonById = new Map(result.excluded.map(({ variantId, reason }) => [variantId, reason]));
  const duplicateIds = new Set(result.duplicateGroups.flatMap((group) => group.variantIds));
  const conflictIds = new Set(result.warnings.flatMap((warning) => warning.variantIds));
  const narrowIds = new Set(result.legibilityWarnings.map((warning) => warning.variantId));
  const shownIds = new Set(rows.slice(0, MAX_ROWS).map(({ variant }) => variant.id));
  const hiddenSelected = selection.filter(({ variantId }) => !shownIds.has(variantId)).length;
  const narrowestModuleMm = result.labels.reduce<number | null>(
    (min, label) => (label.metrics && (min === null || label.metrics.moduleWidthMm < min) ? label.metrics.moduleWidthMm : min),
    null,
  );

  const toggle = (variantId: string, checked: boolean) =>
    setQuantities((current) => {
      const next = { ...current };
      if (checked) next[variantId] = current[variantId] ?? '1';
      else delete next[variantId];
      return next;
    });

  if (!mayAccessLabels) {
    return (
      <section className="empty-card">
        <h2>Etiquetas no disponibles</h2>
        <p>
          Tu sesión no incluye el acceso administrativo (report.view) que habilita esta pantalla. Es un control
          visual provisional: no equivale a un permiso propio de impresión de etiquetas ni reemplaza la
          autorización del servidor.
        </p>
      </section>
    );
  }
  if (blocked) {
    return (
      <section className="empty-card">
        <h2>Sin acceso al catálogo</h2>
        <p>El servidor rechazó la lectura del catálogo para tu sesión.</p>
      </section>
    );
  }

  return (
    <div className="page-stack">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Etiquetas</p>
          <h2>Etiquetas y códigos de barras</h2>
        </div>
      </div>

      <p className="muted">
        Vista previa (ADM-15-A). Esta pantalla no imprime, no envía nada a una impresora y no modifica stock,
        precios ni productos. La impresión y la prueba con lector se validan en ADM-15-B. El acceso a esta
        pantalla es un control visual provisional (report.view); los datos los autoriza el servidor.
      </p>

      {error ? <p className="error-banner" role="alert">{error}</p> : null}
      {loading ? <p className="muted" role="status">Cargando catálogo...</p> : null}
      {!loading && !error && truncated ? (
        <p className="error-banner" role="alert">
          Catálogo incompleto: se cargaron {products.length} de {totalProducts} productos. La detección de
          duplicados solo cubre lo cargado.
        </p>
      ) : null}
      {!loading && !error && duplicatesDropped > 0 ? (
        <p className="field-hint" role="status">
          El catálogo cambió mientras se cargaba: se descartaron {duplicatesDropped} productos repetidos.
        </p>
      ) : null}
      {!loading && !error ? (
        <p className="field-hint">
          Catálogo inspeccionado: solo productos y variantes activas ({products.length} productos, {variantCount}{' '}
          variantes). La detección de duplicados cubre solo este catálogo y no reemplaza las restricciones de
          unicidad ni la búsqueda del POS.
        </p>
      ) : null}

      <div className="filters">
        <label htmlFor="labels-search">
          Buscar
          <input
            id="labels-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Producto, SKU, código de barras, color o talle"
          />
        </label>
        <label htmlFor="labels-show-price">
          <input
            id="labels-show-price"
            type="checkbox"
            checked={showPrice}
            onChange={(event) => setShowPrice(event.target.checked)}
          />{' '}
          Mostrar precio efectivo en la etiqueta
        </label>
      </div>
      {showPrice ? (
        <p className="field-hint">
          Se imprime únicamente el precio efectivo (cashPrice). Las variantes sin cashPrice no generan etiqueta.
          La política comercial de precio impreso sigue pendiente de definición.
        </p>
      ) : null}

      {selection.length > 0 ? (
        <section className="form-card" aria-label="Resumen de exclusiones">
          <h3>Resumen de exclusiones</h3>
          <p role="status">
            Seleccionadas: {selection.length} · Incluidas: {result.labels.length} · Excluidas: {summary.variants}
            {summary.variants > 0 ? ` (${summary.labels} etiquetas${summary.unknownQuantityVariants > 0 ? `, ${summary.unknownQuantityVariants} con cantidad inválida` : ''})` : ''}
          </p>
          {hiddenSelected > 0 ? (
            <p className="field-hint">
              {hiddenSelected} variantes seleccionadas no se ven en la tabla por la búsqueda o por el tope de {MAX_ROWS}{' '}
              filas; igual cuentan en este resumen.
            </p>
          ) : null}
          {summary.variants > 0 ? (
            <div role="alert">
              <ul>
                {summary.byReason.map((group) => (
                  <li key={group.reason}>
                    {REASON_TEXT[group.reason]} {group.variants} {group.variants === 1 ? 'variante' : 'variantes'}, {group.labels} etiquetas.
                  </li>
                ))}
              </ul>
              <ul>
                {summary.items.slice(0, MAX_SUMMARY_ITEMS).map((item) => (
                  <li key={item.variantId}>
                    {item.sku ?? item.variantId} — {item.productName ?? 'Sin datos de catálogo'} (cantidad {item.quantity ?? 'inválida'}): {REASON_TEXT[item.reason]}
                  </li>
                ))}
              </ul>
              {summary.items.length > MAX_SUMMARY_ITEMS ? (
                <p className="field-hint">y {summary.items.length - MAX_SUMMARY_ITEMS} más.</p>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {result.legibilityWarnings.length > 0 ? (
        <section className="form-card" aria-label="Advertencias de legibilidad">
          <h3>Advertencias de legibilidad</h3>
          <ul>
            {result.legibilityWarnings.map((warning) => (
              <li key={`${warning.code}-${warning.variantId}`}>
                {skuById.get(warning.variantId) ?? warning.variantId}:{' '}
                {warning.code === 'NARROW_MODULE'
                  ? `ancho de módulo calculado ${formatMm(warning.moduleWidthMm)} mm, por debajo del mínimo provisional de ${formatMm(warning.minimumMm)} mm.`
                  : `el texto legible queda en ${warning.fontPt} pt, por debajo del mínimo provisional de ${warning.minimumPt} pt.`}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {result.labels.length > 0 ? (
        <p className="field-hint">
          {narrowestModuleMm !== null
            ? `Ancho de módulo calculado más estrecho: ${formatMm(narrowestModuleMm)} mm (mínimo provisional ${formatMm(MIN_MODULE_WIDTH_MM)} mm). `
            : ''}
          Son cálculos geométricos y solo advierten: la legibilidad física no está verificada (se valida en ADM-15-B con
          impresión y lector).
        </p>
      ) : null}

      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th><span className="sr-only">Seleccionar</span></th>
              <th>Producto</th>
              <th>Variante</th>
              <th>SKU</th>
              <th>Código de barras</th>
              <th>Cantidad</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, MAX_ROWS).map(({ product, variant }) => {
              const checked = variant.id in quantities;
              const reason = reasonById.get(variant.id);
              return (
                <tr key={variant.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Seleccionar ${product.name} ${variant.sku}`}
                      checked={checked}
                      onChange={(event) => toggle(variant.id, event.target.checked)}
                    />
                  </td>
                  <td>{product.name}</td>
                  <td>{formatVariant(variant.color, variant.size)}</td>
                  <td>{variant.sku}</td>
                  <td>{variant.barcode || '—'}</td>
                  <td>
                    {checked ? (
                      <input
                        inputMode="numeric"
                        aria-label={`Cantidad de ${variant.sku}`}
                        value={quantities[variant.id]}
                        style={{ width: '5rem' }}
                        onChange={(event) =>
                          setQuantities((current) => ({ ...current, [variant.id]: event.target.value }))
                        }
                      />
                    ) : null}
                  </td>
                  <td>
                    {reason ? <span className="inline-error">{REASON_TEXT[reason]}</span> : null}
                    {!reason && duplicateIds.has(variant.id) ? <span className="inline-error">Código duplicado</span> : null}
                    {!reason && !duplicateIds.has(variant.id) && conflictIds.has(variant.id) ? (
                      <span className="muted">Posible conflicto de códigos</span>
                    ) : null}
                    {!reason && narrowIds.has(variant.id) ? <span className="muted"> Módulo estrecho</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length > MAX_ROWS ? (
          <p className="field-hint">Mostrando {MAX_ROWS} de {rows.length} variantes. Refiná la búsqueda.</p>
        ) : null}
        {!loading && rows.length === 0 ? <p className="muted">Sin variantes para la búsqueda actual.</p> : null}
      </div>

      {result.warnings.length > 0 ? (
        <section className="form-card" aria-label="Posibles conflictos de códigos">
          <h3>Posibles conflictos de códigos</h3>
          <p className="muted">
            Informativo, no bloquea la vista previa. Solo difieren en mayúsculas o un código de barras coincide con
            el SKU de otra variante; su criterio global requiere aprobación y verificación del POS.
          </p>
          <ul>
            {result.warnings.map((warning) => (
              <li key={`${warning.code}-${warning.variantIds.join('-')}`}>
                {warning.code === 'DUPLICATE_BARCODE_CASE' ? 'Difieren solo en mayúsculas' : 'Código de barras igual a un SKU ajeno'}
                : «{warning.value}» ({warning.variantIds.map((id) => skuById.get(id) ?? id).join(', ')})
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {result.duplicateGroups.length > 0 ? (
        <section className="form-card" aria-label="Códigos duplicados">
          <h3>Códigos de barras duplicados (bloqueados)</h3>
          <ul>
            {result.duplicateGroups.map((group) => (
              <li key={group.value}>«{group.value}»: {group.variantIds.map((id) => skuById.get(id) ?? id).join(', ')}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="form-card" aria-label="Configuración de la hoja">
        <h3>Hoja A4 ({DEFAULT_LAYOUT.sheetWidthMm} × {DEFAULT_LAYOUT.sheetHeightMm} mm)</h3>
        <p className="muted">
          Predeterminado provisional: 2 columnas × 7 filas, sujeto a validación física (ADM-15-B).
        </p>
        <div className="form-row">
          {LAYOUT_FIELDS.map(({ key, label }) => (
            <label key={key} htmlFor={`labels-${key}`}>
              {label}
              <input
                id={`labels-${key}`}
                inputMode="decimal"
                value={layoutDraft[key]}
                onChange={(event) => setLayoutDraft((current) => ({ ...current, [key]: event.target.value }))}
              />
            </label>
          ))}
          <label htmlFor="labels-start-slot">
            Posición inicial (0 = primera)
            <input
              id="labels-start-slot"
              inputMode="numeric"
              value={startSlot}
              onChange={(event) => setStartSlot(event.target.value)}
            />
          </label>
        </div>
        <button type="button" className="secondary-button compact" onClick={() => { setLayoutDraft(toDraft(DEFAULT_LAYOUT)); setStartSlot('0'); }}>
          Restablecer 2 × 7
        </button>
        {!layout.ok ? (
          <p className="error-banner" role="alert">
            {layout.code === 'LAYOUT_NO_FIT'
              ? 'La etiqueta no entra en la hoja con esos márgenes.'
              : 'Configuración inválida: revisá que todos los valores sean números positivos (etiquetas de al menos 10 mm).'}
          </p>
        ) : (
          <p className="field-hint">
            {layout.columns} columnas × {layout.rows} filas = {layout.perSheet} etiquetas por hoja.
          </p>
        )}
      </section>

      <section aria-label="Vista previa">
        <h3>Vista previa</h3>
        {sheetPreview.kind === 'READY' ? (
          <p className="field-hint" role="status">
            {sheetPreview.labelCount} etiquetas incluidas en {sheetPreview.sheetCount} {sheetPreview.sheetCount === 1 ? 'hoja' : 'hojas'}.
            {summary.variants > 0 ? ` ${summary.variants} variantes quedaron excluidas (ver el resumen de exclusiones).` : ''}{' '}
            Generar la vista previa no confirma que ninguna impresora haya impreso nada.
          </p>
        ) : null}
        {sheetPreview.kind === 'ERROR' ? (
          <p className="error-banner" role="alert">{previewErrorText(sheetPreview.code)}</p>
        ) : null}
        {sheetPreview.kind === 'EMPTY' ? <p className="muted">Seleccioná variantes para ver la vista previa.</p> : null}
        {sheetPreview.kind === 'LAYOUT_INVALID' ? (
          <p className="muted">Corregí la configuración de la hoja para ver la vista previa.</p>
        ) : null}
        {sheetPreview.kind === 'READY'
          ? sheetPreview.sheets.map((sheet) => (
              <div key={sheet.sheetNumber} style={{ overflowX: 'auto', marginBottom: '1rem' }}>
                <p className="field-hint">Hoja {sheet.sheetNumber} de {sheetPreview.sheetCount}</p>
                <div
                  style={{
                    position: 'relative',
                    width: `${DEFAULT_LAYOUT.sheetWidthMm}mm`,
                    height: `${DEFAULT_LAYOUT.sheetHeightMm}mm`,
                    background: '#fff',
                    border: '1px solid #cfd6d2',
                    boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
                  }}
                >
                  {sheet.placements.map((placement, offset) => (
                    <LabelPreview
                      key={offset}
                      label={placement.label}
                      xMm={placement.xMm}
                      yMm={placement.yMm}
                      widthMm={labelWidthMm}
                      heightMm={parseDecimalField(layoutDraft.labelHeightMm)}
                    />
                  ))}
                </div>
              </div>
            ))
          : null}
      </section>
    </div>
  );
}
