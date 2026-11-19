// News documents are validated against the public news schema, account and Mera documents against the private app schema.
import fs from 'fs';
import path from 'path';
import {
    ACCOUNT_OPERATION_NAMES,
    HOST_NEWS_OPERATION_NAMES,
    MERA_SERVICE_OPERATION_NAMES,
    NEWS_OPERATION_NAMES,
    NEWS_OPERATIONS_NOT_PUBLIC,
} from '@/lib/graphql/news-operations';
import { ACCOUNT_OPERATIONS } from '@/lib/own-services/news-operations';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const checker = require('../../../../scripts/check-schema') as {
    loadSchemas: () => any;
    loadClientLists: () => any;
    collectDocuments: () => { documents: { rel: string; name: string; doc: string }[]; fileCount: number };
    checkDocuments: (docs: { rel: string; name: string; doc: string }[], schemas: any, lists?: any) => {
        failures: { rel: string; name: string; against: string; messages: string[] }[];
        counts: { public: number; private: number };
    };
};

const ROOT = path.resolve(__dirname, '../../../..');
const schemas = checker.loadSchemas();
const real = checker.collectDocuments();
const doc = (name: string, body: string) => ({ rel: 'fixture.ts', name, doc: body });

describe('check:schema split', () => {
    it('takes the client lists from the client, not from a copy', () => {
        const lists = checker.loadClientLists();
        expect([...lists.news].sort()).toEqual([...NEWS_OPERATION_NAMES].sort());
        expect([...lists.hostNews].sort()).toEqual([...HOST_NEWS_OPERATION_NAMES].sort());
        expect([...lists.account].sort()).toEqual([...ACCOUNT_OPERATION_NAMES].sort());
        expect([...lists.service].sort()).toEqual([...MERA_SERVICE_OPERATION_NAMES].sort());
        expect([...lists.notPublic].sort()).toEqual(Object.keys(NEWS_OPERATIONS_NOT_PUBLIC).sort());
        const appAccount = [...ACCOUNT_OPERATIONS].filter((n) => !ACCOUNT_OPERATION_NAMES.includes(n));
        expect([...lists.appAccount].sort()).toEqual(appAccount.sort());
    });

    it('fails a news document that uses a field only the private schema has, naming the operation and the schema', () => {
        const { failures } = checker.checkDocuments([doc('AllCountries', 'query AllCountries { allCountries appConfig { __typename } }')], schemas);
        expect(failures).toHaveLength(1);
        expect(failures[0].name).toBe('AllCountries');
        expect(failures[0].against).toMatch(/news-schema/);
    });

    it('fails an account document that uses a field the private schema lacks', () => {
        const { failures } = checker.checkDocuments([doc('GetUserPersona', 'query GetUserPersona { appConfig { notAField } }')], schemas);
        expect(failures).toHaveLength(1);
        expect(failures[0].name).toBe('GetUserPersona');
        expect(failures[0].against).toMatch(/schema\.gql/);
        expect(failures[0].against).not.toMatch(/news-schema/);
    });

    it('fails a mutation sent to the public schema, which has no mutation root', () => {
        const { failures } = checker.checkDocuments([doc('AllCountries', 'mutation AllCountries { __typename }')], schemas);
        expect(failures).toHaveLength(1);
        expect(failures[0].messages.join(' ')).toMatch(/mutation/i);
    });

    it('passes the client news server status document, which only the public schema has', () => {
        const status = real.documents.filter((d) => d.name === 'NewsServerStatus');
        expect(status).toHaveLength(1);
        expect(checker.checkDocuments(status, schemas).failures).toEqual([]);
    });

    it('checks a news document the public server does not answer against the private schema', () => {
        const held = real.documents.filter((d) => d.name in NEWS_OPERATIONS_NOT_PUBLIC);
        expect(held.map((d) => d.name).sort()).toEqual(Object.keys(NEWS_OPERATIONS_NOT_PUBLIC).sort());
        const { failures, counts } = checker.checkDocuments(held, schemas);
        expect(failures).toEqual([]);
        expect(counts).toEqual({ public: 0, private: held.length });
    });

    it('fails an exception that starts to validate against the public schema', () => {
        const lists = { ...checker.loadClientLists(), notPublic: new Set(['AllCountries']) };
        const { failures } = checker.checkDocuments([doc('AllCountries', 'query AllCountries { allCountries }')], schemas, lists);
        expect(failures).toHaveLength(1);
        expect(failures[0].messages.join(' ')).toMatch(/validates against the public/);
    });

    it('fails an operation that is in no list, naming it', () => {
        const { failures } = checker.checkDocuments([doc('SomethingNew', 'query SomethingNew { allCountries }')], schemas);
        expect(failures).toHaveLength(1);
        expect(failures[0].name).toBe('SomethingNew');
        expect(failures[0].messages.join(' ')).toMatch(/not classified/);
    });

    it('passes every real document, each checked against exactly one schema, and drops none', () => {
        const { failures, counts } = checker.checkDocuments(real.documents, schemas);
        expect(failures).toEqual([]);
        expect(counts.public + counts.private).toBe(real.documents.length);
        // A floor so a scanner that silently drops documents goes red. Raise it when documents are added.
        if (real.documents.length < 56) {
            throw new Error(
                `check:schema found ${real.documents.length} documents, under the floor of 56: the scanner may be dropping some. ` +
                    'Raise this floor when documents are added.',
            );
        }
    });

    it('keeps the own-server reachability probe valid against the public schema', () => {
        const source = fs.readFileSync(path.join(ROOT, 'lib/own-services/check-news.ts'), 'utf8');
        const probe = /const PERSONA = `([\s\S]*?)`/.exec(source)?.[1];
        expect(probe).toBeTruthy();
        const name = /query\s+(\w+)/.exec(probe as string)?.[1] as string;
        expect(NEWS_OPERATION_NAMES).toContain(name);
        const { failures, counts } = checker.checkDocuments([doc(name, probe as string)], schemas);
        expect(failures).toEqual([]);
        expect(counts.public).toBe(1);
    });
});
