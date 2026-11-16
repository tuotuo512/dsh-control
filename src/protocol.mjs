/**
 * Versioned local transport contract between the supervisor (Codex side) and the
 * native execution plugin (inside the DSH Desktop Host).
 *
 * These values are independent of the package version, the DSH version and the
 * run-state schema. Bump PROTOCOL_VERSION only for an incompatible change; add a
 * capability name for an additive one.
 */
export const PROTOCOL_VERSION = 1;

/** Pre-0.3.0 deployments wrote a descriptor without a protocol field. */
export const LEGACY_PROTOCOL = 0;

export const CAPABILITIES = Object.freeze([
  'health',
  'open',
  'prompt',
  'poll',
  'respond',
  'cancel',
  'release',
  'list-sessions',
  'list-workspaces',
  'inspect-session',
  'adopt',
]);

export const DESCRIPTOR_SCHEMA_VERSION = 1;

/** Reject an incompatible descriptor before any mutation is attempted. */
export function assertDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new Error('Missing Desktop connection descriptor');
  }
  if (descriptor.schemaVersion !== DESCRIPTOR_SCHEMA_VERSION) {
    throw new Error(`Unsupported Desktop descriptor schema ${descriptor.schemaVersion}`);
  }
  if (descriptor.protocolVersion !== undefined && descriptor.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `Desktop plugin protocol ${descriptor.protocolVersion} does not match supervisor protocol ${PROTOCOL_VERSION}. ` +
      'Reinstall matching supervisor and plugin builds; no fallback or model downgrade is performed.',
    );
  }
  // A descriptor written before protocol versioning existed is accepted as an
  // explicit legacy deployment (same trust domain, same project), never silently:
  // doctor reports legacyProtocol, and the next install replaces the plugin.
  if (descriptor.protocolVersion === undefined) descriptor.legacyProtocol = true;
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(descriptor.url || '') || typeof descriptor.token !== 'string' || !descriptor.token) {
    throw new Error('Invalid Desktop connection descriptor');
  }
  return descriptor;
}

/** Health must echo the protocol of the plugin that answered. */
export function assertHealth(health, {legacy = false} = {}) {
  if (health && health.protocolVersion === PROTOCOL_VERSION) return health;
  if (legacy && health && health.protocolVersion === undefined) {
    return {...health, protocolVersion: LEGACY_PROTOCOL, legacyProtocol: true};
  }
  throw new Error(
    `Desktop plugin reported protocol ${health?.protocolVersion ?? 'missing'}; supervisor requires ${PROTOCOL_VERSION}`,
  );
}

/** Capabilities the supervisor needs for the operations it exposes. */
export const REQUIRED_CAPABILITIES = Object.freeze(['prompt', 'poll', 'respond', 'cancel', 'release']);

export function missingCapabilities(health) {
  const present = new Set(Array.isArray(health?.capabilities?.operations)
    ? health.capabilities.operations
    : Array.isArray(health?.capabilities) ? health.capabilities : []);
  if (present.size === 0) return [...REQUIRED_CAPABILITIES];
  return REQUIRED_CAPABILITIES.filter(name => !present.has(name));
}
