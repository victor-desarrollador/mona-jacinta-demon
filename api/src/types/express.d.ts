export {};

declare global {
  namespace Express {
    interface ProductionAssignment {
      roleId: string;
      roleCode: 'OWNER' | 'ADMIN' | 'CASHIER' | 'SELLER' | 'WAREHOUSE';
      scopeKind: 'LOCATION' | 'COMPANY';
      locationId: string | null;
      permissions: string[];
    }

    interface AuthContext {
      userId: string;
      roles: string[];
      assignments: ProductionAssignment[];
      effectiveLocationIds: string[];
    }

    interface Request {
      userId?: string;
      auth?: AuthContext;
    }
  }
}
