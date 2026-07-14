/**
 * Whether module -> agent replies have a cryptographically authenticated
 * responder identity.
 *
 * Today only agent -> module envelopes are signed. Foundry broadcasts the
 * request (including its correlation id) to every connected client, so an
 * unsigned rpc.response/rpc.error cannot authorize or confirm a consequential
 * operation. This is deliberately a compile-time trust-floor gate: there is no
 * environment, world-setting, or user preference that can turn it on.
 *
 * Change this only in the same reviewed change that makes the agent verify an
 * authenticated module/responder proof and adds adversarial transport tests.
 */
const AUTHENTICATED_MODULE_RESPONSES_AVAILABLE: boolean = false;

export function hasAuthenticatedModuleResponses(): boolean {
  return AUTHENTICATED_MODULE_RESPONSES_AVAILABLE;
}
