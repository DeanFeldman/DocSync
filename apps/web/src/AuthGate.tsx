import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import docSyncLogo from "./assets/Docsync LOGO.png";
import { authConfigured, supabase } from "./auth";

type AuthContextValue = { user: User; signOut: () => Promise<void> };
const AuthContext = createContext<AuthContextValue | null>(null);
export function useAuthenticatedUser(): AuthContextValue { const value = useContext(AuthContext); if (!value) throw new Error("AuthAccount must be rendered after authentication."); return value; }

export default function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"loading" | "signed_out" | "signing_in" | "signed_in" | "error">("loading");
  const [user, setUser] = useState<User | null>(null); const [error, setError] = useState(""); const client = supabase;
  const restore = useCallback(async () => { if (!client) { setState("error"); setError("DocSync account services are not configured."); return; } setState("loading"); setError(""); try { const { data: sessionData, error: sessionError } = await client.auth.getSession(); if (sessionError || !sessionData.session) { setUser(null); setState("signed_out"); return; } const { data, error: userError } = await client.auth.getUser(); if (userError || !data.user) { await client.auth.signOut(); setUser(null); setState("signed_out"); return; } setUser(data.user); setState("signed_in"); } catch { setUser(null); setError("Could not connect to DocSync account services."); setState("error"); } }, [client]);
  const exchange = useCallback(async (code: string) => { if (!client) return; setState("signing_in"); setError(""); const { data, error: exchangeError } = await client.auth.exchangeCodeForSession(code); if (exchangeError || !data.user) { if (exchangeError) console.error("DocSync OAuth code exchange failed:", exchangeError); setError("Sign-in could not be completed."); setState("error"); return; } setUser(data.user); setState("signed_in"); }, [client]);
  useEffect(() => { const initialise = async () => { const code = await window.docSync?.getAuthCallback(); if (code) { await exchange(code); } else { await restore(); } }; void initialise(); const unsubscribe = window.docSync?.onAuthCallback((code) => void exchange(code)); return unsubscribe; }, [exchange, restore]);
  const signIn = async () => { if (!client) return; setState("signing_in"); setError(""); const { data, error: signInError } = await client.auth.signInWithOAuth({ provider: "google", options: { redirectTo: "za.co.docsync://auth/callback", skipBrowserRedirect: true } }); if (signInError || !data.url || !(await window.docSync?.openOAuth(data.url))) { setError("Could not open Google sign-in."); setState("error"); } };
  const signOut = async () => { await client?.auth.signOut(); await window.docSync?.authStorage?.clear(); setUser(null); setState("signed_out"); };
  if (state === "loading" || state === "signing_in") return <main className="auth-screen auth-loading"><img src={docSyncLogo} alt="DocSync" /><p>{state === "signing_in" ? "Completing sign-in..." : "Opening DocSync..."}</p></main>;
  if (state === "signed_in" && user) return <AuthContext.Provider value={{ user, signOut }}>{children}</AuthContext.Provider>;
  return <main className="auth-screen"><section className="auth-card"><img src={docSyncLogo} alt="DocSync" /><h1>Welcome to DocSync</h1><p>Keep your documents consistent without giving up control.</p>{authConfigured && <button type="button" className="primary-button" onClick={() => void signIn()}>Continue with Google</button>}{state === "error" && <div role="alert"><p>{error}</p><button type="button" className="quiet-button" onClick={() => void restore()}>Retry</button></div>}<small>Your documents remain stored locally on this computer.</small></section></main>;
}
