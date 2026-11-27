import { graphql, HttpResponse, type RequestHandler } from 'msw';

// Per-test overrides for one GraphQL operation, by name. Both match a query or a
// mutation. Use with `server.use(...)`. A RegExp matches every document of one request
// (`/^GetArticleIdsForPersona/`: the language document the client sends first and the plain one
// it falls back to).
//
// A transport failure has no helper: `http.post('*/graphql', () => HttpResponse.error())`.

const matches = (want: string | RegExp, name: string | undefined): boolean =>
    typeof want === 'string' ? name === want : !!name && want.test(name);

export function mockGql<TData>(
    operationName: string | RegExp,
    data: TData | ((variables: Record<string, unknown>) => TData | Promise<TData>),
): RequestHandler {
    return graphql.operation(async ({ operationName: name, variables }) => {
        if (!matches(operationName, name)) return undefined;
        // An async responder is awaited, so a test can hold a response open or compute it lazily.
        const body =
            typeof data === 'function'
                ? await (data as (v: Record<string, unknown>) => TData | Promise<TData>)(variables)
                : data;
        return HttpResponse.json({ data: body as Record<string, unknown> });
    });
}

export function mockGqlError(
    operationName: string | RegExp,
    code: string,
    opts: {
        message?: string;
        statusCode?: number;
        httpStatus?: number;
        headers?: Record<string, string>;
    } = {},
): RequestHandler {
    return graphql.operation(({ operationName: name }) => {
        if (!matches(operationName, name)) return undefined;
        return HttpResponse.json(
            {
                errors: [
                    {
                        message: opts.message ?? code,
                        extensions: { code, ...(opts.statusCode ? { statusCode: opts.statusCode } : {}) },
                    },
                ],
            },
            { status: opts.httpStatus ?? 200, headers: opts.headers },
        );
    });
}
