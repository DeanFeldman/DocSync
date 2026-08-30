import { useAuthenticatedUser } from "./AuthGate";

export default function AuthAccount() {
  const { user, signOut } = useAuthenticatedUser();
  return <div className="account-area">{user.user_metadata?.avatar_url && <img src={user.user_metadata.avatar_url} alt="" />}<span>{user.user_metadata?.full_name || user.email || "Signed in"}</span><button type="button" className="quiet-button" onClick={() => void signOut()}>Sign out</button></div>;
}
