import {
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLType,
  GraphQLUnionType,
  GraphQLNamedType,
  isNamedType,
} from 'graphql';
import {
  cloneType,
  cloneDirective,
  healTypes,
} from '../utils';
import { stripResolvers } from './transformSchema';

export enum VisitSchemaKind {
  TYPE = 'VisitSchemaKind.TYPE',
  SCALAR_TYPE = 'VisitSchemaKind.SCALAR_TYPE',
  ENUM_TYPE = 'VisitSchemaKind.ENUM_TYPE',
  COMPOSITE_TYPE = 'VisitSchemaKind.COMPOSITE_TYPE',
  OBJECT_TYPE = 'VisitSchemaKind.OBJECT_TYPE',
  INPUT_OBJECT_TYPE = 'VisitSchemaKind.INPUT_OBJECT_TYPE',
  ABSTRACT_TYPE = 'VisitSchemaKind.ABSTRACT_TYPE',
  UNION_TYPE = 'VisitSchemaKind.UNION_TYPE',
  INTERFACE_TYPE = 'VisitSchemaKind.INTERFACE_TYPE',
  ROOT_OBJECT = 'VisitSchemaKind.ROOT_OBJECT',
  QUERY = 'VisitSchemaKind.QUERY',
  MUTATION = 'VisitSchemaKind.MUTATION',
  SUBSCRIPTION = 'VisitSchemaKind.SUBSCRIPTION',
}
// I couldn't make keys to be forced to be enum values
export type SchemaVisitor = { [key: string]: TypeVisitor };
export type TypeVisitor = (
  type: GraphQLType,
  schema: GraphQLSchema,
) => GraphQLNamedType | null | undefined;

export function visitSchema(
  schema: GraphQLSchema,
  visitor: SchemaVisitor,
  wrap?: boolean, // deprecated, use wrapSchema
) {
  const types: { [key: string]: GraphQLNamedType } = {};

  const queryType = schema.getQueryType();
  const mutationType = schema.getMutationType();
  const subscriptionType = schema.getSubscriptionType();

  const typeMap = schema.getTypeMap();
  Object.keys(typeMap).map((typeName: string) => {
    const type = typeMap[typeName];
    if (isNamedType(type) && type.name.slice(0, 2) !== '__') {
      const specifiers = getTypeSpecifiers(type, schema);
      const typeVisitor = getVisitor(visitor, specifiers);
      if (typeVisitor) {
        const result = typeVisitor(type, schema);
        if (typeof result === 'undefined') {
          types[typeName] = cloneType(type);
        } else if (result === null) {
          types[typeName] = null;
        } else {
          types[typeName] = cloneType(result);
        }
    } else {
        types[typeName] = cloneType(type);
      }
    }
  });

  const directives = schema.getDirectives().map(d => cloneDirective(d));

  healTypes(types, directives);

  const newSchema = new GraphQLSchema({
    ...schema.toConfig(),
    query: queryType ? (types[queryType.name] as GraphQLObjectType) : null,
    mutation: mutationType ? (types[mutationType.name] as GraphQLObjectType) : null,
    subscription: subscriptionType ? (types[subscriptionType.name] as GraphQLObjectType) : null,
    types: Object.keys(types).map(name => types[name]),
    directives,
  });

  if (wrap) {
    stripResolvers(newSchema);
  }

  return newSchema;
}

function getTypeSpecifiers(
  type: GraphQLType,
  schema: GraphQLSchema,
): Array<VisitSchemaKind> {
  const specifiers = [VisitSchemaKind.TYPE];
  if (type instanceof GraphQLObjectType) {
    specifiers.push(
      VisitSchemaKind.COMPOSITE_TYPE,
      VisitSchemaKind.OBJECT_TYPE,
    );
    const query = schema.getQueryType();
    const mutation = schema.getMutationType();
    const subscription = schema.getSubscriptionType();
    if (type === query) {
      specifiers.push(VisitSchemaKind.ROOT_OBJECT, VisitSchemaKind.QUERY);
    } else if (type === mutation) {
      specifiers.push(VisitSchemaKind.ROOT_OBJECT, VisitSchemaKind.MUTATION);
    } else if (type === subscription) {
      specifiers.push(
        VisitSchemaKind.ROOT_OBJECT,
        VisitSchemaKind.SUBSCRIPTION,
      );
    }
  } else if (type instanceof GraphQLInputObjectType) {
    specifiers.push(VisitSchemaKind.INPUT_OBJECT_TYPE);
  } else if (type instanceof GraphQLInterfaceType) {
    specifiers.push(
      VisitSchemaKind.COMPOSITE_TYPE,
      VisitSchemaKind.ABSTRACT_TYPE,
      VisitSchemaKind.INTERFACE_TYPE,
    );
  } else if (type instanceof GraphQLUnionType) {
    specifiers.push(
      VisitSchemaKind.COMPOSITE_TYPE,
      VisitSchemaKind.ABSTRACT_TYPE,
      VisitSchemaKind.UNION_TYPE,
    );
  } else if (type instanceof GraphQLEnumType) {
    specifiers.push(VisitSchemaKind.ENUM_TYPE);
  } else if (type instanceof GraphQLScalarType) {
    specifiers.push(VisitSchemaKind.SCALAR_TYPE);
  }

  return specifiers;
}

function getVisitor(
  visitor: SchemaVisitor,
  specifiers: Array<VisitSchemaKind>,
): TypeVisitor | null {
  let typeVisitor = null;
  const stack = [...specifiers];
  while (!typeVisitor && stack.length > 0) {
    const next = stack.pop();
    typeVisitor = visitor[next];
  }

  return typeVisitor;
}
