// Helper module for the property-access fixtures (cross-module resolution). Never imported by production code.
import { PrismaClient } from '../../../src/generated/prisma/client.js';
export class Helper { static open() { return new PrismaClient({} as never); } }
