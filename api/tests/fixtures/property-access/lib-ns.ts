// Helper module for the property-access fixtures (cross-module resolution). Never imported by production code.
import { Pool } from 'pg';
export function method() { return new Pool({}); }
