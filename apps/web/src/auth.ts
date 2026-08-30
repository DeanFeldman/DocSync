import { createClient, type SupportedStorage } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const bridge = window.docSync?.authStorage;
export const authConfigured = Boolean(url && key);
const storage: SupportedStorage = {
  getItem: (storageKey: string) => bridge ? bridge.get(storageKey) : Promise.resolve(null),
  setItem: (storageKey: string, value: string) => bridge ? bridge.set(storageKey, value).then(() => undefined) : Promise.resolve(),
  removeItem: (storageKey: string) => bridge ? bridge.remove(storageKey).then(() => undefined) : Promise.resolve(),
};
export const supabase = authConfigured ? createClient(url!, key!, { auth: { flowType: "pkce", storage, persistSession: Boolean(bridge), detectSessionInUrl: false } }) : null;
