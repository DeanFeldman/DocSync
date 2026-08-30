import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { authConfigured, supabase } from "./auth";

export default function AuthAccount() {
  const client = supabase;
  const [user, setUser] = useState<User | null>(null); const [state, setState] = useState("loading"); const [error, setError] = useState("");
  useEffect(() => { if (!client) { setState("signed_out"); return; } const exchange = async (code: string) => { setState("signing_in"); const { data, error } = await client.auth.exchangeCodeForSession(code); if (error) { setError("Sign-in could not be completed."); setState("error"); } else { setUser(data.user); setState("signed_in"); } }; const load = async () => { const { data } = await client.auth.getUser(); setUser(data.user); setState(data.user ? "signed_in" : "signed_out"); const code = await window.docSync?.getAuthCallback(); if (code) void exchange(code); }; void load(); return window.docSync?.onAuthCallback((code) => void exchange(code)); }, [client]);
  async function signIn() { if (!client) return; setState("signing_in"); setError(""); const { data, error } = await client.auth.signInWithOAuth({ provider: "google", options: { redirectTo: "za.co.docsync://auth/callback", skipBrowserRedirect: true } }); if (error || !data.url || !(await window.docSync?.openOAuth(data.url))) { setError("Could not open Google sign-in."); setState("error"); } }
  async function signOut() { await client?.auth.signOut(); await window.docSync?.authStorage?.remove(); setUser(null); setState("signed_out"); }
  if (!authConfigured) return null;
  if (user) return <div className="account-area">{user.user_metadata?.avatar_url && <img src={user.user_metadata.avatar_url} alt="" />}<span>{user.user_metadata?.full_name || user.email || "Signed in"}</span><button type="button" className="quiet-button" onClick={() => void signOut()}>Sign out</button></div>;
  return <div className="account-area"><button type="button" className="quiet-button" disabled={state === "signing_in"} onClick={() => void signIn()}>{state === "signing_in" ? "Opening Google…" : "Sign in with Google"}</button>{error && <small role="alert">{error}</small>}</div>;
}
