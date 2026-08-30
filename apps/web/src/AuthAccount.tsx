import { useState } from "react";
import { useAuthenticatedUser } from "./AuthGate";
import CloudBackup from "./CloudBackup";

export default function AuthAccount() {
  const { user, role, signOut } = useAuthenticatedUser(); const [adminOpen, setAdminOpen] = useState(false);
  return <div className="account-area">{user.user_metadata?.avatar_url && <img src={user.user_metadata.avatar_url} alt="" />}<span><strong>{user.user_metadata?.full_name || "DocSync account"}</strong><small>{user.email}</small></span><CloudBackup />{role === "admin" && <><span className="admin-badge">Admin</span><button type="button" className="quiet-button" onClick={() => setAdminOpen(true)}>Admin</button></>}<button type="button" className="quiet-button" onClick={() => void signOut()}>Sign out</button>{adminOpen && <AdminPage close={() => setAdminOpen(false)} />}</div>;
}
function AdminPage({ close }: { close: () => void }) { return <div className="migration-backdrop" role="presentation"><section className="migration-dialog admin-page" role="dialog" aria-modal="true" aria-label="Admin"><h2>Admin</h2><p>Operational foundations only. Admin access never grants access to private account workspaces.</p><div className="admin-cards">{["Users", "Storage", "Backups", "Downloads", "Reliability"].map((name) => <article key={name}><strong>{name}</strong><span>Available in v1.19</span></article>)}</div><button type="button" className="quiet-button" onClick={close}>Close</button></section></div>; }
