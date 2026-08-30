import { createClient, type SupportedStorage } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const bridge = window.docSync?.authStorage;
export const authConfigured = Boolean(url && key);
const storage: SupportedStorage = {
  getItem: (_key: string) => bridge ? bridge.get() : Promise.resolve(null),
  setItem: (_key: string, value: string) => bridge ? bridge.set(value).then(() => undefined) : Promise.resolve(),
  removeItem: (_key: string) => bridge ? bridge.remove().then(() => undefined) : Promise.resolve(),
};
export const supabase = authConfigured ? createClient(url!, key!, { auth: { flowType: "pkce", storage, persistSession: Boolean(bridge), detectSessionInUrl: false } }) : null;
