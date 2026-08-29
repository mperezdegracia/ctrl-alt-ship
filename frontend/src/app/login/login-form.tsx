"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    const supabase = createClient();
    void supabase.auth.getClaims().then(({ data }) => {
      if (data?.claims) router.replace("/dashboard");
    });
  }, [router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    if (!isSupabaseConfigured) {
      setError("Supabase is not configured. Add the environment variables in .env.local.");
      return;
    }

    setIsSubmitting(true);

    try {
      const supabase = createClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

      if (signInError) {
        // Do not log credentials or session data. This is enough to distinguish a
        // rejected sign-in from a browser/runtime failure while we finish setup.
        console.error("[auth] Password sign-in was rejected", {
          message: signInError.message,
          status: signInError.status,
          code: signInError.code,
        });
        setError(`Could not sign in: ${signInError.message}`);
        return;
      }

      console.info("[auth] Password sign-in succeeded");
      router.replace("/dashboard");
      router.refresh();
    } catch (signInException) {
      const message = signInException instanceof Error
        ? signInException.message
        : "Unexpected error while contacting Supabase.";

      console.error("[auth] Password sign-in failed before Supabase responded", signInException);
      setError(`Could not sign in: ${message}`);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="access-form" onSubmit={handleSubmit}>
      <label htmlFor="email">Email</label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        placeholder="name@nauta.com"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        required
      />
      <div className="field-heading"><label htmlFor="password">Password</label></div>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        required
      />
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Verifying access…" : "Enter operations center"}
      </button>
    </form>
  );
}
