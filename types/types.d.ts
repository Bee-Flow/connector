// Shapes shared by several files of the connector. A file pulls one in with
//   /** @typedef {import('../types/types').NextcloudUser} NextcloudUser */
// (the .d.ts is only read by the type checker, there is nothing to load at runtime).

/** A Nextcloud user as the AppAPI gate resolves it through OCS. */
export interface NextcloudUser {
  uid: string;
  email: string | null;
  displayName: string;
  /** Member of Nextcloud's built-in `admin` group. */
  isNcAdmin: boolean;
}

/** What the AppAPI gate hangs on a request: the user and the SaaS JWT minted for them (null while there is no tenant key). */
export interface BeeflowContext {
  user: NextcloudUser;
  jwt: string | null;
}
