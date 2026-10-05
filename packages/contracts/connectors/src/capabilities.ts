/** Connector categories (Spec §46). */
export const CONNECTOR_CATEGORIES = [
  'PMS',
  'POS',
  'ERP',
  'BMS',
  'PBX',
  'LOCK',
  'PAYMENT',
  'CRM',
  'IOT',
  'WIFI',
  'OTHER',
] as const;
export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number];

/**
 * Capability codes (Spec §46, §55; ADR-0014). A connector *type* declares what it can do; each integration *instance*
 * negotiates the subset that actually works at that hotel (Spec §47). Features and AI tools check the instance.
 */
export const CONNECTOR_CAPABILITIES = [
  // PMS (business capabilities of the Unified OPERA Adapter, ADR-0019; guide §5.1)
  'RESERVATION_READ',
  'RESERVATION_LOOKUP',
  'ARRIVALS_READ',
  'IN_HOUSE_SNAPSHOT',
  'GUEST_READ',
  'PROFILE_LOOKUP',
  'ROOM_INVENTORY_READ',
  'CHECKIN_EVENT',
  'CHECKOUT_EVENT',
  'ROOM_MOVE_EVENT',
  'PROFILE_EVENT',
  'ROOM_STATUS_READ',
  'ROOM_STATUS_WRITE',
  'OOO_READ',
  'OOO_WRITE',
  'PROFILE_WRITE',
  'RESERVATION_WRITE',
  'RECONCILIATION_READ',
  'POST_CHARGE',
  // POS
  'MENU_READ',
  'ITEM_AVAILABILITY',
  'ORDER_CREATE',
  'ORDER_STATUS',
  'CHECK_READ',
  // ERP
  'ITEM_READ',
  'STOCK_READ',
  'REQUISITION_CREATE',
  'PO_STATUS_READ',
  // PBX / voice
  'CALL_RECEIVED',
  'CALL_TRANSFER',
  'CALL_HOLD',
  'CALL_END',
  'EXTENSION_DIRECTORY',
  // Wi-Fi
  'WIFI_SESSION_CREATE',
  'WIFI_SESSION_REVOKE',
  'DEVICE_READ',
  // BMS / IoT (Planova Telemetry Profile v1, ADR-0024)
  'TELEMETRY_READ',
] as const;
export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number];

export function isConnectorCapability(value: string): value is ConnectorCapability {
  return (CONNECTOR_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Capabilities that change the external system. A write is offered only once it was verified at the hotel
 * (commissioning, guide §16.5), is never routed to a read-only connector (the OPERA database) and never silently
 * retried on another connector.
 */
export const WRITE_CAPABILITIES: ReadonlySet<ConnectorCapability> = new Set<ConnectorCapability>([
  'ROOM_STATUS_WRITE',
  'OOO_WRITE',
  'PROFILE_WRITE',
  'RESERVATION_WRITE',
  'POST_CHARGE',
  'ORDER_CREATE',
  'REQUISITION_CREATE',
  'CALL_TRANSFER',
  'CALL_HOLD',
  'CALL_END',
  'WIFI_SESSION_CREATE',
  'WIFI_SESSION_REVOKE',
]);

export function isWriteCapability(capability: ConnectorCapability): boolean {
  return WRITE_CAPABILITIES.has(capability);
}

/**
 * Kinds of external code an integration maps to an internal value (Spec §52). Unknown codes never get guessed: they
 * raise an integration exception. REQUIRED kinds block the message until a mapping is confirmed; OPTIONAL kinds let
 * the message through with the canonical field left empty (the exception still records the gap).
 */
export const MAPPING_TYPES = [
  'ROOM',
  'ROOM_TYPE',
  'RATE',
  'MARKET',
  'VIP',
  'ROOM_STATUS',
  // A telemetry point; engineering's point registry is the mapping (BUILD_PLAN 13.2), so it never blocks a message.
  'POINT',
] as const;
export type MappingType = (typeof MAPPING_TYPES)[number];
export const REQUIRED_MAPPING_TYPES: ReadonlySet<MappingType> = new Set(['ROOM', 'ROOM_STATUS']);

/** Integration health states (Spec §57). */
export const INTEGRATION_HEALTH_STATES = [
  'HEALTHY',
  'DEGRADED',
  'OFFLINE',
  'MISCONFIGURED',
  'AUTH_FAILED',
] as const;
export type IntegrationHealthState = (typeof INTEGRATION_HEALTH_STATES)[number];
