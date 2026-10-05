import { createContext } from "react";

export type AdminRole = "staff" | "owner" | "system_admin";

export type AuthUser = {
  email: string;
  role: AdminRole;
  staffMemberId: string | null;
  storeId: string | null;
};

export type AuthContextValue = {
  user: AuthUser;
  isPrivileged: boolean;
  /**
   * VAPID public key for admin Web Push, or "" when push is not configured for
   * this environment. Not part of AuthUser: it describes the deployment, not
   * the signed-in person.
   */
  vapidPublicKey: string;
};

export const AuthContext = createContext<AuthContextValue | null>(null);
