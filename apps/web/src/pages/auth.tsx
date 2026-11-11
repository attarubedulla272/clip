import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Clapperboard } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { apiRequest } from "../lib/api";
import { useCurrentUser } from "../app";

export function AuthPage({ register = false }: { register?: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const currentUser = useCurrentUser();
  const mutation = useMutation({
    mutationFn: () => apiRequest<{ user: { id: string; email: string; role: "user" | "admin" } }>(
      `/auth/${register ? "register" : "login"}`,
      { method: "POST", body: JSON.stringify({ email, password }), retryAfterRefresh: false }
    ),
    onSuccess: async (result) => {
      queryClient.setQueryData(["auth", "me"], { user: result.user });
      await navigate("/dashboard");
    }
  });

  if (currentUser.isSuccess) return <Navigate to="/dashboard" replace />;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <main className="auth-page">
      <div className="auth-decoration"><div className="glow-orb" /><div className="auth-grid" /></div>
      <section className="auth-card">
        <Link to="/" className="brand"><span className="brand-mark"><Clapperboard size={18} /></span>clipforge</Link>
        <Link to="/" className="back-link"><ArrowLeft size={14} /> Back to home</Link>
        <span className="section-kicker">{register ? "YOUR CREATOR WORKSPACE" : "WELCOME BACK"}</span>
        <h1>{register ? "Make room for\nbetter moments." : "Good to see\nyou again."}</h1>
        <p className="auth-copy">{register ? "Create your local-first ClipForge account." : "Sign in to pick up where you left off."}</p>
        <form onSubmit={submit} className="auth-form">
          <label>Email address<input type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label>
          <label>Password<input type="password" autoComplete={register ? "new-password" : "current-password"} required minLength={register ? 12 : 1} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={register ? "At least 12 characters" : "Your password"} /></label>
          {mutation.isError && <p className="form-error" role="alert">{mutation.error.message}</p>}
          <Button type="submit" className="w-full" disabled={mutation.isPending}>{mutation.isPending ? "Please wait…" : register ? "Create account" : "Sign in"}</Button>
        </form>
        <p className="auth-switch">{register ? "Already have an account?" : "New to ClipForge?"} <Link to={register ? "/login" : "/register"}>{register ? "Sign in" : "Create an account"}</Link></p>
        <p className="privacy-note">Your videos stay on your machine. ClipForge does not sell or share your content.</p>
      </section>
    </main>
  );
}
