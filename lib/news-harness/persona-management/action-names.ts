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
  // Removing a "not interested" filter is an AUDITED mutation, not a silent
  // delete (D5): it logs like any other persona change and inverts via
  // suppression-service.reactivateSuppression. Removal of a NEGATIVE TOPIC is
  // a different thing and stays RETIRE_TOPIC.
  RETIRE_SUPPRESSION: 'retire_suppression',
  SET_HIGH_PRIORITY: 'set_high_priority',
  SET_PUBLICATION_PREF: 'set_publication_pref',
  // source-pref v47 (D2/D6). A GROUP source preference ("prefer Indian
  // sources") is ONE row carrying a live scope predicate — never an expansion
  // into one row per matching outlet. Only `scope_kind = 'country'` exists.
  SET_SOURCE_SCOPE_PREF: 'set_source_scope_pref',
  NUDGE_SUBSCRIBE_PUBLICATION: 'nudge_subscribe_publication',
  NUDGE_BROWSE_RELATED: 'nudge_browse_related',
  REASSIGN_TOPIC: 'reassign_topic',
  MERGE_FACTS: 'merge_facts',
  // Persona-hygiene fact removal (Wave 11 U-B3/N6). A destructive cleanup
  // (fact + cascaded topics deleted) — logged for audit visibility but NOT
  // invertible (see action-display.isRevertible + persona-change-log-service).
  HYGIENE_DELETE_FACT: 'hygiene_delete_fact',
  // r14 — the in-chat topic-plan card's DISCARD. Same destructive shape as
  // HYGIENE_DELETE_FACT (fact + cascaded topics deleted) but user-initiated
  // from the chat rather than proposed by the hygiene sweep, so it gets its own
  // id to keep the audit trail honest about who asked. Like its sibling it is
  // logged for visibility but NOT invertible — `destroyCascade` leaves nothing
  // to restore — so it MUST also sit in action-display.isRevertible's deny-list.
  DISCARD_FACT: 'discard_fact',
  // Location management (Wave 12 U-F2). Both are logged for audit visibility but
  // are NOT invertible this wave — `add` has no revert (delete the row from the
  // locations screen) and `delete` is destroyPermanently (nothing to restore).
  // See action-display.isRevertible + persona-change-log-service (no inverse).
  ADD_LOCATION: 'add_location',
  DELETE_LOCATION: 'delete_location',
  REVERT_CHANGE: 'revert_change',
} as const;

export type ActionName = (typeof ACTION_NAMES)[keyof typeof ACTION_NAMES];
