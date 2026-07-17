// Location persona actions (Wave 12 U-F2) — the change-logged surface the
// locations screen uses for add / delete / weight edits.
//
// `location-service` is the raw WatermelonDB adapter (no change-log). This file
// composes it with the persona change-log so every user-driven location change
// is auditable:
//   • weight edits  → `applyPersonaAction(set_location_weight, 'slider')`
//     (INVERTIBLE — reads `before` internally, revert restores it)
//   • add           → `upsertLocation` + an `add_location` audit row
//     (NOT invertible this wave)
//   • delete        → `deleteLocation` + a `delete_location` audit row
//     (NOT invertible — destroyPermanently, nothing to restore)

import * as locationService from './location-service';
import type { UpsertLocationInput } from './location-service';
import { applyPersonaAction } from './persona-action-executor';
import * as changeLogService from './persona-change-log-service';
import { ACTION_NAMES } from '../../news-harness/persona-management/action-names';
import type LocationModel from '../models/Location';
import type { LocationRole } from '../models/Location';

function normalizePlacePart(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Human label for change-log summaries (English only — summaries are stored raw). */
function labelFor(city: string | null | undefined, countryCode: string): string {
  const c = (city ?? '').trim();
  return c ? `${c}, ${countryCode.toUpperCase()}` : countryCode.toUpperCase();
}

export interface AddLocationResult {
  readonly location: LocationModel;
  /** True when an existing (city, country, role) row was updated, not created. */
  readonly updated: boolean;
}

/**
 * Add (or dedupe-update) a user location, change-logged. Dedupe mirrors
 * `upsertLocation` (normalized city + country_code + role). On a match the row's
 * weight is changed through the invertible `set_location_weight` action; on a
 * fresh insert an `add_location` audit row is appended.
 */
export async function addUserLocation(
  input: UpsertLocationInput,
): Promise<AddLocationResult> {
  const all = await locationService.getAll();
  const existing = all.find(
    (l) =>
      l.countryCode === input.countryCode &&
      normalizePlacePart(l.city) === normalizePlacePart(input.city) &&
      l.role === input.role,
  );

  if (existing) {
    // Route the weight change through the invertible action so the dedupe path
    // is auditable too. Region refresh (if any) goes through upsert separately.
    if (typeof input.weight === 'number' && input.weight !== existing.weight) {
      await applyPersonaAction(
        { action_type: ACTION_NAMES.SET_LOCATION_WEIGHT, locationId: existing.id, weight: input.weight },
        'slider',
      );
    }
    const location = await locationService.upsertLocation({ ...input, weight: undefined });
    return { location, updated: true };
  }

  const location = await locationService.upsertLocation({ ...input, provenance: 'user' });
  await changeLogService.append({
    actionType: ACTION_NAMES.ADD_LOCATION,
    action: { targetId: location.id, city: input.city ?? null, countryCode: input.countryCode, role: input.role },
    source: 'user',
    summary: `Added location: ${labelFor(input.city, input.countryCode)}`,
  });
  return { location, updated: false };
}

/** Delete a user location, appending an audit-only (non-invertible) change-log row. */
export async function deleteUserLocation(location: {
  id: string;
  city: string | null;
  countryCode: string;
  role: LocationRole;
}): Promise<void> {
  await locationService.deleteLocation(location.id);
  await changeLogService.append({
    actionType: ACTION_NAMES.DELETE_LOCATION,
    action: { targetId: location.id, city: location.city, countryCode: location.countryCode, role: location.role },
    source: 'user',
    summary: `Removed location: ${labelFor(location.city, location.countryCode)}`,
  });
}

/** Change a location's weight through the invertible `set_location_weight` action. */
export async function setLocationWeightLogged(locationId: string, weight: number): Promise<void> {
  await applyPersonaAction(
    { action_type: ACTION_NAMES.SET_LOCATION_WEIGHT, locationId, weight },
    'slider',
  );
}
