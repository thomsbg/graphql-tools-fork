/* tslint:disable:no-unused-expression */

// The below is meant to be an alternative canonical schema stitching example
// which relies on type merging.

import { expect } from 'chai';
import { graphql } from 'graphql';
import {
  delegateToSchema,
  mergeSchemas,
  addMockFunctionsToSchema,
  makeExecutableSchema,
} from '../index';

const chirpSchema = makeExecutableSchema({
  typeDefs: `
    type Chirp {
      id: ID!
      text: String
      author: User
    }

    type User {
      id: ID!
      chirps: [Chirp]
    }
    type Query {
      userById(id: ID!): User
    }
  `,
});

addMockFunctionsToSchema({ schema: chirpSchema });

const authorSchema = makeExecutableSchema({
  typeDefs: `
    type User {
      id: ID!
      email: String
    }
    type Query {
      userById(id: ID!): User
    }
  `,
});

addMockFunctionsToSchema({ schema: authorSchema });

const mergedSchema = mergeSchemas({
  subschemas: [{
    schema: chirpSchema,
    mergedTypeConfigs: {
      User: {
        selectionSet: '{ id }',
        merge: (originalResult, context, info, subschema, selectionSet) => delegateToSchema({
          schema: subschema,
          operation: 'query',
          fieldName: 'userById',
          args: { id: originalResult.id },
          selectionSet,
          context,
          info,
          skipTypeMerging: true,
        }),
      }
    },
  }, {
    schema: authorSchema,
    mergedTypeConfigs: {
      User: {
        selectionSet: '{ id }',
        merge: (originalResult, context, info, subschema, selectionSet) => delegateToSchema({
          schema: subschema,
          operation: 'query',
          fieldName: 'userById',
          args: { id: originalResult.id },
          selectionSet,
          context,
          info,
          skipTypeMerging: true,
        }),
      }
    },
  }],
});

describe('merging using type merging', () => {
  it('works', async () => {
    const query = `
      query {
        userById(id: 5) {
          chirps {
            id
            textAlias: text
            author {
              email
            }
          }
        }
      }
    `;

    const result = await graphql(mergedSchema, query);

    expect(result.errors).to.be.undefined;
    expect(result.data.userById.chirps[1].id).to.not.be.null;
    expect(result.data.userById.chirps[1].text).to.not.be.null;
    expect(result.data.userById.chirps[1].author.email).to.not.be.null;
  });
});
