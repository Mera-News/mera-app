import { assetHandlers } from './assets';
import { authHandlers } from './auth';
import { createGatewayHandlers } from './gateway/handlers';
import { graphqlHandlers } from './graphql';

export const defaultHandlers = [
  ...authHandlers,
  ...graphqlHandlers,
  ...createGatewayHandlers(),
  ...assetHandlers,
];
