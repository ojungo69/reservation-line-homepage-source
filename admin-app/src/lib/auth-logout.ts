// Cloudflare Access session-logout endpoint. Hitting this path clears the
// CF_Authorization cookie at the edge (handled by Access before the Worker),
// so the next admin request re-prompts for login. Used by the account menu's
// ログアウト item. Kept as a named constant so the path is covered by a unit
// test and cannot silently drift (a wrong path would silently no-op logout).
export const ACCESS_LOGOUT_PATH = "/cdn-cgi/access/logout";

export function logout(): void {
  window.location.href = ACCESS_LOGOUT_PATH;
}
