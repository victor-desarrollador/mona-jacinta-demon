export {};

declare global {
  namespace Express {
    interface AuthContext {
      userId: string;
      roles: string[];
      branchIds: string[];
      permissions: string[];
    }

    interface Request {
      userId?: string;
      auth?: AuthContext;
    }
  }
}
