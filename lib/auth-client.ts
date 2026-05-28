import { expoClient } from "@better-auth/expo/client";
import { emailOTPClient, jwtClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import Constants from 'expo-constants';
import { secureStore } from "./utils/secure-store-adapter";
import { AUTH_ENDPOINT } from "./config/endpoints";
import logger from "./logger";

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
    if (_pendingJwtRequest) return _pendingJwtRequest;

    _pendingJwtRequest = (async () => {
        try {
            const session = await authClient.getSession();
            if (!session?.data?.session) return null;

            const { data, error } = await authClient.token();
            if (error || !data?.token) return null;

            _cachedJwt = data.token;
            _cachedJwtExpiry = Date.now() + JWT_CACHE_TTL_MS;
            return data.token;
        } catch (e) {
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
