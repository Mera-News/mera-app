// Location Service — WatermelonDB adapter for persona-v3 `locations`.
//
// Thin RN-coupled surface. Locations never leave the device (privacy-lean
// retrieval) — the scoring engine (later wave) reads them for geo matching.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import type LocationModel from '../models/Location';
import type { LocationProvenance, LocationRole } from '../models/Location';

const locationsCollection = database.get<LocationModel>('locations');

function normalizePlacePart(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
}

export interface UpsertLocationInput {
  city?: string | null;
  region?: string | null;
  countryCode: string;
  role: LocationRole;
  weight?: number;
  validUntil?: number | null;
  pinnedForWeather?: boolean;
  provenance?: LocationProvenance;
  sourceFactId?: string | null;
}

/**
 * Creates a location, deduping on normalized (city, country_code, role). An
 * existing match is updated in place (weight/region/valid_until/source fact
 * refreshed) instead of duplicated. Returns the created-or-updated record.
 */
export async function upsertLocation(input: UpsertLocationInput): Promise<LocationModel> {
  const candidates = await locationsCollection
    .query(Q.where('country_code', input.countryCode))
    .fetch();
  const existing = candidates.find(
    (l) =>
      normalizePlacePart(l.city) === normalizePlacePart(input.city) &&
      l.role === input.role,
  );

  return database.write(async () => {
    const now = new Date();
    if (existing) {
      await existing.update((l) => {
        if (input.region !== undefined) l.region = input.region ?? null;
        if (input.weight !== undefined) l.weight = input.weight;
        if (input.validUntil !== undefined) l.validUntil = input.validUntil ?? null;
        if (input.sourceFactId !== undefined) l.sourceFactId = input.sourceFactId ?? null;
        l.updatedAt = now;
      });
      return existing;
    }
    return locationsCollection.create((l) => {
      l.city = input.city ?? null;
      l.region = input.region ?? null;
      l.countryCode = input.countryCode;
      l.role = input.role;
      l.weight = input.weight ?? 0.5;
      l.validUntil = input.validUntil ?? null;
      l.pinnedForWeather = input.pinnedForWeather ?? false;
      l.provenance = input.provenance ?? 'user';
      l.sourceFactId = input.sourceFactId ?? null;
      l.createdAt = now;
      l.updatedAt = now;
    });
  });
}

/** All locations, weight desc (the canonical ordering). */
export async function getAll(): Promise<LocationModel[]> {
  return locationsCollection.query(Q.sortBy('weight', Q.desc)).fetch();
}

/** Reactive query of all locations, weight desc. */
export function observeAll() {
  return locationsCollection.query(Q.sortBy('weight', Q.desc)).observe();
}

export async function setWeight(locationId: string, weight: number): Promise<void> {
  const clamped = Math.max(0, Math.min(1, weight));
  const record = await locationsCollection.find(locationId);
  await database.write(async () => {
    await record.update((l) => {
      l.weight = clamped;
      l.updatedAt = new Date();
    });
  });
}

/**
 * Pins exactly one location for the (future) weather widget — unpins any
 * currently-pinned rows in the same write.
 */
export async function setPinnedForWeather(locationId: string): Promise<void> {
  const target = await locationsCollection.find(locationId);
  const pinned = await locationsCollection
    .query(Q.where('pinned_for_weather', true))
    .fetch();
  await database.write(async () => {
    const now = new Date();
    const batch = pinned
      .filter((l) => l.id !== locationId)
      .map((l) =>
        l.prepareUpdate((r) => {
          r.pinnedForWeather = false;
          r.updatedAt = now;
        }),
      );
    batch.push(
      target.prepareUpdate((r) => {
        r.pinnedForWeather = true;
        r.updatedAt = now;
      }),
    );
    await database.batch(batch);
  });
}

export async function deleteLocation(locationId: string): Promise<void> {
  const record = await locationsCollection.find(locationId);
  await database.write(async () => {
    await record.destroyPermanently();
  });
}
