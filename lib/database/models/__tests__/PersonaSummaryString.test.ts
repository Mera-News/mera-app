// PersonaSummaryString model unit tests. No custom writer methods — cover the
// static table name and field accessibility (the generation pipeline lands in a
// later wave).

jest.mock('@nozbe/watermelondb', () => {
  return {
    Model: class Model {
      async update(fn?: (r: any) => void) {
        fn?.(this);
        return this;
      }
    },
  };
});

jest.mock('@nozbe/watermelondb/decorators', () => ({
  field: () => (_target: any, _key: string) => {},
  date: () => (_target: any, _key: string) => {},
}));

import PersonaSummaryString from '../PersonaSummaryString';

describe('PersonaSummaryString model', () => {
  it('has the correct table name', () => {
    expect(PersonaSummaryString.table).toBe('persona_summary_strings');
  });

  it('allows direct field mutations', () => {
    const instance: any = new (PersonaSummaryString as any)();
    instance.text = 'You follow AI policy in the EU';
    instance.linkedFactIdsJson = '["fact-1"]';
    instance.linkedTopicIdsJson = '["topic-1","topic-2"]';
    instance.generatedAt = new Date(1700000000000);
    instance.personaVersion = 'v3';
    instance.stale = false;

    expect(instance.text).toBe('You follow AI policy in the EU');
    expect(instance.linkedFactIdsJson).toBe('["fact-1"]');
    expect(instance.linkedTopicIdsJson).toBe('["topic-1","topic-2"]');
    expect(instance.generatedAt).toBeInstanceOf(Date);
    expect(instance.personaVersion).toBe('v3');
    expect(instance.stale).toBe(false);
  });
});
