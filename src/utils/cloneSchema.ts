import {
  GraphQLDirective,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLObjectType,
  GraphQLNamedType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLUnionType,
} from 'graphql';
import { healTypeMap } from './healTypeMap';
import isSpecifiedScalarType from './isSpecifiedScalarType';

export function cloneDirective(directive: GraphQLDirective): GraphQLDirective {
  return new GraphQLDirective(directive.toConfig());
}

export function cloneType(type: GraphQLNamedType): GraphQLNamedType {
  if (type instanceof GraphQLObjectType) {
    return new GraphQLObjectType(type.toConfig());
  } else if (type instanceof GraphQLInterfaceType) {
    return new GraphQLInterfaceType(type.toConfig());
  } else if (type instanceof GraphQLUnionType) {
    return new GraphQLUnionType(type.toConfig());
  } else if (type instanceof GraphQLInputObjectType) {
    return new GraphQLInputObjectType(type.toConfig());
  } else if (type instanceof GraphQLEnumType) {
    return new GraphQLEnumType(type.toConfig());
  } else if (type instanceof GraphQLScalarType) {
    return isSpecifiedScalarType(type) ? type : new GraphQLScalarType(type.toConfig());
  } else {
    throw new Error(`Invalid type ${type}`);
  }
}

export function cloneSchema(schema: GraphQLSchema): GraphQLSchema {
  const newDirectives = schema.getDirectives().map(directive => cloneDirective(directive));

  const originalTypeMap = schema.getTypeMap();
  const newTypeMap = {};

  Object.keys(originalTypeMap).forEach(typeName => {
    if (!typeName.startsWith('__')) {
      newTypeMap[typeName] = cloneType(originalTypeMap[typeName]);
    }
  });

  healTypeMap(newTypeMap, newDirectives);

  const selectors = {
    query: 'getQueryType',
    mutation: 'getMutationType',
    subscription: 'getSubscriptionType',
  };

  const rootTypes = Object.create(null);

  Object.keys(selectors).forEach(op => {
    const rootType = schema[selectors[op]]();
    if (rootType) {
      rootTypes[op] = newTypeMap[rootType.name];
    }
  });

  return new GraphQLSchema({
    query: rootTypes.query,
    mutation: rootTypes.mutation,
    subscription: rootTypes.subscription,
    types: Object.keys(newTypeMap).map(typeName => newTypeMap[typeName]),
    directives: newDirectives,
  });
}
