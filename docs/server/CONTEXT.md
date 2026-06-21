# Server

The Server context defines HTTP-facing route contracts, request/response validation, and adapter-neutral routing for Equipped applications.

## Language

**Route Contract**:
A type-level description of an application's HTTP routes that full-stack consumers can import to derive request and response shapes without duplicating schemas.
_Avoid_: tRPC behaviour, API type map

**Route Identity**:
The method-and-full-path pair that uniquely identifies a route in a Route Contract.
_Avoid_: Operation name, procedure name

**Public Route**:
A route intended to appear in generated API documentation and exported Route Contracts.
_Avoid_: Hidden route, internal route

**Route Contract Entry**:
The input/output type pair for one Route Identity inside a Route Contract.
_Avoid_: Procedure definition, endpoint metadata

**Status Code**:
A numeric HTTP response code in the 100–599 range; Equipped exports named built-in constants but does not restrict applications to that built-in set.
_Avoid_: StatusCodesEnum, custom statusCode
