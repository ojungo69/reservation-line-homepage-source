import { Navigate, Outlet } from "react-router";
import { useAuth } from "@/hooks/use-auth";

type Props = {
  requiredPrivilege?: boolean;
};

export function ProtectedRoute({ requiredPrivilege = false }: Readonly<Props>) {
  const { isPrivileged } = useAuth();

  if (requiredPrivilege && !isPrivileged) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
