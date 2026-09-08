import type { UserContext } from './api';

export function canUseBackoffice(user: UserContext | null) {
  return Boolean(user?.permissions.includes('report.view'));
}

export function canManageUsers(user: UserContext | null) {
  return Boolean(user?.permissions.includes('user.manage'));
}
