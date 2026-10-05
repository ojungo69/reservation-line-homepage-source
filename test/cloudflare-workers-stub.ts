// Node-pool stub for the `cloudflare:workers` virtual module. The
// real module is only available inside the Workers runtime
// (provided by `@cloudflare/vitest-pool-workers` for `*.worker.test.ts`).
//
// Tests running under the default Node pool (`vitest.config.ts`) only
// load the LineRateLimiter class via the re-export chain through
// `src/index.ts` — they never instantiate it. We provide a minimal
// DurableObject base class so the import resolves and the rest of the
// module evaluates cleanly. Any code that actually constructs/uses a
// DurableObject must run under the workers pool.
export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

// Node tests only import the named entrypoint through src/index.ts. Its actual
// construction and Service Binding behavior are covered in the Workers pool.
export class WorkerEntrypoint<Env = unknown> {
  constructor(_ctx: unknown, protected env: Env) {}
}

export class WorkflowEntrypoint<Env = unknown, _Params = unknown> {
  protected env: Env;

  constructor(_ctx: unknown, env: Env) {
    this.env = env;
  }

  async run(_event: unknown, _step: unknown): Promise<unknown> {
    return undefined;
  }
}

export class NonRetryableError extends Error {
  constructor(message: string, name?: string) {
    super(message);
    this.name = name ?? "NonRetryableError";
  }
}

export type WorkflowStep = unknown;
export type WorkflowEvent<T = unknown> = { payload: T; timestamp: Date; instanceId: string };
