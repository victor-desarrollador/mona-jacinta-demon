import { type FormEvent, useId, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { api, type CatalogRef } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { slugify } from '../lib/utils';
import { type Feedback, FormFeedback } from './FormFeedback';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type Props = {
  categories: CatalogRef[];
  brands: CatalogRef[];
  referenceError: string;
  onCreated: (product: { id: string; name: string }) => void;
};

// POST /api/v1/products (PRODUCT_MANAGE, COMPANY-required server side).
// Only the fields the API contract accepts: name, slug, categoryId, brandId.
export function CreateProductForm({ categories, brands, referenceError, onCreated }: Props) {
  const { token, logout } = useAuth();
  const id = useId();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [categoryId, setCategoryId] = useState('');
  const [brandId, setBrandId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const effectiveCategoryId = categoryId || (categories.length === 1 ? categories[0].id : '');
  const effectiveBrandId = brandId || (brands.length === 1 ? brands[0].id : '');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || submitting) return;
    const trimmedName = name.trim();
    if (!trimmedName) return setFeedback({ kind: 'error', message: 'Ingresá el nombre del producto.' });
    if (!SLUG_PATTERN.test(slug)) {
      return setFeedback({
        kind: 'error',
        message: 'El identificador solo admite minúsculas, números y guiones (ej. vestido-lino).',
      });
    }
    if (!effectiveCategoryId || !effectiveBrandId) {
      return setFeedback({ kind: 'error', message: 'Seleccioná categoría y marca.' });
    }
    setSubmitting(true);
    setFeedback(null);
    try {
      const { product } = await api.createProduct(
        token,
        { name: trimmedName, slug, categoryId: effectiveCategoryId, brandId: effectiveBrandId },
        logout,
      );
      setFeedback({ kind: 'success', message: `Producto "${product.name}" creado. Ahora podés agregarle variantes.` });
      setName('');
      setSlug('');
      setSlugEdited(false);
      onCreated(product);
    } catch (cause) {
      setFeedback({ kind: 'error', message: errorMessage(cause, 'No se pudo crear el producto.') });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="form-card" onSubmit={submit} aria-labelledby={`${id}-title`} noValidate>
      <div>
        <p className="eyebrow">Paso 1</p>
        <h3 id={`${id}-title`}>Nuevo producto</h3>
      </div>
      {referenceError ? <p className="error-banner" role="alert">{referenceError}</p> : null}
      <label htmlFor={`${id}-name`}>
        Nombre
        <input
          id={`${id}-name`}
          value={name}
          maxLength={120}
          required
          onChange={(event) => {
            setName(event.target.value);
            if (!slugEdited) setSlug(slugify(event.target.value));
          }}
          placeholder="Vestido de lino"
        />
      </label>
      <label htmlFor={`${id}-slug`}>
        Identificador (slug)
        <input
          id={`${id}-slug`}
          value={slug}
          maxLength={120}
          required
          aria-describedby={`${id}-slug-hint`}
          onChange={(event) => {
            setSlug(event.target.value);
            setSlugEdited(true);
          }}
          placeholder="vestido-de-lino"
        />
        <span className="field-hint" id={`${id}-slug-hint`}>
          Se completa desde el nombre. Único; minúsculas, números y guiones.
        </span>
      </label>
      <div className="form-row">
        <label htmlFor={`${id}-category`}>
          Categoría
          <select
            id={`${id}-category`}
            value={effectiveCategoryId}
            required
            onChange={(event) => setCategoryId(event.target.value)}
          >
            <option value="">Seleccioná…</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>{category.name}</option>
            ))}
          </select>
        </label>
        <label htmlFor={`${id}-brand`}>
          Marca
          <select id={`${id}-brand`} value={effectiveBrandId} required onChange={(event) => setBrandId(event.target.value)}>
            <option value="">Seleccioná…</option>
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>{brand.name}</option>
            ))}
          </select>
        </label>
      </div>
      <FormFeedback feedback={feedback} />
      <button type="submit" className="primary-button" disabled={submitting}>
        {submitting ? 'Creando…' : 'Crear producto'}
      </button>
    </form>
  );
}
