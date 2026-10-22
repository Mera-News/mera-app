import { MAX_UPDATE_NOTES, notesSince, parseUpdateNotes, type UpdateNote } from '../update-notes';

const note = (day: number, message = `day ${day}`): UpdateNote => ({
    at: new Date(Date.UTC(2026, 9, day, 9)).toISOString(),
    message,
});

describe('parseUpdateNotes', () => {
    it('reads [] from nothing, bad JSON or a non-array', () => {
        expect(parseUpdateNotes(undefined)).toEqual([]);
        expect(parseUpdateNotes('')).toEqual([]);
        expect(parseUpdateNotes('{ nope')).toEqual([]);
        expect(parseUpdateNotes('{"at":"x"}')).toEqual([]);
    });

    it('drops entries that are not well formed', () => {
        const good = note(20);
        const raw = JSON.stringify([good, null, { at: 'not a date', message: 'm' }, { at: good.at }, { at: good.at, message: '  ' }, 7]);
        expect(parseUpdateNotes(raw)).toEqual([good]);
    });
});

describe('notesSince', () => {
    it('keeps notes strictly newer than the last update this device ran, newest first', () => {
        const notes = [note(18), note(22), note(20), note(21)];
        expect(notesSince(notes, note(20).at)).toEqual([note(22), note(21)]);
    });

    it("leaves out the device's own update when its time equals the marker", () => {
        const own = note(20);
        expect(notesSince([own, note(21)], own.at)).toEqual([note(21)]);
    });

    it('with no known last update gives only the newest note', () => {
        expect(notesSince([note(18), note(22), note(20)], null)).toEqual([note(22)]);
        expect(notesSince([], null)).toEqual([]);
    });

    it(`lists at most ${MAX_UPDATE_NOTES}`, () => {
        const notes = Array.from({ length: 14 }, (_, i) => note(i + 1));
        const shown = notesSince(notes, note(0).at);
        expect(shown).toHaveLength(MAX_UPDATE_NOTES);
        expect(shown[0]).toEqual(note(14));
    });
});
