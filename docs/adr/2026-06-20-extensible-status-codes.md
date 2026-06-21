# Extensible HTTP Status Codes

Equipped's server layer accepts any integer HTTP Status Code in the 100–599 range at the type level instead of restricting applications to the named `StatusCodes` constants. `StatusCode` is the canonical public type; `StatusCodesEnum` remains as a deprecated compatibility alias, while the `StatusCodes` value object stays limited to Equipped's named built-ins. This keeps application-specific statuses possible across route responses, request errors, and socket callbacks without introducing a runtime status-code registry.

## Consequences

- Literal statuses outside 100–599 are compile-time errors; plain `number` values require explicit caller refinement or assertion.
- Runtime range validation is not added in this decision.
- Route response defaults (`defaultStatusCode` and `defaultContentType`) are honored by successful handler outputs so typed defaults match runtime responses.
- Response validation uses the generic serialized error schema for any error Status Code (400–599), including application-specific codes.
- OpenAPI's built-in error responses remain based on Equipped's named `StatusCodes`; application-specific error statuses are validation-supported but not automatically documented.
