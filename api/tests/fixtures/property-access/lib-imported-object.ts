// Helper module for the property-access fixtures (cross-module resolution). Never imported by production code.
import { PrismaClient } from '../../../src/generated/prisma/client.js';
export const importedObject = { method() { return new PrismaClient({} as never); } };
