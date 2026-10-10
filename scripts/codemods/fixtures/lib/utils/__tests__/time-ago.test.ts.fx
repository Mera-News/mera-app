import { timeAgo } from '../time-ago';

jest.mock('../helper');

test('x', () => expect(timeAgo).toBeDefined());
