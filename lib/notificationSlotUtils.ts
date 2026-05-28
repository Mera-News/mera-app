/**
 * Utility functions for converting between News Hours and UTC hours
 * Handles timezone conversion to ensure consistent storage in UTC while displaying in local time
 */

/**
 * Generate all available hours (0-23)
 */
export const NOTIFICATION_HOURS = Array.from({ length: 24 }, (_, i) => i);

/**
 * Converts local hour numbers to UTC hour numbers for database storage
 * @param localHours - Array of local hour numbers (e.g., [9, 14, 18])
 * @returns Array of UTC hour numbers (e.g., [14, 19, 23] for EST timezone)
 */
export const convertLocalHoursToUTC = (localHours: number[]): number[] => {
    return localHours.map(localHour => {
        // Create a date object for today at the selected local hour
        const localDate = new Date();
        localDate.setHours(localHour, 0, 0, 0);

        // Get the UTC hour
        const utcHour = localDate.getUTCHours();

        return utcHour;
    });
};

/**
 * Converts UTC hour numbers back to local timezone hours for display
 * @param utcHours - Array of UTC hour numbers from database (e.g., [14, 19, 23])
 * @returns Array of local hour numbers (e.g., [9, 14, 18] for EST timezone)
 */
export const convertUTCHoursToLocal = (utcHours: number[]): number[] => {
    return utcHours.map(utcHour => {
        // Create a UTC date object for today at the stored UTC hour
        const utcDate = new Date();
        utcDate.setUTCHours(utcHour, 0, 0, 0);

        // Get the local hour
        const localHour = utcDate.getHours();

        return localHour;
    });
};

/**
 * Formats an hour number to display string (e.g., 9 -> "09:00", 14 -> "14:00")
 * @param hour - Hour number (0-23)
 * @returns Formatted time string
 */
export const formatHour = (hour: number): string => {
    return `${hour.toString().padStart(2, '0')}:00`;
};
