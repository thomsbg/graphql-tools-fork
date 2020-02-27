import { PubSub } from 'graphql-subscriptions';
import {
  ApolloLink,
  Observable,
  ExecutionResult as LinkExecutionResult,
} from 'apollo-link';
import {
  GraphQLSchema,
  graphql,
  print,
  subscribe,
  Kind,
  GraphQLScalarType,
  ValueNode,
  ExecutionResult,
  Source,
  GraphQLResolveInfo,
} from 'graphql';
import { forAwaitEach } from 'iterall';

import introspectSchema from '../stitching/introspectSchema';
import { IResolvers, Fetcher, SubschemaConfig } from '../Interfaces';
import { makeExecutableSchema } from '../makeExecutableSchema';

export type Location = {
  name: string;
  coordinates: string;
};

export type Property = {
  id: string;
  name: string;
  location: Location;
};

export type Product = {
  id: string;
  price?: number;
  url?: string;
  type: string;
};

export type Booking = {
  id: string;
  propertyId: string;
  customerId: string;
  startTime: string;
  endTime: string;
};

export type Customer = {
  id: string;
  email: string;
  name: string;
  address?: string;
  vehicleId?: string;
};

export type Vehicle = {
  id: string;
  licensePlate?: string;
  bikeType?: 'MOUNTAIN' | 'ROAD';
};

export const sampleData: {
  Property: { [key: string]: Property };
  Product: { [key: string]: Product };
  Booking: { [key: string]: Booking };
  Customer: { [key: string]: Customer };
  Vehicle: { [key: string]: Vehicle };
} = {
  Product: {
    pd1: {
      id: 'pd1',
      type: 'simple',
      price: 100,
    },
    pd2: {
      id: 'pd2',
      type: 'download',
      url: 'https://graphql.org',
    },
  },
  Property: {
    p1: {
      id: 'p1',
      name: 'Super great hotel',
      location: {
        name: 'Helsinki',
        coordinates: '60.1698° N, 24.9383° E',
      },
    },
    p2: {
      id: 'p2',
      name: 'Another great hotel',
      location: {
        name: 'San Francisco',
        coordinates: '37.7749° N, 122.4194° W',
      },
    },
    p3: {
      id: 'p3',
      name: 'BedBugs - The Affordable Hostel',
      location: {
        name: 'Helsinki',
        coordinates: '60.1699° N, 24.9384° E',
      },
    },
  },
  Booking: {
    b1: {
      id: 'b1',
      propertyId: 'p1',
      customerId: 'c1',
      startTime: '2016-05-04',
      endTime: '2016-06-03',
    },
    b2: {
      id: 'b2',
      propertyId: 'p1',
      customerId: 'c2',
      startTime: '2016-06-04',
      endTime: '2016-07-03',
    },
    b3: {
      id: 'b3',
      propertyId: 'p1',
      customerId: 'c3',
      startTime: '2016-08-04',
      endTime: '2016-09-03',
    },
    b4: {
      id: 'b4',
      propertyId: 'p2',
      customerId: 'c1',
      startTime: '2016-10-04',
      endTime: '2016-10-03',
    },
  },

  Customer: {
    c1: {
      id: 'c1',
      email: 'examplec1@example.com',
      name: 'Exampler Customer',
      vehicleId: 'v1',
    },
    c2: {
      id: 'c2',
      email: 'examplec2@example.com',
      name: 'Joe Doe',
      vehicleId: 'v2',
    },
    c3: {
      id: 'c3',
      email: 'examplec3@example.com',
      name: 'Liisa Esimerki',
      address: 'Esimerkikatu 1 A 77, 99999 Kyyjarvi',
    },
  },

  Vehicle: {
    v1: {
      id: 'v1',
      bikeType: 'MOUNTAIN',
    },
    v2: {
      id: 'v2',
      licensePlate: 'GRAPHQL',
    },
  },
};

function values<T>(o: { [s: string]: T }): Array<T> {
  return Object.keys(o).map(k => o[k]);
}

function coerceString(value: any): string {
  if (Array.isArray(value)) {
    throw new TypeError(
      `String cannot represent an array value: [${String(value)}]`,
    );
  }
  return String(value);
}

const DateTime = new GraphQLScalarType({
  name: 'DateTime',
  description: 'Simple fake datetime',
  serialize: coerceString,
  parseValue: coerceString,
  parseLiteral(ast) {
    return ast.kind === Kind.STRING ? ast.value : null;
  },
});

function identity(value: any): any {
  return value;
}

function parseLiteral(ast: ValueNode): any {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
    case Kind.FLOAT:
      return parseFloat(ast.value);
    case Kind.OBJECT: {
      const value = Object.create(null);
      ast.fields.forEach(field => {
        value[field.name.value] = parseLiteral(field.value);
      });

      return value;
    }
    case Kind.LIST:
      return ast.values.map(parseLiteral);
    default:
      return null;
  }
}

const GraphQLJSON = new GraphQLScalarType({
  name: 'JSON',
  description:
    'The `JSON` scalar type represents JSON values as specified by ' +
    '[ECMA-404](http://www.ecma-international.org/' +
    'publications/files/ECMA-ST/ECMA-404.pdf).',
  serialize: identity,
  parseValue: identity,
  parseLiteral,
});

const addressTypeDef = `
  type Address {
    street: String
    city: String
    state: String
    zip: String
  }
`;

const propertyAddressTypeDef = `
  type Property {
    id: ID!
    name: String!
    location: Location
    address: Address
    error: String
  }
`;

const propertyRootTypeDefs = `
  type Location {
    name: String!
  }

  enum TestInterfaceKind {
    ONE
    TWO
  }

  interface TestInterface {
    kind: TestInterfaceKind
    testString: String
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

  type UnionImpl {
    someField: String
  }

  union TestUnion = TestImpl1 | UnionImpl

  input InputWithDefault {
    test: String = "Foo"
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
`;

const propertyAddressTypeDefs = `
  scalar DateTime
  scalar JSON

  ${addressTypeDef}
  ${propertyAddressTypeDef}
  ${propertyRootTypeDefs}
`;

const propertyResolvers: IResolvers = {
  Query: {
    propertyById(_root, { id }) {
      return sampleData.Property[id];
    },

    properties(_root, { limit }) {
      const list = values(sampleData.Property);
      return limit ? list.slice(0, limit) : list;
    },

    contextTest(_root, args, context) {
      return JSON.stringify(context[args.key]);
    },

    dateTimeTest() {
      return '1987-09-25T12:00:00';
    },

    jsonTest(_root, { input }) {
      return input;
    },

    interfaceTest(_root, { kind }) {
      return kind === 'ONE'
        ? {
            kind: 'ONE',
            testString: 'test',
            foo: 'foo',
          }
        : {
            kind: 'TWO',
            testString: 'test',
            bar: 'bar',
          };
    },

    unionTest(_root, { output }) {
      return output === 'Interface'
        ? {
            kind: 'ONE',
            testString: 'test',
            foo: 'foo',
          }
        : {
            someField: 'Bar',
          };
    },

    errorTest() {
      throw new Error('Sample error!');
    },

    errorTestNonNull() {
      throw new Error('Sample error non-null!');
    },

    defaultInputTest(_parent, { input }) {
      return input.test;
    },
  },
  DateTime,
  JSON: GraphQLJSON,

  TestInterface: {
    __resolveType(obj: any) {
      return obj.kind === 'ONE' ? 'TestImpl1' : 'TestImpl2';
    },
  },

  TestUnion: {
    __resolveType(obj: any) {
      return obj.kind === 'ONE' ? 'TestImpl1' : 'UnionImpl';
    },
  },

  Property: {
    error() {
      const error = new Error('Property.error error');
      (error as any).extensions = {
        code: 'SOME_CUSTOM_CODE',
      };
      throw error;
    },
  },
};

const DownloadableProduct = `
  type DownloadableProduct implements Product & Downloadable {
    id: ID!
    url: String!
  }
`;

const SimpleProduct = `type SimpleProduct implements Product & Sellable {
    id: ID!
    price: Int!
  }
`;

const productTypeDefs = `
  interface Product {
    id: ID!
  }

  interface Sellable {
    price: Int!
  }

  interface Downloadable {
    url: String!
  }

  ${SimpleProduct}
  ${DownloadableProduct}

  type Query {
    products: [Product]
  }
`;

const productResolvers: IResolvers = {
  Query: {
    products(_root) {
      const list = values(sampleData.Product);
      return list;
    },
  },

  Product: {
    __resolveType(obj: any) {
      return obj.type === 'simple' ? 'SimpleProduct' : 'DownloadableProduct';
    },
  },
};

const customerAddressTypeDef = `
  type Customer implements Person {
    id: ID!
    email: String!
    name: String!
    address: Address
    bookings(limit: Int): [Booking!]
    vehicle: Vehicle
    error: String
  }
`;

const bookingRootTypeDefs = `
  scalar DateTime

  type Booking {
    id: ID!
    propertyId: ID!
    customer: Customer!
    startTime: String!
    endTime: String!
    error: String
    errorNonNull: String!
  }

  interface Person {
    id: ID!
    name: String!
  }

  union Vehicle = Bike | Car

  type Bike {
    id: ID!
    bikeType: String
  }

  type Car  {
    id: ID!
    licensePlate: String
  }

  type Query {
    bookingById(id: ID!): Booking
    bookingsByPropertyId(propertyId: ID!, limit: Int): [Booking!]
    customerById(id: ID!): Customer
    bookings(limit: Int): [Booking!]
    customers(limit: Int): [Customer!]
  }

  input BookingInput {
    propertyId: ID!
    customerId: ID!
    startTime: DateTime!
    endTime: DateTime!
  }

  type Mutation {
    addBooking(input: BookingInput): Booking
  }
`;

const bookingAddressTypeDefs = `
  ${addressTypeDef}
  ${customerAddressTypeDef}
  ${bookingRootTypeDefs}
`;

const bookingResolvers: IResolvers = {
  Query: {
    bookingById(_parent, { id }) {
      return sampleData.Booking[id];
    },
    bookingsByPropertyId(_parent, { propertyId, limit }) {
      const list = values(sampleData.Booking).filter(
        (booking: Booking) => booking.propertyId === propertyId,
      );
      return limit ? list.slice(0, limit) : list;
    },
    customerById(_parent, { id }) {
      return sampleData.Customer[id];
    },
    bookings(_parent, { limit }) {
      const list = values(sampleData.Booking);
      return limit ? list.slice(0, limit) : list;
    },
    customers(_parent, { limit }) {
      const list = values(sampleData.Customer);
      return limit ? list.slice(0, limit) : list;
    },
  },

  Mutation: {
    addBooking(
      _parent,
      { input: { propertyId, customerId, startTime, endTime } },
    ) {
      return {
        id: 'newId',
        propertyId,
        customerId,
        startTime,
        endTime,
      };
    },
  },

  Booking: {
    __isTypeOf(source: Source, _context: any, _info: GraphQLResolveInfo) {
      return Object.prototype.hasOwnProperty.call(source, 'id');
    },
    customer(parent: Booking) {
      return sampleData.Customer[parent.customerId];
    },
    error() {
      throw new Error('Booking.error error');
    },
    errorNonNull() {
      throw new Error('Booking.errorNoNull error');
    },
  },

  Customer: {
    bookings(parent: Customer, { limit }) {
      const list = values(sampleData.Booking).filter(
        (booking: Booking) => booking.customerId === parent.id,
      );
      return limit ? list.slice(0, limit) : list;
    },
    vehicle(parent: Customer) {
      return sampleData.Vehicle[parent.vehicleId];
    },
    error() {
      throw new Error('Customer.error error');
    },
  },

  Vehicle: {
    __resolveType(parent: any) {
      if (parent.licensePlate) {
        return 'Car';
      } else if (parent.bikeType) {
        return 'Bike';
      }

      throw new Error('Could not resolve Vehicle type');
    },
  },

  DateTime,
};

const subscriptionTypeDefs = `
  type Notification{
    text: String
    throwError: String
  }

  type Query{
    notifications: Notification
  }

  type Subscription{
    notifications: Notification
  }
`;

export const subscriptionPubSub = new PubSub();
export const subscriptionPubSubTrigger = 'pubSubTrigger';

const subscriptionResolvers: IResolvers = {
  Query: {
    notifications: (_root: any) => ({ text: 'Hello world' }),
  },
  Subscription: {
    notifications: {
      subscribe: () =>
        subscriptionPubSub.asyncIterator(subscriptionPubSubTrigger),
    },
  },
  Notification: {
    throwError: () => {
      throw new Error('subscription field error');
    },
  },
};

export const propertySchema: GraphQLSchema = makeExecutableSchema({
  typeDefs: propertyAddressTypeDefs,
  resolvers: propertyResolvers,
});

export const productSchema: GraphQLSchema = makeExecutableSchema({
  typeDefs: productTypeDefs,
  resolvers: productResolvers,
});

export const bookingSchema: GraphQLSchema = makeExecutableSchema({
  typeDefs: bookingAddressTypeDefs,
  resolvers: bookingResolvers,
});

export const subscriptionSchema: GraphQLSchema = makeExecutableSchema({
  typeDefs: subscriptionTypeDefs,
  resolvers: subscriptionResolvers,
});

const hasSubscriptionOperation = ({ query }: { query: any }): boolean => {
  for (const definition of query.definitions) {
    if (definition.kind === 'OperationDefinition') {
      const operation = definition.operation;
      if (operation === 'subscription') {
        return true;
      }
    }
  }
  return false;
};

function makeLinkFromSchema(schema: GraphQLSchema) {
  return new ApolloLink(
    operation =>
      new Observable(observer => {
        const { query, operationName, variables } = operation;
        const { graphqlContext } = operation.getContext();
        if (!hasSubscriptionOperation(operation)) {
          graphql(
            schema,
            print(query),
            null,
            graphqlContext,
            variables,
            operationName,
          )
            .then(result => {
              observer.next(result);
              observer.complete();
            })
            .catch(err => {
              observer.error(err);
            });
        } else {
          subscribe(
            schema,
            query,
            null,
            graphqlContext,
            variables,
            operationName,
          )
            .then(results => {
              if (
                typeof (results as AsyncIterator<ExecutionResult>).next ===
                'function'
              ) {
                forAwaitEach(
                  results as AsyncIterable<ExecutionResult>,
                  result => observer.next(result),
                )
                  .then(() => observer.complete())
                  .catch(err => observer.error(err));
              } else {
                observer.next(results as LinkExecutionResult);
                observer.complete();
              }
            })
            .catch(err => {
              observer.error(err);
            });
        }
      }),
  );
}

export async function makeSchemaRemoteFromLink(
  schema: GraphQLSchema,
): Promise<SubschemaConfig> {
  const link = makeLinkFromSchema(schema);
  const clientSchema = await introspectSchema(link);
  return {
    schema: clientSchema,
    link,
  };
}

export async function makeSchemaRemoteFromDispatchedLink(
  schema: GraphQLSchema,
): Promise<SubschemaConfig> {
  const link = makeLinkFromSchema(schema);
  const clientSchema = await introspectSchema(link);
  return {
    schema: clientSchema,
    dispatcher: () => link,
  };
}

// ensure fetcher support exists from the 2.0 api
async function makeExecutableSchemaFromDispatchedFetcher(
  schema: GraphQLSchema,
): Promise<SubschemaConfig> {
  const fetcher: Fetcher = ({ query, operationName, variables, context }) =>
    graphql(schema, print(query), null, context, variables, operationName);

  const clientSchema = await introspectSchema(fetcher);
  return {
    schema: clientSchema,
    fetcher,
  };
}

export const remotePropertySchema = makeSchemaRemoteFromLink(propertySchema);
export const remoteProductSchema = makeSchemaRemoteFromDispatchedLink(
  productSchema,
);
export const remoteBookingSchema = makeExecutableSchemaFromDispatchedFetcher(
  bookingSchema,
);
