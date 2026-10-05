import { BrowserRouter } from "react-router";
import { AuthProvider } from "@/providers/auth-provider";
import { AppRoutes } from "@/routes";
import { ErrorBoundary } from "@/components/error-boundary";
import { Toaster } from "@/components/ui/sonner";

export function App() {
  return (
    <BrowserRouter basename="/admin">
      <ErrorBoundary>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </ErrorBoundary>
      <Toaster />
    </BrowserRouter>
  );
}
