import { expoClient } from "@better-auth/expo/client";
import { emailOTPClient, jwtClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import Constants from 'expo-constants';
import { secureStore } from "./utils/secure-store-adapter";
import { AUTH_ENDPOINT } from "./config/endpoints";
import { logoutRevenueCat } from "./revenuecat";
import { logoutIntercom } from "./intercom";
import logger from "./logger";
import {
    clearJwtSubscriptionLock,
    isJwtSubscriptionLocked,
    isSubscriptionRequiredAuthError,
    recordJwtSubscriptionLocked,
} from "./subscription/jwt-subscription-gate";

// Scheme/slug track whatever app.config.js resolves (env override or app.json
// default). The 'app' fallbacks only fire if expoConfig is null; they are
// intentionally neutral so a renamed fork never silently writes
// `meraapp_cookie` / `meraapp_session_data` storage keys.
const scheme = Constants.expoConfig?.scheme;
const APP_SCHEME = Array.isArray(scheme) ? scheme[0] : scheme || 'app';
const APP_SLUG = Constants.expoConfig?.slug || 'app';

export const authClient = createAuthClient({
    baseURL: AUTH_ENDPOINT,
    plugins: [
        expoClient({
            scheme: APP_SCHEME,
            storagePrefix: APP_SLUG,
            storage: secureStore,
        }),
        emailOTPClient(),
        jwtClient(),
    ],
});

export const sendOTP = async (email: string): Promise<{ success: boolean; error?: string }> => {
    try {
        const { error } = await authClient.emailOtp.sendVerificationOtp({
            email,
            type: 'sign-in'
        });

        if (error) {
            return {
                success: false,
                error: error.message || 'Failed to send OTP',
            };
        }

        return {
            success: true,
        };
    } catch (error: any) {
        return {
            success: false,
            error: error.message || 'Failed to send OTP',
        };
    }
};

// Cache the JWT for inference-gateway requests. Server TTL is 1h; we re-fetch
// every 30s to keep the window short while still deduping rapid batch calls.
let _cachedJwt: string | null = null;
let _cachedJwtExpiry = 0;
let _pendingJwtRequest: Promise<string | null> | null = null;
const JWT_CACHE_TTL_MS = 30_000;

export const invalidateJwtCache = () => {
    _cachedJwt = null;
    _cachedJwtExpiry = 0;
};

export const getJwtToken = async (): Promise<string | null> => {
    if (_cachedJwt && Date.now() < _cachedJwtExpiry) return _cachedJwt;
    // TERMINAL for this session, checked before ANY network call — including the
    // `getSession()` below, which is the request that actually tripped
    // better-auth's rate limiter into 429s on staging. A 403
    // SUBSCRIPTION_REQUIRED cannot change until the user buys something, and the
    // purchase paths lift the latch themselves (see jwt-subscription-gate.ts).
    if (isJwtSubscriptionLocked()) return null;
    if (_pendingJwtRequest) return _pendingJwtRequest;

    _pendingJwtRequest = (async () => {
        try {
            const session = await authClient.getSession();
            if (!session?.data?.session) return null;

            const { data, error } = await authClient.token();
            if (error) {
                // Not captured to Sentry: an unsubscribed user being refused a
                // JWT is the system working, exactly as ai-lock.ts says of a
                // 402. Every OTHER error stays exactly as retryable as it was —
                // a lapsed session must still be able to recover.
                if (isSubscriptionRequiredAuthError(error)) recordJwtSubscriptionLocked();
                return null;
            }
            if (!data?.token) return null;

            _cachedJwt = data.token;
            _cachedJwtExpiry = Date.now() + JWT_CACHE_TTL_MS;
            return data.token;
        } catch (e) {
            // The same verdict can arrive as a throw (a client configured with
            // `throw: true`, or a plugin that rethrows) — classify both paths or
            // the storm simply moves.
            if (isSubscriptionRequiredAuthError(e)) {
                recordJwtSubscriptionLocked();
                return null;
            }
            logger.captureException(e, { tags: { service: 'auth-client', method: 'getJwtToken' } });
            return null;
        }
    })();

    try {
        return await _pendingJwtRequest;
    } finally {
        _pendingJwtRequest = null;
    }
};

// Clears the keys better-auth-expo actually writes (verified against
// node_modules/@better-auth/expo/dist/client.mjs:98-99). Called only from
// explicit user-initiated logout flows.
export const clearAuthStorage = async () => {
    invalidateJwtCache();
    // The refusal belonged to the user who just left. Not folded into
    // invalidateJwtCache(), which every 401-recovery path calls — see
    // clearJwtSubscriptionLock's note.
    clearJwtSubscriptionLock();
    // Reset the RevenueCat customer to anonymous so the next signed-in user
    // doesn't inherit the previous user's entitlements.
    await logoutRevenueCat();
    // Same reasoning for the support Messenger: Intercom holds identity
    // NATIVELY, so without this the next user on this device opens Support and
    // reads the previous user's conversation. This has to sit inside
    // clearAuthStorage() rather than in the logout button, because all four
    // callers destroy local identity — logout, delete account, switch user and
    // the onboarding server-error eject — and any of them can be followed by a
    // different person signing in. logoutIntercom() is total and never
    // rejects; see its header for why that is load-bearing here.
    await logoutIntercom();
    // And Google Drive, which is the same class of problem with a worse
    // outcome: the SDK holds a Google account natively, so without this the
    // next person to sign in on this device has Drive backup already
    // "connected" — to somebody else's Drive — and their persona is uploaded
    // into a stranger's account. Required lazily and total by construction, for
    // the same reason as the Sentry call below.
    try {
        const { disconnectGoogleDrive } = require('@/lib/backup/providers/google-drive');
        await disconnectGoogleDrive();
    } catch {
        // Never block a sign-out on the storage SDK.
    }
    // Same reasoning for crash reporting: without this, every error after a
    // sign-out is attributed to the user who just left. Required imports
    // lazily — sentry-scope reaches the Zustand stores, and a static import
    // here would close the auth-client → apollo-client → auth-client cycle.
    try {
        const { applySentryUser } = require('@/lib/observability/sentry-scope');
        applySentryUser(null);
    } catch {
        // Never block a sign-out on telemetry.
    }
    try {
        await authClient.signOut();
    } catch {
        // Ignore — we still want to wipe local state below.
    }
    for (const key of [`${APP_SLUG}_cookie`, `${APP_SLUG}_session_data`]) {
        try {
            await secureStore.deleteItemAsync(key);
        } catch {
            // Ignore if key doesn't exist.
        }
    }
};
