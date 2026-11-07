// Stand-in for the Workers runtime module so Node tests can import the Worker code.
// The real DurableObject base class comes from `cloudflare:workers`.
export class DurableObject<Env = unknown> {
  constructor(
    public ctx: unknown,
    public env: Env
  ) {}
}
