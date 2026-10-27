import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';

export function validate(
  schema: ZodType,
  target: 'body' | 'query' | 'params' = 'body',
): RequestHandler {
  return async (req, _res, next) => {
    try {
      const parsed = await schema.parseAsync(req[target]);
      // Express 5 exposes query through a getter; an own property holds validated data.
      Object.defineProperty(req, target, {
        value: parsed,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      next();
    } catch (error) {
      next(error);
    }
  };
}
