import { useState } from "react";
import { useAuthenticatedUser } from "./AuthGate";

export default function AuthAccount() {
  const { user, role, signOut } = useAuthenticatedUser(); const [adminOpen, setAdminOpen] = useState(false);
  return <div className="account-area">{user.user_metadata?.avatar_url && <img src={user.user_metadata.avatar_url} alt="" />}<span>{user.user_metadata?.full_name || user.email || "Signed in"}</span>{role === "admin" && <><span className="admin-badge">Admin</span><button type="button" className="quiet-button" onClick={() => setAdminOpen(true)}>Admin</button></>}<button type="button" className="quiet-button" onClick={() => void signOut()}>Sign out</button>{adminOpen && <div className="migration-backdrop" role="presentation"><section className="migration-dialog" role="dialog" aria-modal="true" aria-label="Admin"><h2>Admin</h2><p>Administration controls will manage application operations, never private account workspaces.</p><ul><li>Users</li><li>Storage</li><li>Backups</li><li>Downloads</li><li>Reliability</li></ul><button type="button" className="quiet-button" onClick={() => setAdminOpen(false)}>Close</button></section></div>}</div>;
}
