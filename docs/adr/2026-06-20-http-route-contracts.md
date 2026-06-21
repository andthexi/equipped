# HTTP Route Contracts

Equipped's server layer will expose type-only HTTP Route Contracts derived from chained Router and Server registration, with the Server as the primary application contract source. Route Identities are lowercase HTTP method plus normalized full path; Public Routes enter `RouteContractOf<T>`, while hidden routes remain internal but still participate in type-level duplicate checks when their identities are literal. This deliberately chooses TypeScript route-contract accumulation over a runtime tRPC-style client/procedure system so full-stack applications can share request/response types first without changing the HTTP routing model.

## Consequences

- `RouteContractOf<T>`, `RouteInput<C, M, P>`, and `RouteOutput<C, M, P>` are exported from `equipped/server`.
- Route Contract Entries use `{ input, output }`; client inputs use `PipeInput`, outputs use validated server-side `PipeOutput`, and outputs include `statusCode` and `contentType` so typed errors can be added later without reshaping successful responses.
- Contract-tracked registration is a breaking builder-style API: route methods return widened Routers, `server.addRouter(router)` and `router.nest(child)` accept one router at a time, and ignored return values remain runtime-valid but do not widen the type.
