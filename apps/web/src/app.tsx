import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Button } from "./components/ui/button";
import { ApiRequestError, apiRequest } from "./lib/api";
import { AuthPage } from "./pages/auth";
import { DashboardPage } from "./pages/dashboard";
import { LandingPage } from "./pages/landing";
import { ProjectPage } from "./pages/project";

export interface CurrentUser {
  id: string;
  email: string;
  role: "user" | "admin";
}

export function useCurrentUser() {
  return useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => apiRequest<{ user: CurrentUser }>("/auth/me"),
    retry: false
  });
}

function Protected({ children }: { children: React.ReactNode }) {
  const query = useCurrentUser();
  const retryAfter = query.error instanceof ApiRequestError ? query.error.retryAfterSeconds ?? 0 : 0;
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  useEffect(() => {
    setCooldownSeconds(retryAfter);
  }, [retryAfter]);

  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timeout = window.setTimeout(() => setCooldownSeconds((seconds) => Math.max(0, seconds - 1)), 1_000);
    return () => window.clearTimeout(timeout);
  }, [cooldownSeconds]);

  if (query.isPending) {
    return (
      <main className="loading-screen" aria-busy="true">
        <div className="loading-orbit" aria-hidden="true"><span /></div>
        <p>Preparing your workspace…</p>
      </main>
    );
  }
  if (query.isError) {
    if (query.error instanceof ApiRequestError && query.error.status === 401) {
      return <Navigate to="/login" replace />;
    }
    const rateLimited = query.error instanceof ApiRequestError && query.error.status === 429;
    return (
      <main className="loading-screen workspace-error-screen" role="alert">
        <section className="workspace-error-card">
          <span className="section-kicker">{rateLimited ? "A MOMENT, PLEASE" : "WORKSPACE CONNECTION"}</span>
          <h1>{rateLimited ? "Your workspace needs a short pause." : "We couldn’t open your workspace."}</h1>
          <p>{rateLimited
            ? "ClipForge briefly limits changes to protect your local workspace. Read-only progress checks won’t use that limit."
            : query.error.message}</p>
          <p className="workspace-error-detail">{query.error.message}</p>
          <Button onClick={() => void query.refetch()} disabled={cooldownSeconds > 0 || query.isFetching}>
            {query.isFetching ? "Checking…" : cooldownSeconds > 0 ? `Try again in ${cooldownSeconds}s` : "Try again"}
          </Button>
        </section>
      </main>
    );
  }
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<AuthPage />} />
      <Route path="/register" element={<AuthPage register />} />
      <Route path="/dashboard" element={<Protected><DashboardPage /></Protected>} />
      <Route path="/projects/:projectId" element={<Protected><ProjectPage /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
