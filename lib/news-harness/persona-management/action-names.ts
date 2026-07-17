// news-harness — persona-mutation action_type ids (PURE, RN-free).
//
// The canonical map of every `persona_change_log.action_type` string a persona
// mutation can emit. Shared seam: the RN change-log service
// (lib/database/services/persona-change-log-service.ts) and every wave that
// appends/inverts a mutation import these ids from here instead of hardcoding
// literals, so a rename fails loudly at the type layer.
//
// These string values MUST stay bit-identical to the literals already persisted
// by the change-log service ('set_topic_weight', 'set_fact_weight',
// 'set_location_weight', 'add_topic', 'retire_topic', 'revert_change') and the
// migration planner — DO NOT change an existing string (it would orphan logged
// rows from their inverse).

export const ACTION_NAMES = {
  SET_TOPIC_WEIGHT: 'set_topic_weight',
  SET_FACT_WEIGHT: 'set_fact_weight',
  SET_LOCATION_WEIGHT: 'set_location_weight',
  ADD_TOPIC: 'add_topic',
  ADD_NEGATIVE_TOPIC: 'add_negative_topic',
  RETIRE_TOPIC: 'retire_topic',
  SUPPRESS_TOPIC: 'suppress_topic',
  ADD_SUPPRESSION: 'add_suppression',
  SET_HIGH_PRIORITY: 'set_high_priority',
  SET_PUBLICATION_PREF: 'set_publication_pref',
  NUDGE_SUBSCRIBE_PUBLICATION: 'nudge_subscribe_publication',
  NUDGE_BROWSE_RELATED: 'nudge_browse_related',
  REASSIGN_TOPIC: 'reassign_topic',
  MERGE_FACTS: 'merge_facts',
  // Persona-hygiene fact removal (Wave 11 U-B3/N6). A destructive cleanup
  // (fact + cascaded topics deleted) — logged for audit visibility but NOT
  // invertible (see action-display.isRevertible + persona-change-log-service).
  HYGIENE_DELETE_FACT: 'hygiene_delete_fact',
  REVERT_CHANGE: 'revert_change',
} as const;

export type ActionName = (typeof ACTION_NAMES)[keyof typeof ACTION_NAMES];
