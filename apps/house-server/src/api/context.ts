import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HouseApp } from '../app.js';
import type { SseHub } from './sse.js';
import type { PlayerAuth } from './auth.js';
import type { DevWallet } from './dev-wallet.js';

export interface ApiDeps {
  readonly app: HouseApp;
  readonly adminToken: string;
  readonly sse: SseHub;
  readonly log: (line: string) => void;
  /**
   * MAYA_OPEN_PLAYER_API=testnet-unsafe. Without `auth` (Stage A embedded server): serve POST/GET /v1/withdrawals
   * without authentication. With `auth` (production): an explicit dev override that lets account-scoped player routes
   * act for a client-named account when the request carries no session. Off by default; never outside a testnet.
   */
  readonly openPlayerApi?: boolean;
  /**
   * Stage B player sessions (SIWE). main.ts always sets it; then account-scoped player routes take the account from
   * the session (src/api/auth-routes.ts `authorizeAccount`). Absent = the Stage A player API (embedded tests).
   */
  readonly auth?: PlayerAuth;
  /** RPC URL the browser wallet may use for this chain (never a private endpoint with an API key). */
  readonly publicRpcUrl?: string;
  /** DEV ONLY: the local test-wallet signer (MAYA_DEV_TEST_WALLET=1, 127.0.0.1, MAYA_NETWORK=local). */
  readonly devWallet?: DevWallet;
}

export interface Ctx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly deps: ApiDeps;
  /** Admin actor for audit entries ('admin' or 'admin:<X-Maya-Actor>'). */
  readonly actor: string;
}
