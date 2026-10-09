import { graphql, HttpResponse, type RequestHandler } from 'msw';

// Per-test overrides for one GraphQL operation, by name. Both match a query or a
// mutation. Use with `server.use(...)`.
//
// A transport failure has no helper: `http.post('*/graphql', () => HttpResponse.error())`.

export function mockGql<TData>(
    operationName: string,
    data: TData | ((variables: Record<string, unknown>) => TData),
): RequestHandler {
    return graphql.operation(({ operationName: name, variables }) => {
        if (name !== operationName) return undefined;
        const body = typeof data === 'function' ? (data as (v: Record<string, unknown>) => TData)(variables) : data;
        return HttpResponse.json({ data: body as Record<string, unknown> });
    });
}

export function mockGqlError(
    operationName: string,
    code: string,
    opts: {
        message?: string;
        statusCode?: number;
        httpStatus?: number;
        headers?: Record<string, string>;
    } = {},
): RequestHandler {
    return graphql.operation(({ operationName: name }) => {
        if (name !== operationName) return undefined;
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
