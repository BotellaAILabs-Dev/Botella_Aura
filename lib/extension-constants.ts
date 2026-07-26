/**
 * Shared rate-limit constants for the Chrome Extension (Sprint 4, Module 2).
 * The extension enforces these CLIENT-side (the hard requirement — prevents even
 * well-intentioned power users from behaving like a bot). The server also
 * enforces the daily cap as defense-in-depth. Keep both in sync via this file.
 */
export const EXTENSION_DAILY_CAP = 25;
export const EXTENSION_HOURLY_CAP = 8;
