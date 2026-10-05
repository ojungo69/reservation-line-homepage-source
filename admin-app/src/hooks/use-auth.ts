import { use } from "react";
import { AuthContext } from "@/providers/auth-context";

export function useAuth() {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}
