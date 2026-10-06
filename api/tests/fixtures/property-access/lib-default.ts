// Helper module for the property-access fixtures (cross-module resolution). Never imported by production code.
import { Pool } from 'pg';
export default { open() { return new Pool({}); } };
