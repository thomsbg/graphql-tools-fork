import { deprecated } from 'deprecated-decorator';
import { GraphQLSchema, GraphQLFieldResolver, isSchema } from 'graphql';

import { IConnectors, IConnector, IConnectorCls } from '../Interfaces';

import addSchemaLevelResolver from './addSchemaLevelResolver';

// takes a GraphQL-JS schema and an object of connectors, then attaches
// the connectors to the context by wrapping each query or mutation resolve
// function with a function that attaches connectors if they don't exist.
// attaches connectors only once to make sure they are singletons
const attachConnectorsToContext = deprecated<Function>(
  {
    version: '0.7.0',
    url: 'https://github.com/apollostack/graphql-tools/issues/140',
  },
  (schema: GraphQLSchema, connectors: IConnectors): void => {
    if (!schema || !isSchema(schema)) {
      throw new Error(
        'schema must be an instance of GraphQLSchema. ' +
          'This error could be caused by installing more than one version of GraphQL-JS',
      );
    }

    if (typeof connectors !== 'object') {
      const connectorType = typeof connectors;
      throw new Error(
        `Expected connectors to be of type object, got ${connectorType}`,
      );
    }
    if (Object.keys(connectors).length === 0) {
      throw new Error('Expected connectors to not be an empty object');
    }
    if (Array.isArray(connectors)) {
      throw new Error('Expected connectors to be of type object, got Array');
    }
    if (schema['_apolloConnectorsAttached']) {
      throw new Error(
        'Connectors already attached to context, cannot attach more than once',
      );
    }
    schema['_apolloConnectorsAttached'] = true;
    const attachconnectorFn: GraphQLFieldResolver<any, any> = (
      root,
      _args,
      ctx,
    ) => {
      if (typeof ctx !== 'object') {
        // if in any way possible, we should throw an error when the attachconnectors
        // function is called, not when a query is executed.
        const contextType = typeof ctx;
        throw new Error(
          `Cannot attach connector because context is not an object: ${contextType}`,
        );
      }
      if (typeof ctx.connectors === 'undefined') {
        ctx.connectors = {};
      }
      Object.keys(connectors).forEach(connectorName => {
        const connector: IConnector = connectors[connectorName];
        if (connector.prototype != null) {
          ctx.connectors[connectorName] = new (connector as IConnectorCls)(ctx);
        } else {
          throw new Error('Connector must be a function or an class');
        }
      });
      return root;
    };
    addSchemaLevelResolver(schema, attachconnectorFn);
  },
);

export default attachConnectorsToContext;
