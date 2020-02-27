import {
  graphql,
  GraphQLSchema,
  ExecutionResult,
  subscribe,
  parse,
  GraphQLScalarType,
  FieldNode,
  printSchema,
  GraphQLObjectTypeConfig,
  GraphQLFieldConfig,
  GraphQLObjectType,
} from 'graphql';
import { forAwaitEach } from 'iterall';
import { expect } from 'chai';

import {
  transformSchema,
  filterSchema,
  RenameTypes,
  RenameRootFields,
  RenameObjectFields,
  TransformObjectFields,
  ExtendSchema,
  WrapType,
  WrapFields,
  HoistField,
  FilterRootFields,
  FilterObjectFields,
} from '../transforms';

import { makeExecutableSchema } from '../makeExecutableSchema';
import {
  delegateToSchema,
  mergeSchemas,
  createMergedResolver,
} from '../stitching';
import { SubschemaConfig } from '../Interfaces';
import isSpecifiedScalarType from '../utils/isSpecifiedScalarType';
import { wrapFieldNode, renameFieldNode, hoistFieldNodes } from '../utils';

import {
  propertySchema,
  remoteBookingSchema,
  subscriptionSchema,
  subscriptionPubSub,
  subscriptionPubSubTrigger,
} from './testingSchemas';

const linkSchema = `
  """
  A new type linking the Property type.
  """
  type LinkType {
    test: String
    """
    The property.
    """
    property: Properties_Property
  }

  interface Node {
    id: ID!
  }

  extend type Bookings_Booking implements Node {
    """
    The property of the booking.
    """
    property: Properties_Property
  }

  extend type Properties_Property implements Node {
    """
    A list of bookings.
    """
    bookings(
      """
      The maximum number of bookings to retrieve.
      """
      limit: Int
    ): [Bookings_Booking]
  }

  extend type Query {
    linkTest: LinkType
    node(id: ID!): Node
    nodes: [Node]
  }

  extend type Bookings_Customer implements Node
`;

describe('merge schemas through transforms', () => {
  let bookingSubschemaConfig: SubschemaConfig;
  let mergedSchema: GraphQLSchema;

  before(async () => {
    bookingSubschemaConfig = await remoteBookingSchema;

    // namespace and strip schemas
    const propertySchemaTransforms = [
      new FilterRootFields(
        (operation: string, rootField: string) =>
          `${operation}.${rootField}` === 'Query.properties',
      ),
      new RenameTypes((name: string) => `Properties_${name}`),
      new RenameRootFields(
        (_operation: string, name: string) => `Properties_${name}`,
      ),
    ];
    const bookingSchemaTransforms = [
      new FilterRootFields(
        (operation: string, rootField: string) =>
          `${operation}.${rootField}` === 'Query.bookings',
      ),
      new RenameTypes((name: string) => `Bookings_${name}`),
      new RenameRootFields(
        (_operation: string, name: string) => `Bookings_${name}`,
      ),
    ];
    const subscriptionSchemaTransforms = [
      new FilterRootFields(
        (operation: string, rootField: string) =>
          // must include a Query type otherwise graphql will error
          `${operation}.${rootField}` === 'Query.notifications' ||
          `${operation}.${rootField}` === 'Subscription.notifications',
      ),
      new RenameTypes((name: string) => `Subscriptions_${name}`),
      new RenameRootFields(
        (_operation: string, name: string) => `Subscriptions_${name}`,
      ),
    ];

    const propertySubschema = {
      schema: propertySchema,
      transforms: propertySchemaTransforms,
    };
    const bookingSubschema = {
      ...bookingSubschemaConfig,
      transforms: bookingSchemaTransforms,
    };
    const subscriptionSubschema = {
      schema: subscriptionSchema,
      transforms: subscriptionSchemaTransforms,
    };

    mergedSchema = mergeSchemas({
      subschemas: [propertySubschema, bookingSubschema, subscriptionSubschema],
      typeDefs: linkSchema,
      resolvers: {
        Query: {
          // delegating directly, no subschemas or mergeInfo
          node: (_parent, args, context, info) => {
            if (args.id.startsWith('p')) {
              return info.mergeInfo.delegateToSchema({
                schema: propertySubschema,
                operation: 'query',
                fieldName: 'propertyById',
                args,
                context,
                info,
                transforms: [],
              });
            } else if (args.id.startsWith('b')) {
              return delegateToSchema({
                schema: bookingSubschema,
                operation: 'query',
                fieldName: 'bookingById',
                args,
                context,
                info,
                transforms: [],
              });
            } else if (args.id.startsWith('c')) {
              return delegateToSchema({
                schema: bookingSubschema,
                operation: 'query',
                fieldName: 'customerById',
                args,
                context,
                info,
                transforms: [],
              });
            }
            throw new Error('invalid id');
          },
        },
        // eslint-disable-next-line camelcase
        Properties_Property: {
          bookings: {
            fragment: 'fragment PropertyFragment on Property { id }',
            resolve: (parent, args, context, info) =>
              delegateToSchema({
                schema: bookingSubschema,
                operation: 'query',
                fieldName: 'bookingsByPropertyId',
                args: {
                  propertyId: parent.id,
                  limit: args.limit ? args.limit : null,
                },
                context,
                info,
              }),
          },
        },
        // eslint-disable-next-line camelcase
        Bookings_Booking: {
          property: {
            fragment: 'fragment BookingFragment on Booking { propertyId }',
            resolve: (parent, _args, context, info) =>
              info.mergeInfo.delegateToSchema({
                schema: propertySubschema,
                operation: 'query',
                fieldName: 'propertyById',
                args: {
                  id: parent.propertyId,
                },
                context,
                info,
              }),
          },
        },
      },
    });
  });

  // FIXME fragemnt replacements
  it('node should work', async () => {
    const result = await graphql(
      mergedSchema,
      `
        query($pid: ID!, $bid: ID!) {
          property: node(id: $pid) {
            __typename
            ... on Properties_Property {
              name
              bookings {
                startTime
                endTime
              }
            }
          }
          booking: node(id: $bid) {
            __typename
            ... on Bookings_Booking {
              startTime
              endTime
              property {
                id
                name
              }
            }
          }
        }
      `,
      {},
      {},
      {
        pid: 'p1',
        bid: 'b1',
      },
    );

    expect(result).to.deep.equal({
      data: {
        booking: {
          __typename: 'Bookings_Booking',
          endTime: '2016-06-03',
          property: {
            id: 'p1',
            name: 'Super great hotel',
          },
          startTime: '2016-05-04',
        },
        property: {
          __typename: 'Properties_Property',
          bookings: [
            {
              endTime: '2016-06-03',
              startTime: '2016-05-04',
            },
            {
              endTime: '2016-07-03',
              startTime: '2016-06-04',
            },
            {
              endTime: '2016-09-03',
              startTime: '2016-08-04',
            },
          ],
          name: 'Super great hotel',
        },
      },
    });
  });

  it('local subscriptions should work even if root fields are renamed', done => {
    const originalNotification = {
      notifications: {
        text: 'Hello world',
      },
    };

    const transformedNotification = {
      // eslint-disable-next-line camelcase
      Subscriptions_notifications: originalNotification.notifications,
    };

    const subscription = parse(`
      subscription Subscription {
        Subscriptions_notifications {
          text
        }
      }
    `);

    let notificationCnt = 0;
    subscribe(mergedSchema, subscription)
      .then(results => {
        forAwaitEach(
          results as AsyncIterable<ExecutionResult>,
          (result: ExecutionResult) => {
            expect(result).to.have.property('data');
            expect(result.data).to.deep.equal(transformedNotification);
            if (!notificationCnt++) {
              return done();
            }
          },
        ).catch(done);
      })
      .then(() =>
        subscriptionPubSub.publish(
          subscriptionPubSubTrigger,
          originalNotification,
        ),
      )
      .catch(done);
  });
});

describe('transform object fields', () => {
  let transformedPropertySchema: GraphQLSchema;

  before(() => {
    transformedPropertySchema = transformSchema(propertySchema, [
      new TransformObjectFields(
        (typeName: string, fieldName: string) => {
          if (typeName !== 'Property' || fieldName !== 'name') {
            return undefined;
          }
          const type = propertySchema.getType(typeName) as GraphQLObjectType;
          const typeConfig = type.toConfig() as GraphQLObjectTypeConfig<
            any,
            any
          >;
          const fieldConfig = typeConfig.fields[
            fieldName
          ] as GraphQLFieldConfig<any, any>;
          fieldConfig.resolve = () => 'test';
          return fieldConfig;
        },
        (typeName: string, fieldName: string, fieldNode: FieldNode) => {
          if (typeName !== 'Property' || fieldName !== 'name') {
            return fieldNode;
          }
          const newFieldNode = {
            ...fieldNode,
            name: {
              ...fieldNode.name,
              value: 'id',
            },
          };
          return newFieldNode;
        },
      ),
    ]);
  });

  it('should work', async () => {
    const result = await graphql(
      transformedPropertySchema,
      `
        query($pid: ID!) {
          propertyById(id: $pid) {
            id
            name
            location {
              name
            }
          }
        }
      `,
      {},
      {},
      {
        pid: 'p1',
      },
    );

    expect(result).to.deep.equal({
      data: {
        propertyById: {
          id: 'p1',
          name: 'test',
          location: {
            name: 'Helsinki',
          },
        },
      },
    });
  });
});

describe('transform object fields', () => {
  let schema: GraphQLSchema;

  before(() => {
    const ITEM = {
      id: '123',
      // eslint-disable-next-line camelcase
      camel_case: "I'm a camel!",
    };

    const itemSchema = makeExecutableSchema({
      typeDefs: `
        type Item {
          id: ID!
          camel_case: String
        }
        type ItemConnection {
          edges: [ItemEdge!]!
        }
        type ItemEdge {
          node: Item!
        }
        type Query {
          item: Item
          allItems: ItemConnection!
        }
      `,
      resolvers: {
        Query: {
          item: () => ITEM,
          allItems: () => ({
            edges: [
              {
                node: ITEM,
              },
            ],
          }),
        },
      },
    });

    schema = transformSchema(itemSchema, [
      new FilterObjectFields((_typeName, fieldName) => {
        if (fieldName === 'id') {
          return false;
        }
        return true;
      }),
      new RenameRootFields((_operation, fieldName) => {
        if (fieldName === 'allItems') {
          return 'items';
        }
        return fieldName;
      }),
      new RenameObjectFields((_typeName, fieldName) => {
        if (fieldName === 'camel_case') {
          return 'camelCase';
        }
        return fieldName;
      }),
    ]);
  });

  it('renaming should work', async () => {
    const result = await graphql(
      schema,
      `
        query {
          item {
            camelCase
          }
          items {
            edges {
              node {
                camelCase
              }
            }
          }
        }
      `,
    );

    const TRANSFORMED_ITEM = {
      camelCase: "I'm a camel!",
    };

    expect(result).to.deep.equal({
      data: {
        item: TRANSFORMED_ITEM,
        items: {
          edges: [
            {
              node: TRANSFORMED_ITEM,
            },
          ],
        },
      },
    });
  });

  it('filtering should work', async () => {
    const result = await graphql(
      schema,
      `
        query {
          items {
            edges {
              node {
                id
              }
            }
          }
        }
      `,
    );

    expect(result).to.deep.equal({
      errors: [
        {
          locations: [
            {
              column: 17,
              line: 6,
            },
          ],
          message: 'Cannot query field "id" on type "Item".',
        },
      ],
    });
  });
});

describe('filter and rename object fields', () => {
  let transformedPropertySchema: GraphQLSchema;

  before(() => {
    transformedPropertySchema = filterSchema({
      schema: transformSchema(propertySchema, [
        new RenameTypes((name: string) => `New_${name}`),
        new RenameObjectFields((typeName: string, fieldName: string) =>
          typeName === 'New_Property' ? `new_${fieldName}` : fieldName,
        ),
      ]),
      rootFieldFilter: (operation: string, fieldName: string) =>
        `${operation}.${fieldName}` === 'Query.propertyById',
      fieldFilter: (typeName: string, fieldName: string) =>
        typeName === 'New_Property' || fieldName === 'name',
      typeFilter: (typeName: string, type) =>
        typeName === 'New_Property' ||
        typeName === 'New_Location' ||
        isSpecifiedScalarType(type),
    });
  });

  it('should filter', () => {
    expect(printSchema(transformedPropertySchema)).to.equal(`type New_Location {
  name: String!
}

type New_Property {
  new_id: ID!
  new_name: String!
  new_location: New_Location
  new_error: String
}

type Query {
  propertyById(id: ID!): New_Property
}
`);
  });

  it('should work', async () => {
    const result = await graphql(
      transformedPropertySchema,
      `
        query($pid: ID!) {
          propertyById(id: $pid) {
            new_id
            new_name
            new_location {
              name
            }
            new_error
          }
        }
      `,
      {},
      {},
      {
        pid: 'p1',
      },
    );

    expect(result).to.deep.equal({
      data: {
        propertyById: {
          // eslint-disable-next-line camelcase
          new_id: 'p1',
          // eslint-disable-next-line camelcase
          new_name: 'Super great hotel',
          // eslint-disable-next-line camelcase
          new_location: {
            name: 'Helsinki',
          },
          // eslint-disable-next-line camelcase
          new_error: null,
        },
      },
      errors: [
        {
          extensions: {
            code: 'SOME_CUSTOM_CODE',
          },
          locations: [
            {
              column: 13,
              line: 9,
            },
          ],
          message: 'Property.error error',
          path: ['propertyById', 'new_error'],
        },
      ],
    });
  });
});

describe('WrapType transform', () => {
  let transformedPropertySchema: GraphQLSchema;

  before(() => {
    transformedPropertySchema = transformSchema(propertySchema, [
      new WrapType('Query', 'Namespace_Query', 'namespace'),
    ]);
  });

  it('should modify the schema', () => {
    expect(printSchema(transformedPropertySchema)).to.equal(`type Address {
  street: String
  city: String
  state: String
  zip: String
}

"""Simple fake datetime"""
scalar DateTime

input InputWithDefault {
  test: String = "Foo"
}

"""
The \`JSON\` scalar type represents JSON values as specified by [ECMA-404](http://www.ecma-international.org/publications/files/ECMA-ST/ECMA-404.pdf).
"""
scalar JSON

type Location {
  name: String!
}

type Namespace_Query {
  propertyById(id: ID!): Property
  properties(limit: Int): [Property!]
  contextTest(key: String!): String
  dateTimeTest: DateTime
  jsonTest(input: JSON): JSON
  interfaceTest(kind: TestInterfaceKind): TestInterface
  unionTest(output: String): TestUnion
  errorTest: String
  errorTestNonNull: String!
  relay: Query!
  defaultInputTest(input: InputWithDefault!): String
}

type Property {
  id: ID!
  name: String!
  location: Location
  address: Address
  error: String
}

type Query {
  namespace: Namespace_Query
}

type TestImpl1 implements TestInterface {
  kind: TestInterfaceKind
  testString: String
  foo: String
}

type TestImpl2 implements TestInterface {
  kind: TestInterfaceKind
  testString: String
  bar: String
}

interface TestInterface {
  kind: TestInterfaceKind
  testString: String
}

enum TestInterfaceKind {
  ONE
  TWO
}

union TestUnion = TestImpl1 | UnionImpl

type UnionImpl {
  someField: String
}
`);
  });

  it('should work', async () => {
    const result = await graphql(
      transformedPropertySchema,
      `
        query($pid: ID!) {
          namespace {
            propertyById(id: $pid) {
              id
              name
              error
            }
          }
        }
      `,
      undefined,
      undefined,
      {
        pid: 'p1',
      },
    );

    expect(result).to.deep.equal({
      data: {
        namespace: {
          propertyById: {
            id: 'p1',
            name: 'Super great hotel',
            error: null,
          },
        },
      },
      errors: [
        {
          extensions: {
            code: 'SOME_CUSTOM_CODE',
          },
          locations: [
            {
              column: 15,
              line: 7,
            },
          ],
          message: 'Property.error error',
          path: ['namespace', 'propertyById', 'error'],
        },
      ],
    });
  });
});

describe('ExtendSchema transform', () => {
  let transformedPropertySchema: GraphQLSchema;

  before(() => {
    transformedPropertySchema = transformSchema(propertySchema, [
      new ExtendSchema({
        typeDefs: `
          extend type Property {
            locationName: String
            wrap: Wrap
          }

          type Wrap {
            id: ID
            name: String
          }
        `,
      }),
    ]);
  });

  it('should work', () => {
    expect(printSchema(transformedPropertySchema)).to.equal(`type Address {
  street: String
  city: String
  state: String
  zip: String
}

"""Simple fake datetime"""
scalar DateTime

input InputWithDefault {
  test: String = "Foo"
}

"""
The \`JSON\` scalar type represents JSON values as specified by [ECMA-404](http://www.ecma-international.org/publications/files/ECMA-ST/ECMA-404.pdf).
"""
scalar JSON

type Location {
  name: String!
}

type Property {
  id: ID!
  name: String!
  location: Location
  address: Address
  error: String
  locationName: String
  wrap: Wrap
}

type Query {
  propertyById(id: ID!): Property
  properties(limit: Int): [Property!]
  contextTest(key: String!): String
  dateTimeTest: DateTime
  jsonTest(input: JSON): JSON
  interfaceTest(kind: TestInterfaceKind): TestInterface
  unionTest(output: String): TestUnion
  errorTest: String
  errorTestNonNull: String!
  relay: Query!
  defaultInputTest(input: InputWithDefault!): String
}

type TestImpl1 implements TestInterface {
  kind: TestInterfaceKind
  testString: String
  foo: String
}

type TestImpl2 implements TestInterface {
  kind: TestInterfaceKind
  testString: String
  bar: String
}

interface TestInterface {
  kind: TestInterfaceKind
  testString: String
}

enum TestInterfaceKind {
  ONE
  TWO
}

union TestUnion = TestImpl1 | UnionImpl

type UnionImpl {
  someField: String
}

type Wrap {
  id: ID
  name: String
}
`);
  });
});

describe('schema transformation with extraction of nested fields', () => {
  it('should work via ExtendSchema transform', async () => {
    const transformedPropertySchema = transformSchema(propertySchema, [
      new ExtendSchema({
        typeDefs: `
          extend type Property {
            locationName: String
            renamedError: String
          }
        `,
        resolvers: {
          Property: {
            locationName: createMergedResolver({ fromPath: ['location'] }),
          },
        },
        fieldNodeTransformerMap: {
          Property: {
            locationName: fieldNode =>
              wrapFieldNode(renameFieldNode(fieldNode, 'name'), ['location']),
            renamedError: fieldNode => renameFieldNode(fieldNode, 'error'),
          },
        },
      }),
    ]);

    const result = await graphql(
      transformedPropertySchema,
      `
        query($pid: ID!) {
          propertyById(id: $pid) {
            id
            name
            test: locationName
            renamedError
          }
        }
      `,
      {},
      {},
      {
        pid: 'p1',
      },
    );

    expect(result).to.deep.equal({
      data: {
        propertyById: {
          id: 'p1',
          name: 'Super great hotel',
          test: 'Helsinki',
          renamedError: null,
        },
      },
      errors: [
        {
          extensions: {
            code: 'SOME_CUSTOM_CODE',
          },
          locations: [
            {
              column: 13,
              line: 7,
            },
          ],
          message: 'Property.error error',
          path: ['propertyById', 'renamedError'],
        },
      ],
    });
  });

  it('should work via HoistField transform', async () => {
    const transformedPropertySchema = transformSchema(propertySchema, [
      new HoistField('Property', ['location', 'name'], 'locationName'),
    ]);

    const result = await graphql(
      transformedPropertySchema,
      `
        query($pid: ID!) {
          propertyById(id: $pid) {
            test: locationName
          }
        }
      `,
      {},
      {},
      {
        pid: 'p1',
      },
    );

    expect(result).to.deep.equal({
      data: {
        propertyById: {
          test: 'Helsinki',
        },
      },
    });
  });
});

describe('schema transformation with wrapping of object fields', () => {
  it('should work via ExtendSchema transform', async () => {
    const transformedPropertySchema = transformSchema(propertySchema, [
      new ExtendSchema({
        typeDefs: `
          extend type Property {
            outerWrap: OuterWrap
          }

          type OuterWrap {
            innerWrap: InnerWrap
          }

          type InnerWrap {
            id: ID
            name: String
            error: String
          }
        `,
        resolvers: {
          Property: {
            outerWrap: createMergedResolver({ dehoist: true }),
          },
        },
        fieldNodeTransformerMap: {
          Property: {
            outerWrap: (fieldNode, fragments) =>
              hoistFieldNodes({
                fieldNode,
                fieldNames: ['id', 'name', 'error'],
                path: ['innerWrap'],
                fragments,
              }),
          },
        },
      }),
    ]);

    const result = await graphql(
      transformedPropertySchema,
      `
        query($pid: ID!) {
          propertyById(id: $pid) {
            test1: outerWrap {
              innerWrap {
                ...W1
              }
            }
            test2: outerWrap {
              innerWrap {
                ...W2
              }
            }
          }
        }
        fragment W1 on InnerWrap {
          one: id
          two: error
        }
        fragment W2 on InnerWrap {
          one: name
        }
      `,
      {},
      {},
      {
        pid: 'p1',
      },
    );

    expect(result).to.deep.equal({
      data: {
        propertyById: {
          test1: {
            innerWrap: {
              one: 'p1',
              two: null,
            },
          },
          test2: {
            innerWrap: {
              one: 'Super great hotel',
            },
          },
        },
      },
      errors: [
        {
          extensions: {
            code: 'SOME_CUSTOM_CODE',
          },
          locations: [
            {
              column: 11,
              line: 18,
            },
          ],
          message: 'Property.error error',
          path: ['propertyById', 'test1', 'innerWrap', 'two'],
        },
      ],
    });
  });

  describe('WrapFields transform', () => {
    it('should work', async () => {
      const transformedPropertySchema = transformSchema(propertySchema, [
        new WrapFields(
          'Property',
          ['outerWrap'],
          ['OuterWrap'],
          ['id', 'name', 'error'],
        ),
      ]);

      const result = await graphql(
        transformedPropertySchema,
        `
          query($pid: ID!) {
            propertyById(id: $pid) {
              test1: outerWrap {
                ...W1
              }
              test2: outerWrap {
                ...W2
              }
            }
          }
          fragment W1 on OuterWrap {
            one: id
            two: error
          }
          fragment W2 on OuterWrap {
            one: name
          }
        `,
        {},
        {},
        {
          pid: 'p1',
        },
      );

      expect(result).to.deep.equal({
        data: {
          propertyById: {
            test1: {
              one: 'p1',
              two: null,
            },
            test2: {
              one: 'Super great hotel',
            },
          },
        },
        errors: [
          {
            extensions: {
              code: 'SOME_CUSTOM_CODE',
            },
            locations: [
              {
                column: 13,
                line: 14,
              },
            ],
            message: 'Property.error error',
            path: ['propertyById', 'test1', 'two'],
          },
        ],
      });
    });

    it('should work, even with multiple fields', async () => {
      const transformedPropertySchema = transformSchema(propertySchema, [
        new WrapFields(
          'Property',
          ['outerWrap', 'innerWrap'],
          ['OuterWrap', 'InnerWrap'],
          ['id', 'name', 'error'],
        ),
      ]);

      const result = await graphql(
        transformedPropertySchema,
        `
          query($pid: ID!) {
            propertyById(id: $pid) {
              test1: outerWrap {
                innerWrap {
                  ...W1
                }
              }
              test2: outerWrap {
                innerWrap {
                  ...W2
                }
              }
            }
          }
          fragment W1 on InnerWrap {
            one: id
            two: error
          }
          fragment W2 on InnerWrap {
            one: name
          }
        `,
        {},
        {},
        {
          pid: 'p1',
        },
      );

      expect(result).to.deep.equal({
        data: {
          propertyById: {
            test1: {
              innerWrap: {
                one: 'p1',
                two: null,
              },
            },
            test2: {
              innerWrap: {
                one: 'Super great hotel',
              },
            },
          },
        },
        errors: [
          {
            extensions: {
              code: 'SOME_CUSTOM_CODE',
            },
            locations: [
              {
                column: 13,
                line: 18,
              },
            ],
            message: 'Property.error error',
            path: ['propertyById', 'test1', 'innerWrap', 'two'],
          },
        ],
      });
    });
  });
});

describe('schema transformation with renaming of object fields', () => {
  let transformedPropertySchema: GraphQLSchema;

  before(() => {
    transformedPropertySchema = transformSchema(propertySchema, [
      new ExtendSchema({
        typeDefs: `
          extend type Property {
            new_error: String
          }
        `,
        fieldNodeTransformerMap: {
          Property: {
            // eslint-disable-next-line camelcase
            new_error: fieldNode => renameFieldNode(fieldNode, 'error'),
          },
        },
      }),
    ]);
  });

  it('should work, even with aliases, and should preserve errors', async () => {
    const result = await graphql(
      transformedPropertySchema,
      `
        query($pid: ID!) {
          propertyById(id: $pid) {
            new_error
          }
        }
      `,
      {},
      {},
      {
        pid: 'p1',
      },
    );

    expect(result).to.deep.equal({
      data: {
        propertyById: {
          // eslint-disable-next-line camelcase
          new_error: null,
        },
      },
      errors: [
        {
          extensions: {
            code: 'SOME_CUSTOM_CODE',
          },
          locations: [
            {
              column: 13,
              line: 4,
            },
          ],
          message: 'Property.error error',
          path: ['propertyById', 'new_error'],
        },
      ],
    });
  });
});

describe('interface resolver inheritance', () => {
  const testSchemaWithInterfaceResolvers = `
    interface Node {
      id: ID!
    }
    type User implements Node {
      id: ID!
      name: String!
    }
    type Query {
      user: User!
    }
    schema {
      query: Query
    }
  `;
  const user = { _id: 1, name: 'Ada', type: 'User' };
  const resolvers = {
    Node: {
      __resolveType: ({ type }: { type: string }) => type,
      id: ({ _id }: { _id: number }) => `Node:${_id.toString()}`,
    },
    User: {
      name: ({ name }: { name: string }) => `User:${name}`,
    },
    Query: {
      user: () => user,
    },
  };

  it('copies resolvers from interface', async () => {
    const mergedSchema = mergeSchemas({
      schemas: [
        // pull in an executable schema just so mergeSchema doesn't complain
        // about not finding default types (e.g. ID)
        propertySchema,
        testSchemaWithInterfaceResolvers,
      ],
      resolvers,
      inheritResolversFromInterfaces: true,
    });
    const query = '{ user { id name } }';
    const response = await graphql(mergedSchema, query);
    expect(response).to.deep.equal({
      data: {
        user: {
          id: 'Node:1',
          name: 'User:Ada',
        },
      },
    });
  });

  it('does not copy resolvers from interface when flag is false', async () => {
    const mergedSchema = mergeSchemas({
      schemas: [
        // pull in an executable schema just so mergeSchema doesn't complain
        // about not finding default types (e.g. ID)
        propertySchema,
        testSchemaWithInterfaceResolvers,
      ],
      resolvers,
      inheritResolversFromInterfaces: false,
    });
    const query = '{ user { id name } }';
    const response = await graphql(mergedSchema, query);
    expect(response.errors.length).to.equal(1);
    expect(response.errors[0].message).to.equal(
      'Cannot return null for non-nullable field User.id.',
    );
    expect(response.errors[0].path).to.deep.equal(['user', 'id']);
  });

  it('does not copy resolvers from interface when flag is not provided', async () => {
    const mergedSchema = mergeSchemas({
      schemas: [
        // pull in an executable schema just so mergeSchema doesn't complain
        // about not finding default types (e.g. ID)
        propertySchema,
        testSchemaWithInterfaceResolvers,
      ],
      resolvers,
    });
    const query = '{ user { id name } }';
    const response = await graphql(mergedSchema, query);
    expect(response.errors.length).to.equal(1);
    expect(response.errors[0].message).to.equal(
      'Cannot return null for non-nullable field User.id.',
    );
    expect(response.errors[0].path).to.deep.equal(['user', 'id']);
  });
});

describe('mergeSchemas', () => {
  it('can merge null root fields', async () => {
    const schema = makeExecutableSchema({
      typeDefs: `
        type Query {
          test: Test
        }
        type Test {
          field: String
        }
      `,
      resolvers: {
        Query: {
          test: () => null,
        },
      },
    });
    const mergedSchema = mergeSchemas({
      schemas: [schema],
    });

    const query = '{ test { field } }';
    const response = await graphql(mergedSchema, query);
    expect(response.data.test).to.equal(null);
    expect(response.errors).to.equal(undefined);
  });

  it('can merge default input types', async () => {
    const schema = makeExecutableSchema({
      typeDefs: `
        input InputWithDefault {
          field: String = "test"
        }
        type Query {
          getInput(input: InputWithDefault!): String
        }
      `,
      resolvers: {
        Query: {
          getInput: (_root, args) => args.input.field,
        },
      },
    });
    const mergedSchema = mergeSchemas({
      schemas: [schema],
    });

    const query = '{ getInput(input: {}) }';
    const response = await graphql(mergedSchema, query);

    expect(printSchema(schema)).to.equal(printSchema(mergedSchema));
    expect(response.data?.getInput).to.equal('test');
  });

  it('can override scalars with new internal values', async () => {
    const schema = makeExecutableSchema({
      typeDefs: `
        scalar TestScalar
        type Query {
          getTestScalar: TestScalar
        }
      `,
      resolvers: {
        TestScalar: new GraphQLScalarType({
          name: 'TestScalar',
          description: undefined,
          serialize: value => (value as string).slice(1),
          parseValue: value => `_${value as string}`,
          parseLiteral: (ast: any) => `_${ast.value as string}`,
        }),
        Query: {
          getTestScalar: () => '_test',
        },
      },
    });
    const mergedSchema = mergeSchemas({
      schemas: [schema],
      resolvers: {
        TestScalar: new GraphQLScalarType({
          name: 'TestScalar',
          description: undefined,
          serialize: value => (value as string).slice(2),
          parseValue: value => `__${value as string}`,
          parseLiteral: (ast: any) => `__${ast.value as string}`,
        }),
      },
    });

    const query = '{ getTestScalar }';
    const response = await graphql(mergedSchema, query);

    expect(response.data?.getTestScalar).to.equal('test');
  });

  it('can override scalars with new internal values when using default input types', async () => {
    const schema = makeExecutableSchema({
      typeDefs: `
        scalar TestScalar
        type Query {
          getTestScalar(input: TestScalar = "test"): TestScalar
        }
      `,
      resolvers: {
        TestScalar: new GraphQLScalarType({
          name: 'TestScalar',
          description: undefined,
          serialize: value => (value as string).slice(1),
          parseValue: value => `_${value as string}`,
          parseLiteral: (ast: any) => `_${ast.value as string}`,
        }),
        Query: {
          getTestScalar: () => '_test',
        },
      },
    });
    const mergedSchema = mergeSchemas({
      schemas: [schema],
      resolvers: {
        TestScalar: new GraphQLScalarType({
          name: 'TestScalar',
          description: undefined,
          serialize: value => (value as string).slice(2),
          parseValue: value => `__${value as string}`,
          parseLiteral: (ast: any) => `__${ast.value as string}`,
        }),
      },
    });

    const query = '{ getTestScalar }';
    const response = await graphql(mergedSchema, query);

    expect(response.data?.getTestScalar).to.equal('test');
  });

  it('can use @include directives', async () => {
    const schema = makeExecutableSchema({
      typeDefs: `
        type WrappingType {
          subfield: String
        }
        type Query {
          get1: WrappingType
        }
      `,
      resolvers: {
        Query: {
          get1: () => ({ subfield: 'test' }),
        },
      },
    });
    const mergedSchema = mergeSchemas({
      schemas: [
        schema,
        `
          type Query {
            get2: WrappingType
          }
        `,
      ],
      resolvers: {
        Query: {
          get2: (_root, _args, context, info) =>
            delegateToSchema({
              schema,
              operation: 'query',
              fieldName: 'get1',
              context,
              info,
            }),
        },
      },
    });

    const query = `
      {
        get2 @include(if: true) {
          subfield
        }
      }
    `;
    const response = await graphql(mergedSchema, query);
    expect(response.data?.get2.subfield).to.equal('test');
  });

  it('can use functions in subfields', async () => {
    const schema = makeExecutableSchema({
      typeDefs: `
        type WrappingObject {
          functionField: Int!
        }
        type Query {
          wrappingObject: WrappingObject
        }
      `,
    });

    const mergedSchema = mergeSchemas({
      schemas: [schema],
      resolvers: {
        Query: {
          wrappingObject: () => ({
            functionField: () => 8,
          }),
        },
      },
    });

    const query = '{ wrappingObject { functionField } }';
    const response = await graphql(mergedSchema, query);
    expect(response.data?.wrappingObject.functionField).to.equal(8);
  });
});

describe('onTypeConflict', () => {
  let schema1: GraphQLSchema;
  let schema2: GraphQLSchema;

  beforeEach(() => {
    const typeDefs1 = `
      type Query {
        test1: Test
      }

      type Test {
        fieldA: String
        fieldB: String
      }
    `;

    const typeDefs2 = `
      type Query {
        test2: Test
      }

      type Test {
        fieldA: String
        fieldC: String
      }
      `;

    schema1 = makeExecutableSchema({
      typeDefs: typeDefs1,
      resolvers: {
        Query: {
          test1: () => ({}),
        },
        Test: {
          fieldA: () => 'A',
          fieldB: () => 'B',
        },
      },
    });

    schema2 = makeExecutableSchema({
      typeDefs: typeDefs2,
      resolvers: {
        Query: {
          test2: () => ({}),
        },
        Test: {
          fieldA: () => 'A',
          fieldC: () => 'C',
        },
      },
    });
  });

  it('by default takes last type', async () => {
    const mergedSchema = mergeSchemas({
      schemas: [schema1, schema2],
    });
    const result1 = await graphql(mergedSchema, '{ test2 { fieldC } }');
    expect(result1.data?.test2.fieldC).to.equal('C');
    const result2 = await graphql(mergedSchema, '{ test2 { fieldB } }');
    expect(result2.data).to.equal(undefined);
  });

  it('can use onTypeConflict to select last type', async () => {
    const mergedSchema = mergeSchemas({
      schemas: [schema1, schema2],
      onTypeConflict: (_left, right) => right,
    });
    const result1 = await graphql(mergedSchema, '{ test2 { fieldC } }');
    expect(result1.data?.test2.fieldC).to.equal('C');
    const result2 = await graphql(mergedSchema, '{ test2 { fieldB } }');
    expect(result2.data).to.equal(undefined);
  });

  it('can use onTypeConflict to select first type', async () => {
    const mergedSchema = mergeSchemas({
      schemas: [schema1, schema2],
      onTypeConflict: left => left,
    });
    const result1 = await graphql(mergedSchema, '{ test1 { fieldB } }');
    expect(result1.data?.test1.fieldB).to.equal('B');
    const result2 = await graphql(mergedSchema, '{ test1 { fieldC } }');
    expect(result2.data).to.equal(undefined);
  });
});

describe('mergeTypes', () => {
  let schema1: GraphQLSchema;
  let schema2: GraphQLSchema;

  beforeEach(() => {
    const typeDefs1 = `
      type Query {
        rootField1: Wrapper
        getTest(id: ID): Test
      }

      type Wrapper {
        test: Test
      }

      type Test {
        id: ID
        field1: String
      }
    `;

    const typeDefs2 = `
      type Query {
        rootField2: Wrapper
        getTest(id: ID): Test
      }

      type Wrapper {
        test: Test
      }

      type Test {
        id: ID
        field2: String
      }
    `;

    schema1 = makeExecutableSchema({
      typeDefs: typeDefs1,
      resolvers: {
        Query: {
          rootField1: () => ({ test: { id: '1' } }),
          getTest: (_parent, { id }) => ({ id }),
        },
        Test: {
          field1: parent => parent.id,
        },
      },
    });

    schema2 = makeExecutableSchema({
      typeDefs: typeDefs2,
      resolvers: {
        Query: {
          rootField2: () => ({ test: { id: '2' } }),
          getTest: (_parent, { id }) => ({ id }),
        },
        Test: {
          field2: parent => parent.id,
        },
      },
    });
  });

  it('can merge types', async () => {
    const subschemaConfig1: SubschemaConfig = {
      schema: schema1,
      merge: {
        Test: {
          selectionSet: '{ id }',
          resolve: (originalResult, context, info, subschema, selectionSet) =>
            delegateToSchema({
              schema: subschema,
              operation: 'query',
              fieldName: 'getTest',
              args: { id: originalResult.id },
              selectionSet,
              context,
              info,
              skipTypeMerging: true,
            }),
        },
      },
    };

    const subschemaConfig2: SubschemaConfig = {
      schema: schema2,
      merge: {
        Test: {
          selectionSet: '{ id }',
          resolve: (originalResult, context, info, subschema, selectionSet) =>
            delegateToSchema({
              schema: subschema,
              operation: 'query',
              fieldName: 'getTest',
              args: { id: originalResult.id },
              selectionSet,
              context,
              info,
              skipTypeMerging: true,
            }),
        },
      },
    };

    const mergedSchema = mergeSchemas({
      subschemas: [subschemaConfig1, subschemaConfig2],
    });

    const result1 = await graphql(
      mergedSchema,
      `
        {
          rootField1 {
            test {
              field1
              ... on Test {
                field2
              }
            }
          }
        }
      `,
    );
    expect(result1).to.deep.equal({
      data: {
        rootField1: {
          test: {
            field1: '1',
            field2: '1',
          },
        },
      },
    });
  });
});
