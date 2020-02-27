import { expect } from 'chai';
import { GraphQLObjectType, GraphQLObjectTypeConfig } from 'graphql';

import { healSchema } from '../utils';
import { makeExecutableSchema } from '../makeExecutableSchema';

describe('heal', () => {
  it('should prune empty types', () => {
    const schema = makeExecutableSchema({
      typeDefs: `
      type WillBeEmptyObject {
        willBeRemoved: String
      }

      type Query {
        someQuery: WillBeEmptyObject
      }
      `
    });
    const originalTypeMap = schema.getTypeMap();

    const config = originalTypeMap['WillBeEmptyObject'].toConfig() as GraphQLObjectTypeConfig<any, any>;
    originalTypeMap['WillBeEmptyObject'] = new GraphQLObjectType({
      ...config,
      fields: {},
    });

    healSchema(schema);

    const healedTypeMap = schema.getTypeMap();
    expect(healedTypeMap).not.to.haveOwnProperty('WillBeEmptyObject');
  });
});
