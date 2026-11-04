// Clear profile's cascade: the bulk delete takes each fact's topics, so an emptied profile really is
// empty to the launch rule and to retrieval.
import { addFact, deleteAllFacts, getFacts } from '@/lib/database/services/fact-service';
import { countActiveTopicsIncludingStaged, createTopics, getActive } from '@/lib/database/services/topic-service';
import { readStartupTab } from '@/lib/navigation/startup-tab';

const seedFactWithTopics = async (statement: string, texts: string[]) => {
  const fact = await addFact(statement);
  await createTopics(texts.map((text) => ({ text, factId: fact.id, weight: 1, status: 'active', provenance: 'llm' })));
};

it('takes every fact and the topics they own, so the next launch opens World', async () => {
  await seedFactWithTopics('I follow racing', ['formula 1', 'motogp']);
  await seedFactWithTopics('Works as a nurse', ['nursing pay']);
  expect(await readStartupTab()).toBe('feed');

  await deleteAllFacts();

  expect(await getFacts()).toEqual([]);
  expect(await countActiveTopicsIncludingStaged()).toBe(0);
  expect(await readStartupTab()).toBe('world');
});

it('keeps a followed story, which no fact owns', async () => {
  await seedFactWithTopics('I follow racing', ['formula 1']);
  await createTopics([{ text: 'gaza ceasefire', weight: 1, status: 'active', provenance: 'tracked' }]);

  await deleteAllFacts();

  expect((await getActive()).map((t) => t.text)).toEqual(['gaza ceasefire']);
});
