// Properties this code hangs on Node's own types (errors carry a code and an HTTP status,
// requests carry what the middleware attached). Declared once here, not cast at every use.
import 'node:http';
import type { BeeflowContext } from './types';

declare global {
  interface Error {
    code?: string;
    status?: number;
    remediation?: string;
    attemptsLeft?: number;
  }

  namespace Express {
    interface Request {
      beeflow?: BeeflowContext;
    }
  }
}

declare module 'node:http' {
  interface IncomingMessage {
    /** Set by a body parser (express.json / express.raw); anything until a route has checked it. */
    body?: unknown;
    /** On a response received by a proxy: the request that produced it. */
    req?: import('node:http').ClientRequest;
    beeflow?: BeeflowContext;
    __beeflowRetried?: boolean;
    __shellNext?: () => void;
    /** The connector-local path of a shell request, before the proxy rewrote req.url to /embed/... */
    __shellUrl?: string;
    /** The outbound request the API proxy opened for this request (headers timeout). */
    __beeflowProxyReq?: import('node:http').ClientRequest;
    __beeflowHeadersTimer?: ReturnType<typeof setTimeout>;
    /** The headers timeout answered while the request still waited for a socket. */
    __beeflowTimedOut?: boolean;
  }
}

export {};
